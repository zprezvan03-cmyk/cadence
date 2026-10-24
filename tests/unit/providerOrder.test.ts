/**
 * Tests for the provider registry, the recommended 13-entry default order, legacy order migration
 * and the service behavior those keys drive (local split, unavailable slots, disabled slots).
 * Network is mocked everywhere — no test reaches a live API.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { LibraryStore } from "../../src/main/library/store";
import {
  DEFAULT_PROVIDER_ORDER,
  LYRIC_SOURCE_KEYS,
  PROVIDER_CONFIGS,
  isKnownProviderKey,
  migrateProviderOrder,
  providerConfig,
  untoggleProvider,
} from "../../src/shared/upstream/better-lyrics/constants";

const RECOMMENDED_13 = [
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
];

describe("provider registry and default order", () => {
  it("exposes exactly the recommended 13 providers in the mandated order, with no duplicates", () => {
    expect(DEFAULT_PROVIDER_ORDER).toEqual(RECOMMENDED_13);
    expect(new Set(DEFAULT_PROVIDER_ORDER).size).toBe(13);
  });

  it("gives every default slot a registry entry and keeps priorities contiguous", () => {
    DEFAULT_PROVIDER_ORDER.forEach((key, index) => {
      const config = providerConfig(key);
      expect(config).toBeDefined();
      expect(config?.priority).toBe(index + 1);
    });
  });

  it("flags only the two slots without a keyless endpoint as unavailable, with explanations", () => {
    const unavailable = PROVIDER_CONFIGS.filter(config => !config.available).map(config => config.key);
    expect(unavailable).toEqual(["blyrics-line", "qq-line"]);
    for (const key of unavailable) {
      expect(providerConfig(key)?.unavailableReason).toBeTruthy();
    }
  });

  it("keeps implemented variants outside the default but available in the registry", () => {
    for (const key of ["unison-wordsynced", "binimum-synced", "unison-plain"]) {
      expect(DEFAULT_PROVIDER_ORDER).not.toContain(key);
      expect(LYRIC_SOURCE_KEYS).toContain(key);
      expect(providerConfig(key)?.available).toBe(true);
    }
  });

  it("never registers the legacy local-sidecar key as a selectable provider", () => {
    expect(isKnownProviderKey("local-sidecar")).toBe(false);
    expect(LYRIC_SOURCE_KEYS).not.toContain("local-sidecar");
  });
});

describe("migrateProviderOrder", () => {
  it("returns the exact default for missing or empty input", () => {
    expect(migrateProviderOrder(undefined)).toEqual(RECOMMENDED_13);
    expect(migrateProviderOrder(null)).toEqual(RECOMMENDED_13);
    expect(migrateProviderOrder([])).toEqual(RECOMMENDED_13);
  });

  it("splits the legacy local-sidecar source into local-rich then local-lrc", () => {
    const migrated = migrateProviderOrder(["local-sidecar", "lrclib-plain"]);
    expect(migrated.indexOf("local-rich")).toBeLessThan(migrated.indexOf("local-lrc"));
    expect(migrated).toContain("lrclib-plain");
    expect(migrated).not.toContain("local-sidecar");
    // New slots introduced by the registry are merged in at their canonical positions.
    expect(migrated).toEqual(expect.arrayContaining(RECOMMENDED_13));
  });

  it("preserves a disabled prefix when splitting and for existing slots", () => {
    const migrated = migrateProviderOrder(["d_local-sidecar", "d_lrclib-synced", "lrclib-plain"]);
    expect(migrated).toContain("d_local-rich");
    expect(migrated).toContain("d_local-lrc");
    expect(migrated).toContain("d_lrclib-synced");
    expect(migrated).toContain("lrclib-plain");
  });

  it("drops unknown keys and collapses duplicates", () => {
    const migrated = migrateProviderOrder([
      "lrclib-plain",
      "made-up-provider",
      "lrclib-plain",
      "d_blyrics-richsynced",
      "blyrics-richsynced",
    ]);
    expect(migrated).not.toContain("made-up-provider");
    expect(migrated.filter(key => untoggleProvider(key) === "lrclib-plain")).toHaveLength(1);
    expect(migrated.filter(key => untoggleProvider(key) === "blyrics-richsynced")).toHaveLength(1);
  });

  it("preserves custom relative ordering while filling newly added slots", () => {
    const migrated = migrateProviderOrder(["embedded-tag", "blyrics-richsynced", "lrclib-plain"]);
    expect(migrated.indexOf("embedded-tag")).toBeLessThan(migrated.indexOf("blyrics-richsynced"));
    expect(migrated.indexOf("blyrics-richsynced")).toBeLessThan(migrated.indexOf("lrclib-plain"));
    expect(migrated).toContain("binimum-richsynced");
  });

  it("keeps implemented extra variants that a user had enabled", () => {
    const migrated = migrateProviderOrder(["local-rich", "unison-plain", "binimum-synced"]);
    expect(migrated).toContain("unison-plain");
    expect(migrated).toContain("binimum-synced");
  });
});

const TTML_WORD = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:00:12.300" end="00:00:15.000"><span begin="00:00:12.300" end="00:00:12.800">First </span><span begin="00:00:12.800" end="00:00:15.000">line</span></p>
</div></body></tt>`;
const LINE_LRC = "[00:12.30]first line\n[00:15.00]second line";

function makeService(trackPath: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "cadence-order-"));
  const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
    disableSqlite: true,
  });
  const cache = new LyricsCache(join(dir, "lyrics.json"));
  const fakeStore = {
    getTrack: () => (trackPath ? { path: trackPath, title: "Harness Song", trackNo: 1 } : undefined),
    getLyrics: () => null,
  } as unknown as LibraryStore;
  return { service: new LyricsService(fakeStore, cache) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("LyricsService provider-order behavior", () => {
  afterEach(() => vi.unstubAllGlobals());

  const resolveRequest = { trackId: 1, title: "Harness Song", artist: "Harness Artist", album: "", duration: 100 } as never;

  it("classifies a TTML sidecar as local-rich and an LRC sidecar as local-lrc", async () => {
    const richDir = mkdtempSync(join(tmpdir(), "cadence-rich-"));
    const richTrack = join(richDir, "Song.flac");
    writeFileSync(richTrack, "fake audio");
    writeFileSync(join(richDir, "Song.ttml"), TTML_WORD);
    const rich = makeService(richTrack);
    const richResult = await rich.service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);
    expect(richResult.candidates[0]!).toMatchObject({ source: "local-rich", syncHint: "richsync" });
    expect(richResult.providerStatus.find(s => s.provider === "local-rich")?.status).toBe("hit");
    expect(richResult.providerStatus.find(s => s.provider === "local-lrc")?.status).toBe("miss");

    const lrcDir = mkdtempSync(join(tmpdir(), "cadence-lrc-"));
    const lrcTrack = join(lrcDir, "Song.flac");
    writeFileSync(lrcTrack, "fake audio");
    writeFileSync(join(lrcDir, "Song.lrc"), LINE_LRC);
    const lrc = makeService(lrcTrack);
    const lrcResult = await lrc.service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);
    expect(lrcResult.candidates[0]!).toMatchObject({ source: "local-lrc", syncHint: "synced" });
    expect(lrcResult.providerStatus.find(s => s.provider === "local-lrc")?.status).toBe("hit");
    expect(lrcResult.providerStatus.find(s => s.provider === "local-rich")?.status).toBe("miss");
  });

  it("skips unavailable slots with an explanation and never sends network traffic for them", async () => {
    const fetchMock = vi.fn(async (_url: string) => json({ error: "not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService(null);

    const result = await service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);

    for (const key of ["blyrics-line", "qq-line"]) {
      const status = result.providerStatus.find(entry => entry.provider === key);
      expect(status).toMatchObject({ status: "skipped" });
      expect(status?.detail).toContain("Unavailable");
    }
    // Every real request goes to a documented host; no invented endpoint for the unavailable slots.
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toMatch(/qq-line|blyrics-line/);
    }
  });

  it("does not query a disabled (d_-prefixed) provider but continues through the rest", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("lrclib.net")) {
        return json({
          id: 9,
          trackName: "Harness Song",
          artistName: "Harness Artist",
          albumName: "",
          duration: 100,
          syncedLyrics: LINE_LRC,
          plainLyrics: null,
        });
      }
      return json({ error: "nope" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService(null);

    const result = await service.resolve(resolveRequest, [
      "d_blyrics-richsynced",
      "lrclib-synced",
      "embedded-tag",
    ]);

    expect(result.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    // The disabled rich endpoint is never called; remaining enabled Better Lyrics variants (QQ/Kugou)
    // still fan out alongside LRCLIB, so check the specific path rather than the whole host.
    const richCalls = fetchMock.mock.calls
      .map(call => String(call[0]))
      .filter(url => url.includes("api.betterlyrics.org") && new URL(url).pathname === "/getLyrics");
    expect(richCalls).toHaveLength(0);
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes("lrclib.net"))).toBe(true);
  });

  it("migrates a legacy order inside the service and resolves with the split local keys", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "nope" }, 404)));
    const { service } = makeService(null);

    const result = await service.resolve(resolveRequest, ["local-sidecar", "lrclib-plain"]);

    expect(result.providerStatus.some(s => s.provider === "local-rich")).toBe(true);
    expect(result.providerStatus.some(s => s.provider === "local-lrc")).toBe(true);
    expect(result.providerStatus.some(s => s.provider === "local-sidecar")).toBe(false);
  });

  it("executes providers and ranks candidates in the exact user-configured order instead of static priority", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "cadence-exec-a-"));
    const trackPathA = join(dirA, "Song.flac");
    writeFileSync(trackPathA, "fake audio");
    writeFileSync(join(dirA, "Song.lrc"), LINE_LRC);

    const eventsA: string[] = [];
    const mockAllProviders = (log: string[]) =>
      vi.fn(async (url: string) => {
        if (url.includes("lrclib.net")) {
          log.push("lrclib");
          return json({
            id: 1,
            trackName: "Harness Song",
            artistName: "Harness Artist",
            albumName: "",
            duration: 100,
            syncedLyrics: "[00:01.00]from lrclib synced",
            plainLyrics: "from lrclib plain",
          });
        }
        if (url.includes("lyrics-api.binimum.org/ttml/")) {
          return new Response(TTML_WORD, { status: 200, headers: { "content-type": "application/ttml+xml" } });
        }
        if (url.includes("lyrics-api.binimum.org")) {
          log.push("binimum");
          return json({
            total: 1,
            results: [
              {
                id: "b1",
                track_name: "Harness Song",
                artist_name: "Harness Artist",
                duration: 100,
                timing_type: "word",
                lyricsUrl: "https://lyrics-api.binimum.org/ttml/b1.ttml",
              },
            ],
          });
        }
        if (url.includes("unison.betterlyrics.org")) {
          log.push("unison");
          return json({
            success: true,
            data: {
              id: 5,
              song: "Harness Song",
              artist: "Harness Artist",
              duration: 100,
              format: "lrc",
              syncType: "linesync",
              lyrics: "[00:01.00]from unison synced",
            },
          });
        }
        if (url.includes("api.betterlyrics.org")) {
          log.push(`blyrics:${new URL(url).pathname}`);
          return json({ ttml: TTML_WORD });
        }
        return json({ error: "nope" }, 404);
      });

    vi.stubGlobal("fetch", mockAllProviders(eventsA));

    const storeA = {
      getTrack: () => ({ path: trackPathA, title: "Harness Song", trackNo: 1 }),
      getLyrics: () => {
        eventsA.push("embedded-tag");
        return { text: "embedded plain lyrics", kind: "plain" as const };
      },
    } as unknown as LibraryStore;
    const serviceA = new LyricsService(storeA, new LyricsCache(join(dirA, "cache.json")));

    const customOrderA = [
      "lrclib-plain",
      "lrclib-synced",
      "embedded-tag",
      "unison-synced",
      "binimum-richsynced",
      "blyrics-richsynced",
      "local-lrc",
      "d_local-rich",
      "d_unison-richsynced",
      "d_blyrics-wordsynced",
      "d_blyrics-synced",
      "d_blyrics-line",
      "d_qq-line",
    ];
    const resultA = await serviceA.resolve(resolveRequest, customOrderA);

    // Actual invocation order matches customOrderA, NOT static priority (where blyrics=2, embedded=13).
    expect(eventsA).toEqual([
      "lrclib",
      "embedded-tag",
      "unison",
      "binimum",
      "blyrics:/getLyrics",
    ]);
    expect(resultA.candidates.map(c => c.source)).toEqual([
      "lrclib-plain",
      "lrclib-synced",
      "embedded-tag",
      "unison-synced",
      "binimum-richsynced",
      "blyrics-richsynced",
      "local-lrc",
    ]);

    // Inverting the configured order on a fresh uncached lookup inverts both invocation order and candidate order.
    const eventsB: string[] = [];
    vi.stubGlobal("fetch", mockAllProviders(eventsB));
    const storeB = {
      getTrack: () => ({ path: trackPathA, title: "Harness Song", trackNo: 1 }),
      getLyrics: () => {
        eventsB.push("embedded-tag");
        return { text: "embedded plain lyrics", kind: "plain" as const };
      },
    } as unknown as LibraryStore;
    const serviceB = new LyricsService(storeB, new LyricsCache(join(dirA, "cache-b.json")));

    const customOrderB = [
      "unison-synced",
      "blyrics-richsynced",
      "embedded-tag",
      "binimum-richsynced",
      "lrclib-synced",
      "lrclib-plain",
      "local-lrc",
      "d_local-rich",
      "d_unison-richsynced",
      "d_blyrics-wordsynced",
      "d_blyrics-synced",
      "d_blyrics-line",
      "d_qq-line",
    ];
    const resultB = await serviceB.resolve(resolveRequest, customOrderB);

    expect(eventsB).toEqual([
      "unison",
      "blyrics:/getLyrics",
      "embedded-tag",
      "binimum",
      "lrclib",
    ]);
    expect(resultB.candidates.map(c => c.source)).toEqual([
      "unison-synced",
      "blyrics-richsynced",
      "embedded-tag",
      "binimum-richsynced",
      "lrclib-synced",
      "lrclib-plain",
      "local-lrc",
    ]);
  });

  it("respects custom order among Better Lyrics endpoints (/kugou -> /qq -> /getLyrics)", async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.hostname === "api.betterlyrics.org") {
          paths.push(parsed.pathname);
          if (parsed.pathname === "/getLyrics") return json({ ttml: TTML_WORD });
          if (parsed.pathname === "/qq/getLyrics") return json({ lyrics: "[0,500]qq(0,500)" });
          if (parsed.pathname === "/kugou/getLyrics") return json({ lyrics: LINE_LRC });
        }
        return json({ error: "miss" }, 404);
      })
    );

    const { service } = makeService(null);
    const order = [
      "blyrics-synced",
      "blyrics-wordsynced",
      "blyrics-richsynced",
      "d_local-rich",
      "d_local-lrc",
      "d_unison-richsynced",
      "d_binimum-richsynced",
      "d_blyrics-line",
      "d_unison-synced",
      "d_qq-line",
      "d_lrclib-synced",
      "d_lrclib-plain",
      "d_embedded-tag",
    ];

    const result = await service.resolve(resolveRequest, order);
    expect(paths).toEqual(["/kugou/getLyrics", "/qq/getLyrics", "/getLyrics"]);
    expect(result.candidates.map(c => c.source)).toEqual([
      "blyrics-synced",
      "blyrics-wordsynced",
      "blyrics-richsynced",
    ]);
  });

  it("falls back cleanly across providers when earlier providers miss, error, or return empty lyrics", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("unison.betterlyrics.org")) {
          calls.push("unison");
          // Returns HTTP 200 with whitespace-only lyrics -> unusable, must fall back.
          return json({
            success: true,
            data: {
              id: 2,
              song: "Harness Song",
              artist: "Harness Artist",
              duration: 100,
              format: "lrc",
              syncType: "linesync",
              lyrics: "   \n  ",
            },
          });
        }
        if (url.includes("lyrics-api.binimum.org")) {
          calls.push("binimum");
          // Server 502 error -> must fall back without aborting subsequent providers.
          return json({ error: "upstream down" }, 502);
        }
        if (url.includes("api.betterlyrics.org")) {
          calls.push(`blyrics:${new URL(url).pathname}`);
          // Uncached keyless miss (401) -> must fall back.
          return json({ error: "Auth required" }, 401);
        }
        if (url.includes("lrclib.net")) {
          calls.push("lrclib");
          return json({
            id: 42,
            trackName: "Harness Song",
            artistName: "Harness Artist",
            albumName: "",
            duration: 100,
            syncedLyrics: null,
            plainLyrics: "Recovered fallback lyrics from LRCLIB",
          });
        }
        return json({ error: "not found" }, 404);
      })
    );

    const { service } = makeService(null);
    const order = [
      "unison-synced",
      "binimum-richsynced",
      "blyrics-richsynced",
      "lrclib-plain",
      "d_local-rich",
      "d_local-lrc",
      "d_unison-richsynced",
      "d_blyrics-wordsynced",
      "d_blyrics-line",
      "d_blyrics-synced",
      "d_qq-line",
      "d_lrclib-synced",
      "d_embedded-tag",
    ];

    const result = await service.resolve(resolveRequest, order);
    expect(calls).toEqual(["unison", "binimum", "blyrics:/getLyrics", "lrclib"]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      source: "lrclib-plain",
      text: "Recovered fallback lyrics from LRCLIB",
    });
  });

  it("re-ranks cached lookups after runtime reorder and fetches newly enabled providers instead of serving partial cache", async () => {
    let unisonCalls = 0;
    let lrclibCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("unison.betterlyrics.org")) {
          unisonCalls += 1;
          return json({
            success: true,
            data: {
              id: 8,
              song: "Harness Song",
              artist: "Harness Artist",
              duration: 100,
              format: "lrc",
              syncType: "linesync",
              lyrics: "[00:01.00]unison line",
            },
          });
        }
        if (url.includes("lrclib.net")) {
          lrclibCalls += 1;
          return json({
            id: 7,
            trackName: "Harness Song",
            artistName: "Harness Artist",
            albumName: "",
            duration: 100,
            syncedLyrics: "[00:01.00]lrclib line",
            plainLyrics: null,
          });
        }
        return json({ error: "miss" }, 404);
      })
    );

    const { service } = makeService(null);
    const baseDisabled = [
      "d_local-rich",
      "d_local-lrc",
      "d_blyrics-richsynced",
      "d_unison-richsynced",
      "d_binimum-richsynced",
      "d_blyrics-wordsynced",
      "d_blyrics-line",
      "d_blyrics-synced",
      "d_qq-line",
      "d_lrclib-plain",
      "d_embedded-tag",
    ];

    // 1. Lookup with unison-synced first, lrclib-synced disabled -> only unison is queried.
    const first = await service.resolve(resolveRequest, [
      "unison-synced",
      "d_lrclib-synced",
      ...baseDisabled,
    ]);
    expect(first.candidates.map(c => c.source)).toEqual(["unison-synced"]);
    expect(unisonCalls).toBe(1);
    expect(lrclibCalls).toBe(0);

    // 2. User enables lrclib-synced ahead of unison-synced -> partial cache must miss and fetch both.
    const second = await service.resolve(resolveRequest, [
      "lrclib-synced",
      "unison-synced",
      ...baseDisabled,
    ]);
    expect(second.candidates.map(c => c.source)).toEqual(["lrclib-synced", "unison-synced"]);
    expect(lrclibCalls).toBe(1);

    // 3. Reordering the same enabled set reuses cache without extra HTTP calls, returning the new order.
    const third = await service.resolve(resolveRequest, [
      "unison-synced",
      "lrclib-synced",
      ...baseDisabled,
    ]);
    expect(third.candidates.map(c => c.source)).toEqual(["unison-synced", "lrclib-synced"]);
    expect(lrclibCalls).toBe(1);
    expect(unisonCalls).toBe(2);
  });

  it("orders manual search execution and results according to configured providerOrder", async () => {
    const searchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("lrclib.net")) {
          searchCalls.push("lrclib");
          return json([
            {
              id: 10,
              trackName: "Harness Song",
              artistName: "Harness Artist",
              albumName: "",
              duration: 100,
              syncedLyrics: null,
              plainLyrics: "LRCLIB manual result",
            },
          ]);
        }
        if (url.includes("api.betterlyrics.org")) {
          searchCalls.push("better-lyrics");
          return json({ ttml: TTML_WORD });
        }
        return json({ error: "miss" }, 404);
      })
    );

    const { service } = makeService(null);
    const customOrder = [
      "lrclib-plain",
      "blyrics-richsynced",
      "d_local-rich",
      "d_local-lrc",
      "d_unison-richsynced",
      "d_binimum-richsynced",
      "d_blyrics-wordsynced",
      "d_blyrics-line",
      "d_unison-synced",
      "d_blyrics-synced",
      "d_qq-line",
      "d_lrclib-synced",
      "d_embedded-tag",
    ];

    const search = await service.searchLyrics(
      { title: "Harness Song", artist: "Harness Artist", album: "", duration: 100 },
      customOrder
    );
    expect(searchCalls).toEqual(["lrclib", "better-lyrics"]);
    expect(search.results.map(r => r.source)).toEqual(["lrclib-plain", "blyrics-richsynced"]);
  });

  it("keeps default ordering intact when providerOrder is omitted or default, and leaves user-file untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-default-"));
    const userLrc = join(dir, "Picked.lrc");
    writeFileSync(userLrc, LINE_LRC);

    const callHosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        callHosts.push(new URL(url).hostname + new URL(url).pathname);
        if (url.includes("api.betterlyrics.org/getLyrics")) return json({ ttml: TTML_WORD });
        if (url.includes("lrclib.net")) {
          return json({
            id: 3,
            trackName: "Harness Song",
            artistName: "Harness Artist",
            albumName: "",
            duration: 100,
            syncedLyrics: LINE_LRC,
            plainLyrics: "plain text",
          });
        }
        return json({ error: "miss" }, 404);
      })
    );

    const { service } = makeService(null);
    const resolved = await service.resolve(resolveRequest);
    // Default order attempts Better Lyrics (/getLyrics -> /qq -> /kugou) -> Unison -> BiniLyrics -> LRCLIB
    // and ranks blyrics-richsynced first.
    expect(callHosts).toEqual([
      "api.betterlyrics.org/getLyrics",
      "api.betterlyrics.org/qq/getLyrics",
      "api.betterlyrics.org/kugou/getLyrics",
      "unison.betterlyrics.org/lyrics",
      "unison.betterlyrics.org/lyrics/search",
      "lyrics-api.binimum.org/",
      "lrclib.net/api/get",
    ]);
    expect(resolved.candidates.map(c => c.source)).toEqual([
      "blyrics-richsynced",
      "lrclib-synced",
      "lrclib-plain",
    ]);

    const manualFile = await service.resolveUserFile(1, userLrc);
    expect(manualFile.candidates).toHaveLength(1);
    expect(manualFile.candidates[0]?.source).toBe("user-file");
  });

  it("handles malformed, duplicate, unknown, and newly introduced provider IDs safely during migration", () => {
    // Non-array / malformed stored inputs safely yield default order without throwing.
    expect(migrateProviderOrder("lrclib-plain" as unknown)).toEqual(RECOMMENDED_13);
    expect(migrateProviderOrder({ 0: "lrclib-plain" } as unknown)).toEqual(RECOMMENDED_13);
    expect(migrateProviderOrder([null, 123, "", "   ", "unknown-v99"] as unknown)).toEqual(RECOMMENDED_13);

    // Duplicate prefixes, duplicate keys, and unknown IDs are normalized cleanly.
    const cleaned = migrateProviderOrder([
      "  lrclib-plain  ",
      "lrclib-plain",
      "d_lrclib-plain",
      "d_d_blyrics-richsynced",
      "removed-provider-v0",
      "unison-synced",
    ]);
    expect(cleaned.filter(entry => untoggleProvider(entry) === "lrclib-plain")).toEqual(["lrclib-plain"]);
    expect(cleaned.filter(entry => untoggleProvider(entry) === "blyrics-richsynced")).toEqual([
      "d_blyrics-richsynced",
    ]);
    expect(cleaned).not.toContain("removed-provider-v0");
    expect(cleaned.indexOf("lrclib-plain")).toBeLessThan(cleaned.indexOf("unison-synced"));

    // Newly introduced default provider is inserted at its canonical position without disturbing
    // either the user's custom relative order or their d_-disabled providers.
    const savedCustom = [
      "lrclib-plain",
      "unison-synced",
      "local-rich",
      "d_blyrics-richsynced",
      "unison-richsynced",
      "binimum-richsynced",
      "blyrics-wordsynced",
      "local-lrc",
      "blyrics-line",
      "blyrics-synced",
      "qq-line",
      "lrclib-synced",
      "embedded-tag",
    ];
    const futureDefaults = [
      "local-rich",
      "blyrics-richsynced",
      "unison-richsynced",
      "future-word-provider",
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
    ];
    const upgraded = migrateProviderOrder(savedCustom, futureDefaults);
    expect(upgraded.slice(0, 3)).toEqual(["lrclib-plain", "unison-synced", "local-rich"]);
    expect(upgraded).toContain("d_blyrics-richsynced");
    expect(upgraded.indexOf("unison-richsynced")).toBeLessThan(upgraded.indexOf("future-word-provider"));
    expect(upgraded.indexOf("future-word-provider")).toBeLessThan(upgraded.indexOf("binimum-richsynced"));
  });
});
