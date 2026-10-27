/**
 * End-to-end harness for the global lyrics cache and its manager (Settings → Cache).
 *
 * Unlike the unit tests, nothing about the storage or the UI is stubbed here: the real
 * `LyricsService` + `LyricsCacheCore` run behind an HTTP server (the same JSON contract the Tauri
 * bridge exposes), the production renderer bundle from `dist/` is driven in headless Chromium, and
 * every assertion reads the actual `lyrics-cache.json`, the actual sidecar files and the actual
 * library store.
 *
 * Usage: npm run build:web && npx vite-node tests/browser/build-library.ts
 *        && npx vite-node tests/browser/lyrics-cache-manager.ts
 */

import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";
import { LyricsCacheCore } from "../../src/main/lyrics/cacheCore";
import { LyricsService } from "../../src/main/lyrics/service";
import { LibraryStore } from "../../src/main/library/store";
import { scanLibrary } from "../../src/main/library/scanner";
import { SettingsStore } from "../../src/main/settings";
import type { LyricsResolveRequest, LyricsSearchRequest } from "../../src/shared/types";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const fixtures = join(root, ".artifacts/fixtures/formats");
const shotDir = join(root, ".artifacts/lyrics-cache");
mkdirSync(shotDir, { recursive: true });

if (!existsSync(join(outDir, "index.html"))) throw new Error("Run: npm run build:web");
if (!existsSync(join(fixtures, "fixture.flac"))) throw new Error("Run: python3 tests/fixtures/generate-audio.py");

/* --------------------------------------------------------------- fixtures */

const RICH_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
    xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
    xml:lang="ja">
  <head>
    <metadata>
      <itunes:metadata>
        <translations>
          <translation xml:lang="en"><text for="L1">Cherry blossoms bloom</text></translation>
        </translations>
        <transliterations>
          <transliteration xml:lang="ja-Latn"><text for="L1">sakura ga saku</text></transliteration>
        </transliterations>
      </itunes:metadata>
    </metadata>
  </head>
  <body dur="00:30.000">
    <div>
      <p begin="00:00.500" end="00:02.400" itunes:key="L1"><span begin="00:00.500" end="00:01.300">桜が</span><span begin="00:01.300" end="00:02.400">咲く</span></p>
      <p begin="00:02.600" end="00:04.800" itunes:key="L2"><span begin="00:02.600" end="00:03.500">風が</span><span begin="00:03.500" end="00:04.800">吹く</span></p>
    </div>
  </body>
</tt>`;

const LINE_LRC = "[00:00.50]Local first line\n[00:02.00]Second local line\n[00:04.00]Third local line";
const PROVIDER_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00.400" end="00:01.800">Provider line one</p>
<p begin="00:02.000" end="00:03.600">Provider line two</p>
<p begin="00:04.000" end="00:05.400">Provider line three</p>
</div></body></tt>`;
const CHOSEN_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00.600" end="00:02.000">Chosen file line one</p>
<p begin="00:02.400" end="00:04.200">Chosen file line two</p>
</div></body></tt>`;

/* ---------------------------------------------------------------- library */

const stateDir = mkdtempSync(join(tmpdir(), "cadence-cache-ui-"));
const musicDir = join(stateDir, "music");
const altDir = join(musicDir, "alt");
const artworkDir = join(stateDir, "artwork");
const libraryDb = join(stateDir, "library.db");
const settingsFile = join(stateDir, "settings.json");
const cacheFile = join(stateDir, "lyrics-cache.json");
mkdirSync(altDir, { recursive: true });
mkdirSync(artworkDir, { recursive: true });

const flacPath = join(musicDir, "Fixture FLAC.flac");
copyFileSync(join(fixtures, "fixture.flac"), flacPath);
writeFileSync(join(musicDir, "Fixture FLAC.ttml"), RICH_TTML, "utf8");
const mp3Path = join(musicDir, "Fixture MP3.mp3");
copyFileSync(join(fixtures, "fixture.mp3"), mp3Path);
writeFileSync(join(musicDir, "Fixture MP3.lrc"), LINE_LRC, "utf8");
const networkOnlyPath = join(musicDir, "Network Only.wav");
copyFileSync(join(fixtures, "fixture.wav"), networkOnlyPath);
const networkTwinPath = join(altDir, "Network Only.wav");
copyFileSync(join(fixtures, "fixture.wav"), networkTwinPath);
const embeddedPath = join(musicDir, "Embedded Song.flac");
copyFileSync(join(fixtures, "fixture.flac"), embeddedPath);
// A wav copy has no embedded tag, so this track genuinely has no lyrics anywhere.
const emptyPath = join(musicDir, "No Lyrics.wav");
copyFileSync(join(fixtures, "fixture.wav"), emptyPath);

let store = new LibraryStore(libraryDb, artworkDir, path => `media://${path}`);
const scan = await scanLibrary(store, { folders: [musicDir] });
if (scan.errors.length) console.log("scan errors:", scan.errors);

