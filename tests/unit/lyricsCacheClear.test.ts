/**
 * Settings -> About -> "Clear lyrics cache": the cache must really be gone.
 *
 * The flow used to mutate memory and *schedule* a write it never waited for, so the UI reported
 * success whatever happened on disk, and a lookup that was still running wrote the entries back
 * moments later. These tests pin the whole chain: cache core, service, the Tauri bridge contract
 * (write failures reach the caller) and a restart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsCacheCore } from "../../src/main/lyrics/cacheCore";
import { LyricsService } from "../../src/main/lyrics/service";
import { LibraryStore } from "../../src/main/library/store";
import { SettingsStore } from "../../src/main/settings";
import { installTauriBridge } from "../../src/tauri/bridge";
import { setRuntimeFetch } from "../../src/main/lyrics/http";
import { emptyDatabase, type DatabaseShape } from "../../src/main/library/storeCore";
import type { LyricsCandidate } from "../../src/shared/types";

const SYNCED = "[00:12.30]first line\n[00:15.00]second line";
const LRCLIB_RECORD = {
  id: 11,
  trackName: "Harness Song",
  artistName: "Harness Artist",
  albumName: "Test Bench",
  duration: 180,
  instrumental: false,
  plainLyrics: null,
  syncedLyrics: SYNCED,
};

const RESOLVE_REQUEST = {
  trackId: 5,
  title: "Harness Song",
  artist: "Harness Artist",
  album: "Test Bench",
  duration: 180,
} as Parameters<LyricsService["resolve"]>[0];

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Routes LRCLIB to a hit and every other provider to a clean miss. */
function routedFetch(onLrclib: () => Response | Promise<Response> = () => response(LRCLIB_RECORD)) {
  return vi.fn(async (url: string) => {
    if (String(url).includes("lrclib.net")) return onLrclib();
    if (String(url).includes("binimum.org")) return response({ total: 0, source: "HIT-LOCAL-LIBSQL", results: [] });
    return response({ error: "not found" }, 404);
  });
}

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-cache-clear-"));
  const cacheFile = join(dir, "lyrics-cache.json");
  const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
    disableSqlite: true,
  });
  const cache = new LyricsCache(cacheFile);
  return { dir, cacheFile, store, cache, service: new LyricsService(store, cache) };
}

const readEntries = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")).entries as Record<string, unknown>;

const candidate = (source: string): LyricsCandidate => ({
  source,
  provider: source,
  text: SYNCED,
  syncHint: "synced",
  language: null,
  songwriters: [],
  sourceHref: null,
  cached: false,
});

afterEach(() => vi.unstubAllGlobals());

describe("LyricsCacheCore — clearing is a verified write", () => {
  it("resolves persistNow only after the emptied file was written", async () => {
    const writes: string[] = [];
    let release = () => {};
    const cache = new LyricsCacheCore({
      persist: json =>
        new Promise<void>(done => {
          release = () => {
            writes.push(json);
            done();
          };
        }),
    });
    cache.set("a", [candidate("lrclib-synced")]);
    expect(cache.size()).toBe(1);

    cache.clear();
    let settled = false;
    const pending = cache.persistNow().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // still waiting for the filesystem
    release();
    await pending;
    expect(settled).toBe(true);
    expect(JSON.parse(writes.at(-1)!)).toEqual({ version: 3, entries: {} });
  });

  it("rejects when the write fails and keeps the data dirty for a later retry", async () => {
    const writes: string[] = [];
    let failing = true;
    const cache = new LyricsCacheCore({
      persist: json => {
        if (failing) throw new Error("Access is denied. (os error 5)");
        writes.push(json);
      },
    });
    cache.set("a", [candidate("lrclib-synced")]);
    cache.clear();

    await expect(cache.persistNow()).rejects.toThrow("Access is denied");
    expect(writes).toHaveLength(0);

    // The retry still has the cleared payload to write: the failure did not drop it silently.
    failing = false;
    await cache.persistNow();
    expect(JSON.parse(writes.at(-1)!)).toEqual({ version: 3, entries: {} });
  });

  it("ignores a write from a lookup that started before the clear", async () => {
    const cache = new LyricsCacheCore();
    const generation = cache.currentGeneration();
    cache.clear();

    cache.set("slow-lookup", [candidate("lrclib-synced")], generation);
    expect(cache.size()).toBe(0);
    expect(cache.get("slow-lookup")).toBeNull();

    // A lookup started after the clear caches normally again.
    cache.set("new-lookup", [candidate("lrclib-synced")], cache.currentGeneration());
    expect(cache.size()).toBe(1);
  });
});

