/**
 * Applies the chosen font to the document. Written for Cadence.
 *
 * The app's UI text and the lyrics renderer read different variables — `--font` for the shell and
 * `--blyrics-font-family` for the upstream renderer — so both are written from one place, and a
 * theme that sets the lyrics family on the container itself still wins.
 */

import {
  FONT_OPTIONS,
  FONT_PROBE_TEXT,
  resolveFontOption,
  unavailableFontFamilies,
  type FontMeasurer,
  type FontOption,
} from "../../shared/fonts";

/** The document-level variables that carry the selected font. */
export const FONT_VARIABLES = ["--font", "--blyrics-font-family"] as const;

/**
 * Publishes `fontId` as the document's font. Unknown ids fall back to the default, so a settings
 * file naming a font this build no longer ships still renders rather than leaving the UI unstyled.
 */
export function applyFontFamily(fontId: string | null | undefined, root: HTMLElement = document.documentElement): FontOption {
  const option = resolveFontOption(fontId);
  for (const property of FONT_VARIABLES) root.style.setProperty(property, option.stack);
  return option;
}

/** Canvas-backed measurer; null in a document without a 2D context, which reads as "unknown". */
function createCanvasMeasurer(): FontMeasurer {
  if (typeof document === "undefined") return () => null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return () => null;
  return cssFont => {
    context.font = cssFont;
    return context.measureText(FONT_PROBE_TEXT).width;
  };
}

/**
 * The fonts this machine does not have, for the picker to label. Every option still applies: its
 * stack names fallbacks, so the browser renders the closest family it has.
 */
export function detectUnavailableFonts(options: readonly FontOption[] = FONT_OPTIONS): Set<string> {
  return new Set(unavailableFontFamilies(options, createCanvasMeasurer()));
}
