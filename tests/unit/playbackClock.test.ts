import { describe, expect, it, vi } from "vitest";
import {
  RemotePlaybackClockSource,
  normalizeRemotePlaybackClock,
  projectRemotePlaybackClock,
} from "../../src/renderer/player/playbackClock";

describe("remote playback clock", () => {
  it("normalizes invalid values and clamps position to duration", () => {
    expect(
      normalizeRemotePlaybackClock({
        currentTime: 250,
        duration: 180,
        isPlaying: true,
        playbackRate: Number.NaN,
        sampledAt: 1234,
      })
    ).toEqual({
      currentTime: 180,
      duration: 180,
      isPlaying: true,
      playbackRate: 1,
      sampledAt: 1234,
    });

    expect(
      normalizeRemotePlaybackClock({
        currentTime: -10,
        duration: -1,
        isPlaying: false,
        playbackRate: 0,
        sampledAt: 99,
      })
    ).toEqual({
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      playbackRate: 1,
      sampledAt: 99,
    });
  });

  it("projects a playing sample by elapsed time and playback rate", () => {
    const projected = projectRemotePlaybackClock(
      {
        currentTime: 10,
        duration: 100,
        isPlaying: true,
        playbackRate: 1.5,
        sampledAt: 1_000,
      },
      3_000
    );

    expect(projected.currentTime).toBeCloseTo(13);
  });

  it("does not project paused samples and never projects beyond duration", () => {
    expect(
      projectRemotePlaybackClock(
        { currentTime: 42, duration: 100, isPlaying: false, playbackRate: 2, sampledAt: 1_000 },
        10_000
      ).currentTime
    ).toBe(42);

    expect(
      projectRemotePlaybackClock(
        { currentTime: 98, duration: 100, isPlaying: true, playbackRate: 2, sampledAt: 1_000 },
        10_000
      ).currentTime
    ).toBe(100);
  });

  it("publishes snapshots, supports unsubscribe, and resets remote playback", () => {
    const source = new RemotePlaybackClockSource();
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    source.setSnapshot({
      currentTime: 12,
      duration: 90,
      isPlaying: true,
      playbackRate: 1,
      sampledAt: 5_000,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot().currentTime).toBe(12);

    unsubscribe();
    source.reset();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot()).toMatchObject({ currentTime: 0, duration: 0, isPlaying: false });
  });
});
