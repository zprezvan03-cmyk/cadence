/**
 * Official YouTube IFrame Player wrapper for Cadence's isolated remote-playback prototype.
 *
 * The YouTube iframe is the playback engine. This file never asks it for a media URL and never
 * routes its audio through Cadence's local engine: it only uses the documented player controls
 * (`cueVideoById`, `playVideo`, `pauseVideo`, `seekTo`, `setVolume`, `getCurrentTime`, …) and
 * samples the player's own clock for the lyrics adapter.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  normalizeRemotePlaybackClock,
  type RemotePlaybackClockSource,
} from "../../player/playbackClock";
import {
  YOUTUBE_PLAYER_SIZES,
  mapYouTubePlayerError,
  resolveYouTubePlayerOrigin,
  youtubePlayerStateName,
  type YouTubePlayerErrorInfo,
  type YouTubePlayerMetadata,
  type YouTubePlayerSizeMode,
  type YouTubePlayerSnapshot,
} from "./youtubePlayerUtils";

export {
  YOUTUBE_PLAYER_SIZES,
  mapYouTubePlayerError,
  resolveYouTubePlayerOrigin,
  youtubePlayerStateName,
};
export type {
  YouTubePlayerErrorInfo,
  YouTubePlayerMetadata,
  YouTubePlayerSizeMode,
  YouTubePlayerSnapshot,
  YouTubePlayerStateName,
} from "./youtubePlayerUtils";

export interface YouTubePlayerHandle {
  play: () => boolean;
  pause: () => void;
  toggle: () => boolean;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  getSnapshot: () => YouTubePlayerSnapshot | null;
}

export interface YouTubeIframePlayerProps {
  videoId: string | null;
  sizeMode: YouTubePlayerSizeMode;
  clockSource: RemotePlaybackClockSource;
  initialVolume?: number;
  onReady?: (snapshot: YouTubePlayerSnapshot) => void;
  onSnapshot?: (snapshot: YouTubePlayerSnapshot) => void;
  onMetadata?: (metadata: YouTubePlayerMetadata) => void;
  onError?: (error: YouTubePlayerErrorInfo) => void;
  onEnded?: (snapshot: YouTubePlayerSnapshot) => void;
  onVisibilityChange?: (ratio: number) => void;
}

interface YTVideoData {
  video_id?: unknown;
  title?: unknown;
  author?: unknown;
}

interface YTPlayer {
  cueVideoById: (videoId: string, startSeconds?: number) => void;
  loadVideoById: (videoId: string, startSeconds?: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setVolume: (volume: number) => void;
  getVolume: () => number;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  setPlaybackRate: (rate: number) => void;
  getPlaybackRate: () => number;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  getVideoData?: () => YTVideoData;
  getIframe?: () => HTMLIFrameElement;
  setSize: (width: number, height: number) => void;
  destroy: () => void;
}

interface YTPlayerEvent {
  target: YTPlayer;
  data?: unknown;
}

interface YTNamespace {
  Player: new (
    element: HTMLElement | string,
    options: {
      width: number;
      height: number;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: YTPlayerEvent) => void;
        onStateChange?: (event: YTPlayerEvent) => void;
        onPlaybackRateChange?: (event: YTPlayerEvent) => void;
        onError?: (event: YTPlayerEvent) => void;
      };
    }
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YOUTUBE_IFRAME_API_SRC = "https://www.youtube.com/iframe_api";
const YOUTUBE_NOCOOKIE_HOST = "https://www.youtube-nocookie.com";
const CLOCK_POLL_MS = 250;
const MIN_VISIBLE_RATIO_FOR_SCRIPTED_PLAYBACK = 0.5;

let iframeApiPromise: Promise<YTNamespace> | null = null;

function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (iframeApiPromise) return iframeApiPromise;

  iframeApiPromise = new Promise<YTNamespace>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      callback();
    };
    const timeout = window.setTimeout(() => {
      finish(() => {
        iframeApiPromise = null;
        reject(new Error("Timed out while loading the official YouTube IFrame API."));
      });
    }, 15_000);

    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      finish(() => {
        if (window.YT?.Player) resolve(window.YT);
        else {
          iframeApiPromise = null;
          reject(new Error("The YouTube IFrame API loaded without a Player constructor."));
        }
      });
    };

    let script = document.querySelector<HTMLScriptElement>('script[data-cadence-youtube-iframe-api="true"]');
    if (!script) {
      script = document.createElement("script");
      script.src = YOUTUBE_IFRAME_API_SRC;
      script.async = true;
      script.dataset.cadenceYoutubeIframeApi = "true";
      script.addEventListener("error", () => {
        finish(() => {
          iframeApiPromise = null;
          reject(new Error("Could not load the official YouTube IFrame API."));
        });
      });
      const firstScript = document.getElementsByTagName("script")[0];
      if (firstScript?.parentNode) firstScript.parentNode.insertBefore(script, firstScript);
      else document.head.appendChild(script);
    }
  });

  return iframeApiPromise;
}

function safeNumber(call: () => number, fallback = 0): number {
  try {
    const value = call();
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function safeBoolean(call: () => boolean, fallback = false): boolean {
  try {
    return Boolean(call());
  } catch {
    return fallback;
  }
}

function cleanMetadataText(value: unknown, maxLength = 300): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export const YouTubeIframePlayer = forwardRef<YouTubePlayerHandle, YouTubeIframePlayerProps>(
  function YouTubeIframePlayer(
    {
      videoId,
      sizeMode,
      clockSource,
      initialVolume = 0.85,
      onReady,
      onSnapshot,
      onMetadata,
      onError,
      onEnded,
      onVisibilityChange,
    },
    ref
  ) {
    const shellRef = useRef<HTMLDivElement | null>(null);
    const playerRef = useRef<YTPlayer | null>(null);
    const readyRef = useRef(false);
    const fatalRef = useRef(false);
    const requestedVideoIdRef = useRef<string | null>(videoId);
    const cuedVideoIdRef = useRef<string | null>(null);
    const stateCodeRef = useRef(-1);
    const visibilityRatioRef = useRef(0);
    const pollTimerRef = useRef<number | undefined>(undefined);
    const metadataRef = useRef<YouTubePlayerMetadata | null>(null);
    const callbacksRef = useRef({ onReady, onSnapshot, onMetadata, onError, onEnded, onVisibilityChange });
    callbacksRef.current = { onReady, onSnapshot, onMetadata, onError, onEnded, onVisibilityChange };

    const size = YOUTUBE_PLAYER_SIZES[sizeMode];

    const stopPolling = () => {
      if (pollTimerRef.current !== undefined) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = undefined;
      }
    };

    const readMetadata = (player: YTPlayer): YouTubePlayerMetadata | null => {
      if (typeof player.getVideoData !== "function") return null;
      try {
        const data = player.getVideoData();
        const dataVideoId = cleanMetadataText(data.video_id, 32);
        const expectedVideoId = requestedVideoIdRef.current;
        if (!dataVideoId || (expectedVideoId && dataVideoId !== expectedVideoId)) return null;
        const title = cleanMetadataText(data.title);
        const author = cleanMetadataText(data.author);
        if (!title && !author) return null;
        return {
          videoId: dataVideoId,
          title: title || "Untitled YouTube video",
          author,
        };
      } catch {
        return null;
      }
    };

    const sample = (override?: Partial<YouTubePlayerSnapshot>): YouTubePlayerSnapshot | null => {
      const player = playerRef.current;
      if (!player || !readyRef.current) return null;

      const stateCode = override?.stateCode ?? safeNumber(() => player.getPlayerState(), stateCodeRef.current);
      stateCodeRef.current = stateCode;
      const duration = safeNumber(() => player.getDuration(), 0);
      const currentTime = override?.currentTime ?? safeNumber(() => player.getCurrentTime(), 0);
      const snapshot: YouTubePlayerSnapshot = {
        ...normalizeRemotePlaybackClock({
          currentTime,
          duration,
          isPlaying: stateCode === 1,
          playbackRate: safeNumber(() => player.getPlaybackRate(), 1),
          sampledAt: Date.now(),
        }),
        state: youtubePlayerStateName(stateCode),
        stateCode,
        volume: Math.min(1, Math.max(0, safeNumber(() => player.getVolume(), initialVolume * 100) / 100)),
        muted: safeBoolean(() => player.isMuted(), false),
      };

      clockSource.setSnapshot(snapshot);
      callbacksRef.current.onSnapshot?.(snapshot);

      const metadata = readMetadata(player);
      if (metadata) {
        const previous = metadataRef.current;
        if (
          previous?.videoId !== metadata.videoId ||
          previous.title !== metadata.title ||
          previous.author !== metadata.author
        ) {
          metadataRef.current = metadata;
          callbacksRef.current.onMetadata?.(metadata);
        }
      }
      return snapshot;
    };

    const startPolling = () => {
      if (pollTimerRef.current !== undefined) return;
      pollTimerRef.current = window.setInterval(() => {
        if (stateCodeRef.current !== 1) {
          stopPolling();
          return;
        }
        sample();
      }, CLOCK_POLL_MS);
    };

    const cueRequestedVideo = () => {
      const player = playerRef.current;
      const requestedVideoId = requestedVideoIdRef.current;
      if (!player || !readyRef.current || !requestedVideoId || fatalRef.current) return false;
      if (cuedVideoIdRef.current === requestedVideoId) return true;
      // Scripted cue/play calls wait until at least half of the official player is on screen.
      if (visibilityRatioRef.current < MIN_VISIBLE_RATIO_FOR_SCRIPTED_PLAYBACK) return false;
      try {
        stopPolling();
        stateCodeRef.current = -1;
        metadataRef.current = null;
        clockSource.reset();
        player.cueVideoById(requestedVideoId, 0);
        cuedVideoIdRef.current = requestedVideoId;
        window.setTimeout(() => sample(), 0);
        return true;
      } catch (error) {
        callbacksRef.current.onError?.({
          code: null,
          kind: "player",
          message: `Could not cue this video: ${(error as Error).message || "unknown player error"}`,
        });
        return false;
      }
    };

    useImperativeHandle(ref, () => ({
      play: () => {
        const player = playerRef.current;
        if (!player || !readyRef.current || fatalRef.current) return false;
        if (visibilityRatioRef.current < MIN_VISIBLE_RATIO_FOR_SCRIPTED_PLAYBACK) return false;
        if (!cueRequestedVideo()) return false;
        try {
          player.playVideo();
          window.setTimeout(() => sample(), 0);
          return true;
        } catch {
          return false;
        }
      },
      pause: () => {
        try {
          playerRef.current?.pauseVideo();
        } catch {
          /* The player may already be destroyed during route cleanup. */
        }
        stopPolling();
        sample({ stateCode: stateCodeRef.current === 1 ? 2 : stateCodeRef.current });
      },
      toggle: () => {
        if (stateCodeRef.current === 1) {
          try {
            playerRef.current?.pauseVideo();
          } catch {
            return false;
          }
          stopPolling();
          sample({ stateCode: 2 });
          return true;
        }
        const player = playerRef.current;
        if (!player || !readyRef.current || fatalRef.current) return false;
        if (visibilityRatioRef.current < MIN_VISIBLE_RATIO_FOR_SCRIPTED_PLAYBACK) return false;
        if (!cueRequestedVideo()) return false;
        try {
          player.playVideo();
          window.setTimeout(() => sample(), 0);
          return true;
        } catch {
          return false;
        }
      },
      seekTo: (seconds, allowSeekAhead = true) => {
        const player = playerRef.current;
        if (!player || !readyRef.current || !Number.isFinite(seconds)) return;
        const target = Math.max(0, seconds);
        try {
          player.seekTo(target, allowSeekAhead);
          // The iframe's own clock can lag a seek by one poll; publish the requested position
          // immediately so timed lyrics move with the user's seek, then let later samples correct it.
          sample({ currentTime: target });
        } catch {
          /* A destroyed/unready player has no seek target. */
        }
      },
      setVolume: volume => {
        const player = playerRef.current;
        if (!player || !readyRef.current || !Number.isFinite(volume)) return;
        const clamped = Math.min(1, Math.max(0, volume));
        try {
          if (clamped > 0) player.unMute();
          player.setVolume(Math.round(clamped * 100));
          sample();
        } catch {
          /* Ignore a player that disappeared while the control was being used. */
        }
      },
      setMuted: muted => {
        try {
          if (muted) playerRef.current?.mute();
          else playerRef.current?.unMute();
          sample();
        } catch {
          /* See setVolume. */
        }
      },
      setPlaybackRate: rate => {
        if (!Number.isFinite(rate) || rate <= 0) return;
        try {
          playerRef.current?.setPlaybackRate(rate);
          sample();
        } catch {
          /* See setVolume. */
        }
      },
      getSnapshot: () => sample(),
    }));

    useEffect(() => {
      requestedVideoIdRef.current = videoId;
      if (!videoId) {
        cuedVideoIdRef.current = null;
        metadataRef.current = null;
        clockSource.reset();
        return;
      }
      if (cuedVideoIdRef.current !== videoId) {
        fatalRef.current = false;
        metadataRef.current = null;
        cueRequestedVideo();
      }
    }, [clockSource, videoId]);

    useEffect(() => {
      const player = playerRef.current;
      if (!player || !readyRef.current) return;
      try {
        player.setSize(size.width, size.height);
      } catch {
        /* The shell still has the requested CSS size if the player is mid-cleanup. */
      }
    }, [size.height, size.width]);

    useEffect(() => {
      const shell = shellRef.current;
      if (!shell || typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver(
        entries => {
          const entry = entries[entries.length - 1];
          if (!entry) return;
          const ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
          visibilityRatioRef.current = ratio;
          callbacksRef.current.onVisibilityChange?.(ratio);
          if (ratio >= MIN_VISIBLE_RATIO_FOR_SCRIPTED_PLAYBACK) cueRequestedVideo();
        },
        { threshold: [0, MIN_VISIBLE_RATIO_FOR_SCRIPTED_PLAYBACK, 1] }
      );
      observer.observe(shell);
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      const shell = shellRef.current;
      if (!shell) return;
      let cancelled = false;

      void loadYouTubeIframeApi()
        .then(YT => {
          if (cancelled || !shell.isConnected) return;
          shell.innerHTML = "";
          const mount = document.createElement("div");
          mount.dataset.cadenceYoutubeMount = "true";
          shell.appendChild(mount);

          const origin = resolveYouTubePlayerOrigin();
          const player = new YT.Player(mount, {
            width: YOUTUBE_PLAYER_SIZES[sizeMode].width,
            height: YOUTUBE_PLAYER_SIZES[sizeMode].height,
            host: YOUTUBE_NOCOOKIE_HOST,
            playerVars: {
              autoplay: 0,
              controls: 1,
              enablejsapi: 1,
              playsinline: 1,
              rel: 0,
              ...(origin ? { origin } : {}),
              widget_referrer: window.location.href.split("#")[0],
            },
            events: {
              onReady: event => {
                if (cancelled) return;
                playerRef.current = event.target;
                readyRef.current = true;
                try {
                  const iframe = event.target.getIframe?.();
                  iframe?.setAttribute("title", "Official YouTube video player");
                  iframe?.setAttribute("data-testid", "youtube-iframe");
                  event.target.setVolume(Math.round(Math.min(1, Math.max(0, initialVolume)) * 100));
                  event.target.setSize(size.width, size.height);
                } catch {
                  /* Volume/size are conveniences; readiness itself has already succeeded. */
                }
                cueRequestedVideo();
                const snapshot = sample();
                if (snapshot) callbacksRef.current.onReady?.(snapshot);
              },
              onStateChange: event => {
                if (cancelled) return;
                const stateCode = typeof event.data === "number" ? event.data : safeNumber(() => event.target.getPlayerState(), -1);
                stateCodeRef.current = stateCode;
                if (stateCode === 1) startPolling();
                else stopPolling();
                const snapshot = sample({ stateCode });
                if (stateCode === 0 && snapshot) callbacksRef.current.onEnded?.(snapshot);
              },
              onPlaybackRateChange: () => {
                if (cancelled) return;
                sample();
                if (stateCodeRef.current === 1) startPolling();
              },
              onError: event => {
                if (cancelled) return;
                fatalRef.current = true;
                stopPolling();
                const code = typeof event.data === "number" ? event.data : null;
                const info = mapYouTubePlayerError(code);
                clockSource.setSnapshot({
                  ...clockSource.getSnapshot(),
                  isPlaying: false,
                  sampledAt: Date.now(),
                });
                callbacksRef.current.onError?.(info);
              },
            },
          });
          playerRef.current = player;
        })
        .catch(error => {
          if (cancelled) return;
          callbacksRef.current.onError?.({
            code: null,
            kind: "api-load",
            message: (error as Error).message || "Could not load the official YouTube IFrame API.",
          });
        });

      return () => {
        cancelled = true;
        stopPolling();
        const player = playerRef.current;
        playerRef.current = null;
        readyRef.current = false;
        cuedVideoIdRef.current = null;
        stateCodeRef.current = -1;
        clockSource.setSnapshot({
          ...clockSource.getSnapshot(),
          isPlaying: false,
          sampledAt: Date.now(),
        });
        try {
          player?.pauseVideo();
        } catch {
          /* Destroy below is the authoritative cleanup. */
        }
        try {
          player?.destroy();
        } catch {
          /* The API may already have removed its iframe during an error. */
        }
        shell.innerHTML = "";
      };
      // The player is intentionally created once for this mount; later size/video changes use the
      // documented setSize/cue methods above instead of rebuilding the iframe.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div
        ref={shellRef}
        className="youtube-player-shell"
        style={{ width: size.width, height: size.height }}
        data-testid="youtube-player-shell"
        data-player-width={size.width}
        data-player-height={size.height}
        aria-label="Official YouTube player"
      />
    );
  }
);
