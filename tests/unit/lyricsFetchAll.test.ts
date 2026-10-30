/**
 * Fetch All Lyrics: queue generation/priority, duplicate recordings, dynamic promotion,
 * failure classification, pause/resume/cancel/retry, persistence across restarts, and the
 * shared request coordination with Autofetch (real service, mocked HTTP).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LyricsFetchAllCore,
  classifyResolveResult,
  orderFetchQueue,
  type FetchAllDeps,
  type FetchTrackInfo,
} from "../../src/main/lyrics/fetchAllCore";
import { clusterRecordings } from "../../src/main/lyrics/recordingIdentity";
import type { TrackLyricsAssessment } from "../../src/main/lyrics/serviceCore";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { LibraryStore } from "../../src/main/library/store";
import type { LyricsCandidate, LyricsFetchJobSnapshot, LyricsResolveResult } from "../../src/shared/types";

const LINE_LRC = "[00:12.30]first line\n[00:15.00]second line";
const candidate: LyricsCandidate = {
  source: "lrclib-synced",
  provider: "LRCLIB Line",
  text: LINE_LRC,
  syncHint: "synced",
  language: null,
  songwriters: [],
  sourceHref: null,
  cached: false,
};

const foundResult: LyricsResolveResult = { candidates: [candidate], providerStatus: [], definitive: true };
const notFoundResult: LyricsResolveResult = { candidates: [], providerStatus: [], definitive: true };
const failedResult: LyricsResolveResult = {
  candidates: [],
  providerStatus: [{ provider: "lrclib", status: "error", detail: "Network error: boom" }],
  definitive: false,
};

function track(id: number, overrides: Partial<FetchTrackInfo> = {}): FetchTrackInfo {
  return {
    id,
    title: `Song ${id}`,
    artist: "Artist",
    album: "Album",
    duration: 200,
    hasSidecarLyrics: false,
    hasEmbeddedLyrics: false,
    lastPlayedAt: null,
    ...overrides,
  };
}

const needsWork: TrackLyricsAssessment = {
  needsWork: true,
  reason: "never-queried",
  hasLyrics: false,
  fullyProcessed: false,
};

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

interface EngineHarness {
  core: LyricsFetchAllCore;
  resolveCalls: { trackId: number; force: boolean }[];
  snapshots: LyricsFetchJobSnapshot[];
  savedJson: () => string;
  shareCalls: { from: number; to: number }[];
}

function makeEngine(
  tracks: FetchTrackInfo[],
  options: {
    resolveTrack?: FetchAllDeps["resolveTrack"];
    assess?: (track: FetchTrackInfo) => TrackLyricsAssessment;
    parallelTracks?: number;
    priority?: { currentTrackId: number | null; historyTrackIds: number[] };
    initialJson?: string | null;
  } = {}
): EngineHarness {
  const resolveCalls: EngineHarness["resolveCalls"] = [];
  const snapshots: LyricsFetchJobSnapshot[] = [];
  const shareCalls: EngineHarness["shareCalls"] = [];
  let saved = "";
  let idCounter = 0;
  const deps: FetchAllDeps = {
    tracksPage: (offset, limit) => ({
      tracks: tracks.slice(offset, offset + limit),
      total: tracks.length,
    }),
    getTrack: trackId => tracks.find(t => t.id === trackId) ?? null,
    assess: options.assess ?? (t => (t.title.trim() ? needsWork : { needsWork: false, reason: "invalid-metadata", hasLyrics: false, fullyProcessed: false })),
    resolveTrack: async (t, opts) => {
      resolveCalls.push({ trackId: t.id, force: opts.force });
      return options.resolveTrack ? options.resolveTrack(t, opts) : foundResult;
    },
    shareResult: (from, to) => {
      shareCalls.push({ from, to: to.id });
      return true;
    },
    getPriority: async () => options.priority ?? { currentTrackId: null, historyTrackIds: [] },
    getParallelTracks: () => options.parallelTracks ?? 1,
    onProgress: snapshot => snapshots.push(snapshot),
    idFactory: () => `job-${++idCounter}`,
  };
  const core = new LyricsFetchAllCore(deps, {
    initialJson: options.initialJson ?? null,
    persist: json => {
      saved = json;
    },
  });
  return { core, resolveCalls, snapshots, savedJson: () => saved, shareCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queue priority ordering", () => {
  it("orders current, then history newest-first, then previously played, then library order", () => {
    const tracks = [
      track(1),
      track(2, { lastPlayedAt: 100 }),
      track(3),
      track(4, { lastPlayedAt: 300 }),
      track(5),
      track(6, { lastPlayedAt: 200 }),
    ];
    const ordered = orderFetchQueue(tracks, { currentTrackId: 5, historyTrackIds: [3, 2, 3] });
    expect(ordered.map(t => t.id)).toEqual([5, 3, 2, 4, 6, 1]);
  });
});

describe("duplicate recording detection", () => {
  it("shares a key for the same recording but never merges versions", () => {
    const base = { artist: "Artist" };
    const keys = clusterRecordings([
      { id: 1, title: "Song", duration: 200, ...base },
      { id: 2, title: "song", duration: 201.4, ...base },
      { id: 3, title: "Song (Live)", duration: 200, ...base },
      { id: 4, title: "Song (Remix)", duration: 200, ...base },
      { id: 5, title: "Song (Instrumental)", duration: 200, ...base },
      { id: 6, title: "Song (Karaoke Version)", duration: 200, ...base },
      { id: 7, title: "Song", duration: 215, ...base },
      { id: 8, title: "Song", duration: 200, artist: "Cover Band" },
      { id: 9, title: "", duration: 200, ...base },
      { id: 10, title: "Song", duration: 0, ...base },
    ]);
    expect(keys.get(1)).toBe(keys.get(2));
    for (const other of [3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(keys.get(other)).not.toBe(keys.get(1));
    }
    expect(keys.get(9)).toBe("track:9");
    expect(keys.get(10)).toBe("track:10");
  });
});

describe("result classification", () => {
  it("distinguishes found, proven not-found, temporary failure and rate limiting", () => {
    expect(classifyResolveResult(foundResult)).toBe("found");
    expect(classifyResolveResult(notFoundResult)).toBe("not-found");
    expect(classifyResolveResult(failedResult)).toBe("failed");
    expect(
      classifyResolveResult({
        candidates: [],
        definitive: false,
        providerStatus: [{ provider: "unison", status: "error", detail: "Rate limited; retry after 30s" }],
      })
    ).toBe("rate-limited");
    // A timeout with no candidates is a failure, never a proven not-found.
    expect(
      classifyResolveResult({
        candidates: [],
        definitive: false,
        providerStatus: [{ provider: "unison", status: "error", detail: "Request timed out" }],
      })
    ).toBe("failed");
  });
});

describe("Fetch All engine", () => {
  it("builds the queue from assessments, skips processed/cooldown tracks, completes with a summary", async () => {
    const tracks = [track(1), track(2), track(3), track(4, { title: "  " }), track(5)];
    const assess = (t: FetchTrackInfo): TrackLyricsAssessment => {
      if (!t.title.trim()) return { needsWork: false, reason: "invalid-metadata", hasLyrics: false, fullyProcessed: false };
      if (t.id === 3) return { needsWork: false, reason: "fully-processed", hasLyrics: true, fullyProcessed: true };
      if (t.id === 5) return { needsWork: false, reason: "not-found-cooldown", hasLyrics: false, fullyProcessed: true };
      return needsWork;
    };
    const { core, resolveCalls } = makeEngine(tracks, {
      assess,
      resolveTrack: async t => (t.id === 2 ? notFoundResult : foundResult),
    });

    const started = await core.start();
    expect(started.state).toBe("running");
    // Tracks 1+2 queued, track 4 terminal invalid, 3 and 5 not queued at all.
    expect(started.total).toBe(3);

    await waitFor(() => core.snapshot().state === "completed");
    const done = core.snapshot();
    expect(done).toMatchObject({ found: 1, notFound: 1, failed: 0, skipped: 1, processed: 3 });
    expect(resolveCalls.map(c => c.trackId).sort()).toEqual([1, 2]);
    expect(core.entries().find(e => e.trackId === 4)?.status).toBe("invalid-metadata");
  });

  it("does not start a duplicate job while one is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const { core } = makeEngine([track(1)], {
      resolveTrack: async () => {
        await gate;
        return foundResult;
      },
    });
    const first = await core.start();
    const second = await core.start();
    expect(second.jobId).toBe(first.jobId);
    release();
    await waitFor(() => core.snapshot().state === "completed");
  });

  it("promotes a newly playing track to the front of pending work without duplicates", async () => {
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => (releaseFirst = resolve));
    const { core } = makeEngine([track(1), track(2), track(3), track(4)], {
      resolveTrack: async t => {
        order.push(t.id);
        if (t.id === 1) await firstGate;
        return foundResult;
      },
    });
    await core.start();
    await waitFor(() => order.length === 1);
    expect(core.promote(4)).toBe(true);
    expect(core.promote(4)).toBe(true); // idempotent: still a single entry
    releaseFirst();
    await waitFor(() => core.snapshot().state === "completed");
    expect(order).toEqual([1, 4, 2, 3]);
    expect(core.entries()).toHaveLength(4);
  });

  it("shares one network answer across duplicate recordings", async () => {
    const tracks = [
      track(1, { title: "Same Song", duration: 200 }),
      track(2, { title: "Same Song", duration: 201 }),
      track(3, { title: "Same Song (Live)", duration: 200 }),
    ];
    const { core, resolveCalls, shareCalls } = makeEngine(tracks);
    await core.start();
    await waitFor(() => core.snapshot().state === "completed");
    // Track 2 reuses track 1's answer; the live version is fetched independently.
    expect(resolveCalls.map(c => c.trackId)).toEqual([1, 3]);
    expect(shareCalls).toEqual([{ from: 1, to: 2 }]);
    expect(core.snapshot()).toMatchObject({ found: 3, total: 3 });
    expect(core.entries().find(e => e.trackId === 2)?.detail).toBe("Shared recording result");
  });

  it("never retries temporary failures automatically; Retry Failed re-queues with force", async () => {
    let succeed = false;
    const { core, resolveCalls } = makeEngine([track(1), track(2)], {
      resolveTrack: async t => (t.id === 2 && !succeed ? failedResult : foundResult),
    });
    await core.start();
    await waitFor(() => core.snapshot().state === "completed");
    expect(core.snapshot()).toMatchObject({ found: 1, failed: 1 });
    const callsAfterCompletion = resolveCalls.length;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(resolveCalls.length).toBe(callsAfterCompletion);
    expect(core.entries().find(e => e.trackId === 2)?.attempts).toBe(1);

    succeed = true;
    core.retryFailed();
    await waitFor(() => core.snapshot().state === "completed" && core.snapshot().failed === 0);
    expect(core.snapshot()).toMatchObject({ found: 2, failed: 0 });
    expect(resolveCalls.at(-1)).toEqual({ trackId: 2, force: true });
  });

  it("pauses and resumes without losing place", async () => {
    const order: number[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => (releaseFirst = resolve));
    const { core } = makeEngine([track(1), track(2)], {
      resolveTrack: async t => {
        order.push(t.id);
        if (t.id === 1) await gate;
        return foundResult;
      },
    });
    await core.start();
    await waitFor(() => order.length === 1);
    core.pause();
    releaseFirst();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(core.snapshot()).toMatchObject({ state: "paused", processed: 1 });
    expect(order).toEqual([1]);

    core.resume();
    await waitFor(() => core.snapshot().state === "completed");
    expect(order).toEqual([1, 2]);
  });

  it("cancel drops pending work, aborts in-flight work and preserves completed results", async () => {
    const { core, savedJson } = makeEngine([track(1), track(2), track(3)], {
      resolveTrack: (t, { signal }) => {
        if (t.id === 1) return Promise.resolve(foundResult);
        return new Promise<LyricsResolveResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      },
    });
    await core.start();
    await waitFor(() => core.entries().find(e => e.trackId === 2)?.status === "processing");
    const canceled = core.cancel();
    expect(canceled).toMatchObject({ state: "canceled", found: 1, skipped: 2 });
    expect(core.entries().find(e => e.trackId === 1)?.status).toBe("found");

    await core.flush();
    // A canceled job never auto-resumes after a restart.
    const restarted = makeEngine([track(1), track(2), track(3)], { initialJson: savedJson() });
    expect(restarted.core.restore().state).toBe("canceled");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(restarted.resolveCalls).toEqual([]);
  });

  it("persists enough to resume an unfinished job after a restart", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const first = makeEngine([track(1), track(2)], {
      resolveTrack: async () => {
        await gate;
        return foundResult;
      },
    });
    await first.core.start();
    await waitFor(() => first.resolveCalls.length === 1);
    await first.core.flush();
    const persisted = JSON.parse(first.savedJson());
    expect(persisted.job.state).toBe("running");
    expect(persisted.job.entries).toHaveLength(2);

    const restarted = makeEngine([track(1), track(2)], { initialJson: first.savedJson() });
    const restored = restarted.core.restore();
    expect(restored.state).toBe("running");
    await waitFor(() => restarted.core.snapshot().state === "completed");
    expect(restarted.core.snapshot()).toMatchObject({ found: 2, total: 2 });
    release();
  });

  it("reports library coverage statistics without starting a job", async () => {
    const { core, resolveCalls } = makeEngine([track(1), track(2), track(3)], {
      assess: t =>
        t.id === 1
          ? { needsWork: false, reason: "fully-processed", hasLyrics: true, fullyProcessed: true }
          : t.id === 2
            ? { needsWork: true, reason: "providers-unchecked", hasLyrics: true, fullyProcessed: false }
            : needsWork,
    });
    await expect(core.stats()).resolves.toEqual({
      totalTracks: 3,
      withLyrics: 2,
      needsSearch: 2,
      fullyProcessed: 1,
    });
    expect(resolveCalls).toEqual([]);
    expect(core.snapshot().state).toBe("idle");
  });
});

describe("shared coordination with the real lyrics service", () => {
  const QUERY = { title: "Harness Song", artist: "Harness Artist", album: "Test Bench", duration: 200 };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("Autofetch reuses Fetch All's in-flight request instead of duplicating provider calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-fetch-shared-"));
    try {
      const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
        disableSqlite: true,
      });
      const cache = new LyricsCache(join(dir, "lyrics.json"));
      const service = new LyricsService(store, cache);

      let lrclibCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("lrclib.net")) {
            lrclibCalls += 1;
            await new Promise(resolve => setTimeout(resolve, 90));
            return json({
              id: 99,
              trackName: QUERY.title,
              artistName: QUERY.artist,
              albumName: QUERY.album,
              duration: QUERY.duration,
              instrumental: false,
              plainLyrics: null,
              syncedLyrics: LINE_LRC,
            });
          }
          if (url.includes("binimum.org")) return json({ total: 0, source: "HIT-LOCAL-LIBSQL", results: [] });
          return json({ error: "not found" }, 404);
        })
      );

      const info: FetchTrackInfo = { id: 1, ...QUERY, hasSidecarLyrics: false, hasEmbeddedLyrics: false, lastPlayedAt: null };
      const harness = makeEngine([info], {
        assess: t => service.assessTrack(t),
        resolveTrack: (t, { signal }) =>
          service.resolve(
            { trackId: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration },
            undefined,
            signal
          ),
      });

      await harness.core.start();
      // The user starts playing the very track Fetch All is working on: Autofetch joins the
      // same in-flight provider fan-out, and the answer is cached for both consumers.
      const autofetch = await service.resolve({ trackId: 1, ...QUERY });
      expect(autofetch.candidates.map(c => c.source)).toContain("lrclib-synced");
      await waitFor(() => harness.core.snapshot().state === "completed");
      expect(harness.core.snapshot()).toMatchObject({ found: 1 });
      expect(lrclibCalls).toBe(1);

      // And the assessment now reflects the cached coverage: nothing left to do.
      expect(service.assessTrack(info)).toMatchObject({ needsWork: false, fullyProcessed: true, hasLyrics: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
