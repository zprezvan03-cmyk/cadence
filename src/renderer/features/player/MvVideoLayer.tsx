/**
 * Music-video Now Playing background.
 *
 * Built-in Chromium decoding only: a single muted `<video>` follows the audio engine's clock.
 * The audio element remains the sole source of truth — this layer never drives playback, and it
 * corrects the video position only when it drifts or the user seeks.
 */

import { useEffect, useRef, useState } from "react";
import { audioEngine } from "../../audio/engine";

export interface MvVideoLayerProps {
  url: string;
  playing: boolean;
  rate: number;
  scrimOpacity: number;
  songDuration: number;
  onError?: (url: string) => void;
}

const DRIFT_SECONDS = 0.25;
const SYNC_INTERVAL_MS = 250;

function clampOpacity(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.45;
}

export function MvVideoLayer({
  url,
  playing,
  rate,
  scrimOpacity,
  songDuration,
  onError,
}: MvVideoLayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playingRef = useRef(playing);
  const rateRef = useRef(rate);
  const songDurationRef = useRef(songDuration);
  const failedUrlRef = useRef<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === url;

  playingRef.current = playing;
  rateRef.current = rate;
  songDurationRef.current = songDuration;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || failed) return;
    video.muted = true;
    video.volume = 0;
    video.src = url;
    video.load();
    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, failed]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || failed) return;
    video.playbackRate = rate > 0 ? rate : 1;
  }, [rate, failed]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || failed) return;

    const targetTime = (audioTime: number): number => {
      const videoDuration = video.duration;
      if (
        Number.isFinite(videoDuration) &&
        videoDuration > 0 &&
        songDurationRef.current > videoDuration + 0.5
      ) {
        return audioTime % videoDuration;
      }
      return audioTime;
    };

    const correct = (force = false): void => {
      const audio = audioEngine.element;
      if (!audio || !Number.isFinite(audio.currentTime)) return;
      const target = targetTime(audio.currentTime);
      const videoDuration = video.duration;
      const bounded =
        Number.isFinite(videoDuration) && videoDuration > 0
          ? Math.min(target, Math.max(0, videoDuration - 0.02))
          : Math.max(0, target);
      if (force || Math.abs(video.currentTime - bounded) > DRIFT_SECONDS) {
        try {
          video.currentTime = bounded;
        } catch {
          // A video that cannot seek yet will resync on loadedmetadata or the next tick.
        }
      }
    };

    const sync = (force = false): void => {
      const shouldPlay = playingRef.current && document.visibilityState === "visible";
      if (shouldPlay) {
        correct(force);
        void video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    };

    let detachAudio: () => void = () => undefined;
    const bindAudio = (audio: HTMLAudioElement): void => {
      detachAudio();
      const onSeeked = () => correct(true);
      const onPlay = () => {
        playingRef.current = true;
        sync(true);
      };
      const onPause = () => {
        playingRef.current = false;
        video.pause();
      };
      const onEnded = () => video.pause();
      const onRateChange = () => {
        video.playbackRate = rateRef.current > 0 ? rateRef.current : 1;
      };
      audio.addEventListener("seeked", onSeeked);
      audio.addEventListener("play", onPlay);
      audio.addEventListener("pause", onPause);
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("ratechange", onRateChange);
      detachAudio = () => {
        audio.removeEventListener("seeked", onSeeked);
        audio.removeEventListener("play", onPlay);
        audio.removeEventListener("pause", onPause);
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("ratechange", onRateChange);
      };
      correct(true);
    };

    const onLoadedMetadata = () => {
      correct(true);
      sync(true);
    };
    const onVisibility = () => sync(true);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    document.addEventListener("visibilitychange", onVisibility);

    bindAudio(audioEngine.element);
    const unsubSource = audioEngine.on("source", ({ element }) => bindAudio(element));
    const unsubState = audioEngine.on("state", (state) => {
      playingRef.current = state.playing;
      sync(true);
    });
    const unsubTime = audioEngine.on("time", () => {
      if (!video.paused) correct();
    });
    const timer = window.setInterval(() => {
      if (!video.paused) correct();
    }, SYNC_INTERVAL_MS);

    sync(true);

    return () => {
      window.clearInterval(timer);
      unsubTime();
      unsubState();
      unsubSource();
      detachAudio();
      document.removeEventListener("visibilitychange", onVisibility);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.pause();
    };
  }, [url, failed, playing]);

  const handleError = (): void => {
    if (failedUrlRef.current === url) return;
    failedUrlRef.current = url;
    setFailedUrl(url);
    onError?.(url);
  };

  if (failed) return null;

  return (
    <div className="np-bg np-mv-bg" data-testid="mv-video-background" data-mode="mv" aria-hidden="true">
      <video
        ref={videoRef}
        className="np-mv-video"
        muted
        playsInline
        preload="metadata"
        disablePictureInPicture
        tabIndex={-1}
        aria-hidden="true"
        onError={handleError}
      />
      <div className="np-mv-scrim" style={{ opacity: clampOpacity(scrimOpacity) }} />
    </div>
  );
}