/** Rewrites one row's tags (a "re-tagged file") without changing its identity in the library. */
const retag = (path: string, patch: { title: string; artist?: string; album?: string }, embedded?: string) => {
  const track = store.getTrackByPath(path);
  if (!track) throw new Error(`No scanned track for ${path}`);
  const { id, favorite, addedAt, lastPlayedAt, playCount, ...row } = track;
  store.upsertTrack({ ...row, ...patch, embeddedLyrics: embedded ? { text: embedded, kind: "synced" } : null });
  return id;
};
const idOf = (path: string) => {
  const track = store.getTrackByPath(path);
  if (!track) throw new Error(`No track for ${path}`);
  return track.id;
};
retag(embeddedPath, { title: "Embedded Song" }, LINE_LRC);
retag(emptyPath, { title: "No Lyrics" });
store.flush();

/* ------------------------------------------------------ main-process modules */

const makeCache = () =>
  new LyricsCacheCore({
    initialJson: existsSync(cacheFile) ? readFileSync(cacheFile, "utf8") : null,
    persist: async json => {
      writeFileSync(`${cacheFile}.tmp`, json);
      const { renameSync } = await import("node:fs");
      renameSync(`${cacheFile}.tmp`, cacheFile);
    },
  });

let settings = new SettingsStore(settingsFile);
// Turn on the decoration passes so the *file-supplied* translation/romanization is rendered too;
// the machine endpoints below answer with nulls, so only embedded decorations can appear.
settings.patch({ lyrics: { translationLanguage: "en", romanization: true } });
let lyricsCache = makeCache();
let lyricsService = new LyricsService(store, lyricsCache);

const coldStart = async () => {
  await lyricsCache.persistNow().catch(() => {});
  store.flush();
  store = new LibraryStore(libraryDb, artworkDir, path => `media://${path}`);
  settings = new SettingsStore(settingsFile);
  lyricsCache = makeCache();
  lyricsService = new LyricsService(store, lyricsCache);
};

/** Ids never change across a cold start (same database file). */
const ids = {
  flac: idOf(flacPath),
  mp3: idOf(mp3Path),
  network: idOf(networkOnlyPath),
  networkTwin: idOf(networkTwinPath),
  embedded: idOf(embeddedPath),
  empty: idOf(emptyPath),
};

const snapshot = () => {
  const tracks = store.getTracks().map(track => ({
    ...store.toTrack(track),
    streamUrl: `/audio/${track.id}`,
    artworkUrl: null,
  }));
  return {
    tracks,
    albums: store.getAlbums(),
    artists: store.getArtists(),
    playlists: store.getPlaylists(),
    folders: store.getFolders(),
    counts: { tracks: tracks.length, albums: store.getAlbums().length, artists: store.getArtists().length },
    scan: {
      running: false,
      phase: "done",
      foldersTotal: 1,
      filesSeen: tracks.length,
      filesProcessed: tracks.length,
      filesSkipped: 0,
      errors: [],
      message: `Library ready — ${tracks.length} files`,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    },
    engine: store.engine,
  };
};

/* ------------------------------------------------------------ provider net */