describe("LyricsService.clearCache", () => {
  it("empties the cache file, reports what it removed and re-fetches afterwards", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { service, cacheFile } = makeService();

    await service.resolve(RESOLVE_REQUEST);
    await service.searchLyrics({ title: "Harness Song", artist: "Harness Artist", album: "", duration: 180 } as never);
    service.flush();
    await new Promise(done => setTimeout(done, 20));
    expect(Object.keys(readEntries(cacheFile)).length).toBeGreaterThan(0);
    const callsBeforeClear = fetchMock.mock.calls.length;

    const removed = await service.clearCache();

    expect(removed).toBeGreaterThan(0);
    // Verified on the filesystem, not just in memory.
    expect(readEntries(cacheFile)).toEqual({});
    expect(new LyricsCache(cacheFile).size()).toBe(0);

    const afterClear = await service.resolve(RESOLVE_REQUEST);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeClear);
    expect(afterClear.candidates.every(entry => !entry.cached)).toBe(true);
  });

  it("is not undone by a lookup that was already running", async () => {
    let releaseLrclib = () => {};
    const gate = new Promise<void>(done => {
      releaseLrclib = done;
    });
    const fetchMock = routedFetch(async () => {
      await gate;
      return response(LRCLIB_RECORD);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { service, cacheFile } = makeService();

    const inFlight = service.resolve(RESOLVE_REQUEST);
    await new Promise(done => setTimeout(done, 10));

    // The user clears the cache while the request is still out.
    await service.clearCache();
    expect(readEntries(cacheFile)).toEqual({});

    releaseLrclib();
    const resolved = await inFlight;
    // The song that was loading still gets its lyrics…
    expect(resolved.candidates.some(entry => entry.source === "lrclib-synced")).toBe(true);
    // …but the cleared cache stays cleared, on disk and in memory.
    service.flush();
    await new Promise(done => setTimeout(done, 600));
    expect(readEntries(cacheFile)).toEqual({});
    expect(new LyricsCache(cacheFile).size()).toBe(0);
  });

  it("reports the entries a failed attempt left on disk when the retry succeeds", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const { dir, cacheFile } = makeService();
    let failing = false;
    const cache = new LyricsCacheCore({
      initialJson: null,
      persist: json => {
        if (failing) throw new Error("Access is denied. (os error 5)");
        writeFileSync(cacheFile, json);
      },
    });
    const store = new LibraryStore(join(dir, "library2.db"), join(dir, "artwork"), path => `media://${path}`, {
      disableSqlite: true,
    });
    const service = new LyricsService(store, cache);

    await service.resolve(RESOLVE_REQUEST);
    const cachedEntries = cache.size();
    expect(cachedEntries).toBeGreaterThan(0);

    failing = true;
    await expect(service.clearCache()).rejects.toThrow("Access is denied");

    // The retry removes what the failed attempt could not: it must not claim "already empty".
    failing = false;
    await expect(service.clearCache()).resolves.toBe(cachedEntries);
    expect(readEntries(cacheFile)).toEqual({});
    // Nothing left over for a third call.
    await expect(service.clearCache()).resolves.toBe(0);
  });

  it("leaves user data alone", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const { dir, service, store } = makeService();

    // A sidecar lyrics file, an embedded-lyrics library row, a favourite and the settings file.
    const audioPath = join(dir, "Song.flac");
    writeFileSync(audioPath, "fake audio");
    const sidecar = join(dir, "Song.lrc");
    writeFileSync(sidecar, SYNCED);
    const settingsFile = join(dir, "settings.json");
    new SettingsStore(settingsFile).patch({ playback: { volume: 0.33 } });
    const { id } = store.upsertTrack({
      path: audioPath,
      title: "Harness Song",
      artist: "Harness Artist",
      albumArtist: "Harness Artist",
      album: "Test Bench",
      genre: "",
      year: null,
      trackNo: 1,
      discNo: 1,
      duration: 180,
      bitrate: null,
      sampleRate: null,
      channels: 2,
      codec: "FLAC",
      size: 10,
      mtimeMs: 1,
      artworkFile: null,
      animatedArtPath: null,
      hasSidecarLyrics: true,
      hasEmbeddedLyrics: true,
      embeddedLyrics: { text: SYNCED, kind: "synced" },
    } as never);
    store.setFavorite(id, true);
    store.flush();

    await service.resolve(RESOLVE_REQUEST);
    await service.clearCache();

    expect(readFileSync(sidecar, "utf8")).toBe(SYNCED);
    expect(existsSync(audioPath)).toBe(true);
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).playback.volume).toBe(0.33);
    expect(store.getTracks()).toHaveLength(1);
    expect(store.getTrack(id)?.favorite).toBe(true);
    expect(store.getLyrics(id)?.text).toBe(SYNCED);
  });
});

