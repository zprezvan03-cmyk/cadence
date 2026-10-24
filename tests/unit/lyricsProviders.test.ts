/**
 * Tests for the Better Lyrics API and Unison lyrics providers and their orchestration in
 * LyricsService. Every network response is mocked — no test here reaches a live API.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { normalizeProviderQuery } from "../../src/main/lyrics/serviceCore";
import { fetchBetterLyrics, searchBetterLyrics } from "../../src/main/lyrics/betterLyrics";
import { fetchUnison } from "../../src/main/lyrics/unison";
import { LibraryStore } from "../../src/main/library/store";
import { parseLyricsText } from "../../src/renderer/features/lyrics/parseLyrics";
import {
  BETTER_LYRICS_API_BASE_URL,
  DEFAULT_PROVIDER_ORDER,
  LYRIC_SOURCE_KEYS,
  UNISON_BASE_URL,
} from "../../src/shared/upstream/better-lyrics/constants";
import { DEFAULT_SETTINGS } from "../../src/main/settings";

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

const LINE_LRC = "[00:12.30]first line\n[00:15.00]second line";
const RICH_LRC = "[00:12.30]<12.30>first <13.10>line\n[00:15.00]<15.00>second <15.80>line";
const PLAIN = "first line\nsecond line";
const QRC = `<?xml version="1.0" encoding="utf-8"?><QrcInfos><LyricInfo LyricContent="[12300,2000]first(12300,800) line(13100,1200)
[15000,2000]second(15000,800) line(15800,1200)
"/></QrcInfos>`;

const QUERY = { title: "Harness Song", artist: "Harness Artist", album: "Test Bench", duration: 200 };
const ALL_KEYS = new Set(LYRIC_SOURCE_KEYS);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that never resolves and rejects once the (timeout/abort) signal fires. */
function hangingFetch(): typeof fetch {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })
  ) as unknown as typeof fetch;
}

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-providers-"));
  const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
    disableSqlite: true,
  });
  const cache = new LyricsCache(join(dir, "lyrics.json"));
  return { dir, store, cache, service: new LyricsService(store, cache) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Unison provider", () => {
  it("looks up local files by song/artist metadata and never invents a video id", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      json({ success: true, data: { id: 7, song: QUERY.title, artist: QUERY.artist, format: "ttml", syncType: "richsync", lyrics: TTML_WORD } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUnison(QUERY, ALL_KEYS);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe(`${UNISON_BASE_URL}/lyrics`);
    expect(url.searchParams.get("song")).toBe(QUERY.title);
    expect(url.searchParams.get("artist")).toBe(QUERY.artist);
    expect(url.searchParams.get("album")).toBe(QUERY.album);
    expect(url.searchParams.get("duration")).toBe("200");
    expect(url.searchParams.has("v")).toBe(false);
    expect(result.candidates[0].source).toBe("unison-richsynced");
    expect(result.statuses[0]).toMatchObject({ provider: "unison", status: "hit" });
  });

  it("maps every documented format and sync type to the extension's source keys", async () => {
    const cases: Array<{ format: string; syncType: string; source: string; hint: string; lyrics: string }> = [
      { format: "ttml", syncType: "richsync", source: "unison-richsynced", hint: "richsync", lyrics: TTML_WORD },
      { format: "ttml", syncType: "linesync", source: "unison-synced", hint: "synced", lyrics: TTML_LINE },
      { format: "lrc", syncType: "richsync", source: "unison-wordsynced", hint: "richsync", lyrics: RICH_LRC },
      { format: "lrc", syncType: "linesync", source: "unison-synced", hint: "synced", lyrics: LINE_LRC },
      { format: "plain", syncType: "plain", source: "unison-plain", hint: "none", lyrics: PLAIN },
    ];
    for (const entry of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({ success: true, data: { id: 1, format: entry.format, syncType: entry.syncType, lyrics: entry.lyrics } }))
      );
      const result = await fetchUnison(QUERY, ALL_KEYS);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].source).toBe(entry.source);
      expect(result.candidates[0].syncHint).toBe(entry.hint);
      // Raw provider text is preserved verbatim — nothing is flattened to plain text.
      expect(result.candidates[0].text).toBe(entry.lyrics);
      vi.unstubAllGlobals();
    }
  });

  it("preserves syllable timing end to end through the renderer parser", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ success: true, data: { id: 1, format: "ttml", syncType: "richsync", lyrics: TTML_WORD } }))
    );
    const result = await fetchUnison(QUERY, ALL_KEYS);
    const parsed = parseLyricsText(result.candidates[0].text, QUERY.duration * 1000);
    expect(parsed.syncType).toBe("richsync");
    // The parser inserts instrumental gap lines; locate the sung line carrying syllable parts.
    const sung = parsed.lyrics.find(line => line.parts && line.parts.length > 0);
    expect(sung?.parts?.length).toBeGreaterThan(0);
    expect(sung?.startTimeMs).toBe(12300);
  });

  it("falls back to ranked search on a 404 and validates the fuzzy match itself", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/lyrics/search")) {
        return json({
          success: true,
          data: [
            { id: 2, song: "Completely Different", artist: "Nobody", duration: 90, format: "lrc", syncType: "linesync", lyrics: LINE_LRC },
            { id: 3, song: "Harness Song", artist: "Harness Artist", duration: 201, format: "lrc", syncType: "linesync", lyrics: LINE_LRC },
          ],
        });
      }
      return json({ success: false, error: "Not found", code: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUnison(QUERY, ALL_KEYS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].source).toBe("unison-synced");
  });

  it("rejects search results that fail the duration tolerance or similarity gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/lyrics/search")) {
          return json({
            success: true,
            data: [
              // Right-ish title but 30 seconds away from the local file.
              { id: 4, song: "Harness Song", artist: "Harness Artist", duration: 230, format: "lrc", syncType: "linesync", lyrics: LINE_LRC },
              // Close duration, unrelated metadata.
              { id: 5, song: "Totally Other Tune", artist: "Some Stranger", duration: 200, format: "plain", syncType: "plain", lyrics: PLAIN },
            ],
          });
        }
        return json({ success: false, code: "NOT_FOUND" }, 404);
      })
    );
    const result = await fetchUnison(QUERY, ALL_KEYS);
    expect(result.candidates).toEqual([]);
    expect(result.statuses[0]).toMatchObject({ status: "miss" });
  });

  it("reports a clean miss when both endpoints 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ success: false, error: "Not found", code: "NOT_FOUND" }, 404)));
    const result = await fetchUnison(QUERY, ALL_KEYS);
    expect(result.candidates).toEqual([]);
    expect(result.statuses[0]).toMatchObject({ provider: "unison", status: "miss" });
  });

  it("treats 429, malformed bodies and transport failures as errors, not misses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ success: false, error: "Rate limited" }, 429, { "Retry-After": "30" })));
    const limited = await fetchUnison(QUERY, ALL_KEYS);
    expect(limited.statuses[0]).toMatchObject({ status: "error" });
    expect(limited.statuses[0].detail).toContain("30");
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => json({ success: true, data: null })));
    const malformed = await fetchUnison(QUERY, ALL_KEYS);
    expect(malformed.statuses[0]).toMatchObject({ status: "error", detail: "Malformed response" });
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const broken = await fetchUnison(QUERY, ALL_KEYS);
    expect(broken.statuses[0]).toMatchObject({ status: "error" });
    expect(broken.statuses[0].detail).toContain("Network");
  });

  it("treats a valid entry whose source key is disabled as a miss, not a malformed payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ success: true, data: { id: 1, format: "ttml", syncType: "richsync", lyrics: TTML_WORD } }))
    );
    const result = await fetchUnison(QUERY, new Set(["unison-plain"]));
    expect(result.candidates).toEqual([]);
    expect(result.statuses[0]).toMatchObject({ status: "miss", detail: "Provider disabled" });
  });

  it("surfaces request timeouts via its own timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const result = await fetchUnison(QUERY, ALL_KEYS, undefined, 25);
    expect(result.candidates).toEqual([]);
    expect(result.statuses[0]).toMatchObject({ status: "error", detail: "Request timed out" });
  });
});