let offline = false;
const providerCalls: string[] = [];
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("betterlyrics.org") && !url.includes("lrclib.net") && !url.includes("binimum.org")) {
    return realFetch(input as RequestInfo, init);
  }
  providerCalls.push(url);
  if (offline) throw new TypeError("Failed to fetch");
  // The one deliberately lyric-less track stays empty, so the "choose a file" flow has a subject.
  if (decodeURIComponent(url.replace(/\+/g, " ")).includes("No Lyrics")) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const parsed = new URL(url);
  if (parsed.hostname === "api.betterlyrics.org" && parsed.pathname === "/getLyrics") {
    return new Response(JSON.stringify({ ttml: PROVIDER_TTML }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (parsed.hostname.includes("binimum.org")) {
    return new Response(JSON.stringify({ total: 0, source: "HIT-LOCAL-LIBSQL", results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

/* ------------------------------------------------------------------ server */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
  new Promise(done => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => done(data));
  });

const statsOf = () => {
  const stats = lyricsCache.stats();
  return {
    entryCount: stats.entries,
    tracks: stats.tracks,
    searches: stats.searches,
    bytes: stats.bytes,
  };
};

const detailOf = (key: string) => {
  const entry = lyricsCache.getEntry(key);
  if (!entry) return null;
  return {
    key,
    kind: entry.kind,
    trackId: entry.track.id,
    title: entry.track.title,
    artist: entry.track.artist,
    album: entry.track.album,
    duration: entry.track.duration,
    savedAt: entry.savedAt,
    candidates: [...entry.candidates, ...(entry.network?.candidates ?? [])].map(candidate => ({
      source: candidate.source,
      provider: candidate.provider,
      format: candidate.format,
      origin: candidate.origin,
      syncHint: candidate.syncHint,
      language: candidate.language,
      songwriters: candidate.songwriters,
      sourceHref: candidate.sourceHref,
      cachedAt: candidate.cachedAt,
      text: candidate.text,
    })),
  };
};

let failCacheList = false;
let slowCacheList = false;
let resolveCount = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const sendJson = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname.startsWith("/api/")) {
    try {
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
      if (url.pathname === "/api/library") return sendJson(snapshot());
      if (url.pathname === "/api/settings") return sendJson(settings.get());
      if (url.pathname === "/api/settings/patch") return sendJson(settings.patch(body));
      if (url.pathname === "/api/settings/reset") return sendJson(settings.reset());
      if (url.pathname === "/api/lyrics/resolve") {
        resolveCount += 1;
        const result = await lyricsService.resolve(body as LyricsResolveRequest, settings.get().lyrics.providerOrder);
        console.log(
          `resolve #${resolveCount} track=${(body as LyricsResolveRequest).trackId} "${(body as LyricsResolveRequest).title}" -> ${result.candidates
            .map(candidate => candidate.source)
            .join(",") || "none"}`
        );
        lyricsCache.flush();
        return sendJson(result);
      }
      if (url.pathname === "/api/lyrics/search") {
        const request = body as LyricsSearchRequest;
        // The search flow always offers one deterministic row (the "find lyrics for another
        // title" case), so the manual-selection path is exercised end to end.
        await lyricsService.searchLyrics(request, settings.get().lyrics.providerOrder).catch(() => undefined);
        lyricsCache.flush();
        return sendJson({
          results: [
            {
              source: "lrclib-synced",
              provider: "LRCLIB",
              text: "[00:00.70]Search result line one\n[00:02.50]Search result line two",
              syncHint: "synced",
              language: "en",
              songwriters: [],
              sourceHref: "https://lrclib.net/song/42",
              cached: false,
              matchTitle: request.title,
              matchArtist: request.artist,
              matchAlbum: "",
              matchDuration: request.duration ?? 6,
            },
          ],
          providerStatus: [{ provider: "lrclib", status: "hit" }],
          cached: false,
        });
      }
      if (url.pathname === "/api/lyrics/clear-cache") {
        const removedEntries = await lyricsService.clearCache();
        return sendJson({ removedEntries });
      }
      if (url.pathname === "/api/lyrics/cache-list") {
        if (failCacheList) throw new Error("disk unavailable (harness)");
        if (slowCacheList) await wait(900);
        await lyricsCache.persistNow().catch(() => undefined);
        return sendJson({ entries: lyricsCache.list(), stats: statsOf() });
      }
      if (url.pathname === "/api/lyrics/cache-entry") return sendJson(detailOf(String(body.key)));
      if (url.pathname === "/api/lyrics/cache-remove") {
        const removed = lyricsCache.remove(String(body.key));
        if (removed) await lyricsCache.persistNow();
        return sendJson({ removed, stats: statsOf() });
      }
      if (url.pathname === "/api/lyrics/cache-chosen-file") {
        lyricsService.rememberUserFile(Number(body.trackId), String(body.path), String(body.text));
        lyricsCache.flush();
        return sendJson({});
      }
      if (url.pathname === "/api/lyrics/remember-selection") {
        lyricsService.rememberSelection(Number(body.trackId), body.candidate);
        lyricsCache.flush();
        return sendJson({});
      }
      if (url.pathname === "/api/lyrics/translate") {
        return sendJson({ translations: (body.lines ?? []).map(() => null), detectedLanguage: "en" });
      }
      if (url.pathname === "/api/lyrics/romanize") {
        return sendJson({ romanizations: (body.lines ?? []).map(() => null), detectedLanguage: "en" });
      }
      return sendJson({ error: "unknown endpoint" }, 404);
    } catch (error) {
      return sendJson({ error: (error as Error).message }, 500);
    }
  }

  let file: string | null = null;
  if (url.pathname.startsWith("/audio/")) {
    const track = store.getTrack(Number(url.pathname.slice("/audio/".length)));
    file = track?.path ?? null;
  } else {
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    file = join(outDir, path);
    if (!file.startsWith(outDir)) file = null;
  }
  if (!file || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const size = statSync(file).size;
  const headers: Record<string, string | number> = {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)!;
    const start = Number(match[1] || 0);
    const end = match[2] ? Number(match[2]) : size - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(file).pipe(res);
  }
});

await new Promise<void>(done => server.listen(4795, "0.0.0.0", () => done()));
const base = "http://127.0.0.1:4795";

/* ----------------------------------------------------------------- browser */

await inflate(join(root, "node_modules/@sparticuz/chromium/bin/al2023.tar.br"));
setupLambdaEnvironment(join(tmpdir(), "al2023", "lib"));
chromium.setGraphicsMode = true;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  args: [...chromium.args, "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader"],
  defaultViewport: { width: 1480, height: 900 },
  protocolTimeout: 180_000,
});
const page = await browser.newPage();
const logs: string[] = [];
page.on("console", message => logs.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", (error: unknown) => logs.push(`[pageerror] ${String(error)}`));

await page.evaluateOnNewDocument(() => {
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(
      path,
      body === undefined
        ? { cache: "no-store" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    );
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
    return payload;
  };
  const chrome = { undecorated: false, maximized: false, fullscreen: false, focused: true };
  (window as unknown as { cadence: unknown }).cadence = {
    info: async () => ({
      name: "Cadence",
      version: "harness",
      platform: "browser-harness",
      electron: "",
      chrome: navigator.userAgent,
      node: "n/a",
      dbEngine: "sqlite",
      mediaProtocol: "http",
    }),
    library: {
      snapshot: async () => call("/api/library"),
      addFolder: async () => ({ canceled: true, folders: [] }),
      removeFolder: async () => call("/api/library"),
      rescan: async () => ({ added: 0, updated: 0, removed: 0, errors: [], durationMs: 1 }),
      search: async () => [],
      getTrack: async (id: number) =>
        (await call("/api/library")).tracks.find((track: { id: number }) => track.id === id) ?? null,
      setFavorite: async () => undefined,
      recordPlay: async () => undefined,
      onScanProgress: () => () => {},
      onChanged: () => () => {},
    },
    playlists: {
      list: async () => [],
      create: async () => ({}),
      rename: async () => undefined,
      remove: async () => undefined,
      addTracks: async () => undefined,
      removeTrack: async () => undefined,
      reorder: async () => undefined,
      tracks: async () => [],
    },
    settings: {
      get: async () => call("/api/settings"),
      patch: async (patch: unknown) => call("/api/settings/patch", patch),
      reset: async () => call("/api/settings/reset", {}),
    },
    lyrics: {
      resolve: async (request: unknown) => call("/api/lyrics/resolve", request),
      search: async (request: unknown) => call("/api/lyrics/search", request),
      youtubeMetadata: async () => ({ ok: false, reason: "error", detail: "not in harness" }),
      translate: async (request: { lines: string[] }) => ({ translations: request.lines.map(() => null), detectedLanguage: "en" }),
      romanize: async (request: { lines: string[] }) => ({ romanizations: request.lines.map(() => null), detectedLanguage: "en" }),
      saveSidecar: async () => ({ path: "/harness/lyrics.lrc" }),
      clearCache: async () => call("/api/lyrics/clear-cache", {}),
      listCache: async () => call("/api/lyrics/cache-list"),
      getCacheEntry: async (key: string) => call("/api/lyrics/cache-entry", { key }),
      removeCacheEntry: async (key: string) => call("/api/lyrics/cache-remove", { key }),
      cacheChosenFile: async (request: unknown) => call("/api/lyrics/cache-chosen-file", request),
      rememberSelection: async (request: unknown) => call("/api/lyrics/remember-selection", request),
    },
    app: {
      openExternal: async () => undefined,
      openPath: async () => undefined,
      chooseLyricsFile: async () => {
        const state = (window as unknown as { __chosen: { text: string; path: string } | null }).__chosen;
        (window as unknown as { __chosen: unknown }).__chosen = null;
        return state ? { canceled: false, text: state.text, path: state.path } : { canceled: true };
      },
      window: async () => undefined,
      isFullScreen: async () => false,
      initialWindowChrome: { ...chrome },
      windowChrome: async () => ({ ...chrome }),
      onWindowChromeChange: () => () => {},
    },
    player: {
      prepareAlacSource: async () => "/audio/fixture.wav",
      reportState: async () => undefined,
      onCommand: () => () => {},
    },
    decodeTester: { deleteFiles: async () => [], exportFileList: async () => ({ canceled: true }) },
  };
});

/* ------------------------------------------------------------------ utils */

const results: Record<string, { value: boolean; detail: string }> = {};
const check = (name: string, value: boolean, detail = "") => {
  results[name] = { value: Boolean(value), detail };
  console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const shot = async (name: string) => page.screenshot({ path: join(shotDir, `${name}.png`) as `${string}.png` });

const clickText = async (selector: string, wanted: string, exact = true) => {
  for (const handle of await page.$$(selector)) {
    const text = await handle.evaluate(node => node.textContent?.replace(/\s+/g, " ").trim() ?? "");
    if (exact ? text === wanted : text.includes(wanted)) {
      await handle.click();
      await wait(120);
      return;
    }
  }
  throw new Error(
    `No ${selector} with text ${JSON.stringify(wanted)}; saw ${JSON.stringify(
      await page.$$eval(selector, nodes => nodes.map(node => node.textContent?.replace(/\s+/g, " ").trim()))
    )}`
  );
};
const nav = async (label: string) => {
  await clickText(".sidebar .nav-item", label);
  await wait(280);
};

/** Clicks a Songs row by library id: two untagged fixtures share one title on purpose. */
const nowPlaying = async () =>
  page.evaluate(() => ({
    title: document.querySelector(".player-title")?.textContent?.trim() ?? "",
    artist: document.querySelector(".player-artist")?.textContent?.trim() ?? "",
  }));

/** Clicks a Songs row by library id: two untagged fixtures share one title on purpose. */
const playTrackId = async (trackId: number) => {
  const selector = `[data-testid="track-row"][data-track-id="${trackId}"]`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await nav("Songs");
    const row = await page.$(selector);
    if (!row) throw new Error(`No track row ${trackId}`);
    await row.click();
    await wait(900);
    // Six-second fixtures must not auto-advance in the middle of a check.
    await page.evaluate(() => document.querySelector("audio")?.pause());
    await wait(200);
    // The active row is the truth: two fixtures share the same title, so the player text can lie.
    const active = await page.$eval(selector, node => node.classList.contains("active")).catch(() => false);
    if (active) return;
  }
  throw new Error(`Player did not switch to track ${trackId} (${JSON.stringify(await nowPlaying())})`);
};

const currentTrack = async () => {
  const state = await nowPlaying();
  return `${state.title} / ${state.artist}`;
};

const rawLyricText = () =>
  page.$$eval(".blyrics--line", nodes => nodes.map(node => node.textContent ?? "").join(" | ")).catch(() => "");

/** Polls until the panel shows `expected`, so a slow resolve is never read as a stale track. */
const lyricText = async (expected?: string) => {
  await nav("Now Playing");
  const deadline = Date.now() + 15_000;
  let text = await rawLyricText();
  while (expected !== undefined && !text.includes(expected) && Date.now() < deadline) {
    await wait(250);
    text = await rawLyricText();
  }
  await wait(150);
  return rawLyricText();
};
const openCache = async () => {
  await nav("Settings");
  await clickText(".settings-tabs button", "Cache");
  await wait(350);
};
const cacheRows = async () =>
  page.$$eval('[data-testid="cache-row"]', nodes =>
    nodes.map(node => ({
      key: node.getAttribute("data-key") ?? "",
      text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }))
  );
const cacheKeys = () => {
  try {
    return Object.keys(JSON.parse(readFileSync(cacheFile, "utf8")).entries ?? {}).join(",");
  } catch {
    return "<none>";
  }
};
const cacheFileEntries = (): Record<string, any> => {
  if (!existsSync(cacheFile)) return {};
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8")).entries ?? {};
  } catch {
    return { "<unparseable>": {} };
  }
};
const statsText = async () =>
  page.$eval('[data-testid="cache-stats"]', node => node.textContent?.replace(/\s+/g, " ").trim() ?? "").catch(() => "");

