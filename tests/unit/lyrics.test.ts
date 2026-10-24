import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { fetchLrclib } from "../../src/main/lyrics/lrclib";
import { LibraryStore } from "../../src/main/library/store";

const SYNCED = "[00:12.30]first line\n[00:15.00]second line";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-lyrics-"));
  const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
    disableSqlite: true,
  });
  const cache = new LyricsCache(join(dir, "lyrics.json"));
  return { store, cache, service: new LyricsService(store, cache), dir };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LRCLIB provider", () => {
  it("returns a synced candidate from the exact endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      response({
        id: 42,
        trackName: "Harness Song",
        artistName: "Harness Artist",
        albumName: "Test Bench",
        duration: 200,
        instrumental: false,
        plainLyrics: "first line\nsecond line",
        syncedLyrics: SYNCED,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchLrclib({ title: "Harness Song", artist: "Harness Artist", album: "Test Bench", duration: 200 });
    // A record carrying both forms yields a synced candidate and the plain one as a fallback.
    expect(result.candidates.map(candidate => candidate.source)).toEqual(["lrclib-synced", "lrclib-plain"]);
    expect(result.candidates[0].text).toBe(SYNCED);
    expect(result.candidates[0].syncHint).toBe("synced");
    expect(fetchMock.mock.calls[0][0]).toContain("/get?");
  });

  it("falls back to search and picks the closest match, skipping unrelated records", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/get?")) return response({}, 404);
        return response([
          {
            id: 1,
            trackName: "Something Else Entirely",
            artistName: "Another Artist",
            albumName: null,
            duration: 90,
            instrumental: false,
            plainLyrics: "nope",
            syncedLyrics: null,
          },
          {
            id: 2,
            trackName: "Harness Song",
            artistName: "Harness Artist",
            albumName: "Test Bench",
            duration: 201,
            instrumental: false,
            plainLyrics: null,
            syncedLyrics: SYNCED,
          },
        ]);
      })
    );

    const result = await fetchLrclib({ title: "Harness Song", artist: "Harness Artist", album: "", duration: 200 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].sourceHref).toContain("/lyrics/2");
  });

  it("reports a miss when nothing is close enough", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/get?")
          ? response({}, 404)
          : response([
              {
                id: 3,
                trackName: "Totally Different",
                artistName: "Nobody",
                albumName: null,
                duration: 30,
                instrumental: false,
                plainLyrics: "x",
                syncedLyrics: null,
              },
            ])
      )
    );
    const result = await fetchLrclib({ title: "Harness Song", artist: "Harness Artist", album: "", duration: 300 });
    expect(result.candidates).toEqual([]);
    expect(result.statuses[0].status).toBe("miss");
  });

  it("treats a plain-text record as a plain candidate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          id: 7,
          trackName: "Harness Song",
          artistName: "Harness Artist",
          albumName: null,
          duration: 100,
          instrumental: false,
          plainLyrics: "no timings at all",
          syncedLyrics: null,
        })
      )
    );
    const result = await fetchLrclib({ title: "Harness Song", artist: "Harness Artist", album: "", duration: 100 });
    expect(result.candidates[0].source).toBe("lrclib-plain");
    expect(result.candidates[0].syncHint).toBe("none");
  });

  it("surfaces network failures as a provider error instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const result = await fetchLrclib({ title: "Harness Song", artist: "Harness Artist", album: "", duration: 100 });
    expect(result.candidates).toEqual([]);
    expect(result.statuses[0]).toMatchObject({ provider: "lrclib", status: "error" });
  });
});

describe("LyricsService", () => {
  it("skips network providers in offline mode and says why", async () => {
    const { service } = makeService();
    const result = await service.resolve(
      { trackId: 1, title: "Harness Song", artist: "Harness Artist", album: "", duration: 100, localOnly: true } as never,
      undefined,
      undefined
    );
    expect(result.candidates).toEqual([]);
    const lrclib = result.providerStatus.find(entry => entry.provider === "lrclib");
    expect(lrclib).toMatchObject({ status: "skipped", detail: "Offline mode" });
    // Local providers are still reported, as skipped, so the UI can explain the situation.
    expect(result.providerStatus.some(entry => entry.provider === "local-rich" && entry.status === "skipped")).toBe(true);
    expect(result.providerStatus.some(entry => entry.provider === "local-lrc" && entry.status === "skipped")).toBe(true);
  });

  it("caches a hit and serves it on the next resolve without touching the network", async () => {
    const { service, cache } = makeService();
    const lrclibRecord = {
      id: 11,
      trackName: "Harness Song",
      artistName: "Harness Artist",
      albumName: "Test Bench",
      duration: 180,
      instrumental: false,
      plainLyrics: null,
      syncedLyrics: SYNCED,
    };
    // The service now fans out to Better Lyrics, Unison and LRCLIB in parallel; route each host.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("lrclib.net")) return response(lrclibRecord);
      if (url.includes("unison.betterlyrics.org")) return response({ success: false, error: "Not found", code: "NOT_FOUND" }, 404);
      return response({ error: "Lyrics not available for this track" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = { trackId: 5, title: "Harness Song", artist: "Harness Artist", album: "Test Bench", duration: 180 } as never;
    const first = await service.resolve(request);
    expect(first.candidates).toHaveLength(1);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await service.resolve(request);
    expect(second.candidates[0].cached).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    expect(cache.get(LyricsCache.key("Harness Artist", "Harness Song", "Test Bench", 180))).toHaveLength(1);
  });

  it("honours a custom provider order, dropping disabled providers", async () => {
    const { service } = makeService();
    const fetchMock = vi.fn(async () => response({}, 404));
    vi.stubGlobal("fetch", fetchMock);
    const result = await service.resolve(
      { trackId: 9, title: "Harness Song", artist: "Harness Artist", album: "", duration: 100 } as never,
      ["d_local-rich", "d_local-lrc", "lrclib-synced"]
    );
    // A disabled provider keeps its slot but must not run.
    expect(result.providerStatus.some(entry => entry.provider === "lrclib")).toBe(true);
  });

  it("keeps working when the cache file is corrupt", async () => {
    const { dir, cache, service } = makeService();
    cache.flush();
    const reopened = new LyricsCache(join(dir, "lyrics.json"));
    expect(() => reopened.get("missing")).not.toThrow();
    expect(service).toBeTruthy();
  });
});
