/**
 * Global lyrics cache: every source is cached, replays byte-for-byte, survives restarts, and the
 * cache-manager API can list, inspect and delete entries without touching user files.
 *
 * These tests run the real service over a real cache file (no stubs around the storage layer) and
 * assert on the JSON that actually lands on disk, so "it is cached" always means "it is on disk".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsCacheCore } from "../../src/main/lyrics/cacheCore";
import { LyricsService } from "../../src/main/lyrics/service";
import { LibraryStore } from "../../src/main/library/store";
import { installTauriBridge } from "../../src/tauri/bridge";
import { setRuntimeFetch } from "../../src/main/lyrics/http";
import { emptyDatabase, type DatabaseShape } from "../../src/main/library/storeCore";
import type { LyricsResolveRequest } from "../../src/shared/types";

/* ------------------------------------------------------------------ fixtures */

/** Japanese TTML carrying a line translation and a transliteration, with syllable word timing. */
const RICH_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
    xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
    xml:lang="ja">
  <head>
    <metadata>
      <itunes:metadata>
        <translations>
          <translation xml:lang="en">
            <text for="L1">Cherry blossoms bloom</text>
          </translation>
        </translations>
        <transliterations>
          <transliteration xml:lang="ja-Latn">
            <text for="L1">sakura ga saku</text>
          </transliteration>
        </transliterations>
      </itunes:metadata>
    </metadata>
  </head>
  <body dur="00:30.000">
    <div>
      <p begin="00:06.000" end="00:08.500" itunes:key="L1"><span begin="00:06.000" end="00:07.200">桜が</span><span begin="00:07.200" end="00:08.500">咲く</span></p>
      <p begin="00:16.000" end="00:19.000" itunes:key="L2"><span begin="00:16.000" end="00:17.500">風が</span><span begin="00:17.500" end="00:19.000">吹く</span></p>
    </div>
  </body>