/** Replaces the filter field's value through real keystrokes (React's controlled input). */
const setFilter = async (value: string) => {
  await page.click('[data-testid="cache-filter"]');
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (value) await page.type('[data-testid="cache-filter"]', value);
  await wait(300);
};

/* ------------------------------------------------------------------ script */

console.log(`track ids: ${JSON.stringify(ids)}`);

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sidebar", { timeout: 60_000 });
await wait(900);

/* 1. Local TTML (original + translation + romanization) is cached and rendered. */
await playTrackId(ids.flac);
const flacLyrics = await lyricText();
await shot("01-now-playing-local-ttml");
check(
  "local-ttml-renders",
  flacLyrics.includes("桜が") && flacLyrics.includes("Cherry blossoms bloom") && flacLyrics.includes("sakura ga saku"),
  JSON.stringify(flacLyrics.slice(0, 160))
);

/* The panel must say it is reading the cache instead of showing an empty list. */
slowCacheList = true;
await nav("Settings");
await clickText(".settings-tabs button", "Cache");
const loadingShown = await page
  .waitForSelector('[data-testid="cache-loading"]', { timeout: 5_000 })
  .then(() => true)
  .catch(() => false);
check("cache-loading-state", loadingShown, loadingShown ? "" : "the loading state never rendered");
await page.waitForSelector('[data-testid="cache-row"]', { timeout: 15_000 }).catch(() => undefined);
slowCacheList = false;
await openCache();
await shot("02-cache-list");
const rowsAfterFlac = await cacheRows();
const flacRow = rowsAfterFlac.find(row => row.text.includes("Fixture FLAC"));
check("cache-lists-local-entry", Boolean(flacRow), JSON.stringify(rowsAfterFlac.map(row => row.text)));
check(
  "cache-row-shows-source-and-format",
  Boolean(flacRow && /Local TTML\/QRC/.test(flacRow.text) && /TTML/.test(flacRow.text) && /Harness Artist/.test(flacRow.text)),
  flacRow?.text ?? ""
);

