/**
 * Tests for the keyless BiniLyrics client and the manual-search orchestration in LyricsService.
 * Every network response is mocked — no test here reaches a live API.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { fetchBinimum, searchBinimum } from "../../src/main/lyrics/binimum";
import { LibraryStore } from "../../src/main/library/store";
import { parseLyricsText } from "../../src/renderer/features/lyrics/parseLyrics";
import {
  BINIMUM_BASE_URL,
  DEFAULT_PROVIDER_ORDER,
} from "../../src/shared/upstream/better-lyrics/constants";
import type { LyricsSearchRequest } from "../../src/shared/types";

const TTML_WORD = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:00:12.300" end="00:00:15.000"><span begin="00:00:12.300" end="00:00:12.800">First </span><span begin="00:00:12.800" end="00:00:15.000">line</span></p>
<p begin="00:00:15.000" end="00:00:18.000"><span begin="00:00:15.000" end="00:00:15.600">Second </span><span begin="00:00:15.600" end="00:00:18.000">line</span></p>
</div></body></tt>`;

const TTML_LINE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:00:12.300" end="00:00:15.000">First line</p>
<p begin="00:00:15.000" end="00:00:18.000">Second line</p>
</div></body></tt>`;

const QUERY = { title: "Harness Song", artist: "Harness Artist", album: "Test Bench", duration: 200 };
const ALL_KEYS = new Set(DEFAULT_PROVIDER_ORDER);
const FILE_URL = "https://files.binimum.org/lyrics/r1.ttml";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/xml" } });
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    track_name: "Harness Song",
    artist_name: "Harness Artist",
    album_name: "Test Bench",
    duration: 200,
    isrc: "XXHARNESS1",
    timing_type: "word",
    lyricsUrl: FILE_URL,
    ...overrides,
  };
}

function binimumMock(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    return handler(url);
  });
  return { fetchMock, calls };
}

describe("BiniLyrics client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the index then the TTML file and classifies word timing", async () => {
    const { fetchMock, calls } = binimumMock(url =>
      url.startsWith(BINIMUM_BASE_URL)
        ? json({ total: 1, results: [record()] })
        : text(TTML_WORD)
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBinimum(QUERY, ALL_KEYS);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(BINIMUM_BASE_URL);
    expect(calls[0]).toContain("track=Harness+Song");
    expect(calls[0]).toContain("artist=Harness+Artist");
    expect(calls[0]).toContain("album=Test+Bench");
    expect(calls[0]).toContain("duration=200");
    expect(calls[1]).toBe(FILE_URL);

    expect(result.statuses[0]).toMatchObject({ provider: "binimum", status: "hit" });
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate).toMatchObject({
      source: "binimum-richsynced",
      provider: "BiniLyrics",
      syncHint: "richsync",
      text: TTML_WORD,
      sourceHref: BINIMUM_BASE_URL,
      matchTitle: "Harness Song",
      matchArtist: "Harness Artist",
      matchAlbum: "Test Bench",
      matchDuration: 200,
    });
  });

  it("classifies line timing as line-synced", async () => {
    vi.stubGlobal(
      "fetch",
      binimumMock(url =>
        url.startsWith(BINIMUM_BASE_URL)
          ? json({ total: 1, results: [record({ timing_type: "line" })] })
          : text(TTML_LINE)
      ).fetchMock
    );

    const result = await fetchBinimum(QUERY, ALL_KEYS);

    expect(result.candidates[0]).toMatchObject({ source: "binimum-synced", syncHint: "synced" });
  });

  it("treats an empty index as a clean miss and never fetches a file", async () => {
    const { fetchMock, calls } = binimumMock(() => json({ total: 0, results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBinimum(QUERY, ALL_KEYS);

    expect(calls).toHaveLength(1);
    expect(result.candidates).toEqual([]);
    expect(result.statuses[0]).toMatchObject({ provider: "binimum", status: "miss" });
  });

  it("rejects a non-TTML storage response as a miss rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      binimumMock(url =>
        url.startsWith(BINIMUM_BASE_URL)
          ? json({ total: 1, results: [record()] })
          : new Response("<html><body>storage error</body></html>", { status: 200, headers: { "content-type": "text/html" } })
      ).fetchMock
    );

    const result = await fetchBinimum(QUERY, ALL_KEYS);

    expect(result.candidates).toEqual([]);
    expect(result.statuses[0].status).toBe("miss");
  });

  it("maps 404 to a miss and 429 Retry-After to a rate-limit error", async () => {
    const notFound = binimumMock(() => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", notFound.fetchMock);
    const miss = await fetchBinimum(QUERY, ALL_KEYS);
    expect(miss.statuses[0]).toMatchObject({ provider: "binimum", status: "miss" });

    vi.unstubAllGlobals();
    const limited = binimumMock(() =>
      new Response("slow down", { status: 429, headers: { "retry-after": "30" } })
    );
    vi.stubGlobal("fetch", limited.fetchMock);
    const error = await fetchBinimum(QUERY, ALL_KEYS);
    expect(error.candidates).toEqual([]);
    expect(error.statuses[0]).toMatchObject({ provider: "binimum", status: "error" });
    expect(error.statuses[0].detail).toContain("retry after 30");
  });

  it("survives malformed index JSON without throwing", async () => {
    vi.stubGlobal("fetch", binimumMock(() => new Response("not json", { status: 200 })).fetchMock);

    const result = await fetchBinimum(QUERY, ALL_KEYS);

    expect(result.candidates).toEqual([]);
    expect(result.statuses[0].status).toBe("error");
  });

  it("propagates an abort so a stale track lookup cannot finish", async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    vi.stubGlobal("fetch", hanging);
    const controller = new AbortController();
    const pending = fetchBinimum(QUERY, ALL_KEYS, controller.signal);
    controller.abort();

    // Provider clients surface aborts as a classified LyricsHttpError; isAbort() recognises it and
    // the service-level Promise.race still delivers the caller's own AbortError.
    await expect(pending).rejects.toMatchObject({ name: "LyricsHttpError", kind: "aborted" });
  });

  it("search returns every usable version with metadata and tolerates bad files", async () => {
    const records = [
      record({ id: "r1", lyricsUrl: "https://files.binimum.org/r1.ttml" }),
      record({ id: "r2", timing_type: "line", lyricsUrl: "https://files.binimum.org/r2.ttml" }),
      record({ id: "r3", lyricsUrl: "https://files.binimum.org/r3.ttml" }),
    ];
    vi.stubGlobal(
      "fetch",
      binimumMock(url => {
        if (url.startsWith(BINIMUM_BASE_URL)) return json({ total: 3, results: records });
        if (url.endsWith("/r1.ttml")) return text(TTML_WORD);
        if (url.endsWith("/r2.ttml")) return text(TTML_LINE);
        return text("<html>gone</html>");
      }).fetchMock
    );

    const result = await searchBinimum(QUERY, ALL_KEYS);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(c => c.source)).toEqual(["binimum-richsynced", "binimum-synced"]);
    expect(result.candidates[0].matchTitle).toBe("Harness Song");
    expect(result.statuses[0]).toMatchObject({ provider: "binimum", status: "hit" });
  });

  it("search caps at six file fetches and skips disabled source keys", async () => {
    const seven = Array.from({ length: 7 }, (_, index) =>
      record({ id: `r${index}`, lyricsUrl: `https://files.binimum.org/r${index}.ttml` })
    );
    const { fetchMock, calls } = binimumMock(url =>
      url.startsWith(BINIMUM_BASE_URL)
        ? json({ total: 7, results: seven })
        : text(TTML_WORD)
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchBinimum(QUERY, new Set(["binimum-synced"]));

    expect(calls.filter(url => url.endsWith(".ttml"))).toHaveLength(6);
    // Every fetched file is word-timed; with only the line-synced key enabled nothing is offered.
    expect(result.candidates).toEqual([]);
  });

  it("produces a candidate whose timings survive the renderer parse used on selection", () => {
    const parsed = parseLyricsText(TTML_WORD, QUERY.duration * 1000);

    expect(parsed.syncType).toBe("richsync");
    // The parser prepends an instrumental lead-in; the two timed lines are what selection renders.
    const timed = parsed.lyrics.filter(line => line.startTimeMs > 0);
    expect(timed).toHaveLength(2);
    expect(timed[0].startTimeMs).toBeCloseTo(12300);
    expect(timed[0].parts?.[0]).toMatchObject({ words: "First ", startTimeMs: 12300 });
  });
});

type Host = "blyrics" | "unison" | "binimum" | "lrclib";

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-search-"));
  const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
    disableSqlite: true,
  });
  const cache = new LyricsCache(join(dir, "lyrics.json"));
  return { service: new LyricsService(store, cache), dir };
}

/** Per-host router with clean-miss defaults so a default run is a definitive empty answer. */
function routedFetch(overrides: Partial<Record<Host, (url: string) => Response>> = {}) {
  const calls: Record<Host, string[]> = { blyrics: [], unison: [], binimum: [], lrclib: [] };
  const routes: Record<Host, (url: string) => Response> = {
    blyrics: () => new Response("not found", { status: 404 }),
    unison: () => json({ success: true, data: [] }),
    binimum: () => json({ total: 0, results: [] }),
    lrclib: () => json([]),
    ...overrides,
  };
  const fetchMock = vi.fn(async (url: string) => {
    const host: Host = url.includes("api.betterlyrics.org")
      ? "blyrics"
      : url.includes("unison.betterlyrics.org")
        ? "unison"
        : url.includes("binimum.org")
          ? "binimum"
          : "lrclib";
    calls[host].push(url);
    return routes[host](url);
  });
  return { fetchMock, calls };
}

