/**
 * Applies the chosen font to the document. Written for Cadence.
 *
 * The app's UI text and the lyrics renderer read different variables — `--font` for the shell and
 * `--blyrics-font-family` for the upstream renderer — so both are written from one place, and a
 * Now Playing profile that sets a font on the lyrics container itself still wins (it is set on a
 * descendant). The two surfaces only disagree for the `system` preset: the shell keeps the
 * platform's UI face while lyrics use the Better Lyrics default (Satoshi → Noto Sans → platform).
 * The family otherwise comes from the host's system-font scan, so a font installed after the build
 * is applied the same way.
 */

import { fontStack, normalizeFontId, type FontOption } from "../../shared/fonts";

/** The document-level variables that carry the selected font. */
export const FONT_VARIABLES = ["--font", "--blyrics-font-family"] as const;

/**
 * Publishes `fontId` as the document's font. Unknown, empty or corrupt ids fall back to the system
 * default, so a settings file naming a font this machine no longer has still renders rather than
 * leaving the UI unstyled (the stack ends in generic families either way).
 */
export function applyFontFamily(
  fontId: string | null | undefined,
  root: HTMLElement = document.documentElement
): FontOption {
  const normalized = normalizeFontId(fontId);
  const stack = fontStack(normalized);
  root.style.setProperty("--font", stack);
  root.style.setProperty("--blyrics-font-family", fontStack(normalized, "lyrics"));
  root.dataset.fontFamily = normalized;
  return { id: normalized, label: normalized, stack, preset: normalized === "system" || normalized === "monospace" };
}

/** The CSS stack a family resolves to, for a single element's preview. */
export function previewFontStack(fontId: string | null | undefined): string {
  return fontStack(fontId);
}