const statsFlac = await statsText();
const fileBytes = JSON.parse(readFileSync(cacheFile, "utf8"));
check(
  "cache-stats-show-exact-bytes",
  statsFlac.includes(`${Buffer.byteLength(JSON.stringify(fileBytes), "utf8").toLocaleString()} bytes`),
  `${statsFlac} (file=${statSync(cacheFile).size} B)`
);

/* 2. Inspector replays translations, romanization and word timing from the stored payload. */
for (const row of await page.$$('[data-testid="cache-row"]')) {
  const text = await row.evaluate(node => node.textContent ?? "");
  if (text.includes("Fixture FLAC")) {
    await (await row.$(".cache-row-main"))!.click();
    break;
  }
}
await page.waitForSelector('[data-testid="cache-inspector"]', { timeout: 5000 });
await wait(250);
const inspector = await page.$eval('[data-testid="cache-inspector"]', node => node.textContent?.replace(/\s+/g, " ").trim() ?? "");
await shot("03-cache-inspector");
check(
  "inspector-shows-original-translation-romanization",
  inspector.includes("桜が") &&
    inspector.includes("Cherry blossoms bloom") &&
    inspector.includes("sakura ga saku") &&
    /1 translated/.test(inspector) &&
    /1 romanized/.test(inspector),
  inspector.slice(0, 220)
);
check("inspector-reports-word-timing", /word-timed/.test(inspector), inspector.slice(0, 160));
await page.click('[data-testid="cache-inspector-close"]');
await wait(200);

