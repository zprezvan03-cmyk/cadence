/**
 * Native Android Media3 ExoPlayer audio adapter for Cadence.
 *
 * When running on Android (`window.cadence?.android` is present), playback, lockscreen media
 * notifications, Bluetooth/headset controls, AudioFocus, hardware Equalizer, and screen-off
 * gapless auto-advance are owned by `CadenceMediaService` (Media3 ExoPlayer).
 *
 * This module coordinates queue synchronization, ReplayGain/EQ updates, and feeds Media3
 * playback snapshots into `androidPlaybackClock` (`RemotePlaybackClockSource`) so
 * `<braccato-lyrics>` drives 60fps word-level karaoke highlighting without a WebView `<audio>`.
 */

import { parseMediaUrl } from "../../main/media/protocolHandler";
import type { EqualizerSettings, PlaybackSettings, RepeatMode, Track } from "../../shared/types";
import { RemotePlaybackClockSource } from "../player/playbackClock";
import { isAlacCodec } from "./codecs";
import { resolvePlaybackSource } from "./playbackSource";
import { computeReplayGain } from "./replayGain";

export interface AndroidPlaybackSnapshot {
  index: number;
  trackId: number;
  position: number;
  duration: number;
  buffered: number;
  playing: boolean;
  buffering: boolean;
  ended: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  rate: number;
  volume: number;
  muted: boolean;
  sampledAt?: number;
}

export interface AndroidAudioEventHandlers {
  onPlayback?: (snapshot: AndroidPlaybackSnapshot) => void;
  onTrackTransition?: (index: number, trackId: number) => void;
  onError?: (message: string) => void;
  onOpenNowPlaying?: () => void;
}

declare global {
  interface Window {
    __cadenceAndroidDispatch?: (msg: { event: string; payload: Record<string, unknown> }) => void;
  }
}

export function isAndroidNativeAudio(): boolean {
  return typeof window !== "undefined" && Boolean(window.cadence?.android);
}

/** Shared clock driving `<braccato-lyrics>` smoothly on Android from Media3 snapshots. */
export const androidPlaybackClock = new RemotePlaybackClockSource();

const eventListeners = new Set<AndroidAudioEventHandlers>();

function ensureDispatcher(): void {
  if (typeof window === "undefined" || typeof window.__cadenceAndroidDispatch === "function") return;
  window.__cadenceAndroidDispatch = msg => {
    if (!msg || typeof msg.event !== "string") return;
    const payload = msg.payload ?? {};

    if (msg.event === "playback") {
      const snap = payload as unknown as AndroidPlaybackSnapshot;
      androidPlaybackClock.setSnapshot({
        currentTime: Number(snap.position) || 0,
        duration: Number(snap.duration) || 0,
        isPlaying: Boolean(snap.playing),
        playbackRate: Number(snap.rate) || 1,
        sampledAt: Date.now(),
      });
      for (const listener of eventListeners) {
        listener.onPlayback?.(snap);
      }
      return;
    }

    if (msg.event === "trackTransition") {
      const index = Number(payload.index);
      const trackId = Number(payload.trackId);
      if (Number.isInteger(index) && index >= 0) {
        for (const listener of eventListeners) {
          listener.onTrackTransition?.(index, trackId);
        }
      }
      return;
    }

    if (msg.event === "error") {
      const message = String(payload.message ?? "Android playback error");
      for (const listener of eventListeners) {
        listener.onError?.(message);
      }
      return;
    }

    if (msg.event === "openNowPlaying") {
      for (const listener of eventListeners) {
        listener.onOpenNowPlaying?.();
      }
    }
  };
}

export function subscribeAndroidAudioEvents(handlers: AndroidAudioEventHandlers): () => void {
  ensureDispatcher();
  eventListeners.add(handlers);
  return () => {
    eventListeners.delete(handlers);
  };
}

async function resolveExoUriForTrack(track: Track, shouldDecodeAlac: boolean): Promise<string> {
  if (isAlacCodec(track.codec) && shouldDecodeAlac) {
    try {
      const decodedUrl = await resolvePlaybackSource(track);
      const parsed = parseMediaUrl(decodedUrl);
      if ("decodedPath" in parsed && parsed.decodedPath) {
        return parsed.decodedPath;
      }
    } catch (error) {
      console.warn("[Cadence Android] Failed to decode ALAC source:", error);
    }
  }
  return track.path;
}

function artworkFsPath(artworkUrl: string | null): string | null {
  if (!artworkUrl) return null;
  const parsed = parseMediaUrl(artworkUrl);
  if ("decodedPath" in parsed && parsed.decodedPath) {
    return parsed.decodedPath;
  }
  return artworkUrl.startsWith("/") ? artworkUrl : null;
}

let queueSyncGeneration = 0;

export async function syncQueueToAndroid(args: {
  tracks: Track[];
  startIndex: number;
  startPositionSec: number;
  autoplay: boolean;
  preserveCurrent?: boolean;
  playbackSettings: Pick<
    PlaybackSettings,
    "replayGainMode" | "replayGainPreampDb" | "replayGainPreventClipping"
  >;
}): Promise<boolean> {
  const android = window.cadence?.android;
  if (!android) return false;

  const generation = ++queueSyncGeneration;
  const { tracks, startIndex, startPositionSec, autoplay, preserveCurrent = false, playbackSettings } = args;
  const clampedStart = Math.max(0, Math.min(startIndex, Math.max(0, tracks.length - 1)));

  const items = await Promise.all(
    tracks.map(async (track, index) => {
      // Only decode ALAC eagerly for the active track and its immediate neighbor.
      const shouldDecodeAlac = Math.abs(index - clampedStart) <= 1;
      const uri = await resolveExoUriForTrack(track, shouldDecodeAlac);
      return {
        uri,
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        artworkPath: artworkFsPath(track.artworkUrl),
        durationSec: track.duration,
        replayGainLinear: computeReplayGain(track, playbackSettings).linear,
      };
    })
  );

  if (generation !== queueSyncGeneration) return false;

  await android.audioAction("syncQueue", {
    items,
    startIndex: clampedStart,
    startPositionSec: Math.max(0, startPositionSec),
    autoplay,
    preserveCurrent,
  });
  return true;
}

export async function androidAudioAction(
  action: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const android = window.cadence?.android;
  if (!android) return;
  await android.audioAction(action, payload);
}

export function androidApplyEqualizer(equalizer: EqualizerSettings): void {
  void androidAudioAction("setEqualizer", { equalizer });
}

export function androidSetTrackGain(gain: number): void {
  void androidAudioAction("setTrackGain", { gain });
}

export function androidSetSystemBarsTheme(light: boolean): void {
  void androidAudioAction("setSystemBars", { light });
}
