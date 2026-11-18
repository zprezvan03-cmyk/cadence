import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { PlaybackTelemetryTracker } from "../../src/shared/listeningTelemetry";
import { LibraryStore } from "../../src/main/library/store";
import { useIntelligence } from "../../src/renderer/state/intelligenceStore";

describe("PlaybackTelemetryTracker — session-safe, idempotent telemetry", () => {
  it("records a natural completion once listened time crosses 50% (or 240s) and is idempotent on later manual skip", () => {
    const tracker = new PlaybackTelemetryTracker();
    tracker.startSession("occ-1:1", {
      trackId: 10,
      title: "Starlight",
      artist: "Muse",
      durationSeconds: 200,
    });

    // Simulate 100s of genuine playback in 1s ticks (50% of 200s = 100s)
    let emitted = null;
    for (let t = 1; t <= 100; t++) {
      const ev = tracker.observeTick(t, 200, true, 1000 + t * 1000);
      if (ev) emitted = ev;
    }

    expect(emitted).not.toBeNull();
    expect(emitted?.outcome).toBe("completed");
    expect(emitted?.persisted).toBe(true);
    expect(emitted?.listenedSeconds).toBe(100);

    // Later ticks do not re-emit completion
    expect(tracker.observeTick(120, 200, true, 121_000)).toBeNull();

    // User clicks "Next" manually at 150s -> must be a no-op because session already completed!
    expect(tracker.finalizeCurrent("manual-skip", 151_000)).toBeNull();
    // Natural end after that is also a no-op
    expect(tracker.finalizeCurrent("natural-end", 200_000)).toBeNull();
  });

  it("distinguishes rapid browsing (<2s), genuine early skip (2s..35%), and partial listen (>=35%)", () => {
    const tracker = new PlaybackTelemetryTracker();

    // 1. Rapid click-through (< 2s heard) -> "browsed" (not persisted as skip)
    tracker.startSession("occ-1:1", {
      trackId: 1,
      title: "Track 1",
      artist: "Artist 1",
      durationSeconds: 180,
    });
    tracker.observeTick(1.2, 180, true, 2000);
    const browsed = tracker.finalizeCurrent("manual-skip", 2500);
    expect(browsed?.outcome).toBe("browsed");
    expect(browsed?.persisted).toBe(false);

    // 2. Genuine early skip (8s heard out of 180s) -> "skipped" (persisted)
    tracker.startSession("occ-2:2", {
      trackId: 2,
      title: "Track 2",
      artist: "Artist 2",
      durationSeconds: 180,
    });
    for (let t = 1; t <= 8; t++) {
      tracker.observeTick(t, 180, true, 10_000 + t * 1000);
    }
    const skipped = tracker.finalizeCurrent("manual-skip", 19_000);
    expect(skipped?.outcome).toBe("skipped");
    expect(skipped?.persisted).toBe(true);
    expect(skipped?.listenedSeconds).toBe(8);
    // Calling finalizeCurrent a second time is idempotent
    expect(tracker.finalizeCurrent("manual-skip", 19_500)).toBeNull();

    // 3. Partial listen (45s heard out of 180s, where earlySkipCeiling is 35s and completion is 90s) -> "partial"
    tracker.startSession("occ-3:3", {
      trackId: 3,
      title: "Track 3",
      artist: "Artist 3",
      durationSeconds: 180,
    });
    for (let t = 1; t <= 45; t++) {
      tracker.observeTick(t, 180, true, 30_000 + t * 1000);
    }
    const partial = tracker.finalizeCurrent("manual-skip", 80_000);
    expect(partial?.outcome).toBe("partial");
    expect(partial?.persisted).toBe(false);
  });

  it("does not credit seek jumps as listened time and prevents end-scrubbing from faking completion", () => {
    const tracker = new PlaybackTelemetryTracker();
    tracker.startSession("occ-seek:1", {
      trackId: 5,
      title: "Long Song",
      artist: "Prog Band",
      durationSeconds: 300,
    });

    // Listen for 5 seconds
    for (let t = 1; t <= 5; t++) {
      tracker.observeTick(t, 300, true, t * 1000);
    }
    expect(tracker.getAccumulatedListenSeconds()).toBe(5);

    // User scrubs directly to 295s (98% of the song)
    tracker.observeSeek(295, 300);

    // Play the remaining 5 seconds until natural end
    for (let t = 296; t <= 300; t++) {
      tracker.observeTick(t, 300, true, t * 1000);
    }
    expect(tracker.getAccumulatedListenSeconds()).toBe(10);

    // Natural end fires, but because the user scrubbed to the end with only 10s heard, it's "partial", not "completed"
    const outcome = tracker.finalizeCurrent("natural-end", 301_000);
    expect(outcome?.outcome).toBe("partial");
    expect(outcome?.persisted).toBe(false);
  });

  it("never penalizes a track when a playback or decode error occurs", () => {
    const tracker = new PlaybackTelemetryTracker();
    tracker.startSession("occ-err:1", {
      trackId: 9,
      title: "Corrupt File",
      artist: "Broken Codec",
      durationSeconds: 200,
    });

    tracker.observeTick(3, 200, true, 3000);
    const errEvent = tracker.markPlaybackError(4000);
    expect(errEvent?.outcome).toBe("error");
    expect(errEvent?.persisted).toBe(false);

    // Subsequent manual skip after error must not emit a "skipped" event
    expect(tracker.finalizeCurrent("manual-skip", 5000)).toBeNull();
  });

  it("detects repeat-one loops and starts a fresh telemetry session for the replay", () => {
    const tracker = new PlaybackTelemetryTracker();
    tracker.startSession("occ-loop:1", {
      trackId: 12,
      title: "Short Interlude",
      artist: "Loop Artist",
      durationSeconds: 30,
    });

    for (let t = 1; t <= 29; t++) {
      tracker.observeTick(t, 30, true, t * 1000);
    }
    expect(tracker.getActiveSessionId()).toBe("occ-loop:1");

    // Loop wraps back to 0.2s
    tracker.observeTick(0.2, 30, true, 30_200);
    expect(tracker.getActiveSessionId()).toBe("occ-loop:1:loop-1");
    expect(tracker.getAccumulatedListenSeconds()).toBe(0);
  });
});