/* 3. Local LRC, embedded tag and a network-only track join the same cache. */
await playTrackId(ids.mp3);
const mp3Lyrics = await lyricText("Local first line");
check(
  "local-lrc-renders",
  mp3Lyrics.includes("Local first line"),
  `${await currentTrack()} | ${JSON.stringify(mp3Lyrics.slice(0, 120))} | ${cacheKeys()}`
);

await playTrackId(ids.embedded);
await lyricText();
const embeddedEntry = JSON.parse(readFileSync(cacheFile, "utf8")).entries[`track:${ids.embedded}`];
check(
  "embedded-tag-is-cached",
  embeddedEntry?.candidates?.some((candidate: any) => candidate.source === "embedded-tag" && candidate.format === "lrc"),
  JSON.stringify(embeddedEntry?.candidates?.map((c: any) => `${c.source}/${c.format}`))
);

const callsBeforeNetwork = providerCalls.length;
await playTrackId(ids.network);
const networkLyrics = await lyricText("Provider line one");
check("network-only-renders", networkLyrics.includes("Provider line one"), JSON.stringify(networkLyrics.slice(0, 120)));
check("network-only-fetched", providerCalls.length > callsBeforeNetwork, `${providerCalls.length - callsBeforeNetwork} calls`);

await openCache();
const rowsAll = await cacheRows();
check(
  "cache-covers-every-source",
  ["Fixture FLAC", "Fixture MP3", "Embedded Song", "Network Only"].every(title =>
    rowsAll.some(row => row.text.includes(title))
  ),
  JSON.stringify(rowsAll.map(row => row.text.slice(0, 40)))
);
const embeddedRow = rowsAll.find(row => row.text.includes("Embedded Song"));
check("cache-row-shows-embedded-source", Boolean(embeddedRow && /Embedded tag/.test(embeddedRow.text)), embeddedRow?.text ?? "");

/* 4. Same-metadata tracks stay separate entries. */
const twinEntries = Object.keys(cacheFileEntries()).filter(
  key => key === `track:${ids.network}` || key === `track:${ids.networkTwin}`
);
check(
  "identical-metadata-tracks-have-separate-entries",
  Boolean(cacheFileEntries()[`track:${ids.network}`]) && !cacheFileEntries()[`track:${ids.networkTwin}`],
  twinEntries.join(",")
);
await playTrackId(ids.networkTwin);
await lyricText();
await openCache();
check(
  "twin-track-gets-its-own-entry-after-playing",
  cacheFileEntries()[`track:${ids.network}`]?.track?.id === ids.network &&
    cacheFileEntries()[`track:${ids.networkTwin}`]?.track?.id === ids.networkTwin &&
    cacheFileEntries()[`track:${ids.network}`].track.title === cacheFileEntries()[`track:${ids.networkTwin}`].track.title,
  `${cacheKeys()} | ${JSON.stringify(await nowPlaying())}`
);

/* 5. Filtering, empty-filter state and refresh. */
await setFilter("Embedded Song");
const filteredRows = await cacheRows();
check(
  "cache-filter-narrows-the-list",
  filteredRows.length === 1 && filteredRows[0].text.includes("Embedded Song"),
  JSON.stringify(filteredRows.map(row => row.text.slice(0, 40)))
);
await setFilter("zzzz-nothing");
check(
  "cache-filter-empty-state",
  Boolean(await page.$('[data-testid="cache-empty-filtered"]')),
  (await page.$eval('[data-testid="cache-empty-filtered"]', node => node.textContent ?? "").catch(() => "")) ?? ""
);
await shot("04-cache-filter-empty");
await setFilter("");
const refreshCallsBefore = resolveCount;
await page.click('[data-testid="cache-refresh"]');
await wait(400);
check("cache-refresh-does-not-resolve", resolveCount === refreshCallsBefore, `${refreshCallsBefore} -> ${resolveCount}`);
check("cache-refresh-restores-list", (await cacheRows()).length >= 4, JSON.stringify((await cacheRows()).length));

/* 6. Reading the list can fail without breaking anything. */
failCacheList = true;
await page.click('[data-testid="cache-refresh"]');
await wait(400);
const errorText = await page.$eval('[data-testid="cache-error"]', node => node.textContent ?? "").catch(() => "");
await shot("05-cache-error-state");
check("cache-error-state", errorText.includes("disk unavailable"), JSON.stringify(errorText));
failCacheList = false;
await page.click('[data-testid="cache-refresh"]');
await wait(400);
check("cache-recovers-after-error", (await cacheRows()).length >= 4 && !(await page.$('[data-testid="cache-error"]')), "");

