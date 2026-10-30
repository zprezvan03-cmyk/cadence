/**
 * Pure candidate-selection and seamless-upgrade decisions for Autofetch.
 *
 * Priority always comes from the user's existing provider order (`providerOrderRank` over
 * `settings.lyrics.providerOrder`) — Autofetch invents no ordering of its own. Response speed
 * never decides anything: candidates arrive sorted by that rank and the first one wins.
 */

import type { LyricsCandidate } from "../../../shared/types";
import { providerOrderRank } from "../../../shared/upstream/better-lyrics/constants";

/** Source key of a lyrics file the user loaded by hand; it outranks every automatic match. */
export const USER_FILE_SOURCE = "user-file";

/**
 * The candidate a resolve should display: the user's persisted explicit choice for the track,
 * else a hand-picked file, else the highest-priority candidate (list is rank-sorted).
 */
export function pickPreferredCandidate(
  candidates: readonly LyricsCandidate[],
  selectedSource: string | undefined
): LyricsCandidate | undefined {
  return (
    candidates.find(candidate => candidate.source === selectedSource) ??
    candidates.find(candidate => candidate.source === USER_FILE_SOURCE) ??
    candidates[0]
  );
}

/**
 * Whether the lyrics currently on screen were explicitly chosen by the user (provider-selector
 * pick, manual search pick, or a hand-loaded TTML/QRC/LRC file). Automatic fetching may keep
 * caching in the background but must never replace these.
 */
export function isManualSelection(
  activeSource: string | null,
  selectedSource: string | undefined
): boolean {
  if (!activeSource) return false;
  return activeSource === USER_FILE_SOURCE || activeSource === selectedSource;
}

/**
 * Whether a newly resolved candidate may replace the one on screen:
 * - never over a manual selection (unless it *is* that selection),
 * - always when nothing is showing yet,
 * - otherwise only when its provider-order rank is at least as high as the current one —
 *   a lower-priority candidate never displaces a higher-priority fallback.
 */
export function shouldApplyUpgrade(args: {
  currentSource: string | null;
  nextSource: string;
  providerOrder: readonly string[];
  manual: boolean;
}): boolean {
  if (args.manual) return args.nextSource === args.currentSource;
  if (!args.currentSource) return true;
  if (args.nextSource === args.currentSource) return true;
  return (
    providerOrderRank(args.nextSource, args.providerOrder) <=
    providerOrderRank(args.currentSource, args.providerOrder)
  );
}

/** Identity of the lyrics payload currently rendered by the Now Playing host. */
export interface LyricsRenderIdentity {
  trackId: string | number | null;
  source: string | null;
  hasLyrics: boolean;
}

/**
 * Whether changing the rendered payload deserves the short opacity dip. This is deliberately
 * narrower than "the lyrics array changed": only a same-track switch from one visible source
 * to another is an Autofetch/source-selector upgrade. Track changes, first loads, clears, and
 * translation/romanization refreshes (same source) must not inherit this treatment.
 */
export function shouldCrossfadeUpgrade(
  previous: LyricsRenderIdentity | null,
  next: LyricsRenderIdentity | null
): boolean {
  if (!previous || !next) return false;
  return (
    previous.trackId !== null &&
    previous.trackId === next.trackId &&
    previous.hasLyrics &&
    next.hasLyrics &&
    previous.source !== null &&
    next.source !== null &&
    previous.source !== next.source
  );
}