function binimumHitRoute(): (url: string) => Response {
  return url =>
    url.startsWith(BINIMUM_BASE_URL)
      ? json({ total: 1, results: [record()] })
      : text(TTML_WORD);
}

const SEARCH_REQUEST: LyricsSearchRequest = {
  title: QUERY.title,
  artist: QUERY.artist,
  album: QUERY.album,
  duration: QUERY.duration,
};

describe("LyricsService.searchLyrics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caches a definitive result set and re-serves it without network, including offline", async () => {
    const { service } = makeService();
    const { fetchMock, calls } = routedFetch({ binimum: binimumHitRoute() });
    vi.stubGlobal("fetch", fetchMock);

    const first = await service.searchLyrics(SEARCH_REQUEST, DEFAULT_PROVIDER_ORDER);
    expect(first.cached).toBe(false);
    expect(first.results).toHaveLength(1);
    expect(first.results[0].source).toBe("binimum-richsynced");
    expect(calls.binimum).toHaveLength(2);

    const onlineCalls = fetchMock.mock.calls.length;
    const second = await service.searchLyrics(SEARCH_REQUEST, DEFAULT_PROVIDER_ORDER);
    expect(second.cached).toBe(true);
    expect(second.results[0].text).toBe(TTML_WORD);
    expect(fetchMock.mock.calls.length).toBe(onlineCalls);

    const offline = await service.searchLyrics(
      { ...SEARCH_REQUEST, localOnly: true },
      DEFAULT_PROVIDER_ORDER
    );
    expect(offline.cached).toBe(true);
    expect(offline.results).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBe(onlineCalls);
  });

  it("skips every module offline when the search was never cached", async () => {
    const { service } = makeService();
    const { fetchMock } = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.searchLyrics(
      { ...SEARCH_REQUEST, localOnly: true },
      DEFAULT_PROVIDER_ORDER
    );

    expect(result.results).toEqual([]);
    expect(result.cached).toBe(true);
    expect(result.providerStatus.length).toBeGreaterThan(0);
    expect(result.providerStatus.every(entry => entry.status === "skipped" && entry.detail === "Offline mode")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a blank title without touching the network", async () => {
    const { service } = makeService();
    const { fetchMock } = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.searchLyrics({ ...SEARCH_REQUEST, title: "   " }, DEFAULT_PROVIDER_ORDER);

    expect(result.results).toEqual([]);
    expect(result.providerStatus.every(entry => entry.detail === "Title required")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent identical searches into one network batch", async () => {
    const { service } = makeService();
    const { fetchMock, calls } = routedFetch({ binimum: binimumHitRoute() });
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([
      service.searchLyrics(SEARCH_REQUEST, DEFAULT_PROVIDER_ORDER),
      service.searchLyrics(SEARCH_REQUEST, DEFAULT_PROVIDER_ORDER),
    ]);

    expect(a.results).toHaveLength(1);
    expect(b.results).toHaveLength(1);
    // One index lookup shared by both callers, not two.
    expect(calls.binimum.filter(url => url.startsWith(BINIMUM_BASE_URL))).toHaveLength(1);
  });

  it("never negative-caches transient failures, so a retry reaches the network again", async () => {
    const { service } = makeService();
    const failing = routedFetch({
      blyrics: () => new Response("boom", { status: 500 }),
      unison: () => new Response("boom", { status: 500 }),
      binimum: () => new Response("boom", { status: 500 }),
      lrclib: () => new Response("boom", { status: 500 }),
    });
    vi.stubGlobal("fetch", failing.fetchMock);

    const first = await service.searchLyrics(SEARCH_REQUEST, DEFAULT_PROVIDER_ORDER);
    expect(first.results).toEqual([]);
    expect(first.providerStatus.some(entry => entry.status === "error")).toBe(true);
    const firstCalls = failing.fetchMock.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    const second = await service.searchLyrics(SEARCH_REQUEST, DEFAULT_PROVIDER_ORDER);
    expect(second.cached).toBe(false);
    expect(failing.fetchMock.mock.calls.length).toBeGreaterThan(firstCalls);
  });

  it("does not cache an empty answer so corrected spelling always reaches the providers", async () => {
    const { service } = makeService();
    const { fetchMock } = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const first = await service.searchLyrics(SEARCH_REQUEST, DEFAULT_PROVIDER_ORDER);
    expect(first.results).toEqual([]);
    expect(first.cached).toBe(false);
    // A clean miss: every provider answered, none reported a transient error.
    expect(first.providerStatus.every(entry => entry.status !== "error")).toBe(true);
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await service.searchLyrics(SEARCH_REQUEST, DEFAULT_PROVIDER_ORDER);
    expect(second.cached).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("orders rows by provider priority and dedupes identical source + text", async () => {
    const { service } = makeService();
    const lrcRecord = {
      id: 42,
      trackName: "Harness Song",
      artistName: "Harness Artist",
      albumName: "Test Bench",
      duration: 200,
      syncedLyrics: "[00:12.30]first line\n[00:15.00]second line",
      plainLyrics: "first line\nsecond line",
    };
    const { fetchMock } = routedFetch({
      binimum: binimumHitRoute(),
      // Two catalogue rows carrying the same synced text collapse into one service-level row.
      lrclib: () => json([lrcRecord, { ...lrcRecord, id: 43 }]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.searchLyrics(SEARCH_REQUEST, DEFAULT_PROVIDER_ORDER);

    const sources = result.results.map(candidate => candidate.source);
    expect(sources).toContain("binimum-richsynced");
    expect(sources).toContain("lrclib-synced");
    expect(sources.indexOf("binimum-richsynced")).toBeLessThan(sources.indexOf("lrclib-synced"));
    expect(sources.filter(source => source === "lrclib-synced")).toHaveLength(1);
    expect(result.results.every(candidate => candidate.matchTitle === "Harness Song")).toBe(true);
  });

  it("never queries a module whose source keys are disabled in the provider order", async () => {
    const { service } = makeService();
    const { fetchMock, calls } = routedFetch({ binimum: binimumHitRoute() });
    vi.stubGlobal("fetch", fetchMock);

    const binimumOnly = DEFAULT_PROVIDER_ORDER.map(key =>
      key === "binimum-richsynced" || key === "binimum-synced" ? key : `d_${key}`
    );
    const result = await service.searchLyrics(SEARCH_REQUEST, binimumOnly);

    expect(result.results.map(candidate => candidate.source)).toEqual(["binimum-richsynced"]);
    expect(calls.blyrics).toEqual([]);
    expect(calls.unison).toEqual([]);
    expect(calls.lrclib).toEqual([]);
    expect(calls.binimum.length).toBeGreaterThan(0);
  });
});