/* 7. Deleting one entry leaves the rest, and never touches the sidecar or the library. */
for (const row of await page.$$('[data-testid="cache-row"]')) {
  const text = await row.evaluate(node => node.textContent ?? "");
  if (text.includes("Fixture MP3")) {
    await (await row.$('[data-testid="cache-delete"]'))!.click();
    break;
  }
}
await wait(700);
const afterDeleteRows = await cacheRows();
check(
  "delete-one-removes-only-that-entry",
  !afterDeleteRows.some(row => row.text.includes("Fixture MP3")) &&
    afterDeleteRows.some(row => row.text.includes("Fixture FLAC")) &&
    !cacheFileEntries()[`track:${ids.mp3}`] &&
    Boolean(cacheFileEntries()[`track:${ids.flac}`]),
  JSON.stringify(afterDeleteRows.map(row => row.text.slice(0, 30)))
);
check("delete-one-keeps-sidecar-file", existsSync(join(musicDir, "Fixture MP3.lrc")), "");
check("delete-one-keeps-library-track", store.getTrack(ids.mp3)?.title === "Fixture MP3", "");
await shot("06-after-delete-one");

/* 8. A manually searched and chosen result is remembered for its track. */
await playTrackId(ids.flac);
await nav("Now Playing");
await wait(300);
await page.click('.lyrics-dock button[title="Lyrics source"]');
await wait(250);
await page.click(".dock-sources .manual-search-entry");
await wait(350);
await page.click(".dock-search .search-submit");
await page.waitForSelector(".dock-search .source-row:not(.manual-search-entry)", { timeout: 15_000 });
await wait(250);
await shot("07-manual-search-results");
const searchResultRows = await page.$$(".dock-search .source-row:not(.manual-search-entry)");
await searchResultRows[0].click();
await wait(900);
const afterManual = await lyricText("Search result line one");
check("manual-search-result-is-shown", afterManual.includes("Search result line one"), JSON.stringify(afterManual.slice(0, 140)));
await wait(700);
const manualEntry = JSON.parse(readFileSync(cacheFile, "utf8")).entries[`track:${ids.flac}`];
check(
  "manual-selection-is-cached",
  manualEntry?.candidates?.some((candidate: any) => candidate.origin === "manual" && candidate.source === "lrclib-synced"),
  JSON.stringify(manualEntry?.candidates?.map((c: any) => `${c.origin}/${c.source}`))
);

/* 9. Chosen file: stored, then restored after a restart. */
await playTrackId(ids.empty);
await nav("Now Playing");
await page.waitForSelector(".lyrics-empty-panel", { timeout: 20_000 });
const emptyLyrics = await rawLyricText();
check(
  "no-lyrics-track-is-empty",
  !emptyLyrics.trim(),
  `${await currentTrack()} | ${JSON.stringify(emptyLyrics.slice(0, 80))} | ${cacheKeys()}`
);
await nav("Now Playing");
await wait(300);
await page.evaluate(
  (text: string) => {
    (window as unknown as { __chosen: { text: string; path: string } }).__chosen = {
      text,
      path: "/outside/library/chosen.ttml",
    };
  },
  CHOSEN_TTML
);
await page.click('.lyrics-dock button[title="Open a lyrics file"]');
await wait(900);
const chosenLyrics = await lyricText("Chosen file line one");
check("chosen-file-renders", chosenLyrics.includes("Chosen file line one"), JSON.stringify(chosenLyrics.slice(0, 120)));
await wait(400);
check(
  "chosen-file-is-cached",
  JSON.parse(readFileSync(cacheFile, "utf8")).entries[`track:${ids.empty}`]?.candidates?.some(
    (candidate: any) => candidate.source === "user-file" && candidate.sourceHref === "/outside/library/chosen.ttml"
  ),
  JSON.stringify(cacheFileEntries()[`track:${ids.empty}`]?.candidates?.map((c: any) => c.source))
);

/* 10. Navigate away and back: lyrics stay, nothing is resolved again. */
const resolveAfterChosen = resolveCount;
await nav("Songs");
await nav("Albums");
await nav("Now Playing");
await wait(600);
const afterNavigation = await page.$$eval(".blyrics--line", nodes => nodes.map(node => node.textContent ?? "").join(" | "));
check(
  "navigation-keeps-lyrics-without-refetch",
  afterNavigation.includes("Chosen file line one") && resolveCount === resolveAfterChosen,
  `${resolveAfterChosen} -> ${resolveCount}`
);

