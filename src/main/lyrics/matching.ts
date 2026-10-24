/**
 * Conservative metadata matching shared by the network lyrics providers.
 *
 * The normalization deliberately keeps letters and numbers of every script (Unicode-aware),
 * strips diacritics and punctuation, and collapses whitespace. The Sørensen–Dice bigram score is
 * used only to *rank* candidates a provider already returned and to gate obviously wrong matches —
 * providers stay authoritative for their own catalogs. Written for Cadence; the LRCLIB provider
 * previously carried private copies of these helpers.
 */

export function normalizeMetadata(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Sørensen–Dice bigram similarity in the 0..1 range. */
export function similarity(a: string, b: string): number {
  const left = normalizeMetadata(a).replace(/\s+/g, "");
  const right = normalizeMetadata(b).replace(/\s+/g, "");
  if (!left || !right) return 0;
  if (left === right) return 1;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < left.length - 1; i++) {
    const bigram = left.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  let matches = 0;
  for (let i = 0; i < right.length - 1; i++) {
    const bigram = right.slice(i, i + 2);
    const count = bigrams.get(bigram) ?? 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      matches += 1;
    }
  }
  return (2 * matches) / (left.length - 1 + right.length - 1);
}

export interface MatchableTrack {
  title: string;
  artist: string;
  album: string;
  duration: number;
}

export interface MatchableRecord {
  title: string;
  artist: string;
  album?: string | null;
  duration?: number | null;
}

/**
 * Scores a provider record against the local file's metadata. Title and artist dominate; duration
 * and album are soft signals, never hard requirements (local tags are often imperfect).
 */
export function matchScore(query: MatchableTrack, record: MatchableRecord): number {
  const titleScore = similarity(record.title, query.title) * 0.55;
  const artistScore = similarity(record.artist, query.artist) * 0.35;
  const durationPenalty =
    query.duration > 0 && record.duration && record.duration > 0
      ? Math.min(1, Math.abs(record.duration - query.duration) / 15)
      : 0;
  const durationScore = (1 - durationPenalty) * 0.07;
  const albumScore =
    query.album && record.album ? similarity(record.album, query.album) * 0.03 : 0;
  return titleScore + artistScore + durationScore + albumScore;
}

/** Below this a fuzzy match is considered a different song rather than a bad-tag spelling. */
export const MATCH_SCORE_THRESHOLD = 0.45;

/**
 * Unison's documented duration tolerance (src/config.ts `matching.durationTolerance`): the server
 * matches within ±2 seconds when a duration is supplied, so client-side validation uses the same
 * window for fuzzy search fallback records.
 */
export const DURATION_TOLERANCE_SECONDS = 2;

export function durationWithinTolerance(queryDuration: number, recordDuration: number | null | undefined): boolean {
  if (!queryDuration || !recordDuration) return true;
  return Math.abs(recordDuration - queryDuration) <= DURATION_TOLERANCE_SECONDS;
}
