/**
 * Autofetch Lyrics: cache-first behaviour, provider coverage (only unchecked providers run),
 * Not Found cooldown, independent provider timeouts, priority-over-speed selection, seamless
 * upgrade decisions and manual-lyrics protection. Runs the real service/cache over mocked HTTP,
 * following the existing provider suites.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { ConcurrencyLimiter } from "../../src/main/lyrics/http";
import { LibraryStore } from "../../src/main/library/store";
import { LYRIC_SOURCE_KEYS } from "../../src/shared/upstream/better-lyrics/constants";
import {
  isManualSelection,
  pickPreferredCandidate,
  shouldApplyUpgrade,
} from "../../src/renderer/features/lyrics/upgrade";
import type { LyricsCandidate } from "../../src/shared/types";

const LINE_LRC = "[00:12.30]first line\n[00:15.00]second line";
const TTML_WORD = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:00:12.300" end="00:00:15.000"><span begin="00:00:12.300" end="00:00:12.800">First </span><span begin="00:00:12.800" end="00:00:15.000">line</span></p>
<p begin="00:00:15.000" end="00:00:18.000"><span begin="00:00:15.000" end="00:00:15.600">Second </span><span begin="00:00:15.600" end="00:00:18.000">line</span></p>
</div></body></tt>`;

const QUERY = { title: "Harness Song", artist: "Harness Artist", album: "Test Bench", duration: 200 };
const tempDirs: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Full provider order with only the named network slots switched on (rest `d_` disabled). */
function orderWithEnabled(enabled: string[]): string[] {
  const local = new Set(["local-rich", "local-lrc", "embedded-tag"]);
  return LYRIC_SOURCE_KEYS.map(key => (local.has(key) || enabled.includes(key) ? key : `d_${key}`));
}

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-autofetch-"));
  tempDirs.push(dir);
  const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
    disableSqlite: true,
  });
  const cacheFile = join(dir, "lyrics.json");
  const cache = new LyricsCache(cacheFile);
  return { dir, store, cache, cacheFile, service: new LyricsService(store, cache) };
}

const request = (overrides: Record<string, unknown> = {}) =>
  ({ trackId: 1, ...QUERY, ...overrides }) as Parameters<LyricsService["resolve"]>[0];

const lrclibHit = () =>
  json({
    id: 99,
    trackName: QUERY.title,
    artistName: QUERY.artist,
    albumName: QUERY.album,
    duration: QUERY.duration,
    instrumental: false,
    plainLyrics: null,
    syncedLyrics: LINE_LRC,
  });

function hostRoutedFetch(routes: {
  blyrics?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  unison?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  binimum?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  lrclib?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}): typeof fetch {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const target = url.includes("api.betterlyrics.org")
      ? (routes.blyrics ?? (() => json({ error: "not found" }, 404)))
      : url.includes("unison.betterlyrics.org")
        ? (routes.unison ?? (() => json({ success: false, code: "NOT_FOUND" }, 404)))
        : url.includes("binimum.org")
          ? (routes.binimum ?? (() => json({ total: 0, source: "HIT-LOCAL-LIBSQL", results: [] })))
          : (routes.lrclib ?? (() => json({}, 404)));
    return target(url, init);
  }) as unknown as typeof fetch;
}

