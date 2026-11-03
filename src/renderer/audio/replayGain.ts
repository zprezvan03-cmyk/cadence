import type { PlaybackSettings, Track } from "../../shared/types";

export type ReplayGainTrackFields = Pick<
  Track,
  "replayGainTrackDb" | "replayGainAlbumDb" | "replayGainTrackPeak" | "replayGainAlbumPeak"
>;

export type ReplayGainSettings = Pick<
  PlaybackSettings,
  "replayGainMode" | "replayGainPreampDb" | "replayGainPreventClipping"
>;

export interface ReplayGainResult {
  /** Linear multiplier safe to assign to a Web Audio GainNode. */
  linear: number;
  /** Total dB adjustment before optional peak limiting; null when ReplayGain did not apply. */
  appliedDb: number | null;
  /** Which tag family supplied the gain and peak. */
  source: "track" | "album" | null;
  /** Peak used for clipping prevention, when one was available. */
  peak: number | null;
  /** True when peak limiting reduced the requested gain. */
  limitedByPeak: boolean;
}

const NO_GAIN: ReplayGainResult = {
  linear: 1,
  appliedDb: null,
  source: null,
  peak: null,
  limitedByPeak: false,
};

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Resolves a track's ReplayGain tags to one bounded linear gain.
 *
 * Track mode prefers track gain and falls back to album gain; album mode does the reverse.
 * The preamp is applied only when a ReplayGain value exists, so enabling the feature never
 * unexpectedly changes untagged files. Malformed/extreme tags are bounded before conversion.
 */
export function computeReplayGain(
  track: ReplayGainTrackFields | null | undefined,
  settings: ReplayGainSettings
): ReplayGainResult {
  if (!track || settings.replayGainMode === "off") return NO_GAIN;

  const trackCandidate = {
    source: "track" as const,
    gainDb: finiteNumber(track.replayGainTrackDb),
    peak: finiteNumber(track.replayGainTrackPeak),
  };
  const albumCandidate = {
    source: "album" as const,
    gainDb: finiteNumber(track.replayGainAlbumDb),
    peak: finiteNumber(track.replayGainAlbumPeak),
  };
  const candidates =
    settings.replayGainMode === "album" ? [albumCandidate, trackCandidate] : [trackCandidate, albumCandidate];
  const selected = candidates.find(candidate => candidate.gainDb !== null);
  if (!selected || selected.gainDb === null) return NO_GAIN;

  const preampDb = Math.min(12, Math.max(-12, finiteNumber(settings.replayGainPreampDb) ?? 0));
  const appliedDb = Math.min(24, Math.max(-24, selected.gainDb + preampDb));
  let linear = dbToLinear(appliedDb);
  let limitedByPeak = false;

  if (settings.replayGainPreventClipping && selected.peak !== null && selected.peak > 0) {
    const peakLimit = 1 / selected.peak;
    if (linear > peakLimit) {
      linear = peakLimit;
      limitedByPeak = true;
    }
  }

  return {
    // A second hard bound protects the output if a file carries a nonsensical peak such as 0.001.
    linear: Math.min(4, Math.max(0.05, linear)),
    appliedDb,
    source: selected.source,
    peak: selected.peak,
    limitedByPeak,
  };
}
