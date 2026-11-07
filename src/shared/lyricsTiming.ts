/**
 * Timing-granularity rule shared by the main process and the renderer.
 *
 * Written for Cadence. Providers hand back wildly different payloads under the same labels, so
 * the only trustworthy signal is the parsed line/part structure itself:
 *
 *   - a line split into two or more timed parts is genuinely syllable/word timed;
 *   - a line whose single part merely repeats the whole line (the `<p><span begin=… end=…>whole
 *     line</span></p>` shape many line-synced TTML files use) carries no sub-line timing at all —
 *     it is line-synced lyrics wearing a karaoke token, and must never be advertised as syllable
 *     level.
 *
 * `@braccato/parsers` reports `isWordSynced: true` for that second shape, which is why provider
 * classification cannot lean on it alone. Both `inspectLyricsPayload` (main) and `detectSyncType`
 * (renderer) call this one function so a candidate's provider identity and the sync badge the UI
 * shows can never disagree.
 */

/** Structural subset of `@braccato/types` `LyricPart`, so this module stays dependency free. */
export interface TimedPart {
  startTimeMs: number;
  durationMs: number;
  words: string;
}

/** Structural subset of `@braccato/types` `Lyric`. */
export interface TimedLine {
  startTimeMs: number;
  durationMs: number;
  words: string;
  parts?: TimedPart[];
  isInstrumental?: boolean;
}

/** Rounding slack between a part's start and its line's start, in milliseconds. */
const START_TOLERANCE_MS = 10;

/** True when `line` is subdivided into independently timed fragments. */
export function lineHasSyllableTiming(line: TimedLine): boolean {
  if (line.isInstrumental) return false;
  const parts = line.parts ?? [];
  if (parts.length === 0) return false;
  if (parts.length > 1) return true;
  const only = parts[0];
  // One part covering the line's full text from the line's own start time is the line itself.
  if (only.words.trim() !== line.words.trim()) return true;
  return only.startTimeMs - line.startTimeMs > START_TOLERANCE_MS;
}

/** True when at least one sung line carries genuine per-syllable/per-word timing. */
export function hasSyllableTiming(lines: readonly TimedLine[]): boolean {
  return lines.some(line => lineHasSyllableTiming(line));
}
