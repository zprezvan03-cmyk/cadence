/**
 * Font choices, shared between the renderer that applies them and the settings store that persists
 * the chosen id. Written for Cadence.
 *
 * Every option is a full CSS font-family stack ending in a generic family, so a font that is not
 * installed on the machine degrades to a similar one instead of to the browser default. Nothing is
 * bundled: Cadence picks from fonts the platform already has.
 */

export type FontKind = "Sans" | "Serif" | "Monospace";

export interface FontOption {
  /** Persisted in settings; never change an id that has shipped. */
  id: string;
  label: string;
  /** Heading the picker groups the option under. */
  kind: FontKind;
  /** Full CSS font-family stack, always ending in a generic family. */
  stack: string;
  /**
   * Primary family the picker probes to tell the user when it is not installed. Null when the stack
   * starts with a family the platform always resolves (`system-ui`, `ui-monospace`).
   */
  probe: string | null;
}

/** The stack the app shipped with before the setting existed, so the default changes nothing. */
export const DEFAULT_FONT_ID = "system";

export const FONT_OPTIONS: readonly FontOption[] = [
  {
    id: DEFAULT_FONT_ID,
    label: "System default",
    kind: "Sans",
    stack: '"Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif',
    probe: null,
  },
  { id: "segoe-ui", label: "Segoe UI", kind: "Sans", stack: '"Segoe UI", system-ui, sans-serif', probe: "Segoe UI" },
  {
    id: "helvetica",
    label: "Helvetica Neue",
    kind: "Sans",
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    probe: "Helvetica Neue",
  },
  { id: "arial", label: "Arial", kind: "Sans", stack: 'Arial, Helvetica, sans-serif', probe: "Arial" },
  { id: "verdana", label: "Verdana", kind: "Sans", stack: "Verdana, Geneva, sans-serif", probe: "Verdana" },
  { id: "tahoma", label: "Tahoma", kind: "Sans", stack: "Tahoma, Verdana, sans-serif", probe: "Tahoma" },
  {
    id: "trebuchet",
    label: "Trebuchet MS",
    kind: "Sans",
    stack: '"Trebuchet MS", Tahoma, sans-serif',
    probe: "Trebuchet MS",
  },
  { id: "roboto", label: "Roboto", kind: "Sans", stack: 'Roboto, "Helvetica Neue", Arial, sans-serif', probe: "Roboto" },
  { id: "noto-sans", label: "Noto Sans", kind: "Sans", stack: '"Noto Sans", system-ui, sans-serif', probe: "Noto Sans" },
  { id: "georgia", label: "Georgia", kind: "Serif", stack: 'Georgia, "Times New Roman", serif', probe: "Georgia" },
  {
    id: "palatino",
    label: "Palatino",
    kind: "Serif",
    stack: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
    probe: "Palatino Linotype",
  },
  {
    id: "times-new-roman",
    label: "Times New Roman",
    kind: "Serif",
    stack: '"Times New Roman", Times, serif',
    probe: "Times New Roman",
  },
  {
    id: "monospace",
    label: "Monospace",
    kind: "Monospace",
    stack: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
    probe: null,
  },
];

export const FONT_KINDS: readonly FontKind[] = ["Sans", "Serif", "Monospace"];

/** Text whose glyph widths expose the difference between two faces. */
const PROBE_TEXT = "mmmmmmmmmmlliWWWWWWWWWW0123456789";

/** Generics the probe compares against, so a missing family is caught whichever one it falls to. */
const PROBE_GENERICS = ["monospace", "serif", "sans-serif"] as const;

/**
 * Measures a CSS `font` shorthand (e.g. `72px "Georgia", monospace`) and answers its text width.
 * Returning null means the platform could not measure, which the caller reads as "do not guess".
 */
export type FontMeasurer = (cssFont: string) => number | null;

/**
 * An option whose id is unknown (settings written by a newer build, a hand-edited file, a font that
 * was dropped) resolves to the default rather than leaving the app without a font.
 */
export function resolveFontOption(id: string | null | undefined): FontOption {
  return FONT_OPTIONS.find(option => option.id === id) ?? FONT_OPTIONS[0];
}

export function fontStack(id: string | null | undefined): string {
  return resolveFontOption(id).stack;
}

/**
 * Whether the platform has `family`. A family it does not have falls back to the generic in the
 * probe, which measures exactly like the generic alone; a family it does have measures differently
 * against at least one generic. Nothing is reported as missing when the platform cannot measure.
 */
export function isFamilyInstalled(family: string, measure: FontMeasurer): boolean {
  return PROBE_GENERICS.some(generic => {
    const fallback = measure(`72px ${generic}`);
    const candidate = measure(`72px "${family}", ${generic}`);
    if (fallback === null || candidate === null) return true;
    return Math.abs(candidate - fallback) > 0.01;
  });
}

/** The probe families from `options` this platform does not have. */
export function unavailableFontFamilies(options: readonly FontOption[], measure: FontMeasurer): string[] {
  const probes = new Set(options.map(option => option.probe).filter((probe): probe is string => probe !== null));
  return [...probes].filter(probe => !isFamilyInstalled(probe, measure));
}

export const FONT_PROBE_TEXT = PROBE_TEXT;
