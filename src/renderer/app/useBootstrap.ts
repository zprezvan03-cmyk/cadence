/**
 * Application bootstrap: loads settings and library, wires the audio engine to the player store,
 * restores the last session, and installs keyboard, media-key and OS media-session (SMTC)
 * integration. Written for Cadence.
 */

import { useEffect } from "react";
import type { AppSettings, MediaCommand } from "../../shared/types";
import { inferArtworkMimeType } from "../../main/media/protocolHandler";
import { audioEngine } from "../audio/engine";
import { applyFontFamily } from "./fonts";
import { useLibrary } from "../state/libraryStore";
import { readSession, usePlayer, currentTrackId } from "../state/playerStore";
import { useSettings } from "../state/settingsStore";
import { useUi } from "../state/uiStore";
import { useHistory } from "../state/historyStore";
import { formatTime } from "../player/queue";
import {
  explainPlaybackFailure,
  isDecoderOrDemuxerMessage,
  probeMediaAccessStatus,
  type MediaAccessStatus,
} from "../audio/codecs";

const SEEK_STEP = 5;
const MEDIA_ACTION_DEDUP_MS = 100;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export { inferArtworkMimeType };

export function useBootstrap(): void {
  useEffect(() => {
    let disposed = false;
    let lastHardwareCommandAt = 0;
    // Read before any settings setter can persist the store's initial empty queue over the session.
    const savedSession = readSession();

    void (async () => {
      await useSettings.getState().load();
      await useLibrary.getState().refresh();
      // Restore persistent listening history so both the History tab and the homepage's Recently
      // Played section reconstruct from SQLite on every launch. Idempotent: safe to call again
      // from view mounts; the store ignores duplicate loads once loaded is true.
      await useHistory.getState().load();
      if (disposed) return;

      const settings = useSettings.getState().settings;
      if (!settings) return;

      const player = usePlayer.getState();
      player.setVolume(settings.playback.volume);
      player.setMuted(settings.playback.muted);
      player.setRate(settings.playback.playbackRate);
      player.setRepeat(settings.playback.repeat);
      if (settings.playback.shuffle !== player.shuffle) player.toggleShuffle();

      if (settings.playback.resumeOnLaunch && savedSession) {
        // Drop queue entries whose files no longer exist in the library.
        const available = useLibrary.getState().tracksById;
        const queue = savedSession.queue.filter(id => available.has(id));
        if (queue.length > 0) {
          await usePlayer.getState().restore({ ...savedSession, queue });
        }
      }
    })();

    const unsubscribers = [
      audioEngine.on("time", ({ position, duration, buffered }) => {
        usePlayer.getState().syncTime(position, duration, buffered);
      }),
      audioEngine.on("state", state => {
        usePlayer.getState().syncState(state);
      }),
      audioEngine.on("metadata", ({ duration }) => {
        if (duration > 0) usePlayer.setState({ duration });
      }),
      audioEngine.on("error", ({ message, code, mediaMessage, src }) => {
        // Turn a bare media error code into something the listener can act on, while keeping
        // file-access errors (403/404) separate from unsupported-codec and decode errors.
        const trackId = currentTrackId(usePlayer.getState());
        const track = trackId === null ? null : useLibrary.getState().tracksById.get(trackId) ?? null;

        const report = (httpStatus: MediaAccessStatus) => {
          if (disposed || currentTrackId(usePlayer.getState()) !== trackId) return;
          const explanation = explainPlaybackFailure(code, track, { httpStatus, mediaMessage });
          const text = code ? explanation : message;
          if (usePlayer.getState().error === text) return;
          usePlayer.getState().setError(text);
          useUi.getState().showToast(text);
          console.error(
            "[Cadence] Playback error:",
            message,
            "code:",
            code,
            "status:",
            httpStatus,
            "detail:",
            mediaMessage,
            "track:",
            track?.title
          );
        };

        if (code && src && !isDecoderOrDemuxerMessage(mediaMessage)) {
          void probeMediaAccessStatus(src).then(report);
        } else {
          report(null);
        }
      }),
      audioEngine.on("volume", ({ volume, muted }) => {
        usePlayer.setState({ volume, muted });
      }),
      audioEngine.on("rate", ({ rate }) => {
        usePlayer.setState({ rate });
      }),
    ];

    // Auto-advance when the element reaches the end of a track.
    const ending = audioEngine.on("state", state => {
      if (state.ended) void usePlayer.getState().handleEnded();
    });
    unsubscribers.push(ending);

    const dispatchMediaCommand = (command: MediaCommand, fromGlobalShortcut = false) => {
      const now = performance.now();
      if (fromGlobalShortcut) {
        lastHardwareCommandAt = now;
      } else if (now - lastHardwareCommandAt < MEDIA_ACTION_DEDUP_MS) {
        // Prevent duplicate toggles/skips on Windows when both `global-shortcut` and WebView2 SMTC
        // emit the same hardware media key press within a single frame.
        return;
      }

      const player = usePlayer.getState();
      switch (command) {
        case "play-pause":
          void player.toggle();
          break;
        case "next":
          void player.next(false);
          break;
        case "previous":
          player.previous();
          break;
        case "stop":
          audioEngine.pause();
          break;
        case "seek-forward":
          player.seekBy(SEEK_STEP);
          break;
        case "seek-back":
          player.seekBy(-SEEK_STEP);
          break;
        default:
          break;
      }
    };

    const commandListener = window.cadence?.player?.onCommand?.(command => {
      dispatchMediaCommand(command, true);
    });

    const menuListener = (
      window.cadence as unknown as { onMenuAction?: (listener: (action: string) => void) => () => void }
    )?.onMenuAction?.(action => {
      if (action === "add-folder") void useLibrary.getState().addFolder();
      if (action === "rescan") void useLibrary.getState().rescan();
      if (action === "toggle-fullscreen-lyrics") useUi.getState().toggleFullscreenLyrics();
    });

    const unsubscribeProgress = window.cadence?.library?.onScanProgress?.(progress => {
      useLibrary.setState({ scanning: progress.running });
      const snapshot = useLibrary.getState().snapshot;
      if (snapshot) useLibrary.setState({ snapshot: { ...snapshot, scan: progress } });
      if (!progress.running && progress.phase === "done") {
        void useLibrary.getState().refresh();
      }
    });

    const unsubscribeChanged = window.cadence?.library?.onChanged?.(() => {
      void useLibrary.getState().refresh();
    });

    // OS media session (Windows SMTC via WebView2 `navigator.mediaSession`)
    let lastMetadataSignature = "";
    let lastReportedKey = "";

    const updateMediaSession = () => {
      const state = usePlayer.getState();
      const trackId = currentTrackId(state);
      const track = trackId === null ? null : useLibrary.getState().tracksById.get(trackId) ?? null;

      // Report discrete state transitions to the desktop bridge without spamming 10 Hz ticks.
      const reportKey = `${trackId ?? "none"}|${state.isPlaying}|${state.repeat}|${state.shuffle}|${state.orderPosition}`;
      if (reportKey !== lastReportedKey) {
        lastReportedKey = reportKey;
        void window.cadence?.player?.reportState?.({
          trackId,
          position: state.position,
          duration: state.duration,
          playing: state.isPlaying,
          volume: state.volume,
          muted: state.muted,
          playbackRate: state.rate,
          shuffle: state.shuffle,
          repeat: state.repeat,
          queue: state.queue,
          queueIndex: state.orderPosition,
        });
      }

      if (!("mediaSession" in navigator)) return;

      if (!track) {
        if (lastMetadataSignature !== "") {
          lastMetadataSignature = "";
          try {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = "none";
          } catch {
            /* best-effort */
          }
        }
        return;
      }

      try {
        const signature = `${track.id}\u0000${track.title}\u0000${track.artist}\u0000${track.album}\u0000${track.artworkUrl ?? ""}`;
        if (signature !== lastMetadataSignature && typeof MediaMetadata !== "undefined") {
          lastMetadataSignature = signature;
          navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: track.artist,
            album: track.album,
            artwork: track.artworkUrl
              ? [
                  {
                    src: track.artworkUrl,
                    sizes: "512x512",
                    type: inferArtworkMimeType(track.artworkUrl),
                  },
                ]
              : [],
          });
        }
        navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
        if (state.duration > 0) {
          navigator.mediaSession.setPositionState({
            duration: state.duration,
            position: Math.min(Math.max(0, state.position), state.duration),
            playbackRate: state.rate,
          });
        }
      } catch {
        /* media session is best-effort */
      }
    };

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      [
        "play",
        () => {
          if (performance.now() - lastHardwareCommandAt < MEDIA_ACTION_DEDUP_MS) return;
          if (!usePlayer.getState().isPlaying) void usePlayer.getState().toggle();
        },
      ],
      [
        "pause",
        () => {
          if (performance.now() - lastHardwareCommandAt < MEDIA_ACTION_DEDUP_MS) return;
          if (usePlayer.getState().isPlaying) void usePlayer.getState().toggle();
        },
      ],
      [
        "stop",
        () => {
          audioEngine.pause();
        },
      ],
      ["previoustrack", () => dispatchMediaCommand("previous", false)],
      ["nexttrack", () => dispatchMediaCommand("next", false)],
      ["seekbackward", () => dispatchMediaCommand("seek-back", false)],
      ["seekforward", () => dispatchMediaCommand("seek-forward", false)],
      [
        "seekto",
        details => {
          if (typeof details.seekTime === "number") usePlayer.getState().seek(details.seekTime);
        },
      ],
    ];

    if ("mediaSession" in navigator) {
      for (const [action, handler] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, handler);
        } catch {
          /* unsupported action */
        }
      }
    }

    const unsubscribeMediaPlayer = usePlayer.subscribe(updateMediaSession);
    const unsubscribeMediaLibrary = useLibrary.subscribe(updateMediaSession);
    updateMediaSession();

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      // Space is the native activation key for focused buttons. Let the control handle it instead
      // of turning every keyboard activation into a global play/pause shortcut.
      if (event.key === " " && event.target instanceof HTMLElement && event.target.closest("button, [role='button']")) return;
      const player = usePlayer.getState();
      const ui = useUi.getState();
      const cmd = event.ctrlKey || event.metaKey;
      const lower = event.key.toLowerCase();

      if (cmd && lower === "k") {
        event.preventDefault();
        document.getElementById("global-search")?.focus();
        return;
      }
      if (cmd && !event.shiftKey && lower === "o") {
        event.preventDefault();
        void useLibrary.getState().addFolder();
        return;
      }
      if (cmd && event.shiftKey && lower === "r") {
        event.preventDefault();
        void useLibrary.getState().rescan();
        return;
      }
      if (cmd && !event.shiftKey && lower === "p") {
        event.preventDefault();
        void player.toggle();
        return;
      }
      if (cmd && event.key === "ArrowRight") {
        event.preventDefault();
        void player.next(false);
        return;
      }
      if (cmd && event.key === "ArrowLeft") {
        event.preventDefault();
        player.previous();
        return;
      }
      if (cmd && event.key === "ArrowUp") {
        event.preventDefault();
        player.setVolume(player.volume + 0.05);
        return;
      }
      if (cmd && event.key === "ArrowDown") {
        event.preventDefault();
        player.setVolume(player.volume - 0.05);
        return;
      }
      if (event.key === "F11") {
        event.preventDefault();
        ui.toggleFullscreenLyrics();
        void (async () => {
          try {
            const full = await window.cadence?.app?.isFullScreen?.();
            await window.cadence?.app?.window?.(full ? "exitFullscreen" : "fullscreen");
          } catch {
            /* browser harness has no native window */
          }
        })();
        return;
      }

      if (cmd) return;

      switch (event.key) {
        case " ":
          event.preventDefault();
          void player.toggle();
          break;
        case "ArrowRight":
          event.preventDefault();
          if (event.shiftKey) void player.next(false);
          else player.seekBy(SEEK_STEP);
          break;
        case "ArrowLeft":
          event.preventDefault();
          if (event.shiftKey) player.previous();
          else player.seekBy(-SEEK_STEP);
          break;
        case "ArrowUp":
          event.preventDefault();
          player.setVolume(player.volume + 0.05);
          break;
        case "ArrowDown":
          event.preventDefault();
          player.setVolume(player.volume - 0.05);
          break;
        case "m":
        case "M":
          player.setMuted(!player.muted);
          break;
        case "l":
        case "L":
          ui.navigate({ name: "lyrics" });
          break;
        case "q":
        case "Q":
          ui.toggleQueue();
          break;
        case "n":
        case "N":
        case "f":
        case "F":
          ui.toggleFullscreenLyrics();
          break;
        case "s":
        case "S":
          player.toggleShuffle();
          break;
        case "r":
        case "R":
          player.cycleRepeat();
          break;
        case "Escape":
          // Overlays consume Escape before the immersive view does. QueuePanel also listens for
          // this key; toggling to false in both places is idempotent and prevents a double exit.
          if (ui.playlistPicker) {
            ui.closePlaylistPicker();
            return;
          }
          if (ui.queueOpen) {
            event.preventDefault();
            event.stopImmediatePropagation();
            ui.toggleQueue(false);
            return;
          }
          if (ui.fullscreenLyrics) {
            ui.setFullscreenLyrics(false);
            void (async () => {
              try {
                if (await window.cadence?.app?.isFullScreen?.()) {
                  await window.cadence?.app?.window?.("exitFullscreen");
                }
              } catch {
                /* ignore */
              }
            })();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      commandListener?.();
      menuListener?.();
      unsubscribeProgress?.();
      unsubscribeChanged?.();
      unsubscribeMediaPlayer();
      unsubscribeMediaLibrary();
      if ("mediaSession" in navigator) {
        for (const [action] of handlers) {
          try {
            navigator.mediaSession.setActionHandler(action, null);
          } catch {
            /* ignore */
          }
        }
      }
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Playback settings and the transport are two views of the same live state. Settings changes
  // (including Reset all) apply immediately; transport, volume and media-key changes are written
  // back so navigating to Settings never shows stale values and they survive the next launch.
  useEffect(() => {
    let applyingSettings = false;
    const applySettings = (settings: AppSettings | null) => {
      if (!settings) return;
      const player = usePlayer.getState();
      applyingSettings = true;
      try {
        if (player.volume !== settings.playback.volume) player.setVolume(settings.playback.volume);
        if (player.muted !== settings.playback.muted) player.setMuted(settings.playback.muted);
        if (player.rate !== settings.playback.playbackRate) player.setRate(settings.playback.playbackRate);
        if (player.repeat !== settings.playback.repeat) player.setRepeat(settings.playback.repeat);
        if (player.shuffle !== settings.playback.shuffle) player.toggleShuffle();
      } finally {
        applyingSettings = false;
      }
    };

    const unsubscribeSettings = useSettings.subscribe((state, previous) => {
      if (state.settings?.playback !== previous.settings?.playback) applySettings(state.settings);
    });
    const unsubscribePlayer = usePlayer.subscribe((state, previous) => {
      if (applyingSettings) return;
      const settings = useSettings.getState().settings;
      if (!settings) return;
      const playback: Partial<AppSettings["playback"]> = {};
      if (state.volume !== previous.volume && settings.playback.volume !== state.volume) playback.volume = state.volume;
      if (state.muted !== previous.muted && settings.playback.muted !== state.muted) playback.muted = state.muted;
      if (state.rate !== previous.rate && settings.playback.playbackRate !== state.rate) playback.playbackRate = state.rate;
      if (state.repeat !== previous.repeat && settings.playback.repeat !== state.repeat) playback.repeat = state.repeat;
      if (state.shuffle !== previous.shuffle && settings.playback.shuffle !== state.shuffle) playback.shuffle = state.shuffle;
      if (Object.keys(playback).length > 0) void useSettings.getState().patch({ playback });
    });

    applySettings(useSettings.getState().settings);
    return () => {
      unsubscribeSettings();
      unsubscribePlayer();
    };
  }, []);

  // Visual settings that live on the document root.
  useEffect(() => {
    const apply = (settings: AppSettings | null) => {
      if (!settings) return;
      const root = document.documentElement;
      root.style.setProperty("--accent", settings.appearance.accent);
      root.dataset.reduceMotion = settings.appearance.reduceMotion ? "true" : "false";
      root.dataset.compactSidebar = settings.appearance.compactSidebar ? "true" : "false";
      root.dataset.blurArtwork = settings.appearance.blurArtwork ? "true" : "false";
      applyFontFamily(settings.appearance.fontFamily, root);
    };
    // Settings that loaded before this effect ran (a remount, StrictMode) still reach the root.
    apply(useSettings.getState().settings);
    return useSettings.subscribe(state => apply(state.settings));
  }, []);

  // Shader audio analysis settings + start/stop with playback.
  useEffect(() => {
    const apply = () => {
      const settings = useSettings.getState().settings;
      const shaders = settings?.shaders;
      const playing = usePlayer.getState().isPlaying;
      audioEngine.configureAnalysis({
        audioResponsive: Boolean(shaders?.enabled && shaders.audioResponsive),
        audioBeatThreshold: shaders?.audioBeatThreshold ?? 0.75,
        audioSpeedMultiplier: shaders?.audioSpeedMultiplier ?? 4,
        kawarpAudioScaleBoost: shaders?.kawarpAudioScaleBoost ?? 2,
      });
      if (playing && shaders?.enabled && shaders.audioResponsive) audioEngine.startAnalysis();
      else audioEngine.stopAnalysis();
    };

    apply();
    // Playback clock ticks do not change analysis configuration; only play/pause and shader settings do.
    const unsubscribePlayer = usePlayer.subscribe((state, previous) => {
      if (state.isPlaying !== previous.isPlaying) apply();
    });
    const unsubscribeSettings = useSettings.subscribe((state, previous) => {
      if (state.settings?.shaders !== previous.settings?.shaders) apply();
    });
    return () => {
      unsubscribePlayer();
      unsubscribeSettings();
    };
  }, []);

  // Document title, so the taskbar and window capture reflect the current song.
  useEffect(() => {
    return usePlayer.subscribe(state => {
      const trackId = currentTrackId(state);
      const track = trackId === null ? null : useLibrary.getState().tracksById.get(trackId);
      document.title = track ? `${track.title} · ${track.artist} — Cadence` : "Cadence";
      if (track && state.duration > 0) {
        document.body.dataset.playback = state.isPlaying ? "playing" : "paused";
        document.body.dataset.position = formatTime(state.position);
      }
    });
  }, []);
}
