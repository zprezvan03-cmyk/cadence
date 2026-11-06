/**
 * Profile-selected Now Playing backgrounds.
 *
 * "fluid" is the existing Kawarp shader, unchanged. The other modes are deliberately
 * cheap: two are plain CSS layers, and the two canvas effects (particles, visualizer)
 * exist only while selected, animate only while playing and visible, honor
 * reduced-motion with a single static frame, and cap their resolution at 1.5× DPR.
 * When the profile changes away from a canvas mode the component unmounts and its
 * animation frame and listeners go with it. Written for Cadence.
 */

import { useEffect, useRef } from "react";
import type { NowPlayingBackgroundMode, ShaderSettings } from "../../../shared/types";
import { audioEngine } from "../../audio/engine";
import { KawarpBackground } from "../shaders/KawarpBackground";

export interface NowPlayingBackgroundProps {
  mode: NowPlayingBackgroundMode;
  artworkUrl: string | null;
  animatedArtUrl?: string | null;
  shaderSettings: ShaderSettings;
  playing: boolean;
  verbose?: boolean;
  intensity: number;
  blurPx: number;
  speed: number;
  density: number;
  /** Dominant artwork colour when the library computed one. */
  accentColor?: string | null;
  /** App accent, used when the track has no artwork colour. */
  fallbackAccent: string;
}

function safeAccent(value: string | null | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function NowPlayingBackground({
  mode,
  artworkUrl,
  animatedArtUrl,
  shaderSettings,
  playing,
  verbose,
  intensity,
  blurPx,
  speed,
  density,
  accentColor,
  fallbackAccent,
}: NowPlayingBackgroundProps) {
  const accent = safeAccent(accentColor, safeAccent(fallbackAccent, "#ff3d71"));

  if (mode === "fluid") {
    return (
      <KawarpBackground
        artworkUrl={artworkUrl}
        animatedArtUrl={animatedArtUrl}
        settings={{
          ...shaderSettings,
          kawarpOpacity: Math.min(1, Math.max(0, shaderSettings.kawarpOpacity * intensity)),
        }}
        playing={playing}
        verbose={verbose}
      />
    );
  }

  return (
    <div className="np-bg" data-testid="now-playing-background" data-mode={mode} aria-hidden="true">
      {mode === "solid" ? <div className="np-bg-fill np-bg-solid" /> : null}
      {mode === "gradient" ? (
        <div
          className="np-bg-fill"
          style={{
            background: `linear-gradient(160deg, ${accent} 0%, #0a0a12 68%, #05050a 100%)`,
            opacity: intensity,
          }}
        />
      ) : null}
      {mode === "blurred-artwork" ? (
        artworkUrl ? (
          <div
            className="np-bg-fill np-bg-blurred"
            style={{
              backgroundImage: `url("${artworkUrl.replace(/"/g, "%22")}")`,
              filter: `blur(${blurPx}px) saturate(1.25) brightness(0.75)`,
              opacity: intensity,
            }}
          />
        ) : (
          <div
            className="np-bg-fill"
            style={{
              background: `radial-gradient(120% 90% at 30% 20%, ${accent} 0%, #07070c 70%)`,
              opacity: intensity,
            }}
          />
        )
      ) : null}
      {mode === "particles" || mode === "visualizer" ? (
        <EffectCanvas
          kind={mode}
          playing={playing}
          speed={speed}
          density={density}
          intensity={intensity}
          accent={accent}
        />
      ) : null}
      <div className="kawarp-scrim" />
    </div>
  );
}

interface Particle {
  x: number;
  y: number;
  radius: number;
  speed: number;
  phase: number;
  alpha: number;
}

function EffectCanvas({
  kind,
  playing,
  speed,
  density,
  intensity,
  accent,
}: {
  kind: "particles" | "visualizer";
  playing: boolean;
  speed: number;
  density: number;
  intensity: number;
  accent: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let frequencyData: Uint8Array<ArrayBuffer> | null = null;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(90 * density);
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: 0.6 + Math.random() * 1.8,
        speed: 0.15 + Math.random() * 0.55,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.25 + Math.random() * 0.55,
      }));
    };

    const paintBackdrop = () => {
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "#0a0a14");
      gradient.addColorStop(1, "#05050a");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
      // Accent glow as a radial gradient that reaches full transparency at its
      // edge; a solid-filled ellipse left a visible hard outline over the scrim.
      const alphaHex = Math.round(Math.min(1, 0.16 * intensity) * 255)
        .toString(16)
        .padStart(2, "0");
      const glow = context.createRadialGradient(
        width * 0.3,
        height * 0.25,
        0,
        width * 0.3,
        height * 0.25,
        Math.max(width, height) * 0.65
      );
      glow.addColorStop(0, `${accent}${alphaHex}`);
      glow.addColorStop(1, `${accent}00`);
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);
    };

    const drawParticles = (time: number, advance: boolean) => {
      paintBackdrop();
      context.fillStyle = "#ffffff";
      for (const particle of particles) {
        if (advance) {
          particle.y -= particle.speed * speed;
          particle.x += Math.sin(time / 1600 + particle.phase) * 0.25 * speed;
          if (particle.y < -4) {
            particle.y = height + 4;
            particle.x = Math.random() * width;
          }
          if (particle.x < -4) particle.x = width + 4;
          if (particle.x > width + 4) particle.x = -4;
        }
        context.globalAlpha = particle.alpha * intensity;
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const drawVisualizer = (time: number) => {
      paintBackdrop();
      const analyser = audioEngine.getAnalyser();
      const barCount = Math.round(28 + 36 * density);
      const gap = 3;
      const barWidth = Math.max(2, width / barCount - gap);
      if (analyser) {
        if (!frequencyData || frequencyData.length !== analyser.frequencyBinCount) {
          frequencyData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        }
        analyser.getByteFrequencyData(frequencyData);
      }
      context.fillStyle = accent;
      for (let index = 0; index < barCount; index += 1) {
        let level: number;
        if (analyser && frequencyData) {
          const bin = Math.floor(Math.pow(index / barCount, 1.6) * frequencyData.length * 0.72);
          level = (frequencyData[bin] ?? 0) / 255;
        } else {
          level = 0.18 + 0.14 * Math.sin(time / 700 + index * 0.55);
        }
        const barHeight = Math.max(3, level * height * 0.55 * intensity);
        context.globalAlpha = 0.35 + 0.6 * level;
        context.fillRect(
          index * (barWidth + gap),
          height - barHeight,
          barWidth,
          barHeight
        );
      }
      context.globalAlpha = 1;
    };

    const draw = (time: number, advance: boolean) => {
      if (kind === "particles") drawParticles(time, advance);
      else drawVisualizer(time);
    };

    const loop = (time: number) => {
      draw(time, true);
      frame = window.requestAnimationFrame(loop);
    };

    const start = () => {
      cancel();
      if (reducedMotion || !playing || document.hidden) {
        draw(performance.now(), false);
        return;
      }
      frame = window.requestAnimationFrame(loop);
    };
    const cancel = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibility = () => start();
    const onResize = () => {
      resize();
      if (!frame) draw(performance.now(), false);
    };

    resize();
    start();
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancel();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [kind, playing, speed, density, intensity, accent]);

  return <canvas ref={canvasRef} className="np-bg-canvas" />;
}
