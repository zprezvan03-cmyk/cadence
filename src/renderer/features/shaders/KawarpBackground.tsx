/**
 * Cadence's mount for the Better Lyrics Shaders engine.
 *
 * PORTED FROM UPSTREAM — Better Lyrics Shaders (https://github.com/better-lyrics/shaders,
 * commit d878877cb225e1bcfef205c2937141a26112ebec), `contents/lib/kawarpManager.ts`.
 * The renderer itself is the upstream `@kawarp/core` package used unmodified. This component
 * carries the manager's behaviour into React:
 *   - crossfade queue when the artwork changes mid-transition
 *   - scale and speed easing (0.5/0.12 and 0.05/0.03 lerps, 0.001 thresholds)
 *   - beat multipliers from the ported audio analysis
 *   - auto-dim of bright artwork via the ported luminance measurement
 *   - pause when playback stops, when the window is hidden, or when the user turned it off
 * Changes for Cadence: DOM lookups replaced by props, the extension's IntersectionObserver replaced
 * by the mount being unmounted, and a performance mode that only scales resolution and blur passes.
 */

import { useEffect, useRef, useState } from "react";
import Kawarp from "@kawarp/core";
import type { ShaderSettings } from "../../../shared/types";
import type { DynamicMultipliers } from "../../../shared/upstream/shaders/gradientSettings";
import { audioEngine } from "../../audio/engine";
import { brightnessForHighlight, measureArtworkHighlight } from "../../upstream/shaders/artworkBrightness";

const SCALE_LERP_UP = 0.5;
const SCALE_LERP_DOWN = 0.12;
const SCALE_THRESHOLD = 0.001;
const SPEED_LERP_UP = 0.05;
const SPEED_LERP_DOWN = 0.03;
const SPEED_THRESHOLD = 0.001;
// Matches the cosine blend @kawarp/core uses for image crossfades.
const KAWARP_CROSSFADE_EASING = "cubic-bezier(0.37, 0, 0.63, 1)";
const SETTING_CHANGE_FILTER_TRANSITION_MS = 150;

const PERFORMANCE_DPR: Record<ShaderSettings["performanceMode"], number> = {
  high: 2,
  balanced: 1.5,
  low: 1,
  off: 1,
};

const PERFORMANCE_BLUR_SCALE: Record<ShaderSettings["performanceMode"], number> = {
  high: 1,
  balanced: 0.75,
  low: 0.5,
  off: 0,
};

export interface KawarpBackgroundProps {
  artworkUrl: string | null;
  animatedArtUrl?: string | null;
  settings: ShaderSettings;
  playing: boolean;
  /** Rendered behind the position the artwork changes from. */
  className?: string;
  onError?: (message: string) => void;
}

