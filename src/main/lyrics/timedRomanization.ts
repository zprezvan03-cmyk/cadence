import { joinRomanizedSpans } from "../../shared/lyricsTiming";

export interface TimedRomanizationLineInput {
  lineIndex: number;
  lineId: string;
  lineText: string;
  spans: string[];
}

export interface TimedRomanizationPosition {
  start: number;
  count: number;
}

export interface FlattenedTimedRomanizationBatch {
  flatLines: string[];
  flatIds: string[];
  promptTimedLines: { lineId: string; lineText: string; spans: { id: string; text: string }[] }[];
  positions: TimedRomanizationPosition[];
}

/** Flatten only the existing spans for AI; preserve each original line's position for regrouping. */
export function flattenTimedRomanizationBatch(
  lines: readonly string[],
  segmentIds: readonly string[] | undefined,
  timedLines: readonly TimedRomanizationLineInput[]
): FlattenedTimedRomanizationBatch {
  const timedByLine = new Map(timedLines.map(line => [line.lineIndex, line]));
  const flatLines: string[] = [];
  const flatIds: string[] = [];
  const promptTimedLines: FlattenedTimedRomanizationBatch["promptTimedLines"] = [];
  const positions: TimedRomanizationPosition[] = [];
  lines.forEach((lineText, lineIndex) => {
    const timed = timedByLine.get(lineIndex);
    if (!timed || timed.spans.length === 0) {
      positions.push({ start: flatLines.length, count: 1 });
      flatLines.push(lineText);
      flatIds.push(segmentIds?.[lineIndex] ?? `line-${lineIndex}`);
      return;
    }
    const lineId = timed.lineId || segmentIds?.[lineIndex] || `line-${lineIndex}`;
    const spans = timed.spans.map((text, spanIndex) => ({ id: `${lineId}-span-${spanIndex}`, text }));
    positions.push({ start: flatLines.length, count: spans.length });
    promptTimedLines.push({ lineId, lineText: timed.lineText || lineText, spans });
    for (const span of spans) {
      flatLines.push(span.text);
      flatIds.push(span.id);
    }
  });
  return { flatLines, flatIds, promptTimedLines, positions };
}

/** Map structured AI output back to each request line; timed values remain separate per span. */
export function groupTimedRomanizationResults(
  results: readonly (string | null)[],
  positions: readonly TimedRomanizationPosition[],
  timedLines: readonly TimedRomanizationLineInput[]
): { romanizations: (string | null)[]; timedRomanizations: ((string | null)[] | null)[] } {
  const timedByLine = new Map(timedLines.map(line => [line.lineIndex, line]));
  const romanizations: (string | null)[] = [];
  const timedRomanizations: ((string | null)[] | null)[] = [];
  positions.forEach((position, lineIndex) => {
    const values = results.slice(position.start, position.start + position.count);
    const timed = timedByLine.get(lineIndex);
    if (timed && values.length === timed.spans.length) {
      timedRomanizations.push(values);
      romanizations.push(joinRomanizedSpans(timed.spans.map((source, index) => ({ source, romanized: values[index] ?? "" }))));
    } else {
      timedRomanizations.push(null);
      romanizations.push(values[0] ?? null);
    }
  });
  return { romanizations, timedRomanizations };
}