/* 11. Restart: cache entries survive, and the chosen file comes back from disk. */
await coldStart();
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sidebar", { timeout: 60_000 });
await wait(900);
offline = true;
// Turning auto-fetch off is the app's offline switch: every resolve must be answered by the cache.
await page.evaluate(() =>
  (window as unknown as { cadence: { settings: { patch: (patch: unknown) => Promise<unknown> } } }).cadence.settings.patch({
    lyrics: { autoFetch: false },
  })
);
await wait(700);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sidebar", { timeout: 60_000 });
await wait(900);
const callsBeforeOffline = providerCalls.length;
await playTrackId(ids.flac);
const offlineFlac = await lyricText("Search result line one");
// The user explicitly picked a result for this track earlier; that choice is restored from the
// cache (no network at all), which is exactly what a cached manual selection is for.
check(
  "restored-manual-selection-plays-offline",
  offlineFlac.includes("Search result line one"),
  JSON.stringify(offlineFlac.slice(0, 120))
);
await playTrackId(ids.network);
const offlineNetwork = await lyricText("Provider line one");
check("offline-network-lyrics-come-from-cache", offlineNetwork.includes("Provider line one"), JSON.stringify(offlineNetwork.slice(0, 120)));
await playTrackId(ids.mp3);
const offlineLrc = await lyricText("Local first line");
check("offline-local-lrc-plays", offlineLrc.includes("Local first line"), JSON.stringify(offlineLrc.slice(0, 120)));
check("offline-restart-makes-no-provider-calls", providerCalls.length === callsBeforeOffline, `${callsBeforeOffline} -> ${providerCalls.length}`);

await playTrackId(ids.empty);
const restoredChosen = await lyricText("Chosen file line one");
check("chosen-file-survives-restart", restoredChosen.includes("Chosen file line one"), JSON.stringify(restoredChosen.slice(0, 120)));
offline = false;

await openCache();
const rowsAfterRestart = await cacheRows();
check(
  "cache-survives-restart",
  rowsAfterRestart.some(row => row.text.includes("Fixture FLAC")) &&
    rowsAfterRestart.some(row => row.text.includes("Embedded Song")),
  JSON.stringify(rowsAfterRestart.map(row => row.text.slice(0, 30)))
);
await shot("07-cache-after-restart");

/* 12. Rapid track changes never show another track's lyrics. */
await playTrackId(ids.flac);
await nav("Songs");
await page.click(`[data-testid="track-row"][data-track-id="${ids.network}"]`);
await page.click(`[data-testid="track-row"][data-track-id="${ids.mp3}"]`);
await page.evaluate(() => document.querySelector("audio")?.pause());
await wait(1400);
await page.evaluate(() => document.querySelector("audio")?.pause());
const afterRapid = await lyricText("Local first line");
check(
  "rapid-switch-shows-the-last-track",
  afterRapid.includes("Local first line") && !afterRapid.includes("Provider line one"),
  JSON.stringify(afterRapid.slice(0, 140))
);

/* 13. Clear everything: empties the cache, keeps every user file. */
await playTrackId(ids.flac);
await openCache();
await shot("08-before-clear");
const entriesBeforeClear = Object.keys(cacheFileEntries()).length;
const clearDialog = new Promise<void>(done => page.once("dialog", dialog => void dialog.accept().then(done)));
await page.click('[data-testid="cache-clear"]');
await clearDialog;
await wait(900);
await shot("09-after-clear");
check("clear-empties-the-file", Object.keys(cacheFileEntries()).length === 0, `${entriesBeforeClear} -> 0`);
check("clear-shows-empty-state", Boolean(await page.$('[data-testid="cache-empty"]')), "");
check(
  "clear-keeps-user-files",
  existsSync(join(musicDir, "Fixture FLAC.ttml")) &&
    existsSync(join(musicDir, "Fixture MP3.lrc")) &&
    existsSync(join(musicDir, "No Lyrics.wav")) &&
    store.getTracks().length === 6,
  `${store.getTracks().length} library tracks`
);
check("clear-keeps-lyrics-rendering", (await lyricText("桜が")).includes("桜が"), "");

/* 14. A fresh lookup repopulates the cache after the clear. */
await playTrackId(ids.mp3);
await lyricText("Local first line");
let repopulated = false;
for (let attempt = 0; attempt < 20 && !repopulated; attempt += 1) {
  repopulated = Boolean(cacheFileEntries()[`track:${ids.mp3}`]);
  if (!repopulated) await wait(250);
}
check("cache-repopulates-after-clear", repopulated, Object.keys(cacheFileEntries()).join(","));

/* 15. Dismissing the confirmation leaves everything intact. */
const entriesBeforeCancel = Object.keys(cacheFileEntries()).length;
const cancelDialog = new Promise<void>(done => page.once("dialog", dialog => void dialog.dismiss().then(done)));
await openCache();
await page.click('[data-testid="cache-clear"]');
await cancelDialog;
await wait(600);
check(
  "cancelled-clear-keeps-the-cache",
  Object.keys(cacheFileEntries()).length === entriesBeforeCancel && entriesBeforeCancel > 0,
  `${entriesBeforeCancel} entries`
);

/* ------------------------------------------------------------------ report */

const failures = Object.entries(results).filter(([, entry]) => !entry.value);
console.log(`\n${Object.keys(results).length - failures.length}/${Object.keys(results).length} checks passed`);
if (failures.length) {
  console.log("Failures:");
  for (const [name, entry] of failures) console.log(`  ${name}: ${entry.detail}`);
  console.log("Console log tail:", logs.slice(-15).join("\n"));
}
console.log(`Provider calls: ${providerCalls.length}; resolves: ${resolveCount}; cache file: ${cacheFile}`);
console.log(`Screenshots: ${shotDir}`);

await browser.close();
server.close();
rmSync(stateDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
