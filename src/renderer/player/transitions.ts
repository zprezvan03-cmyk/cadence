import type { RepeatMode } from "../../shared/types";

export const GAPLESS_TRIGGER_SECONDS = 0.35;
export const MIN_TRANSITION_ELAPSED_SECONDS = 1;

export interface TransitionProbe {
  isPlaying: boolean;
  position: number;
  duration: number;
  crossfadeSeconds: number;
  gaplessPlayback: boolean;
  repeat: RepeatMode;
  hasNext: boolean;
}

export type TransitionDecision =
  | { kind: "none" }
  | { kind: "crossfade"; fadeSeconds: number }
  | { kind: "gapless-cut" }
  | { kind: "repeat-one-loop" };

const NONE: TransitionDecision = { kind: "none" };

export function effectiveCrossfadeSeconds(duration: number, requestedSeconds: number): number {
  if (!Number.isFinite(duration) || !Number.isFinite(requestedSeconds)) return 0;
  return Math.min(12, Math.max(0, requestedSeconds), Math.max(0, duration) / 2);
}

/**
 * Pure scheduling decision used by the player store's clock subscription. It intentionally has
 * no queue or engine dependencies: callers provide whether an auto-advance target exists.
 */
export function decideTransition(probe: TransitionProbe): TransitionDecision {
  if (!probe.isPlaying || !Number.isFinite(probe.position) || !Number.isFinite(probe.duration)) return NONE;
  if (probe.duration <= 0 || probe.position < MIN_TRANSITION_ELAPSED_SECONDS) return NONE;

  const remaining = probe.duration - probe.position;
  if (remaining <= 0) return NONE;

  if (probe.repeat === "one") {
    return probe.gaplessPlayback && remaining <= GAPLESS_TRIGGER_SECONDS
      ? { kind: "repeat-one-loop" }
      : NONE;
  }

  if (!probe.hasNext) return NONE;

  const fadeSeconds = effectiveCrossfadeSeconds(probe.duration, probe.crossfadeSeconds);
  if (fadeSeconds > 0 && remaining <= fadeSeconds) {
    return { kind: "crossfade", fadeSeconds };
  }

  if (probe.gaplessPlayback && remaining <= GAPLESS_TRIGGER_SECONDS) {
    return { kind: "gapless-cut" };
  }

  return NONE;
}

/**
 * Prevents the 10 Hz player clock from starting the same end-of-track transition repeatedly.
 * Observing a position near zero clears it, covering repeat-one and a one-track repeat-all loop
 * where both the queue position and track id remain the same after a successful transition.
 */
export class TransitionGuard {
  private key: string | null = null;

  tryArm(key: string): boolean {
    if (this.key === key) return false;
    this.key = key;
    return true;
  }

  observe(position: number): void {
    if (position < MIN_TRANSITION_ELAPSED_SECONDS) this.key = null;
  }

  reset(): void {
    this.key = null;
  }
}