describe("track_intelligence persistence & store integration", () => {
  beforeEach(() => {
    useIntelligence.getState().resetForTests();
  });

  it("persists and reloads track_intelligence records in SQLite LibraryStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-intel-"));
    try {
      const dbPath = join(dir, "library.db");
      const artDir = join(dir, "artwork");
      const store = new LibraryStore(dbPath, artDir, p => p);

      store.upsertIntelligence([
        {
          recordingKey: "muse|starlight|240",
          trackId: 10,
          artist: "Muse",
          title: "Starlight",
          popularity: 0.84,
          popularitySource: "lastfm",
          popularityConfidence: 0.9,
          externalListeners: 1_250_000,
          externalGenres: ["Alternative Rock", "Space Rock"],
          fetchedAt: 1_700_000_000_000,
          expiresAt: 1_702_592_000_000,
          skipCount: 1,
          completeCount: 9,
          lastSkippedAt: 1_699_000_000_000,
          lastCompletedAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
      ]);

      const rows = store.listIntelligence();
      expect(rows).toHaveLength(1);
      expect(rows[0].recordingKey).toBe("muse|starlight|240");
      expect(rows[0].popularity).toBeCloseTo(0.84, 4);
      expect(rows[0].externalGenres).toEqual(["Alternative Rock", "Space Rock"]);
      expect(rows[0].skipCount).toBe(1);
      expect(rows[0].completeCount).toBe(9);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates skipCount and completeCount optimistically in useIntelligence store", () => {
    const tracker = new PlaybackTelemetryTracker();
    tracker.startSession("s1", {
      trackId: 42,
      title: "paranoid android",
      artist: "Radiohead",
      durationSeconds: 380,
    });
    for (let t = 1; t <= 6; t++) {
      tracker.observeTick(t, 380, true, t * 1000);
    }
    const skipEv = tracker.finalizeCurrent("manual-skip", 7000);
    const updatedAfterSkip = useIntelligence.getState().applyTelemetryEvent(skipEv);
    expect(updatedAfterSkip?.skipCount).toBe(1);
    expect(updatedAfterSkip?.completeCount).toBe(0);

    // Second play: user completes the song
    tracker.startSession("s2", {
      trackId: 42,
      title: "Paranoid Android",
      artist: "Radiohead",
      durationSeconds: 380,
    });
    let compEv = null;
    for (let t = 1; t <= 200; t += 2) {
      const ev = tracker.observeTick(t, 380, true, 10_000 + t * 1000);
      if (ev) compEv = ev;
    }
    const updatedAfterComplete = useIntelligence.getState().applyTelemetryEvent(compEv);
    expect(updatedAfterComplete?.skipCount).toBe(1);
    expect(updatedAfterComplete?.completeCount).toBe(1);
  });
});