describe("Better Lyrics API provider", () => {
  it("fetches TTML, QRC and LRC from the documented endpoints with metadata only", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(`${BETTER_LYRICS_API_BASE_URL}/getLyrics`)) return json({ ttml: TTML_WORD });
      if (url.includes("/qq/getLyrics")) return json({ lyrics: QRC, provider: "qq" });
      return json({ lyrics: LINE_LRC, provider: "kugou" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBetterLyrics(QUERY, ALL_KEYS);
    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(urls.some(url => url.includes("/getLyrics?") && url.includes("s=Harness"))).toBe(true);
    expect(urls.every(url => !url.includes("videoId") && !url.includes("&v="))).toBe(true);
    expect(result.candidates.map(c => c.source)).toEqual([
      "blyrics-richsynced",
      "blyrics-wordsynced",
      "blyrics-synced",
    ]);
    expect(result.candidates.map(c => c.syncHint)).toEqual(["richsync", "richsync", "synced"]);
    expect(result.statuses[0]).toMatchObject({ provider: "better-lyrics", status: "hit" });
  });

  it("classifies line-only TTML as line synced from the actual payload, not the endpoint name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ttml: TTML_LINE })));
    const result = await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]));
    expect(result.candidates[0].syncHint).toBe("synced");
  });

  it("keeps QRC word timing parseable through Cadence's parser chain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ lyrics: QRC, provider: "qq" })));
    const result = await fetchBetterLyrics(QUERY, new Set(["blyrics-wordsynced"]));
    const parsed = parseLyricsText(result.candidates[0].text, QUERY.duration * 1000);
    expect(parsed.format).toBe("qrc");
    expect(parsed.syncType).toBe("richsync");
    const sung = parsed.lyrics.find(line => line.parts && line.parts.length > 0);
    expect(sung?.parts?.length).toBeGreaterThan(0);
  });

  it("treats 401 as an expected keyless cache miss, never throws and never sends a key", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ error: "API key required", message: "Uncached queries require a valid API key" }, 401)
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBetterLyrics(QUERY, ALL_KEYS);
    expect(result.candidates).toEqual([]);
    expect(result.statuses[0]).toMatchObject({ provider: "better-lyrics", status: "miss" });
    expect(result.statuses[0].detail).not.toMatch(/API key/i);
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers["X-API-Key"]).toBeUndefined();
    }

    const searched = await searchBetterLyrics(QUERY, new Set(["blyrics-wordsynced"]));
    expect(searched.candidates).toEqual([]);
    expect(searched.statuses[0]).toMatchObject({ provider: "better-lyrics", status: "miss" });
    expect(searched.statuses[0].detail).not.toMatch(/API key/i);
  });

  it("retries an endpoint once without album when a 401 occurs and the query included an album", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.searchParams.has("al")) {
        return json({ error: "API key required", message: "Uncached queries require a valid API key" }, 401);
      }
      return json({ lyrics: QRC, provider: "qq" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBetterLyrics(QUERY, new Set(["blyrics-wordsynced"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const retryUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(firstUrl.searchParams.get("al")).toBe(QUERY.album);
    expect(retryUrl.searchParams.has("al")).toBe(false);
    expect(retryUrl.searchParams.get("s")).toBe(QUERY.title);
    expect(retryUrl.searchParams.get("a")).toBe(QUERY.artist);
    expect(retryUrl.searchParams.get("d")).toBe("200");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].source).toBe("blyrics-wordsynced");
    expect(result.statuses[0]).toMatchObject({ provider: "better-lyrics", status: "hit" });
  });

  it("does not retry without album when album is absent, normalized away, or when status is not 401", async () => {
    const fetchNoAlbum = vi.fn(async () => json({ error: "API key required" }, 401));
    vi.stubGlobal("fetch", fetchNoAlbum);
    const noAlbum = await fetchBetterLyrics({ ...QUERY, album: "" }, new Set(["blyrics-wordsynced"]));
    expect(fetchNoAlbum).toHaveBeenCalledTimes(1);
    expect(noAlbum.statuses[0].status).toBe("miss");
    vi.unstubAllGlobals();

    const fetchPlaceholderAlbum = vi.fn(async (_url: string) => json({ error: "API key required" }, 401));
    vi.stubGlobal("fetch", fetchPlaceholderAlbum);
    const placeholderAlbum = await fetchBetterLyrics(
      { ...QUERY, album: "  Unknown Album  " },
      new Set(["blyrics-wordsynced"])
    );
    expect(fetchPlaceholderAlbum).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchPlaceholderAlbum.mock.calls[0][0])).searchParams.has("al")).toBe(false);
    expect(placeholderAlbum.statuses[0].status).toBe("miss");
    vi.unstubAllGlobals();

    // Only one retry when both the album-qualified and album-less requests return 401.
    const fetchBoth401 = vi.fn(async () => json({ error: "API key required" }, 401));
    vi.stubGlobal("fetch", fetchBoth401);
    await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]));
    expect(fetchBoth401).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();

    // Non-401 statuses (404, 429, 500) must not trigger an album-less retry.
    for (const status of [404, 429, 500]) {
      const fetchNon401 = vi.fn(async () => json({ error: "nope" }, status));
      vi.stubGlobal("fetch", fetchNon401);
      await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]));
      expect(fetchNon401).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes 404 misses, 429 rate limits, 5xx server errors, timeouts, network errors and malformed payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Lyrics not available for this track" }, 404)));
    const miss = await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]));
    expect(miss.statuses[0]).toMatchObject({ status: "miss" });
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Too Many Requests" }, 429, { "Retry-After": "60" })));
    const limited = await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]));
    expect(limited.statuses[0]).toMatchObject({ status: "error" });
    expect(limited.statuses[0].detail).toContain("60");
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Upstream failure" }, 503)));
    const serverError = await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]));
    expect(serverError.statuses[0]).toMatchObject({ status: "error", detail: "Server error (503)" });
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", hangingFetch());
    const timedOut = await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]), undefined, 25);
    expect(timedOut.statuses[0]).toMatchObject({ status: "error", detail: "Request timed out" });
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const networkFailed = await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]));
    expect(networkFailed.statuses[0]).toMatchObject({
      status: "error",
      detail: expect.stringContaining("Network error"),
    });
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => json({ unexpected: true })));
    const malformed = await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]));
    expect(malformed.statuses[0]).toMatchObject({ status: "error", detail: expect.stringContaining("malformed") });
  });

  it("propagates cancellation during initial request or album-less retry without extra requests", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.has("al")) {
        controller.abort();
        return json({ error: "API key required" }, 401);
      }
      throw new Error("album-less retry must not hit network after abort");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBetterLyrics(QUERY, new Set(["blyrics-wordsynced", "blyrics-synced"]), controller.signal)
    ).rejects.toMatchObject({ name: "LyricsHttpError", kind: "aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("queries only enabled endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/kugou/") ? json({ lyrics: LINE_LRC, provider: "kugou" }) : json({ error: "nope" }, 404)
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBetterLyrics(QUERY, new Set(["blyrics-synced"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/kugou/getLyrics");
    expect(result.candidates[0].source).toBe("blyrics-synced");
  });

  it("continues to the next endpoint when one fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // Match the exact main endpoint: the provider-specific paths also end in /getLyrics.
        if (url.startsWith(`${BETTER_LYRICS_API_BASE_URL}/getLyrics`)) throw new TypeError("network down");
        if (url.includes("/qq/")) return json({ error: "rate" }, 429, { "Retry-After": "5" });
        return json({ lyrics: LINE_LRC, provider: "kugou" });
      })
    );
    const result = await fetchBetterLyrics(QUERY, ALL_KEYS);
    expect(result.candidates.map(c => c.source)).toEqual(["blyrics-synced"]);
    expect(result.statuses[0].status).toBe("hit");
  });
});

