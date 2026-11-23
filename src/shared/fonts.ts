/**
 * Font choices, shared between the renderer that applies them, the settings store that persists
 * them, and the Tauri host that enumerates the platform's installed fonts.
 *
 * A font id is either one of the built-in generic presets (`system`, `monospace`) or the exact
 * family name of a font the host found installed (see `src-tauri/src/fonts.rs`). Family names are
 * read from the fonts themselves, so a font installed after the build is selectable without a code
 * change. Every stack ends in a generic family, so a font that disappears between launches still
 * renders with a sensible system fallback instead of leaving the app unstyled.
 */

/** Built-in presets that are not a single installed family. */
export type FontPreset = "system" | "monospace";

export interface SystemFontFamily {
  /** Family name exactly as CSS `font-family` expects it. */
  family: string;
  /** Distinct styles the platform has for this family (e.g. Regular, Bold). */
  styles: string[];
}

export interface FontOption {
  /** Persisted in settings. `system` and `monospace` are presets; everything else is a family. */
  id: string;
  label: string;
  /** Full CSS font-family stack, always ending in a generic family. */
  stack: string;
  /** Whether this is a built-in preset rather than a discovered system family. */
  preset: boolean;
}

/** The stack the app shipped before system discovery existed. */
export const DEFAULT_FONT_ID = "system";

/**
 * "System default" for the app shell: the platform's own UI face (SF on macOS, Segoe UI on
 * Windows, the desktop's sans on Linux), so Cadence's chrome stays native.
 */
export const SYSTEM_FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif';

/**
 * "System default" for lyrics: Braccato's own default stack, which Better Lyrics renders with.
 * Satoshi is bundled (renderer/styles/fonts.css); the Noto families cover scripts the Latin face
 * lacks, and the rest is the same platform fallback chain.
 */
export const LYRICS_DEFAULT_FONT_STACK =
  'Satoshi, "Noto Sans", Avenir, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif';

const MONOSPACE_FONT_STACK =
  'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Courier New", monospace';

/** Which surface a stack is for: the app shell, or the lyrics renderer (they default differently). */
export type FontTarget = "ui" | "lyrics";

/**
 * Font ids written by builds that shipped a fixed list. They stay valid after an upgrade by
 * resolving to the family (or preset) that they named.
 */
export const LEGACY_FONT_PRESETS: Readonly<Record<string, string>> = Object.freeze({
  system: "system",
  "segoe-ui": "Segoe UI",
  helvetica: "Helvetica Neue",
  arial: "Arial",
  verdana: "Verdana",
  tahoma: "Tahoma",
  trebuchet: "Trebuchet MS",
  roboto: "Roboto",
  "noto-sans": "Noto Sans",
  georgia: "Georgia",
  palatino: "Palatino Linotype",
  "times-new-roman": "Times New Roman",
  monospace: "monospace",
});

/** Families a browser-only build (no Tauri host) can offer so the picker still works. */
export const FALLBACK_FONT_FAMILIES: readonly SystemFontFamily[] = Object.freeze([
  { family: "Segoe UI", styles: ["Regular"] },
  { family: "Helvetica Neue", styles: ["Regular"] },
  { family: "Arial", styles: ["Regular"] },
  { family: "Verdana", styles: ["Regular"] },
  { family: "Tahoma", styles: ["Regular"] },
  { family: "Trebuchet MS", styles: ["Regular"] },
  { family: "Roboto", styles: ["Regular"] },
  { family: "Noto Sans", styles: ["Regular"] },
  { family: "Georgia", styles: ["Regular"] },
  { family: "Palatino Linotype", styles: ["Regular"] },
  { family: "Times New Roman", styles: ["Regular"] },
]);

/** Longest family name the host may report; anything longer is treated as corrupt. */
const MAX_FONT_ID_LENGTH = 120;

/**
 * Turns whatever was persisted into a font id that is safe to put in settings. Unknown-but-plausible
 * family names are kept verbatim: the picker can show them as "not installed" and the CSS stack can
 * still fall back gracefully.
 */
export function normalizeFontId(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_FONT_ID;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_FONT_ID;
  const legacy = LEGACY_FONT_PRESETS[trimmed.toLowerCase()];
  if (legacy) return legacy;
  if (trimmed.length > MAX_FONT_ID_LENGTH) return DEFAULT_FONT_ID;
  // Family names come from font files. Refuse control characters; everything else is escaped when
  // it reaches CSS, so a quote or backslash in a name cannot break out of the string.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return DEFAULT_FONT_ID;
  return trimmed;
}

/** True for the two presets that are not installed families. */
export function isFontPreset(id: string | null | undefined): boolean {
  const normalized = normalizeFontId(id);
  return normalized === "system" || normalized === "monospace";
}

/** Escapes a family name for use as a quoted CSS string. */
function quoteCssFamily(family: string): string {
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The full CSS stack for a font id. Only the `system` preset differs by target; a chosen family is the same everywhere. */
export function fontStack(id: string | null | undefined, target: FontTarget = "ui"): string {
  const normalized = normalizeFontId(id);
  if (normalized === "system") return target === "lyrics" ? LYRICS_DEFAULT_FONT_STACK : SYSTEM_FONT_STACK;
  if (normalized === "monospace") return MONOSPACE_FONT_STACK;
  return `${quoteCssFamily(normalized)}, ${SYSTEM_FONT_STACK}`;
}

/** A picker entry for any font id, including the built-in presets. */
export function fontOption(id: string | null | undefined, families: readonly SystemFontFamily[] = []): FontOption {
  const normalized = normalizeFontId(id);
  if (normalized === "system") {
    return { id: "system", label: "System default", stack: SYSTEM_FONT_STACK, preset: true };
  }
  if (normalized === "monospace") {
    return { id: "monospace", label: "Monospace", stack: MONOSPACE_FONT_STACK, preset: true };
  }
  const installed = families.find(family => family.family.toLowerCase() === normalized.toLowerCase());
  return {
    id: normalized,
    label: installed?.family ?? normalized,
    stack: fontStack(normalized),
    preset: false,
  };
}

/** The option list the picker shows: the two presets, then every installed family. */
export function fontOptions(families: readonly SystemFontFamily[]): FontOption[] {
  return [
    fontOption("system"),
    fontOption("monospace"),
    ...families.map(family => fontOption(family.family, families)),
  ];
}

/** Sorted, de-duplicated family names, as the host should return them. */
export function normalizeSystemFontFamilies(families: readonly SystemFontFamily[] | null | undefined): SystemFontFamily[] {
  const byFamily = new Map<string, SystemFontFamily>();
  for (const entry of families ?? []) {
    if (!entry || typeof entry.family !== "string") continue;
    const family = normalizeFontId(entry.family);
    if (family === DEFAULT_FONT_ID || family === "monospace") continue;
    const key = family.toLowerCase();
    const existing = byFamily.get(key);
    const styles = Array.isArray(entry.styles)
      ? entry.styles.filter((style): style is string => typeof style === "string" && style.trim() !== "")
      : [];
    if (existing) {
      const merged = new Set([...existing.styles, ...styles]);
      existing.styles = [...merged].sort();
    } else {
      byFamily.set(key, { family, styles: [...new Set(styles)].sort() });
    }
  }
  return [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: "base" }));
}