describe("Tauri bridge — Settings -> Clear lyrics cache", () => {
  beforeEach(() => {
    if (typeof (globalThis as { window?: unknown }).window === "undefined") {
      (globalThis as unknown as { window: unknown }).window = globalThis;
    }
  });

  afterEach(() => {
    clearMocks();
    setRuntimeFetch((...args) => globalThis.fetch(...args));
    delete (globalThis as { cadence?: unknown }).cadence;
  });

  it("writes the emptied cache through Rust, survives a restart, and surfaces write failures", async () => {
    const persistedDb: DatabaseShape = emptyDatabase();
    let persistedLyricsCacheJson: string | null = null;
    let failWrites = false;
    let httpCalls = 0;
    const writes: string[] = [];

    const install = () =>
      mockIPC(
        async (cmd, payload: any) => {
          switch (cmd) {
            case "cmd_bootstrap":
              return {
                appDataDir: "C:\\Users\\Alice\\AppData\\Roaming\\app.cadence.player",
                artworkDir: "C:\\Users\\Alice\\AppData\\Roaming\\app.cadence.player\\artwork",
                platform: "win32",
                arch: "x86_64",
                appVersion: "0.2.2",
                tauriVersion: "2.12.5",
                settingsJson: null,
                lyricsCacheJson: persistedLyricsCacheJson,
                dbSnapshot: { ...structuredClone(persistedDb), lyrics: {} },
                startupFiles: [],
                undecorated: true,
              };
            case "cmd_write_user_json":
              if (payload.kind !== "lyricsCache") return null;
              // Mirrors `atomic_write_utf8`: nothing is written when the command fails.
              if (failWrites) throw "Access is denied. (os error 5)";
              writes.push(payload.content);
              persistedLyricsCacheJson = payload.content;
              return null;
            case "cmd_http_fetch": {
              httpCalls += 1;
              const url = String(payload.args.url);
              if (url.includes("lrclib.net/api/get")) {
                return {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(LRCLIB_RECORD),
                };
              }
              return { status: 404, headers: {}, body: "" };
            }
            default:
              return null;
          }
        },
        { shouldMockEvents: true }
      );

    install();
    const session = await installTauriBridge();
    expect(typeof session.api.lyrics.clearCache).toBe("function");

    await session.api.lyrics.resolve(RESOLVE_REQUEST);
    await new Promise(done => setTimeout(done, 20));
    expect(Object.keys(JSON.parse(persistedLyricsCacheJson!).entries).length).toBeGreaterThan(0);

    const result = await session.api.lyrics.clearCache();
    expect(result.removedEntries).toBeGreaterThan(0);
    expect(JSON.parse(writes.at(-1)!)).toEqual({ version: 3, entries: {} });
    expect(JSON.parse(persistedLyricsCacheJson!).entries).toEqual({});

    session.dispose();
    clearMocks();

    // Restart: the cleared cache stays cleared, so the lyrics are fetched again.
    install();
    const restarted = await installTauriBridge();
    const callsBefore = httpCalls;
    const afterRestart = await restarted.api.lyrics.resolve(RESOLVE_REQUEST);
    expect(httpCalls).toBeGreaterThan(callsBefore);
    expect(afterRestart.candidates.every(entry => !entry.cached)).toBe(true);
    await new Promise(done => setTimeout(done, 20));

    // A failing filesystem must reach the UI instead of a success toast.
    failWrites = true;
    const cacheBeforeFailure = persistedLyricsCacheJson;
    await expect(restarted.api.lyrics.clearCache()).rejects.toBeDefined();
    expect(persistedLyricsCacheJson).toBe(cacheBeforeFailure);
    restarted.dispose();
  }, 30_000);
});
