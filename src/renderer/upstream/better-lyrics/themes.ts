/**
 * Lyrics themes.
 *
 * PORTED PARTIALLY FROM UPSTREAM — Better Lyrics
 * Repository: https://github.com/better-lyrics/better-lyrics
 * Commit:     18be32089343ec721fbead38c082117e4d44871f
 * Original:   src/options/themes.ts + public/css/themes/{Default,HDR}.css
 * License:    GPL-3.0
 *
 * `Default` and `HDR` are the upstream stylesheets, unmodified. The store-hosted themes listed
 * upstream (Spotlight, Even Better Lyrics Plus, Minimal, Dynamic Background, Apple Music) are
 * fetched from themes.betterlyrics.org by the extension and are not redistributed here; Cadence
 * ships its own extra themes instead, marked as Cadence originals.
 *
 * The theme is handed to `<braccato-lyrics>` as CSS. Behaviour settings travel in `blyrics-*`
 * comments, which is the upstream contract (see the @braccato/core README).
 */

import type { LyricsSettings } from "../../../shared/types";
import defaultCss from "./themes/Default.css?raw";
import hdrCss from "./themes/HDR.css?raw";

export interface LyricsTheme {
  id: string;
  name: string;
  author: string;
  origin: "upstream" | "cadence";
  css: string;
}

const cadenceMidnight = `
/* Cadence original: deep blue, tighter lines, softer inactive text. */
.blyrics-container {
  --blyrics-font-weight: 650;
  --blyrics-lyric-active-color: #ffffff;
  --blyrics-lyric-inactive-color: rgb(255 255 255 / var(--blyrics-inactive-opacity, 0.28));
  --blyrics-glow-color: rgb(120 170 255 / 0.45);
  --blyrics-translated-color: rgb(190 210 255 / 0.7);
  --blyrics-padding: 1.6rem;
}
`;

const cadenceNeon = `
/* Cadence original: high-contrast accent glow for the active line. */
.blyrics-container {
  --blyrics-font-weight: 800;
  --blyrics-lyric-active-color: #ffffff;
  --blyrics-lyric-inactive-color: rgb(255 255 255 / var(--blyrics-inactive-opacity, 0.22));
  --blyrics-glow-color: rgb(255 61 113 / 0.55);
  --blyrics-translated-color: rgb(255 190 210 / 0.75);
  --blyrics-font-size: 3.4rem;
}
`;

const cadenceMinimal = `
/* Cadence original: smaller, quieter, left-aligned lines. */
.blyrics-container {
  --blyrics-font-size: 2.1rem;
  --blyrics-font-weight: 600;
  --blyrics-line-height: 1.5;
  --blyrics-lyric-inactive-color: rgb(255 255 255 / var(--blyrics-inactive-opacity, 0.35));
  --blyrics-padding: 1.2rem;
}
`;

export const THEMES: LyricsTheme[] = [
  { id: "default", name: "Default", author: "Better Lyrics", origin: "upstream", css: defaultCss },
  { id: "hdr", name: "HDR", author: "Better Lyrics", origin: "upstream", css: hdrCss },
  { id: "midnight", name: "Midnight", author: "Cadence", origin: "cadence", css: cadenceMidnight },
  { id: "neon", name: "Neon", author: "Cadence", origin: "cadence", css: cadenceNeon },
  { id: "minimal", name: "Minimal (Cadence)", author: "Cadence", origin: "cadence", css: cadenceMinimal },
  { id: "custom", name: "Custom CSS", author: "You", origin: "cadence", css: "" },
];

export function getTheme(id: string): LyricsTheme {
  return THEMES.find(theme => theme.id === id) ?? THEMES[0];
}

/** Secondary-line sizes are pixel sliders; anything missing or out of range falls back to the renderer's own defaults. */
function secondaryFontSizePx(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(48, Math.max(10, Math.round(value))) : fallback;
}

/**
 * Composes the theme stylesheet with the user's typography controls. The controls are ordinary CSS
 * custom properties, so they compose with any theme rather than replacing its design.
 */
