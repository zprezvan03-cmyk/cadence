/**
 * A tiny external playback-clock source for players that do not expose an HTML media element.
 *
 * The YouTube IFrame player is sampled at a deliberately low rate (the caller owns that timer).
 * This class only retains the latest sample and projects it forward for consumers that need a
 * smoother clock, without involving React state or pretending the iframe is a media element.
 */

export interface RemotePlaybackClock {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  /** `Date.now()` timestamp for the sample, in milliseconds. */
  sampledAt: number;
}

export const EMPTY_REMOTE_PLAYBACK_CLOCK: RemotePlaybackClock = {
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  playbackRate: 1,
  sampledAt: 0,
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeRemotePlaybackClock(
  clock: Partial<RemotePlaybackClock> & Pick<RemotePlaybackClock, "currentTime" | "duration" | "isPlaying">
): RemotePlaybackClock {
  const duration = Math.max(0, finiteOr(clock.duration, 0));
  const currentTime = Math.max(0, finiteOr(clock.currentTime, 0));
  const playbackRate = finiteOr(clock.playbackRate ?? 1, 1);
  return {
    currentTime: duration > 0 ? Math.min(currentTime, duration) : currentTime,
    duration,
    isPlaying: Boolean(clock.isPlaying),
    playbackRate: playbackRate > 0 ? playbackRate : 1,
    sampledAt: Math.max(0, finiteOr(clock.sampledAt ?? Date.now(), Date.now())),
  };
}

/**
 * Projects a sampled clock to `now`. Paused and ended samples never move; a playing sample is
 * advanced by wall-clock elapsed time multiplied by the iframe's reported playback rate.
 */
export function projectRemotePlaybackClock(
  clock: RemotePlaybackClock,
  now = Date.now()
): RemotePlaybackClock {
  if (!clock.isPlaying || clock.sampledAt <= 0) return clock;
  const elapsedSeconds = Math.max(0, (now - clock.sampledAt) / 1000);
  const projected = clock.currentTime + elapsedSeconds * clock.playbackRate;
  return {
    ...clock,
    currentTime: clock.duration > 0 ? Math.min(projected, clock.duration) : projected,
  };
}

export class RemotePlaybackClockSource {
  private snapshot: RemotePlaybackClock = EMPTY_REMOTE_PLAYBACK_CLOCK;
  private listeners = new Set<() => void>();

  getSnapshot = (): RemotePlaybackClock => this.snapshot;

  projectedAt = (now = Date.now()): RemotePlaybackClock =>
    projectRemotePlaybackClock(this.snapshot, now);

  setSnapshot = (clock: RemotePlaybackClock): void => {
    const next = normalizeRemotePlaybackClock(clock);
    const previous = this.snapshot;
    if (
      previous.currentTime === next.currentTime &&
      previous.duration === next.duration &&
      previous.isPlaying === next.isPlaying &&
      previous.playbackRate === next.playbackRate &&
      previous.sampledAt === next.sampledAt
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  };

  reset = (): void => {
    this.setSnapshot({ ...EMPTY_REMOTE_PLAYBACK_CLOCK, sampledAt: Date.now() });
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
