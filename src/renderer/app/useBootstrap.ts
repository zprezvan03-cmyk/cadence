/**
 * Application bootstrap: loads settings and library, wires the audio engine to the player store,
 * restores the last session, and installs keyboard, media-key and OS media-session integration.
 * Written for Cadence.
 */

import { useEffect } from "react";
import { audioEngine } from "../audio/engine";
import { useLibrary } from "../state/libraryStore";
import { readSession, usePlayer, currentTrackId } from "../state/playerStore";
import { useSettings } from "../state/settingsStore";
import { useUi } from "../state/uiStore";
import { formatTime } from "../player/queue";
import { explainPlaybackFailure } from "../audio/codecs";

const SEEK_STEP = 5;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function useBootstrap(): void {
  useEffect(() => {
    let disposed = false;

    void (async () => {
      await useSettings.getState().load();
      await useLibrary.getState().refresh();
      if (disposed) return;

      const settings = useSettings.getState().settings;
      if (!settings) return;

      const player = usePlayer.getState();
      player.setVolume(settings.playback.volume);
      player.setMuted(settings.playback.muted);
      player.setRate(settings.playback.playbackRate);
      player.setRepeat(settings.playback.repeat);
      if (settings.playback.shuffle !== player.shuffle) player.toggleShuffle();

      if (settings.playback.resumeOnLaunch) {
        const session = readSession();
        if (session) {
          // Drop queue entries whose files no longer exist in the library.
          const available = useLibrary.getState().tracksById;
          const queue = session.queue.filter(id => available.has(id));
          if (queue.length > 0) {
            await usePlayer.getState().restore({ ...session, queue });
          }
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
      audioEngine.on("error", ({ message, code }) => {
        // Turn a bare media error code into something the listener can act on.
        const trackId = currentTrackId(usePlayer.getState());
        const track = trackId === null ? null : useLibrary.getState().tracksById.get(trackId) ?? null;
        const explanation = explainPlaybackFailure(code, track);
        const text = code ? explanation : message;
        usePlayer.getState().setError(text);
        useUi.getState().showToast(text);
        console.error("[Cadence] Playback error:", message, "code:", code, "track:", track?.title);
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

    const commandListener = window.cadence?.player?.onCommand?.(command => {
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
    });

    const menuListener = (
      window.cadence as unknown as { onMenuAction?: (listener: (action: string) => void) => () => void }
    )?.onMenuAction?.(action => {
      if (action === "add-folder") void useLibrary.getState().addFolder();
      if (action === "rescan") void useLibrary.getState().rescan();
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

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const player = usePlayer.getState();
      const ui = useUi.getState();
      const cmd = event.ctrlKey || event.metaKey;

      if (cmd && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("global-search")?.focus();
        return;
      }

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
          ui.toggleNowPlaying();
          break;
        case "f":
        case "F":
          ui.setFullscreenLyrics(!ui.fullscreenLyrics);
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
          if (ui.fullscreenLyrics) ui.setFullscreenLyrics(false);
          if (ui.nowPlayingOpen) ui.toggleNowPlaying(false);
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
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Visual settings that live on the document root.
  useEffect(() => {
    return useSettings.subscribe(state => {
      const settings = state.settings;
      if (!settings) return;
      const root = document.documentElement;
      root.style.setProperty("--accent", settings.appearance.accent);
      root.dataset.reduceMotion = settings.appearance.reduceMotion ? "true" : "false";
      root.dataset.compactSidebar = settings.appearance.compactSidebar ? "true" : "false";
      root.dataset.blurArtwork = settings.appearance.blurArtwork ? "true" : "false";
    });
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
    const unsubscribePlayer = usePlayer.subscribe(apply);
    const unsubscribeSettings = useSettings.subscribe(apply);
    return () => {
      unsubscribePlayer();
      unsubscribeSettings();
    };
  }, []);

  // OS media session + document title.
  useEffect(() => {
    const updateMediaSession = () => {
      if (!("mediaSession" in navigator)) return;
      const trackId = currentTrackId(usePlayer.getState());
      const track = trackId === null ? null : useLibrary.getState().tracksById.get(trackId);
      if (!track) return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: track.album,
          artwork: track.artworkUrl ? [{ src: track.artworkUrl, sizes: "512x512", type: "image/jpeg" }] : [],
        });
        navigator.mediaSession.playbackState = usePlayer.getState().isPlaying ? "playing" : "paused";
        const { position, duration, rate } = usePlayer.getState();
        if (duration > 0) {
          navigator.mediaSession.setPositionState({
            duration,
            position: Math.min(position, duration),
            playbackRate: rate,
          });
        }
      } catch {
        /* media session is best-effort */
      }
    };

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => void usePlayer.getState().toggle()],
      ["pause", () => void usePlayer.getState().toggle()],
      ["previoustrack", () => usePlayer.getState().previous()],
      ["nexttrack", () => void usePlayer.getState().next(false)],
      ["seekbackward", () => usePlayer.getState().seekBy(-SEEK_STEP)],
      ["seekforward", () => usePlayer.getState().seekBy(SEEK_STEP)],
      ["seekto", details => {
        if (typeof details.seekTime === "number") usePlayer.getState().seek(details.seekTime);
      }],
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

    const unsubscribePlayer = usePlayer.subscribe(updateMediaSession);
    const unsubscribeLibrary = useLibrary.subscribe(updateMediaSession);
    updateMediaSession();

    return () => {
      unsubscribePlayer();
      unsubscribeLibrary();
      if ("mediaSession" in navigator) {
        for (const [action] of handlers) {
          try {
            navigator.mediaSession.setActionHandler(action, null);
          } catch {
            /* ignore */
          }
        }
      }
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
