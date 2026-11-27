/**
 * The application-wide shader background. Written for Cadence.
 *
 * Better Lyrics' shader is scoped to the player page; this surface carries the same Kawarp mount
 * behind the whole application — library, settings, and Now Playing alike — as one fixed layer under
 * every piece of UI. It is a sibling of the routes, not part of them, so navigating never mounts or
 * unmounts it, and it takes no pointer input (`pointer-events: none`), sits at `z-index: 0`, and is
 * hidden from assistive tech.
 *
 * Off by default, and off costs nothing: the chrome only mounts the shader when the user turned the
 * global background on *and* the shader engine itself is enabled. `KawarpBackground` owns the GL
 * lifecycle from there — it creates the context on mount, disposes it on unmount, pauses with the
 * window hidden or playback stopped, and falls back to the blurred artwork layer when the engine
 * cannot start. This component only picks the artwork (the playing track's cover, the same image the
 * player bar shows) and remembers a failure for the session so a broken driver is not retried on
 * every settings change.
 *
 * The wallpaper dims the app's own canvas: the shell surfaces above it stay translucent instead of
 * opaque (see `.app-shell[data-shader-background]` in global.css), so the UI keeps its contrast while
 * the shader moves underneath.
 */

import { useMemo, useState } from "react";
import type { ShaderSettings } from "../../../shared/types";
import { useCurrentMediaItem, useCurrentTrack } from "../../app/hooks";
import { useReducedMotion } from "../../app/useMotionPreference";
import { useSettings } from "../../state/settingsStore";
import { usePlayer } from "../../state/playerStore";
import { KawarpBackground } from "../shaders/KawarpBackground";
import { ShaderBubbles } from "./ShaderBubbles";
import { generatedShaderSource } from "./shaderSource";

/** The global surface only exists when both switches are on. */
export function globalShaderEnabled(settings: { shaders?: Partial<ShaderSettings> } | null | undefined): boolean {
  const shaders = settings?.shaders;
  return Boolean(shaders?.enabled && shaders.globalBackground);
}

export function GlobalShaderBackground() {
  const settings = useSettings(state => state.settings);
  const item = useCurrentMediaItem();
  const track = useCurrentTrack();
  const playing = usePlayer(state => state.isPlaying);
  // A wallpaper behind a library page should breathe even with nothing playing, but it must not move
  // for someone who asked for reduced motion: then it holds one still frame.
  const reducedMotion = useReducedMotion();
  // A driver that refused the context once will refuse it again; retrying on every settings change
  // would drop the UI back to the wallpaper and back for no gain. Cleared only by a restart.
  const [failed, setFailed] = useState(false);

  const shaders = settings?.shaders;
  const active = Boolean(shaders && globalShaderEnabled(settings));
  // The user's own shader settings, not a Now Playing profile's: the wallpaper is app-level, so it
  // follows the settings panel exactly and keeps updating while the panel is open.
  const shaderSettings = useMemo(() => shaders, [shaders]);
  // With nothing playing there is no cover to warp, and a shader over an empty source is a black
  // field. Fall back to a generated accent gradient so the wallpaper always has colour to bend.
  const accent = settings?.appearance.accent ?? "#ff3d71";
  // Hooks must run unconditionally: this used to read
  // `item?.artworkUrl ?? useMemo(...)`, so the `useMemo` was skipped on the first render after a
  // track started playing. React counts that as "rendered more hooks than during the previous
  // render" and throws, and because nothing upstream caught it the whole root unmounted — the
  // blank window. Compute the fallback gradient every render and pick between the two.
  const generated = useMemo(() => generatedShaderSource(accent), [accent]);
  const artworkUrl = item?.artworkUrl ?? generated;
  const animatedArtUrl = track?.animatedArtUrl ?? null;

  if (!active || !shaderSettings) return null;

  return (
    <div className="global-shader-bg" data-testid="global-shader-background" data-playing={playing ? "true" : "false"} aria-hidden="true">
      <KawarpBackground
        artworkUrl={artworkUrl}
        animatedArtUrl={animatedArtUrl}
        settings={shaderSettings}
        playing={playing}
        animateWhenPaused
        still={reducedMotion}
        verbose={settings?.advanced.showLogs ?? false}
        // The engine could not start: KawarpBackground has already swapped in its blurred artwork
        // layer, so the wallpaper stays a wallpaper instead of a hole. Log once, per session.
        onError={() => {
          if (!failed) console.warn("[Cadence] Global shader unavailable — using the artwork fallback.");
          setFailed(true);
        }}
      />
      {/* Frosted glass spheres over the shader, still inside the wallpaper layer — never above UI. */}
      <ShaderBubbles />
    </div>
  );
}
