/**
 * Session-safe, idempotent playback telemetry tracker for Cadence Listening Intelligence.
 *
 * Accurately distinguishes:
 * - "completed": genuine listen reaching >= 50% of duration (or 240s), or natural end without end-scrubbing
 * - "skipped": manual skip / track switch after hearing >= 2s but < 35% of duration (or 35s)
 * - "browsed": rapid click-through (< 2s heard), neutral
 * - "partial": manual switch after >= 35% heard but before completion threshold, neutral
 * - "error": decode or playback failure, never penalizes the track
 *
 * Every playback load receives a unique `sessionId`. At most ONE terminal outcome can ever be
 * emitted per `sessionId`.
 */

import { smartRecordingKey } from "./smartShuffle";

export type TelemetryOutcomeKind = "completed" | "skipped" | "browsed" | "partial" | "error";

export type TelemetryEndReason = "natural-end" | "manual-skip" | "context-change" | "stop";

export interface TelemetryTrackMeta {
  trackId: number;
  title: string;
  artist: string;
  durationSeconds: number;
}

export interface TelemetrySessionEvent {
  sessionId: string;
  trackId: number;
  recordingKey: string;
  title: string;
  artist: string;
  outcome: TelemetryOutcomeKind;
  listenedSeconds: number;
  durationSeconds: number;
  seekCount: number;
  timestampMs: number;
  /** True only for "completed" and "skipped" outcomes that update persistent preference counters. */
  persisted: boolean;
}

interface ActiveSession {
  sessionId: string;
  trackId: number;
  recordingKey: string;
  title: string;
  artist: string;
  durationSeconds: number;
  startedAtMs: number;
  lastPositionSeconds: number;
  accumulatedListenSeconds: number;
  seekCount: number;
  seekedNearEnd: boolean;
  hadPlaybackError: boolean;
  outcome: TelemetryOutcomeKind | null;
}

/** Minimum seconds a track must be heard before a manual skip counts as a negative preference signal. */
export const MIN_GENUINE_SKIP_LISTEN_SECONDS = 2.0;

/** Maximum delta (in seconds) between consecutive time ticks credited as continuous playback. */
export const MAX_CONTINUOUS_TICK_DELTA_SECONDS = 2.5;

/**
 * Computes the listened-seconds threshold required to consider a track play "completed" mid-stream.
 * Mirrors scrobble semantics while adapting to short tracks/interludes.
 */
export function completionThresholdSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 120;
  if (durationSeconds < 24) return Math.max(4, durationSeconds * 0.6);
  return Math.min(240, Math.max(12, durationSeconds * 0.5));
}

/**
 * Computes the upper bound of listened seconds where a manual transition still counts as an early skip.
 */
export function earlySkipCeilingSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 20;
  if (durationSeconds < 20) return Math.max(3, durationSeconds * 0.35);
  return Math.min(35, Math.max(8, durationSeconds * 0.35));
}

export class PlaybackTelemetryTracker {
  private current: ActiveSession | null = null;
  private readonly finalizedSessions = new Set<string>();
  private readonly maxFinalizedHistory = 256;
  private loopCounter = 0;

  /** Starts tracking a new playback session. If a previous session was still open, finalizes it first. */
  startSession(
    sessionId: string,
    meta: TelemetryTrackMeta,
    initialPositionSeconds = 0,
    now = Date.now(),
    previousEndReason: TelemetryEndReason = "manual-skip"
  ): TelemetrySessionEvent | null {
    let previousOutcome: TelemetrySessionEvent | null = null;
    if (this.current && this.current.sessionId !== sessionId) {
      previousOutcome = this.finalizeCurrent(previousEndReason, now);
    }
    if (this.current?.sessionId === sessionId) {
      return null;
    }

    const recordingKey = smartRecordingKey({
      id: meta.trackId,
      title: meta.title,
      artist: meta.artist,
      duration: meta.durationSeconds,
    });

    this.current = {
      sessionId,
      trackId: meta.trackId,
      recordingKey,
      title: meta.title,
      artist: meta.artist,
      durationSeconds: Math.max(0, meta.durationSeconds || 0),
      startedAtMs: now,
      lastPositionSeconds: Math.max(0, initialPositionSeconds || 0),
      accumulatedListenSeconds: 0,
      seekCount: 0,
      seekedNearEnd: false,
      hadPlaybackError: false,
      outcome: null,
    };

    return previousOutcome;
  }

  getActiveSessionId(): string | null {
    return this.current?.sessionId ?? null;
  }

  getAccumulatedListenSeconds(): number {
    return this.current?.accumulatedListenSeconds ?? 0;
  }

  /**
   * Records a user seek operation so jumped forward intervals are never credited as listened time,
   * and scrubbing directly to the end of a track cannot fake a natural completion.
   */
  observeSeek(targetSeconds: number, durationSeconds?: number): void {
    const session = this.current;
    if (!session) return;
    if (durationSeconds && durationSeconds > 0) {
      session.durationSeconds = durationSeconds;
    }
    const clampedTarget = Math.max(0, targetSeconds);
    const dur = session.durationSeconds;
    if (
      dur > 20 &&
      session.lastPositionSeconds < dur * 0.5 &&
      clampedTarget >= dur * 0.85 &&
      session.accumulatedListenSeconds < completionThresholdSeconds(dur) * 0.6
    ) {
      session.seekedNearEnd = true;
    }
    session.seekCount += 1;
    session.lastPositionSeconds = clampedTarget;
  }