function countCalls(fetchMock: ReturnType<typeof vi.fn>, fragment: string): number {
  return fetchMock.mock.calls.filter(call => String(call[0]).includes(fragment)).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Autofetch cache + coverage behaviour", () => {
  it("serves a fresh cached answer without any network request and records provider coverage", async () => {
    const { service, cache, cacheFile } = makeService();
    const fetchMock = vi.fn(hostRoutedFetch({ lrclib: () => lrclibHit() }));
    vi.stubGlobal("fetch", fetchMock);
    const order = orderWithEnabled(["lrclib-synced"]);

    const first = await service.resolve(request(), order);
    expect(first.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    expect(first.definitive).toBe(true);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await service.resolve(request(), order);
    expect(second.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

    cache.flush();
    await new Promise(resolve => setTimeout(resolve, 20));
    const entries = JSON.parse(readFileSync(cacheFile, "utf8")).entries as Record<string, any>;
    const entry = entries["track:1"];
    expect(entry.network.queriedModules).toContain("lrclib");
    expect(entry.network.enabledKeys).toContain("lrclib-synced");
    expect(cache.stats().entries).toBe(1);
  });

  it("searches only newly enabled providers and merges them with the cached result (upgrade)", async () => {
    const { service } = makeService();
    const fetchMock = vi.fn(
      hostRoutedFetch({
        lrclib: () => lrclibHit(),
        unison: () =>
          json({ success: true, data: { id: 1, format: "ttml", syncType: "richsync", lyrics: TTML_WORD } }),
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const onlyLrclib = orderWithEnabled(["lrclib-synced"]);
    const first = await service.resolve(request(), onlyLrclib);
    expect(first.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    const lrclibCallsAfterFirst = countCalls(fetchMock, "lrclib.net");
    expect(countCalls(fetchMock, "unison.betterlyrics.org")).toBe(0);

    // The user enables Unison: only Unison runs; the cached LRCLIB answer is not re-fetched,
    // and both end up cached, ordered by the user's provider order (Unison ranks higher).
    const withUnison = orderWithEnabled(["lrclib-synced", "unison-richsynced"]);
    const second = await service.resolve(request(), withUnison);
    expect(second.candidates.map(c => c.source)).toEqual(["unison-richsynced", "lrclib-synced"]);
    expect(countCalls(fetchMock, "unison.betterlyrics.org")).toBeGreaterThan(0);
    expect(countCalls(fetchMock, "lrclib.net")).toBe(lrclibCallsAfterFirst);

    // Third pass: everything covered — fully cache-served.
    const callsAfterSecond = fetchMock.mock.calls.length;
    const third = await service.resolve(request(), withUnison);
    expect(third.candidates.map(c => c.source)).toEqual(["unison-richsynced", "lrclib-synced"]);
    expect(fetchMock.mock.calls.length).toBe(callsAfterSecond);
  });

  it("forceRefresh (manual retry) bypasses the Not Found cooldown", async () => {
    const { service } = makeService();
    const fetchMock = vi.fn(hostRoutedFetch({}));
    vi.stubGlobal("fetch", fetchMock);
    const order = orderWithEnabled(["lrclib-synced", "unison-synced", "blyrics-synced"]);

    const first = await service.resolve(request(), order);
    expect(first.candidates).toEqual([]);
    expect(first.definitive).toBe(true);
    const callsAfterFirst = fetchMock.mock.calls.length;

    const cached = await service.resolve(request(), order);
    expect(cached.candidates).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

    await service.resolve(request({ forceRefresh: true }), order);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("reinterprets the stored attempt timestamp when the cooldown setting changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-cooldown-"));
    tempDirs.push(dir);
    const cacheFile = join(dir, "lyrics.json");
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 3,
        entries: {
          "track:1": {
            savedAt: Date.now(),
            kind: "track",
            track: { id: 1, title: QUERY.title, artist: QUERY.artist, album: QUERY.album, duration: QUERY.duration },
            candidates: [],
            network: {
              savedAt: twoDaysAgo,
              negative: true,
              candidates: [],
              queriedModules: ["lrclib"],
              enabledKeys: ["lrclib-synced"],
            },
          },
        },
      }),
      "utf8"
    );
    const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
      disableSqlite: true,
    });
    const cache = new LyricsCache(cacheFile);
    const service = new LyricsService(store, cache);
    const fetchMock = vi.fn(hostRoutedFetch({ lrclib: () => lrclibHit() }));
    vi.stubGlobal("fetch", fetchMock);
    const order = orderWithEnabled(["lrclib-synced"]);

    cache.setNegativeTtlMs(7 * 24 * 60 * 60 * 1000);
    const withinCooldown = await service.resolve(request(), order);
    expect(withinCooldown.candidates).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(0);

    // Shortening the cooldown to 1 day makes the very same stored timestamp eligible at once.
    cache.setNegativeTtlMs(1 * 24 * 60 * 60 * 1000);
    const afterCooldown = await service.resolve(request(), order);
    expect(afterCooldown.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("times out a hanging provider independently and never calls the track Not Found", async () => {
    const { service } = makeService();
    service.setModuleTimeoutMs(60);
    const hanging = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    const fetchMock = vi.fn(hostRoutedFetch({ unison: hanging }));
    vi.stubGlobal("fetch", fetchMock);
    const order = orderWithEnabled(["unison-synced", "lrclib-synced"]);

    const result = await service.resolve(request(), order);
    expect(result.candidates).toEqual([]);
    expect(result.definitive).toBe(false);
    expect(result.providerStatus.find(s => s.provider === "unison")).toMatchObject({
      status: "error",
      detail: "Request timed out",
    });

    // Not negative-cached: a later resolve tries the network again.
    const callsAfterFirst = fetchMock.mock.calls.length;
    await service.resolve(request(), order);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("selects by provider priority, not by response speed", async () => {
    const { service } = makeService();
    const slow = (response: Response) =>
      new Promise<Response>(resolve => setTimeout(() => resolve(response), 70));
    vi.stubGlobal(
      "fetch",
      hostRoutedFetch({
        // Better Lyrics is slow but ranks first; LRCLIB answers instantly.
        blyrics: async url => (url.includes("/getLyrics") ? slow(json({ ttml: TTML_WORD })) : json({ error: "no" }, 404)),
        lrclib: () => lrclibHit(),
      })
    );
    const order = orderWithEnabled(["blyrics-richsynced", "lrclib-synced"]);
    const result = await service.resolve(request(), order);
    expect(result.candidates[0].source).toBe("blyrics-richsynced");
    expect(result.candidates.map(c => c.source)).toContain("lrclib-synced");
  });
});

describe("central concurrency limiter", () => {
  it("never exceeds its bound and releases waiters FIFO", async () => {
    const limiter = new ConcurrencyLimiter(3);
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        limiter.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(index);
          await new Promise(resolve => setTimeout(resolve, 5));
          active -= 1;
        })
      )
    );
    expect(maxActive).toBe(3);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("raising the limit immediately releases queued work", async () => {
    const limiter = new ConcurrencyLimiter(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const first = limiter.run(() => gate);
    let secondRan = false;
    const second = limiter.run(async () => {
      secondRan = true;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(secondRan).toBe(false);
    limiter.setLimit(2);
    await second;
    expect(secondRan).toBe(true);
    release();
    await first;
  });
});

describe("seamless upgrade decisions (renderer)", () => {
  const order = [...LYRIC_SOURCE_KEYS];
  const candidate = (source: string): LyricsCandidate => ({
    source,
    provider: source,
    text: LINE_LRC,
    syncHint: "synced",
    language: null,
    songwriters: [],
    sourceHref: null,
    cached: false,
  });

  it("picks the explicit selection first, then a hand-picked file, then priority order", () => {
    const list = [candidate("lrclib-synced"), candidate("unison-synced")];
    expect(pickPreferredCandidate(list, "unison-synced")?.source).toBe("unison-synced");
    expect(pickPreferredCandidate(list, undefined)?.source).toBe("lrclib-synced");
    const withFile = [candidate("lrclib-synced"), candidate("user-file")];
    expect(pickPreferredCandidate(withFile, undefined)?.source).toBe("user-file");
  });

  it("never replaces a manual selection and never downgrades priority", () => {
    expect(
      shouldApplyUpgrade({ currentSource: "user-file", nextSource: "blyrics-richsynced", providerOrder: order, manual: true })
    ).toBe(false);
    expect(
      shouldApplyUpgrade({ currentSource: "unison-synced", nextSource: "unison-synced", providerOrder: order, manual: true })
    ).toBe(true);
    // local-rich (rank 0) on screen; a late LRCLIB answer must not displace it.
    expect(
      shouldApplyUpgrade({ currentSource: "local-rich", nextSource: "lrclib-synced", providerOrder: order, manual: false })
    ).toBe(false);
    // LRCLIB fallback on screen; a word-synced TTML upgrades it.
    expect(
      shouldApplyUpgrade({ currentSource: "lrclib-synced", nextSource: "blyrics-richsynced", providerOrder: order, manual: false })
    ).toBe(true);
    expect(
      shouldApplyUpgrade({ currentSource: null, nextSource: "lrclib-synced", providerOrder: order, manual: false })
    ).toBe(true);
    expect(isManualSelection("user-file", undefined)).toBe(true);
    expect(isManualSelection("lrclib-synced", "lrclib-synced")).toBe(true);
    expect(isManualSelection("lrclib-synced", undefined)).toBe(false);
  });
});

describe("manual lyrics protection (service)", () => {
  it("keeps a hand-picked file across automatic resolves and restarts", async () => {
    const { service, store, cache, cacheFile } = makeService();
    const { id } = store.upsertTrack({
      path: "/music/Harness Song.flac",
      title: QUERY.title,
      artist: QUERY.artist,
      albumArtist: QUERY.artist,
      album: QUERY.album,
      genre: "",
      year: null,
      trackNo: 1,
      discNo: 1,
      duration: QUERY.duration,
      bitrate: null,
      sampleRate: null,
      channels: 2,
      codec: "FLAC",
      fileSize: 10,
      mtimeMs: 1,
      artworkFile: null,
      animatedArtPath: null,
      accentColor: null,
      hasSidecarLyrics: false,
      hasEmbeddedLyrics: false,
      playable: true,
    } as never);
    service.rememberUserFile(id, "/chosen/manual.ttml", TTML_WORD);
    cache.flush();
    await new Promise(resolve => setTimeout(resolve, 20));

    const fetchMock = vi.fn(hostRoutedFetch({ lrclib: () => lrclibHit() }));
    vi.stubGlobal("fetch", fetchMock);
    const order = orderWithEnabled(["lrclib-synced"]);
    const result = await service.resolve(request({ trackId: id }), order);
    const manual = result.candidates.find(c => c.source === "user-file");
    expect(manual?.text).toBe(TTML_WORD);
    // And the renderer-side pick keeps it on screen over the automatic match.
    expect(pickPreferredCandidate(result.candidates, undefined)?.source).toBe("user-file");
    const stored = JSON.parse(readFileSync(cacheFile, "utf8")).entries[`track:${id}`];
    expect(stored.candidates.some((c: any) => c.origin === "manual")).toBe(true);
  });
});