</tt>`;

const LINE_LRC = "[00:12.30]first line\n[00:15.00]second line";

const LRCLIB_RECORD = {
  id: 11,
  trackName: "Harness Song",
  artistName: "Harness Artist",
  albumName: "Test Bench",
  duration: 180,
  instrumental: false,
  plainLyrics: null,
  syncedLyrics: LINE_LRC,
};

const REQUEST: LyricsResolveRequest = {
  trackId: 5,
  title: "Harness Song",
  artist: "Harness Artist",
  album: "Test Bench",
  duration: 180,
};

const tempDirs: string[] = [];

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Better Lyrics hits with `ttml` (when given), every other provider answers 404. */
function networkHit(ttml: string | null, calls?: string[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls?.push(url);
    if (url.includes("betterlyrics.org") && ttml && url.includes("/getLyrics")) {
      return response({ ttml });
    }
    if (url.includes("binimum.org")) return response({ total: 0, source: "HIT-LOCAL-LIBSQL", results: [] });
    return response({ error: "not found" }, 404);
  });
}

/** Every provider fails at the transport level: the "no internet" case. */
function offlineFetch() {
  return vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
}

interface Harness {
  dir: string;
  cacheFile: string;
  store: LibraryStore;
  cache: LyricsCache;
  service: LyricsService;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "cadence-cache-manager-"));
  tempDirs.push(dir);
  const cacheFile = join(dir, "lyrics-cache.json");
  const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
    disableSqlite: true,
  });
  const cache = new LyricsCache(cacheFile);
  return { dir, cacheFile, store, cache, service: new LyricsService(store, cache) };
}

/** Rebuilds the cache + service from the file on disk: an actual app restart. */
function restart(harness: Harness): Harness {
  harness.cache.flush();
  const cache = new LyricsCache(harness.cacheFile);
  return { ...harness, cache, service: new LyricsService(harness.store, cache) };
}

function addTrack(
  harness: Harness,
  overrides: Partial<Parameters<LibraryStore["upsertTrack"]>[0]> & { embeddedLyrics?: { text: string; kind: string } } = {}
) {
  const { embeddedLyrics, ...rest } = overrides;
  const path = rest.path ?? join(harness.dir, "music", `${rest.title ?? "Harness Song"}.flac`);
  return harness.store.upsertTrack({
    path,
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
    hasSidecarLyrics: false,
    hasEmbeddedLyrics: Boolean(embeddedLyrics),
    embeddedLyrics: embeddedLyrics ?? null,
    ...rest,
  } as never);
}

const readEntries = (file: string): Record<string, any> => JSON.parse(readFileSync(file, "utf8")).entries;

function writeSidecar(dir: string, name: string, text: string): string {
  mkdirSync(join(dir, "music"), { recursive: true });
  const path = join(dir, "music", name);
  writeFileSync(path, text, "utf8");
  return path;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  setRuntimeFetch((...args) => globalThis.fetch(...args));
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------- tests */

describe("Global cache — every source is stored", () => {
  it("caches the local TTML sidecar, the embedded tag and the provider answer in one track entry", async () => {
    const harness = makeHarness();
    writeSidecar(harness.dir, "Harness Song.lrc", LINE_LRC);
    const { id } = addTrack(harness, { embeddedLyrics: { text: LINE_LRC, kind: "synced" } });
    vi.stubGlobal("fetch", networkHit(RICH_TTML));

    const result = await harness.service.resolve({ ...REQUEST, trackId: id });
    expect(result.candidates.map(candidate => candidate.source).sort()).toEqual([
      "blyrics-richsynced",
      "embedded-tag",
      "local-lrc",
    ]);
    harness.cache.flush();
    await new Promise(done => setTimeout(done, 20));

    const entries = readEntries(harness.cacheFile);
    expect(Object.keys(entries)).toEqual([`track:${id}`]);
    const entry = entries[`track:${id}`];
    expect(entry.kind).toBe("track");
    expect(entry.track).toMatchObject({ id, title: "Harness Song", artist: "Harness Artist", album: "Test Bench" });
    expect(entry.candidates.map((candidate: any) => [candidate.source, candidate.format, candidate.origin])).toEqual([
      ["local-lrc", "lrc", "local"],
      ["embedded-tag", "lrc", "local"],
    ]);
    expect(entry.network.candidates).toHaveLength(1);
    expect(entry.network.candidates[0]).toMatchObject({ source: "blyrics-richsynced", origin: "network" });
    expect(entry.network.negative).toBe(false);
  });

  it("stores a hand-picked file even when it lives outside the library, and restores it after a restart", async () => {
    const harness = makeHarness();
    const { id } = addTrack(harness);
    const outside = join(harness.dir, "downloads", "chosen.ttml");
    mkdirSync(join(harness.dir, "downloads"), { recursive: true });
    writeFileSync(outside, RICH_TTML, "utf8");

    harness.service.rememberUserFile(id, outside, RICH_TTML);
    harness.cache.flush();
    await new Promise(done => setTimeout(done, 20));

    const entry = readEntries(harness.cacheFile)[`track:${id}`];
    expect(entry.candidates).toHaveLength(1);
    expect(entry.candidates[0]).toMatchObject({ source: "user-file", format: "ttml", origin: "manual", sourceHref: outside });

    vi.stubGlobal("fetch", offlineFetch());
    const afterRestart = restart(harness);
    const resolved = await afterRestart.service.resolve({ ...REQUEST, trackId: id });
    const chosen = resolved.candidates.find(candidate => candidate.source === "user-file");
    expect(chosen?.text).toBe(RICH_TTML);
    expect(chosen?.cached).toBe(true);
    // The cache bookkeeping fields never leak into the renderer payload.
    expect(chosen && "format" in chosen).toBe(false);
  });

  it("remembers a manual search selection for its track and serves it after a restart", async () => {
    const harness = makeHarness();
    const { id } = addTrack(harness);
    harness.service.rememberSelection(id, {
      source: "lrclib-synced",
      provider: "LRCLIB",
      text: LINE_LRC,
      syncHint: "synced",
      language: null,
      songwriters: [],
      sourceHref: "https://lrclib.net/song/11",
      cached: false,
    });
    harness.cache.flush();
    await new Promise(done => setTimeout(done, 20));

    const entry = readEntries(harness.cacheFile)[`track:${id}`];
    expect(entry.candidates[0]).toMatchObject({ source: "lrclib-synced", origin: "manual", format: "lrc" });

    vi.stubGlobal("fetch", networkHit(null));
    const afterRestart = restart(harness);
    const resolved = await afterRestart.service.resolve({ ...REQUEST, trackId: id });
    expect(resolved.candidates.map(candidate => candidate.source)).toContain("lrclib-synced");
    expect(resolved.candidates.find(candidate => candidate.source === "lrclib-synced")?.text).toBe(LINE_LRC);
  });
});

describe("Global cache — replays exactly what was stored", () => {
  it("keeps translation, romanization and syllable timing intact across a restart", async () => {
    const harness = makeHarness();
    writeSidecar(harness.dir, "Harness Song.ttml", RICH_TTML);
    const { id } = addTrack(harness);
    vi.stubGlobal("fetch", offlineFetch());

    const first = await harness.service.resolve({ ...REQUEST, trackId: id, localOnly: true });
    const original = first.candidates.find(candidate => candidate.source === "local-rich");
    expect(original?.syncHint).toBe("richsync");
    expect(original?.language).toBe("ja");

    const afterRestart = restart(harness);
    const second = await afterRestart.service.resolve({ ...REQUEST, trackId: id, localOnly: true });
    const replayed = second.candidates.find(candidate => candidate.source === "local-rich");
    expect(replayed?.text).toBe(original?.text);
    expect(replayed?.syncHint).toBe(original?.syncHint);
    expect(replayed?.language).toBe(original?.language);
    expect(replayed?.sourceHref).toBe(original?.sourceHref);
  });

  it("serves the provider answer offline, without a single request", async () => {
    const harness = makeHarness();
    const { id } = addTrack(harness);
    const live = networkHit(RICH_TTML);
    vi.stubGlobal("fetch", live);
    await harness.service.resolve({ ...REQUEST, trackId: id });
    const callsAfterFirst = live.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const afterRestart = restart(harness);
    const offline = offlineFetch();
    vi.stubGlobal("fetch", offline);
    const resolved = await afterRestart.service.resolve({ ...REQUEST, trackId: id });
    expect(offline).not.toHaveBeenCalled();
    const candidate = resolved.candidates.find(entry => entry.source === "blyrics-richsynced");
    expect(candidate?.cached).toBe(true);
    expect(candidate?.text).toBe(RICH_TTML);
  });

  it("replays the local copy when the sidecar disappeared (unplugged drive)", async () => {
    const harness = makeHarness();
    const sidecar = writeSidecar(harness.dir, "Harness Song.lrc", LINE_LRC);
    const { id } = addTrack(harness);
    vi.stubGlobal("fetch", offlineFetch());
    const first = await harness.service.resolve({ ...REQUEST, trackId: id, localOnly: true });
    expect(first.candidates[0]).toMatchObject({ source: "local-lrc" });

    // The whole media folder goes away.
    rmSync(join(harness.dir, "music"), { recursive: true, force: true });
    expect(existsSync(sidecar)).toBe(false);

    const afterRestart = restart(harness);
    const second = await afterRestart.service.resolve({ ...REQUEST, trackId: id, localOnly: true });
    const restored = second.candidates.find(candidate => candidate.source === "local-lrc");
    expect(restored?.text).toBe(LINE_LRC);
    expect(second.providerStatus.find(status => status.provider === "local-lrc")).toMatchObject({
      status: "hit",
      detail: "Cached copy (source file unavailable)",
    });
  });

  it("does not resurrect a sidecar the user replaced", async () => {
    const harness = makeHarness();
    writeSidecar(harness.dir, "Harness Song.lrc", LINE_LRC);
    const { id } = addTrack(harness);
    vi.stubGlobal("fetch", offlineFetch());
    await harness.service.resolve({ ...REQUEST, trackId: id, localOnly: true });

    rmSync(join(harness.dir, "music", "Harness Song.lrc"));
    writeSidecar(harness.dir, "Harness Song.ttml", RICH_TTML);
    const resolved = await harness.service.resolve({ ...REQUEST, trackId: id, localOnly: true });
    expect(resolved.candidates.map(candidate => candidate.source)).toEqual(["local-rich"]);
  });
});

describe("Global cache — track identity", () => {
  it("keeps two untagged songs with the same title apart", async () => {
    const harness = makeHarness();
    mkdirSync(join(harness.dir, "music"), { recursive: true });
    writeFileSync(join(harness.dir, "music", "one.flac"), "a");
    writeFileSync(join(harness.dir, "music", "two.flac"), "b");
    const first = addTrack(harness, {
      path: join(harness.dir, "music", "one.flac"),
      title: "Same Title",
      artist: "",
      album: "",
    });
    const second = addTrack(harness, {
      path: join(harness.dir, "music", "two.flac"),
      title: "Same Title",
      artist: "",
      album: "",
    });
    writeSidecar(harness.dir, "one.lrc", LINE_LRC);
    writeSidecar(harness.dir, "two.lrc", "[00:10.00]other song");
    vi.stubGlobal("fetch", offlineFetch());

    const a = await harness.service.resolve({
      trackId: first.id,
      title: "Same Title",
      artist: "",
      album: "",
      duration: 180,
      localOnly: true,
    });
    const b = await harness.service.resolve({
      trackId: second.id,
      title: "Same Title",
      artist: "",
      album: "",
      duration: 180,
      localOnly: true,
    });
    expect(a.candidates[0].text).toBe(LINE_LRC);
    expect(b.candidates[0].text).toBe("[00:10.00]other song");

    harness.cache.flush();
    await new Promise(done => setTimeout(done, 20));
    expect(Object.keys(readEntries(harness.cacheFile)).sort()).toEqual([`track:${first.id}`, `track:${second.id}`]);
  });

  it("never replays a track's lyrics after its tags changed", async () => {
    const harness = makeHarness();
    const { id } = addTrack(harness);
    const live = networkHit(RICH_TTML);
    vi.stubGlobal("fetch", live);
    await harness.service.resolve({ ...REQUEST, trackId: id });
    const callsAfterFirst = live.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // The user retags the file and the library rescans it: same row id, new identity.
    addTrack(harness, { path: join(harness.dir, "music", "Harness Song.flac"), title: "A Different Song" });
    const renamed = await harness.service.resolve({
      ...REQUEST,
      trackId: id,
      title: "A Different Song",
      duration: 200,
    });
    expect(live.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(renamed.candidates.every(candidate => !candidate.cached)).toBe(true);
  });
});

describe("Global cache — integrity", () => {
  it("ignores malformed entries instead of crashing, and keeps the healthy ones", async () => {
    const harness = makeHarness();
    writeFileSync(
      harness.cacheFile,
      JSON.stringify({
        version: 3,
        entries: {
          "track:1": { savedAt: Date.now(), kind: "track", track: { id: 1, title: "x" }, candidates: "nope" },
          "track:2": "garbage",
          "track:3": {
            savedAt: Date.now(),
            kind: "track",
            track: { id: 3, title: "Good", artist: "", album: "", duration: 1 },
            candidates: [
              { source: "local-lrc", provider: "Local LRC", text: LINE_LRC, syncHint: "synced", songwriters: [] },
              { source: "local-lrc", provider: "broken", text: "", syncHint: "synced", songwriters: [] },
            ],
          },
        },
      })
    );
    const cache = new LyricsCache(harness.cacheFile);
    expect(() => cache.list()).not.toThrow();
    const rows = cache.list();
    expect(rows.map(row => row.key)).toContain("track:3");
    // `track:1` had a corrupt candidate list and `track:2` was not an object at all.
    expect(rows.map(row => row.key)).not.toContain("track:2");
    expect(cache.getEntry("track:3")?.candidates).toHaveLength(1);
  });

  it("drops a cache file written by an older schema", () => {
    const harness = makeHarness();
    const stale = JSON.stringify({ version: 2, entries: { "artist|title||200": { savedAt: Date.now(), negative: false, candidates: [] } } });
    const cache = new LyricsCacheCore({ initialJson: stale });
    expect(cache.size()).toBe(0);
    expect(cache.list()).toEqual([]);
  });

  it("keeps resolving when the cache file cannot be written", async () => {
    const harness = makeHarness();
    const { id } = addTrack(harness);
    const cache = new LyricsCacheCore({
      initialJson: null,
      persist: () => {
        throw new Error("Access is denied. (os error 5)");
      },
    });
    const service = new LyricsService(harness.store, cache);
    vi.stubGlobal("fetch", networkHit(RICH_TTML));

    const resolved = await service.resolve({ ...REQUEST, trackId: id });
    expect(resolved.candidates).toHaveLength(1);
    // The debounced flush swallows the failure instead of breaking the resolve.
    await expect(cache.persistNow()).rejects.toThrow("Access is denied");
    expect(cache.size()).toBe(1);
  });

  it("does not rewrite the file when an identical bundle is resolved again", async () => {
    const harness = makeHarness();
    writeSidecar(harness.dir, "Harness Song.lrc", LINE_LRC);
    const { id } = addTrack(harness);
    let writes = 0;
    const cache = new LyricsCacheCore({
      initialJson: null,
      persist: () => {
        writes += 1;
      },
    });
    const service = new LyricsService(harness.store, cache);
    vi.stubGlobal("fetch", offlineFetch());

    await service.resolve({ ...REQUEST, trackId: id, localOnly: true });
    await cache.persistNow();
    const writesAfterFirst = writes;
    expect(writesAfterFirst).toBeGreaterThan(0);

    await service.resolve({ ...REQUEST, trackId: id, localOnly: true });
    await cache.persistNow();
    expect(writes).toBe(writesAfterFirst);
  });
});

describe("Global cache — cache manager data", () => {
  it("lists, inspects, deletes one entry and clears everything without touching user files", async () => {
    const harness = makeHarness();
    const sidecar = writeSidecar(harness.dir, "Harness Song.lrc", LINE_LRC);
    const { id } = addTrack(harness, { embeddedLyrics: { text: LINE_LRC, kind: "synced" } });
    vi.stubGlobal("fetch", networkHit(RICH_TTML));

    await harness.service.resolve({ ...REQUEST, trackId: id });
    await harness.service.searchLyrics({ title: "Harness Song", artist: "Harness Artist" } as never);
    harness.cache.flush();
    await new Promise(done => setTimeout(done, 20));

    const rows = harness.cache.list();
    const trackRow = rows.find(row => row.key === `track:${id}`);
    expect(trackRow).toMatchObject({ title: "Harness Song", artist: "Harness Artist", album: "Test Bench" });
    expect(trackRow?.sources).toEqual(expect.arrayContaining(["Local LRC", "Embedded tag", "Better Lyrics"]));
    expect(trackRow?.formats).toEqual(expect.arrayContaining(["lrc", "ttml"]));
    expect(rows.some(row => row.kind === "search")).toBe(true);

    const stats = harness.cache.stats();
    expect(stats.entries).toBe(rows.length);
    expect(stats.tracks).toBe(1);
    expect(stats.searches).toBe(rows.length - 1);
    // The reported size is the exact serialized byte length, not an estimate.
    expect(stats.bytes).toBe(new TextEncoder().encode(JSON.stringify(JSON.parse(readFileSync(harness.cacheFile, "utf8")))).length);

    // One entry gone, the others untouched.
    expect(harness.cache.remove("track:not-there")).toBe(false);
    expect(harness.cache.remove(`track:${id}`)).toBe(true);
    await harness.cache.persistNow();
    const afterDelete = readEntries(harness.cacheFile);
    expect(afterDelete[`track:${id}`]).toBeUndefined();
    expect(Object.keys(afterDelete).some(key => key.startsWith("search:"))).toBe(true);
    // The original lyrics file and the library are untouched by a cache deletion.
    expect(readFileSync(sidecar, "utf8")).toBe(LINE_LRC);
    expect(harness.store.getTrack(id)?.title).toBe("Harness Song");

    await harness.service.clearCache();
    expect(readEntries(harness.cacheFile)).toEqual({});
    expect(existsSync(sidecar)).toBe(true);
    expect(harness.store.getLyrics(id)?.text).toBe(LINE_LRC);
  });

  it("does not cache an unsuccessful lookup", async () => {
    const harness = makeHarness();
    const { id } = addTrack(harness);
    vi.stubGlobal("fetch", offlineFetch());
    const resolved = await harness.service.resolve({ ...REQUEST, trackId: id });
    expect(resolved.candidates).toEqual([]);
    harness.cache.flush();
    await new Promise(done => setTimeout(done, 20));
    const entries = readEntries(harness.cacheFile);
    // Transport failures are not definitive: nothing is remembered as "no lyrics exist".
    expect(entries[`track:${id}`]?.network).toBeUndefined();
    // No entry at all: an unfinished lookup answers nothing and is not served as a cached miss.
    expect(harness.cache.get(`track:${id}`)).toBeNull();
  });

  it("keeps a definitive miss for 12 hours and then asks the providers again", async () => {
    const harness = makeHarness();
    const { id } = addTrack(harness);
    const live = networkHit(null);
    vi.stubGlobal("fetch", live);
    await harness.service.resolve({ ...REQUEST, trackId: id });
    const callsAfterMiss = live.mock.calls.length;
    expect(callsAfterMiss).toBeGreaterThan(0);

    // Inside the negative TTL the cached miss answers without traffic.
    await harness.service.resolve({ ...REQUEST, trackId: id });
    expect(live.mock.calls.length).toBe(callsAfterMiss);

    // Age the stored answer past 12h: the next resolve must retry.
    harness.cache.flush();
    await new Promise(done => setTimeout(done, 20));
    const data = JSON.parse(readFileSync(harness.cacheFile, "utf8"));
    const key = `track:${id}`;
    expect(data.entries[key].network.negative).toBe(true);
    data.entries[key].network.savedAt = Date.now() - 13 * 60 * 60 * 1000;
    writeFileSync(harness.cacheFile, JSON.stringify(data));
    const aged = restart(harness);
    await aged.service.resolve({ ...REQUEST, trackId: id });
    expect(live.mock.calls.length).toBeGreaterThan(callsAfterMiss);
  });
});

/* ------------------------------------------------------------ Tauri bridge */

describe("Tauri bridge — cache manager API", () => {
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

  it("lists, inspects and deletes entries through the real IPC contract", async () => {
    const persistedDb: DatabaseShape = emptyDatabase();
    let persistedLyricsCacheJson: string | null = null;
    const writes: string[] = [];

    mockIPC(
      async (cmd, payload: any) => {
        switch (cmd) {
          case "cmd_bootstrap":
            return {
              appDataDir: "/tmp/cadence",
              artworkDir: "/tmp/cadence/artwork",
              platform: "linux",
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
            writes.push(payload.content);
            persistedLyricsCacheJson = payload.content;
            return null;
          case "cmd_http_fetch": {
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

    const session = await installTauriBridge();
    await session.api.lyrics.resolve(REQUEST);
    await new Promise(done => setTimeout(done, 20));

    const list = await session.api.lyrics.listCache();
    expect(list.stats.entryCount).toBeGreaterThan(0);
    expect(list.stats.bytes).toBeGreaterThan(0);
    const row = list.entries.find(entry => entry.key === "track:5");
    expect(row).toMatchObject({ title: "Harness Song", artist: "Harness Artist", kind: "track" });

    const detail = await session.api.lyrics.getCacheEntry("track:5");
    expect(detail?.candidates[0]).toMatchObject({ source: "lrclib-synced", format: "lrc", origin: "network" });
    expect(detail?.candidates[0].text).toBe(LINE_LRC);
    expect(await session.api.lyrics.getCacheEntry("track:missing")).toBeNull();

    const removal = await session.api.lyrics.removeCacheEntry("track:5");
    expect(removal.removed).toBe(true);
    expect(removal.stats.entryCount).toBe(0);
    expect(writes.length).toBeGreaterThan(0);
    expect(JSON.parse(writes.at(-1)!).entries).toEqual({});
    expect((await session.api.lyrics.removeCacheEntry("track:5")).removed).toBe(false);
    session.dispose();
  }, 30_000);
});