describe("LyricsService provider orchestration", () => {
  const request = (overrides: Partial<Parameters<LyricsService["resolve"]>[0]> = {}) =>
    ({ trackId: 1, title: QUERY.title, artist: QUERY.artist, album: QUERY.album, duration: QUERY.duration, ...overrides }) as Parameters<
      LyricsService["resolve"]
    >[0];

  const binimumEmpty = () => json({ total: 0, source: "HIT-LOCAL-LIBSQL", results: [] });

  function hostRoutedFetch(routes: Record<string, (url: string) => Response | Promise<Response>>): typeof fetch {
    return vi.fn(async (url: string) => {
      const target = url.includes("api.betterlyrics.org")
        ? routes.blyrics
        : url.includes("unison.betterlyrics.org")
          ? routes.unison
          : url.includes("lyrics-api.binimum.org")
            ? routes.binimum ?? binimumEmpty
            : routes.lrclib;
      return target(url);
    }) as unknown as typeof fetch;
  }

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

  it("runs every enabled network provider in parallel and returns candidates in upstream priority order", async () => {
    const { service } = makeService();
    vi.stubGlobal(
      "fetch",
      hostRoutedFetch({
        blyrics: () => json({ ttml: TTML_WORD }),
        unison: () => json({ success: true, data: { id: 1, format: "lrc", syncType: "linesync", lyrics: LINE_LRC } }),
        lrclib: () => lrclibHit(),
      })
    );

    const result = await service.resolve(request());
    expect(result.candidates.map(c => c.source)).toEqual([
      "blyrics-richsynced",
      "unison-synced",
      "lrclib-synced",
    ]);
    expect(result.providerStatus.map(s => s.provider)).toEqual(
      expect.arrayContaining(["local-rich", "local-lrc", "embedded-tag", "better-lyrics", "unison", "lrclib"])
    );
  });

  it("caches fallback provider hits when Better Lyrics returns an expected 401 cache miss", async () => {
    const { service } = makeService();
    const fetchMock = vi.fn(
      hostRoutedFetch({
        blyrics: () => json({ error: "API key required" }, 401),
        unison: () => json({ success: false, code: "NOT_FOUND" }, 404),
        lrclib: () => lrclibHit(),
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await service.resolve(request());
    expect(first.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    expect(first.providerStatus.find(s => s.provider === "better-lyrics")?.status).toBe("miss");
    expect(first.providerStatus.find(s => s.provider === "unison")?.status).toBe("miss");

    // A keyless 401 is a normal cache miss, so valid fallback lyrics are persisted and served from cache.
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await service.resolve(request());
    expect(second.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    expect(second.candidates[0].cached).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does not cache partial fallback results when Better Lyrics hits a genuine 429 or 5xx error", async () => {
    const { service } = makeService();
    const fetchMock = vi.fn(
      hostRoutedFetch({
        blyrics: () => json({ error: "Too Many Requests" }, 429, { "Retry-After": "30" }),
        unison: () => json({ success: false, code: "NOT_FOUND" }, 404),
        lrclib: () => lrclibHit(),
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await service.resolve(request());
    expect(first.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    expect(first.providerStatus.find(s => s.provider === "better-lyrics")?.status).toBe("error");

    // Transient rate-limit/server errors prevent caching so a later resolve retries Better Lyrics.
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await service.resolve(request());
    expect(second.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("strips synthetic Unknown artist / Unknown album placeholders while preserving real names", async () => {
    expect(
      normalizeProviderQuery({
        title: "  Song Title  ",
        artist: "  Unknown Artist ",
        album: "unknown   album",
        duration: 185,
      })
    ).toEqual({ title: "Song Title", artist: "", album: "", duration: 185 });

    // Legitimate names containing "Unknown" must be preserved verbatim (apart from outer trim).
    expect(
      normalizeProviderQuery({
        title: "Multi-Love",
        artist: "  Unknown Mortal Orchestra ",
        album: " Unknown Pleasures ",
        duration: 250,
      })
    ).toEqual({
      title: "Multi-Love",
      artist: "Unknown Mortal Orchestra",
      album: "Unknown Pleasures",
      duration: 250,
    });
    expect(
      normalizeProviderQuery({
        title: "Track",
        artist: "Unknown",
        album: "Unknown",
        duration: 120,
      })
    ).toEqual({ title: "Track", artist: "Unknown", album: "Unknown", duration: 120 });

    const { service } = makeService();
    const seenUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seenUrls.push(String(url));
        if (url.includes("api.betterlyrics.org")) return json({ ttml: TTML_WORD });
        if (url.includes("unison.betterlyrics.org")) return json({ success: false, code: "NOT_FOUND" }, 404);
        if (url.includes("lyrics-api.binimum.org")) return binimumEmpty();
        return json({}, 404);
      })
    );

    const resolved = await service.resolve(
      request({ artist: "Unknown artist", album: "Unknown album" })
    );
    expect(resolved.candidates[0].source).toBe("blyrics-richsynced");
    for (const rawUrl of seenUrls) {
      expect(rawUrl.toLowerCase()).not.toContain("unknown+artist");
      expect(rawUrl.toLowerCase()).not.toContain("unknown%20artist");
      expect(rawUrl.toLowerCase()).not.toContain("unknown+album");
      expect(rawUrl.toLowerCase()).not.toContain("unknown%20album");
      const parsed = new URL(rawUrl);
      expect(parsed.searchParams.has("al")).toBe(false);
      expect(parsed.searchParams.has("album")).toBe(false);
      expect(parsed.searchParams.has("album_name")).toBe(false);
    }

    seenUrls.length = 0;
    await service.searchLyrics({
      title: "Harness Song",
      artist: "  UNKNOWN ARTIST ",
      album: " <unknown> ",
      duration: 200,
    });
    for (const rawUrl of seenUrls) {
      expect(rawUrl.toLowerCase()).not.toContain("unknown");
    }
  });

  it("negative-caches a clean all-provider miss and serves it without new requests", async () => {
    const { service } = makeService();
    const fetchMock = vi.fn(
      hostRoutedFetch({
        blyrics: () => json({ error: "Lyrics not available for this track" }, 404),
        unison: () => json({ success: false, code: "NOT_FOUND" }, 404),
        lrclib: () => json({}, 404),
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await service.resolve(request());
    expect(first.candidates).toEqual([]);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await service.resolve(request());
    expect(second.candidates).toEqual([]);
    expect(second.providerStatus.find(s => s.provider === "unison")?.detail).toBe("Cached negative result");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("skips every network provider in offline mode", async () => {
    const { service } = makeService();
    const fetchMock = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.resolve(request({ localOnly: true }));
    expect(result.candidates).toEqual([]);
    for (const provider of ["better-lyrics", "unison", "lrclib"]) {
      expect(result.providerStatus).toContainEqual(
        expect.objectContaining({ provider, status: "skipped", detail: "Offline mode" })
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never lets network results demote or replace local lyrics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-local-"));
    const trackPath = join(dir, "Harness Song.flac");
    const sidecarPath = join(dir, "Harness Song.ttml");
    writeFileSync(trackPath, "fake audio");
    writeFileSync(sidecarPath, TTML_WORD);
    const fakeStore = {
      getTrack: () => ({ path: trackPath, title: "Harness Song", trackNo: 1 }),
      getLyrics: () => null,
    } as unknown as LibraryStore;
    const cache = new LyricsCache(join(dir, "lyrics.json"));
    const service = new LyricsService(fakeStore, cache);

    vi.stubGlobal(
      "fetch",
      hostRoutedFetch({
        blyrics: () => json({ ttml: TTML_WORD }),
        unison: () => json({ success: true, data: { id: 1, format: "plain", syncType: "plain", lyrics: PLAIN } }),
        lrclib: () => {
          throw new TypeError("offline");
        },
      })
    );

    // Explicit order including the Unison unsynced extra, which is implemented but outside the
    // recommended 13 defaults; the local TTML source must still sort ahead of every network one.
    const result = await service.resolve(
      request(),
      ["local-rich", "blyrics-richsynced", "unison-plain", "lrclib-synced", "embedded-tag"]
    );
    expect(result.candidates[0].source).toBe("local-rich");
    expect(result.candidates[0].text).toBe(TTML_WORD);
    expect(result.candidates.map(c => c.source)).toEqual([
      "local-rich",
      "blyrics-richsynced",
      "unison-plain",
    ]);
    // A failing network provider leaves the local candidate untouched.
    expect(result.providerStatus.find(s => s.provider === "lrclib")?.status).toBe("error");
  });

  it("deduplicates concurrent lookups for the same track", async () => {
    const { service } = makeService();
    const fetchMock = vi.fn(
      hostRoutedFetch({
        blyrics: () => json({ ttml: TTML_WORD }),
        unison: () => json({ success: false, code: "NOT_FOUND" }, 404),
        lrclib: () => json({}, 404),
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([service.resolve(request()), service.resolve(request())]);
    expect(a.candidates.map(c => c.source)).toEqual(b.candidates.map(c => c.source));
    // One parallel fan-out, not two: each host is hit at most once.
    const pathnames = (calls: unknown[][]) => calls.map(call => String(call[0]).split("?")[0]);
    const firstPass = pathnames(fetchMock.mock.calls);
    expect(new Set(firstPass).size).toBe(firstPass.length);
    // A follow-up resolve is served from the persistent cache with no new traffic.
    await service.resolve(request());
    expect(fetchMock.mock.calls.length).toBe(firstPass.length);
  });

  it("aborts a stale lookup and keeps a concurrent track change from overwriting it", async () => {
    const { service } = makeService();
    vi.stubGlobal("fetch", hangingFetch());

    const controller = new AbortController();
    const stale = service.resolve(request({ title: "Previous Track" }), undefined, controller.signal);
    controller.abort();
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });

    // The current track's lookup is independent and still resolves with its own metadata even
    // though the previous request was abandoned.
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      hostRoutedFetch({
        blyrics: () => json({ error: "nope" }, 404),
        unison: () => json({ success: true, data: { id: 1, format: "lrc", syncType: "linesync", lyrics: LINE_LRC } }),
        lrclib: () => json({}, 404),
      })
    );
    const current = await service.resolve(request({ title: "Current Track" }));
    expect(current.candidates).toHaveLength(1);
    expect(current.candidates[0].source).toBe("unison-synced");
    expect(current.candidates[0].text).toBe(LINE_LRC);
  });

  it("keeps the historical local-first and LRCLIB-last default ordering and fullscreen settings", async () => {
    expect(DEFAULT_PROVIDER_ORDER).toEqual([
      "local-rich",
      "blyrics-richsynced",
      "unison-richsynced",
      "binimum-richsynced",
      "blyrics-wordsynced",
      "local-lrc",
      "blyrics-line",
      "unison-synced",
      "blyrics-synced",
      "qq-line",
      "lrclib-synced",
      "lrclib-plain",
      "embedded-tag",
    ]);
    expect(new Set(DEFAULT_PROVIDER_ORDER).size).toBe(DEFAULT_PROVIDER_ORDER.length);
    expect(DEFAULT_PROVIDER_ORDER).toContain("blyrics-richsynced");
    expect(DEFAULT_PROVIDER_ORDER).toContain("unison-synced");
    // Lyrics UI settings owned by other features must remain untouched.
    expect(DEFAULT_SETTINGS.lyrics.showLyricsInFullscreen).toBe(true);
    expect(DEFAULT_SETTINGS.lyrics.translationFontSizePx).toBe(32);
    expect(DEFAULT_SETTINGS.lyrics.romanizationFontSizePx).toBe(26);
  });
});