  /**
   * Marks the current session as having encountered a decode or playback error.
   * Immediately latches the session outcome to `"error"` so subsequent skips or stops
   * never penalize the track.
   */
  markPlaybackError(now = Date.now()): TelemetrySessionEvent | null {
    const session = this.current;
    if (!session) return null;
    session.hadPlaybackError = true;
    if (session.outcome !== null || this.finalizedSessions.has(session.sessionId)) {
      return null;
    }
    return this.latchOutcome(session, "error", now);
  }

  /**
   * Observes a playback clock tick. Accumulates genuine playing time, detects repeat-one loops,
   * and emits a `"completed"` outcome as soon as the completion threshold is crossed.
   */
  observeTick(
    positionSeconds: number,
    durationSeconds: number,
    isPlaying: boolean,
    now = Date.now()
  ): TelemetrySessionEvent | null {
    const session = this.current;
    if (!session) return null;

    if (durationSeconds > 0 && Number.isFinite(durationSeconds)) {
      session.durationSeconds = durationSeconds;
    }

    const delta = positionSeconds - session.lastPositionSeconds;
    const dur = session.durationSeconds;

    // Detect repeat-one wrap from end of track back to start
    const repeatedFromStart =
      delta < -1 && dur > 5 && session.lastPositionSeconds >= dur - 2.5 && positionSeconds < 2.0;

    if (repeatedFromStart) {
      const completedLoopEvent = this.finalizeCurrent("natural-end", now);
      this.loopCounter += 1;
      const nextSessionId = `${session.sessionId}:loop-${this.loopCounter}`;
      this.current = {
        sessionId: nextSessionId,
        trackId: session.trackId,
        recordingKey: session.recordingKey,
        title: session.title,
        artist: session.artist,
        durationSeconds: dur,
        startedAtMs: now,
        lastPositionSeconds: Math.max(0, positionSeconds),
        accumulatedListenSeconds: 0,
        seekCount: 0,
        seekedNearEnd: false,
        hadPlaybackError: false,
        outcome: null,
      };
      return completedLoopEvent;
    }

    session.lastPositionSeconds = Math.max(0, positionSeconds);

    if (!isPlaying || session.hadPlaybackError) {
      return null;
    }

    if (delta > 0 && delta <= MAX_CONTINUOUS_TICK_DELTA_SECONDS) {
      session.accumulatedListenSeconds += delta;
    }

    // Check mid-stream completion threshold
    if (
      session.outcome === null &&
      !this.finalizedSessions.has(session.sessionId) &&
      dur > 0 &&
      session.accumulatedListenSeconds >= completionThresholdSeconds(dur)
    ) {
      return this.latchOutcome(session, "completed", now);
    }

    return null;
  }

  /**
   * Finalizes the current session on natural track end, manual skip, or queue change.
   * Idempotent: if the session already reached a terminal outcome (e.g. "completed" mid-track
   * or "error"), returns `null`.
   */
  finalizeCurrent(reason: TelemetryEndReason, now = Date.now()): TelemetrySessionEvent | null {
    const session = this.current;
    if (!session) return null;
    if (session.outcome !== null || this.finalizedSessions.has(session.sessionId)) {
      return null;
    }
    if (session.hadPlaybackError) {
      return this.latchOutcome(session, "error", now);
    }

    const listened = session.accumulatedListenSeconds;
    const dur = session.durationSeconds;

    if (reason === "natural-end") {
      const minNaturalListen =
        dur > 0 ? Math.min(240, Math.max(3, dur * 0.4)) : MIN_GENUINE_SKIP_LISTEN_SECONDS;
      if (!session.seekedNearEnd && listened >= minNaturalListen) {
        return this.latchOutcome(session, "completed", now);
      }
      return this.latchOutcome(session, "partial", now);
    }

    if (reason === "stop") {
      if (dur > 0 && listened >= completionThresholdSeconds(dur)) {
        return this.latchOutcome(session, "completed", now);
      }
      return this.latchOutcome(session, "partial", now);
    }

    // Manual skip or context change
    if (dur > 0 && listened >= completionThresholdSeconds(dur)) {
      return this.latchOutcome(session, "completed", now);
    }
    if (listened < MIN_GENUINE_SKIP_LISTEN_SECONDS) {
      return this.latchOutcome(session, "browsed", now);
    }
    if (listened < earlySkipCeilingSeconds(dur)) {
      return this.latchOutcome(session, "skipped", now);
    }
    return this.latchOutcome(session, "partial", now);
  }

  reset(): void {
    this.current = null;
  }

  private latchOutcome(
    session: ActiveSession,
    outcome: TelemetryOutcomeKind,
    now: number
  ): TelemetrySessionEvent {
    session.outcome = outcome;
    this.finalizedSessions.add(session.sessionId);
    if (this.finalizedSessions.size > this.maxFinalizedHistory) {
      const oldest = this.finalizedSessions.values().next().value;
      if (oldest !== undefined) this.finalizedSessions.delete(oldest);
    }
    return {
      sessionId: session.sessionId,
      trackId: session.trackId,
      recordingKey: session.recordingKey,
      title: session.title,
      artist: session.artist,
      outcome,
      listenedSeconds: session.accumulatedListenSeconds,
      durationSeconds: session.durationSeconds,
      seekCount: session.seekCount,
      timestampMs: now,
      persisted: outcome === "completed" || outcome === "skipped",
    };
  }
}