export function buildThemeCss(settings: LyricsSettings): string {
  const theme = getTheme(settings.themeId);
  const base = theme.id === "custom" ? settings.customThemeCss : theme.css;
  const activeOpacity = Math.min(1, Math.max(0, settings.activeOpacity));
  const inactiveOpacity = Math.min(1, Math.max(0, settings.inactiveOpacity));
  const fontSize = Math.min(6, Math.max(1.4, settings.fontSizeRem));
  const fontWeight = Math.min(900, Math.max(300, settings.fontWeight));
  const lineHeight = Math.min(2.2, Math.max(1, settings.lineHeight));
  const translationFontSizePx = secondaryFontSizePx(settings.translationFontSizePx, 32);
  const romanizationFontSizePx = secondaryFontSizePx(settings.romanizationFontSizePx, 26);

  const css = `
${base}
/* blyrics-target-scroll-pos-ratio = ${Math.min(0.9, Math.max(0.1, settings.targetScrollRatio))}; */
${settings.hideInstrumentalOnly ? "/* blyrics-hide-instrumental-only = true; */" : ""}
${settings.showCredits ? "" : "/* blyrics-hide-credits = true; */"}
.blyrics-container {
  --blyrics-font-size: var(--np-lyrics-font-size, ${fontSize}rem);
  --blyrics-font-weight: var(--np-lyrics-weight, ${fontWeight});
  --blyrics-line-height: calc(${lineHeight} * var(--np-line-spacing-scale, 1));
  --blyrics-active-opacity: ${activeOpacity};
  --blyrics-inactive-opacity: calc(${inactiveOpacity} * var(--np-inactive-opacity-scale, 1));
  --blyrics-translated-font-size: var(--np-translation-font-size, ${translationFontSizePx}px);
  --blyrics-active-scale: var(--np-active-line-scale, 1);
  --blyrics-animate-highlight-swipe: var(--np-karaoke-swipe, 1);
  --blyrics-animate-highlight-glow: var(--np-karaoke-glow, 1);
  --blyrics-animate-highlight-fade: var(--np-karaoke-fade, 1);
  --blyrics-highlight-glow-radius-from: var(--np-karaoke-glow-radius, 0.8rem);
  --blyrics-letter-wave-emphasis-scale: var(--np-active-word-scale, 1.11);
  letter-spacing: var(--np-letter-spacing, 0em);
}
.blyrics-container .blyrics--romanized {
  font-size: var(--np-romanization-font-size, ${romanizationFontSizePx}px);
  font-family: var(--np-romanization-font, var(--blyrics-translated-font-family, var(--blyrics-font-family, var(--blyrics-default-font-family))));
}
`.trim();
  // The engine's variables.css derives the active/inactive colours from the
  // opacity variables at host scope, where the container-level definitions
  // above cannot substitute (custom properties resolve where they are
  // declared), so the opacity controls would dead-end at the engine's
  // fallbacks. Redeclare the same derivations on the container — where the
  // variables live — whenever the theme does not define the colours itself.
  const derivations: string[] = [];
  if (!base.includes("--blyrics-lyric-active-color")) {
    derivations.push(
      "--blyrics-lyric-active-color: var(--blyrics-text-color, color(display-p3 1 1 1 / var(--blyrics-active-opacity, 1)));"
    );
  }
  if (!base.includes("--blyrics-lyric-inactive-color")) {
    derivations.push(
      "--blyrics-lyric-inactive-color: color(from var(--blyrics-text-color, color(display-p3 1 1 1)) display-p3 r g b / var(--blyrics-inactive-opacity, 0.3));"
    );
  }
  // Same trap for the line enter/exit transforms: variables.css declares them
  // at :root as scale(var(--blyrics-active-scale)), freezing substitution at
  // the engine's --blyrics-active-scale: 1 and dead-ending the profile's
  // active-line-scale. Redeclared at container scope they resolve against
  // the container's --blyrics-active-scale (the --np-active-line-scale alias).
  if (!base.includes("--blyrics-line-enter-transform-to")) {
    derivations.push("--blyrics-line-enter-transform-to: scale(var(--blyrics-active-scale));");
  }
  if (!base.includes("--blyrics-line-exit-transform-from")) {
    derivations.push("--blyrics-line-exit-transform-from: scale(var(--blyrics-active-scale));");
  }
  if (!base.includes("--blyrics-line-enter-transform-from")) {
    derivations.push("--blyrics-line-enter-transform-from: scale(var(--blyrics-scale));");
  }
  if (!base.includes("--blyrics-line-exit-transform-to")) {
    derivations.push("--blyrics-line-exit-transform-to: scale(var(--blyrics-scale));");
  }
  return derivations.length
    ? `${css}\n.blyrics-container {\n  ${derivations.join("\n  ")}\n}`
    : css;
}
