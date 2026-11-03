/**
 * Application bootstrap: loads settings and library, wires the audio engine to the player store,
 * restores the last session, and installs keyboard, media-key and OS media-session (SMTC)
 * integration. Written for Cadence.
 */

import { useEffect } from "react";
import type { AppSettings, MediaCommand } from "../../shared/types";
import { inferArtworkMimeType } from "../../main/media/protocolHandler";
import { audioEngine } from "../audio/engine";
import { computeReplayGain } from "../audio/replayGain";
import { applyFontFamily } from "./fonts";
import { useLibrary } from "../state/libraryStore";
import {
  currentMediaItem as currentPlayerMediaItem,
  currentQueueEntry,
  pruneSessionQueue,
  readSession,
  usePlayer,
  currentTrackId,
} from "../state/playerStore";
import { getTrackById } from "../state/trackRegistry";
import { useSettings } from "../state/settingsStore";
import { useUi } from "../state/uiStore";
import { useHistory } from "../state/historyStore";
import { useYtm } from "../state/ytmusicStore";
import { mediaItemFromLocalTrack, trackSourceKey } from "../../shared/media";
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
      // YouTube Music source: restore the anonymous guest session from settings and re-check the
      // optional connected account (whose cookie lives in the OS secret store). No network call
      // happens here; the first catalog page the user opens lazily fetches visitor data.
      useYtm.getState().syncSessionFromSettings();
      void useYtm.getState().checkAccount();
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
        // Drop local entries whose files no longer exist and legacy non-local entries, remapping
        // the playback order/current occurrence in the same operation.
        const available = new Set(useLibrary.getState().tracksById.keys());
        const session = pruneSessionQueue(savedSession, available);
        if (session.queue.length > 0) {
          await usePlayer.getState().restore(session);
        }
      }
    })();

    const isLocalCurrent = (): boolean => {
      const entry = currentQueueEntry(usePlayer.getState());
      return !entry || entry.item.source.kind === "local";
    };

    const unsubscribers = [
      audioEngine.on("time", ({ position, duration, buffered }) => {
        usePlayer.getState().syncTime(position, duration, buffered);
      }),
      audioEngine.on("state", state => {
        usePlayer.getState().syncState(state);
      }),
      audioEngine.on("metadata", ({ duration }) => {
        if (duration > 0 && isLocalCurrent()) usePlayer.setState({ duration });
      }),
      audioEngine.on("error", ({ message, code, mediaMessage, src }) => {
        // Remote (YouTube Music) items: a mid-playback failure is usually an expired googlevideo
        // URL. Drop the cached stream and retry once through the normal remote load path; if the
        // retry also fails, loadCurrent surfaces the resolver's error in the player bar.
        const remoteCurrent = currentPlayerMediaItem(usePlayer.getState());
        if (remoteCurrent && remoteCurrent.source.kind !== "local") {
          if (disposed) return;
          console.error("[Cadence] Remote playback error:", message, "code:", code, "detail:", mediaMessage);
          void usePlayer.getState().retryRemote();
          return;
        }
        if (!isLocalCurrent()) return;
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
        if (isLocalCurrent()) usePlayer.setState({ volume, muted });
      }),
      audioEngine.on("rate", ({ rate }) => {
        if (isLocalCurrent()) usePlayer.setState({ rate });
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
      if (action === "toggle-mini-player") useUi.getState().toggleMiniPlayer();
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
      const entry = currentQueueEntry(state);
      const trackId = currentTrackId(state);
      const track = trackId === null ? null : useLibrary.getState().tracksById.get(trackId) ?? null;
      const queuedItem = currentPlayerMediaItem(state);
      const item = !entry
        ? null
        : entry.item.source.kind === "local"
          ? track
            ? mediaItemFromLocalTrack(track, entry.item.fetchedAt || Date.now())
            : queuedItem
          : queuedItem;
      const source = item?.source ?? null;
      const sourceKey = source ? trackSourceKey(source) : "none";

      // Report discrete state transitions to the desktop bridge without spamming clock ticks.
      const reportKey = `${entry?.occurrenceId ?? "none"}|${sourceKey}|${state.isPlaying}|${state.playbackMechanism}|${state.repeat}|${state.shuffle}|${state.orderPosition}`;
      if (reportKey !== lastReportedKey) {
        lastReportedKey = reportKey;
        void window.cadence?.player?.reportState?.({
          trackId,
          source,
          playbackMechanism: state.playbackMechanism,
          position: state.position,
          duration: state.duration,
          playing: state.isPlaying,
          volume: state.volume,
          muted: state.muted,
          playbackRate: state.rate,
          shuffle: state.shuffle,
          repeat: state.repeat,
          queue: state.queue.map(queueEntry => queueEntry.item.source),
          queueIndex: state.orderPosition,
        });
      }

      if (!("mediaSession" in navigator)) return;

      if (!item) {
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
        const signature = `${sourceKey}\u0000${item.title}\u0000${item.artistLabel}\u0000${item.albumLabel ?? ""}\u0000${item.artworkUrl ?? ""}`;
        if (signature !== lastMetadataSignature && typeof MediaMetadata !== "undefined") {
          lastMetadataSignature = signature;
          navigator.mediaSession.metadata = new MediaMetadata({
            title: item.title,
            artist: item.artistLabel,
            album: item.albumLabel ?? "",
            artwork: item.artworkUrl
              ? [
                  {
                    src: item.artworkUrl,
                    sizes: "512x512",
                    type: inferArtworkMimeType(item.artworkUrl),
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
          if (!usePlayer.getState().isPlaying) dispatchMediaCommand("play-pause", false);
        },
      ],
      [
        "pause",
        () => {
          if (usePlayer.getState().isPlaying) dispatchMediaCommand("play-pause", false);
        },
      ],
      ["stop", () => dispatchMediaCommand("stop", false)],
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

      // The shortcut reference is modal: while it is open, playback shortcuts
      // must not keep firing behind it. Escape and ? both dismiss it.
      if (ui.shortcutsHelpOpen) {
        if (event.key === "Escape" || event.key === "?") {
          event.preventDefault();
          ui.setShortcutsHelpOpen(false);
        }
        return;
      }

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
      if (cmd && event.shiftKey && lower === "p") {
        event.preventDefault();
        ui.toggleMiniPlayer();
        return;
      }
      if (cmd && !event.shiftKey && lower === "l") {
        event.preventDefault();
        const trackId = currentTrackId(player);
        const track = trackId === null ? null : useLibrary.getState().tracksById.get(trackId) ?? null;
        if (track) void useLibrary.getState().setFavorite(track.id, !track.favorite);
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
        case "?":
          event.preventDefault();
          ui.setShortcutsHelpOpen(true);
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
          if (ui.miniPlayer) {
            event.preventDefault();
            ui.setMiniPlayer(false);
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
        audioEngine.applyEqualizer(settings.playback.equalizer);
        const trackId = currentTrackId(player);
        const track = trackId === null ? null : getTrackById(trackId);
        audioEngine.setTrackGain(computeReplayGain(track, settings.playback).linear);
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
      root.dataset.compactSidebarHoverExpand = settings.appearance.compactSidebarHoverExpand ? "true" : "false";
      root.dataset.blurArtwork = settings.appearance.blurArtwork ? "true" : "false";
      applyFontFamily(settings.appearance.fontFamily, root);
      // Enable the sidebar-width transition only after the restored layout has painted, so a
      // saved compact sidebar starts compact instead of visibly shrinking on every launch.
      if (root.dataset.motionReady !== "true") {
        requestAnimationFrame(() => {
          root.dataset.motionReady = "true";
        });
      }
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
      const item = currentPlayerMediaItem(state);
      document.title = item ? `${item.title} · ${item.artistLabel} — Cadence` : "Cadence";
      if (item && state.duration > 0) {
        document.body.dataset.playback = state.isPlaying ? "playing" : "paused";
        document.body.dataset.position = formatTime(state.position);
      }
    });
  }, []);
}
