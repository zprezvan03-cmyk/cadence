import { describe, expect, it, vi } from "vitest";
import { parseYouTubeVideoId } from "../../src/shared/youtube";
import {
  RemotePlaybackClockSource,
  normalizeRemotePlaybackClock,
  projectRemotePlaybackClock,
} from "../../src/renderer/player/playbackClock";
import {
  YOUTUBE_PLAYER_SIZES,
  mapYouTubePlayerError,
  resolveYouTubePlayerOrigin,
  youtubePlayerStateName,
} from "../../src/renderer/features/youtube/youtubePlayerUtils";

describe("YouTube Phase B link scope", () => {
  it("rejects a playlist-only link because there is no video to cue", () => {
    expect(parseYouTubeVideoId("https://music.youtube.com/playlist?list=PL1234567890")).toBeNull();
    expect(parseYouTubeVideoId("https://www.youtube.com/playlist?list=PL1234567890")).toBeNull();
  });

  it("loads only the video from a watch link that also names a playlist", () => {
    expect(
      parseYouTubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ")
    ).toBe("dQw4w9WgXcQ");
  });
});

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

describe("official YouTube player helpers", () => {
  it("keeps Cadence's two supported player sizes at the required dimensions", () => {
    expect(YOUTUBE_PLAYER_SIZES.compact).toEqual({ width: 200, height: 200 });
    expect(YOUTUBE_PLAYER_SIZES.expanded).toEqual({ width: 480, height: 270 });
  });

  it("maps the documented IFrame player state codes", () => {
    expect(youtubePlayerStateName(-1)).toBe("unstarted");
    expect(youtubePlayerStateName(0)).toBe("ended");
    expect(youtubePlayerStateName(1)).toBe("playing");
    expect(youtubePlayerStateName(2)).toBe("paused");
    expect(youtubePlayerStateName(3)).toBe("buffering");
    expect(youtubePlayerStateName(5)).toBe("cued");
    expect(youtubePlayerStateName(99)).toBe("unknown");
  });

  it("maps unavailable and non-embeddable videos to actionable copy", () => {
    expect(mapYouTubePlayerError(100)).toMatchObject({ kind: "not-found" });
    expect(mapYouTubePlayerError(101)).toMatchObject({ kind: "not-embeddable" });
    expect(mapYouTubePlayerError(150)).toMatchObject({ kind: "not-embeddable" });
    expect(mapYouTubePlayerError(2)).toMatchObject({ kind: "invalid-parameter" });
    expect(mapYouTubePlayerError(5)).toMatchObject({ kind: "player" });
    expect(mapYouTubePlayerError(null).message).toContain("could not be loaded");
  });

  it("passes through the real runtime origin and omits opaque origins", () => {
    expect(
      resolveYouTubePlayerOrigin({
        origin: "http://tauri.localhost",
        protocol: "http:",
        host: "tauri.localhost",
      } as Location)
    ).toBe("http://tauri.localhost");

    expect(
      resolveYouTubePlayerOrigin({
        origin: "null",
        protocol: "https:",
        host: "example.test:1420",
      } as Location)
    ).toBe("https://example.test:1420");

    expect(
      resolveYouTubePlayerOrigin({
        origin: "null",
        protocol: "tauri:",
        host: "localhost",
      } as Location)
    ).toBeUndefined();
  });
});