export function KawarpBackground({
  artworkUrl,
  animatedArtUrl,
  settings,
  playing,
  className,
  onError,
}: KawarpBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<Kawarp | null>(null);
  const stateRef = useRef({
    currentImageUrl: null as string | null,
    pendingImageUrl: null as string | null,
    isTransitioning: false,
    transitionTimeout: null as number | null,
    currentScale: 1,
    targetScale: 1,
    scaleFrame: null as number | null,
    currentSpeed: 1,
    targetSpeed: 1,
    speedFrame: null as number | null,
    paused: false,
    highlightLuminance: null as number | null,
    videoMode: false,
    failed: false,
  });
  const [ready, setReady] = useState(false);
  const multipliersRef = useRef<DynamicMultipliers>({ isBeat: false, speedMultiplier: 1, scaleMultiplier: 1 });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const motionSpeed = (value: ShaderSettings, multipliers: DynamicMultipliers): number =>
    value.kawarpAnimationSpeed * multipliers.speedMultiplier;

  const animateScale = (instance: Kawarp) => {
    const state = stateRef.current;
    const diff = state.targetScale - state.currentScale;
    if (Math.abs(diff) < SCALE_THRESHOLD) {
      state.currentScale = state.targetScale;
      instance.scale = state.currentScale;
      state.scaleFrame = null;
      return;
    }
    state.currentScale += diff * (diff > 0 ? SCALE_LERP_UP : SCALE_LERP_DOWN);
    instance.scale = state.currentScale;
    state.scaleFrame = requestAnimationFrame(() => animateScale(instance));
  };

  const animateSpeed = (instance: Kawarp) => {
    const state = stateRef.current;
    const diff = state.targetSpeed - state.currentSpeed;
    if (Math.abs(diff) < SPEED_THRESHOLD) {
      state.currentSpeed = state.targetSpeed;
      instance.animationSpeed = state.currentSpeed;
      state.speedFrame = null;
      return;
    }
    state.currentSpeed += diff * (diff > 0 ? SPEED_LERP_UP : SPEED_LERP_DOWN);
    instance.animationSpeed = state.currentSpeed;
    state.speedFrame = requestAnimationFrame(() => animateSpeed(instance));
  };

  const applyArtworkBrightness = (transitionMs?: number, hasVideo = false) => {
    const container = containerRef.current;
    const state = stateRef.current;
    const value = settingsRef.current;
    if (!container) return;
    const autoDimStrength = value.autoDimStrength;
    const filterTransitionMs = hasVideo ? value.videoBrightnessTransition : transitionMs ?? value.kawarpTransitionDuration;
    const brightness =
      value.autoDimBrightArtwork && state.highlightLuminance !== null
        ? brightnessForHighlight(state.highlightLuminance, autoDimStrength)
        : 1;
    const isHidden = container.style.opacity === "0";
    container.style.transition = `opacity 0.5s ease-out, filter ${isHidden ? 0 : filterTransitionMs}ms ${KAWARP_CROSSFADE_EASING}`;
    container.style.filter = brightness < 1 ? `brightness(${brightness})` : "";
  };

  const resolveSize = (canvas: HTMLCanvasElement): { width: number; height: number } => {
    const mode = settingsRef.current.performanceMode;
    const ratio = Math.min(window.devicePixelRatio || 1, PERFORMANCE_DPR[mode]);
    const rect = canvas.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round((rect.width || window.innerWidth) * ratio)),
      height: Math.max(1, Math.round((rect.height || window.innerHeight) * ratio)),
    };
  };

  const effectiveBlurPasses = (): number => {
    const value = settingsRef.current;
    const scaled = Math.round(value.kawarpBlurPasses * PERFORMANCE_BLUR_SCALE[value.performanceMode]);
    return Math.max(0, Math.min(40, scaled));
  };

  const applySettings = (instance: Kawarp) => {
    const value = settingsRef.current;
    instance.setOptions({
      warpIntensity: value.kawarpWarpIntensity,
      blurPasses: effectiveBlurPasses(),
      animationSpeed: stateRef.current.paused ? 0 : motionSpeed(value, multipliersRef.current),
      transitionDuration: value.kawarpTransitionDuration,
      saturation: value.kawarpSaturation,
      dithering: value.kawarpDithering,
      scale: stateRef.current.currentScale,
    });
    if (containerRef.current) containerRef.current.style.opacity = String(value.kawarpOpacity);
    applyArtworkBrightness(SETTING_CHANGE_FILTER_TRANSITION_MS, stateRef.current.videoMode);
  };

  // Create the engine once per enabled mount.
  useEffect(() => {
    if (!settings.enabled || settings.performanceMode === "off") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let instance: Kawarp;
    try {
      instance = new Kawarp(canvas, {
        highPrecisionInput: settings.performanceMode !== "low",
        highPrecisionOutput: window.matchMedia("(dynamic-range: high)").matches,
        warpIntensity: settings.kawarpWarpIntensity,
        blurPasses: effectiveBlurPasses(),
        animationSpeed: 0,
        transitionDuration: settings.kawarpTransitionDuration,
        saturation: settings.kawarpSaturation,
        dithering: settings.kawarpDithering,
        scale: 1,
      });
    } catch (error) {
      console.error("[Cadence] Kawarp could not start, falling back to the CSS background:", error);
      onError?.("Shader engine unavailable — using the static artwork background");
      setReady(false);
      return;
    }

    instanceRef.current = instance;
    stateRef.current.failed = false;

    const resize = () => {
      const { width, height } = resolveSize(canvas);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        instance.resize();
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener("resize", resize);

    instance.start();
    setReady(true);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      const state = stateRef.current;
      if (state.transitionTimeout !== null) clearTimeout(state.transitionTimeout);
      if (state.scaleFrame !== null) cancelAnimationFrame(state.scaleFrame);
      if (state.speedFrame !== null) cancelAnimationFrame(state.speedFrame);
      instance.dispose();
      instanceRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.enabled, settings.performanceMode]);

  // Keep engine options in sync with the settings panel.
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    applySettings(instance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Artwork transitions, including the queue used while a crossfade is in flight.
  useEffect(() => {
    const instance = instanceRef.current;
    const state = stateRef.current;
    if (!instance) return;

    const load = async (url: string) => {
      state.isTransitioning = true;
      try {
        instance.transitionDuration = settingsRef.current.kawarpTransitionDuration;
        const [, luminance] = await Promise.all([instance.loadImage(url), measureArtworkHighlight(url)]);
        state.highlightLuminance = luminance;
        state.currentImageUrl = url;
        applyArtworkBrightness(undefined, state.videoMode);
      } catch (error) {
        console.warn("[Cadence] Could not load artwork into the shader:", error);
      }
      state.transitionTimeout = window.setTimeout(() => {
        state.isTransitioning = false;
        state.transitionTimeout = null;
        const pending = state.pendingImageUrl;
        state.pendingImageUrl = null;
        if (pending && pending !== state.currentImageUrl) void start(pending);
      }, settingsRef.current.kawarpTransitionDuration);
    };

    const start = async (url: string) => {
      if (state.isTransitioning) {
        state.pendingImageUrl = url;
        return;
      }
      await load(url);
    };

    const useVideo = Boolean(animatedArtUrl && settings.enableAnimatedArt);
    if (useVideo && animatedArtUrl) {
      const video = document.createElement("video");
      video.src = animatedArtUrl;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.style.display = "none";
      document.body.appendChild(video);
      const playPromise = video.play().catch(() => undefined);
      try {
        if (typeof video.requestVideoFrameCallback === "function") {
          instance.loadVideo(video, {
            sampleWidth: settings.videoSampleWidth,
            sampleHeight: settings.videoSampleHeight,
            downsampleFactor: settings.videoDownsampleFactor,
            frameRate: settings.videoFrameRate,
            smoothing: settings.videoColorResponse,
            onError: error => console.warn("[Cadence] Animated artwork frame failed:", error),
          });
          state.videoMode = true;
        }
      } catch (error) {
        console.warn("[Cadence] Animated artwork unavailable:", error);
        state.videoMode = false;
      }
      void playPromise;
      return () => {
        try {
          instance.unloadVideo();
        } catch {
          /* already unloaded */
        }
        state.videoMode = false;
        video.pause();
        video.remove();
      };
    }

    if (artworkUrl && artworkUrl !== state.currentImageUrl) void start(artworkUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artworkUrl, animatedArtUrl, settings.enableAnimatedArt]);

  // Beat multipliers from the ported audio analysis.
  useEffect(() => {
    if (!settings.enabled || !settings.audioResponsive) return;
    return audioEngine.subscribeBeat(multipliers => {
      const instance = instanceRef.current;
      const state = stateRef.current;
      multipliersRef.current = multipliers;
      if (!instance) return;
      const value = settingsRef.current;
      const beatChanged = state.targetSpeed !== (state.paused ? 0 : motionSpeed(value, multipliers));
      const scaleChanged = Math.abs(state.targetScale - (multipliers.isBeat ? 1 + value.kawarpAudioScaleBoost / 100 : 1)) > 0.0001;
      if (beatChanged || scaleChanged) {
        state.targetSpeed = state.paused ? 0 : motionSpeed(value, multipliers);
        state.targetScale = 1 + (multipliers.isBeat ? value.kawarpAudioScaleBoost / 100 : 0);
        if (state.speedFrame === null && !state.paused) state.speedFrame = requestAnimationFrame(() => animateSpeed(instance));
        if (state.scaleFrame === null) state.scaleFrame = requestAnimationFrame(() => animateScale(instance));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.enabled, settings.audioResponsive, settings.kawarpAnimationSpeed, settings.kawarpAudioScaleBoost]);

  // Pause / resume: playback state, window visibility, and the user's pause setting.
  useEffect(() => {
    const instance = instanceRef.current;
    const state = stateRef.current;
    if (!instance) return;

    const shouldPause = () => {
      if (settingsRef.current.performanceMode === "off") return true;
      if (document.hidden) return true;
      return settingsRef.current.pauseOnInactive && !playing;
    };

    state.paused = shouldPause();
    const value = settingsRef.current;
    state.targetSpeed = state.paused ? 0 : motionSpeed(value, multipliersRef.current);
    if (!state.paused) instance.start();
    if (state.speedFrame === null) state.speedFrame = requestAnimationFrame(() => animateSpeed(instance));

    const onVisibility = () => {
      state.paused = shouldPause();
      state.targetSpeed = state.paused ? 0 : motionSpeed(settingsRef.current, multipliersRef.current);
      if (state.speedFrame === null) state.speedFrame = requestAnimationFrame(() => animateSpeed(instance));
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, settings.pauseOnInactive, settings.enabled, settings.performanceMode]);

  const disabled = !settings.enabled || settings.performanceMode === "off";

  return (
    <div className={className ? `kawarp-bg ${className}` : "kawarp-bg"} aria-hidden="true">
      {disabled ? (
        <div
          className="kawarp-fallback"
          style={
            artworkUrl
              ? {
                  backgroundImage: `url("${artworkUrl}")`,
                }
              : undefined
          }
        />
      ) : (
        <>
          <canvas ref={canvasRef} className="kawarp-canvas" data-testid="kawarp-canvas" />
          {!ready && artworkUrl ? (
            <div className="kawarp-fallback" style={{ backgroundImage: `url("${artworkUrl}")` }} />
          ) : null}
        </>
      )}
      <div className="kawarp-scrim" />
    </div>
  );
}
