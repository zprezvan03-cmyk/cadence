/**
 * End-to-end harness for Settings -> About -> "Clear lyrics cache", in the real UI.
 *
 * Like `provider-identity.ts` this wires the *real* main-process modules behind the
 * `window.cadence` contract — `LyricsService` plus a `LyricsCacheCore` whose `persist` writes the
 * same `lyrics-cache.json` the Tauri build writes through Rust — and drives the production
 * renderer bundle from `dist/` in headless Chromium. Nothing about the deletion is stubbed: the
 * assertions read the cache file off the filesystem between clicks.
 *
 * It covers the complete flow a user reports as "delete cache is not working":
 *   populate -> click the button -> see feedback -> file emptied -> restart -> lyrics re-fetched,
 * plus the two ways the old code lied: a cancelled confirm and a failing disk write.
 *
 * Usage: npm run build:web && npx vite-node tests/browser/build-library.ts
 *        && npx vite-node tests/browser/cache-clear.ts
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";
import { LyricsCacheCore } from "../../src/main/lyrics/cacheCore";
import { LyricsService } from "../../src/main/lyrics/service";
import { SettingsStore } from "../../src/main/settings";
import type { LibraryStore } from "../../src/main/library/store";
import type { LyricsResolveRequest, LyricsSearchRequest } from "../../src/shared/types";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const harnessDir = join(root, ".artifacts/harness");
const audioDir = join(root, ".artifacts/fixtures/formats");
const shotDir = join(root, ".artifacts/cache-clear");
mkdirSync(shotDir, { recursive: true });

const snapshotFile = join(harnessDir, "library.json");
if (!existsSync(snapshotFile)) throw new Error("Run: npx vite-node tests/browser/build-library.ts");
if (!existsSync(join(outDir, "index.html"))) throw new Error("Run: npm run build:web");
const { snapshot } = JSON.parse(readFileSync(snapshotFile, "utf8"));

/* ------------------------------------------------------------ provider payloads */

const TTML_LINE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:00.300" end="00:00:01.600">Cached line one</p>
<p begin="00:00:01.700" end="00:00:03.100">Cached line two</p>
<p begin="00:00:03.200" end="00:00:04.600">Cached line three</p>
</div></body></tt>`;

/* ------------------------------------------- real main-process modules on disk */

const stateDir = mkdtempSync(join(tmpdir(), "cadence-cache-clear-"));
const settingsFile = join(stateDir, "settings.json");
const cacheFile = join(stateDir, "lyrics-cache.json");
const fakeStore = { getTrack: () => undefined, getLyrics: () => null } as unknown as LibraryStore;

/** Flipped on to simulate a filesystem that refuses the write (read-only disk, AV lock, …). */
let failWrites = false;
let writes = 0;

/** Same shape as the Tauri bridge: a core cache whose `persist` is an async write that can fail. */
const makeCache = () =>
  new LyricsCacheCore({
    initialJson: existsSync(cacheFile) ? readFileSync(cacheFile, "utf8") : null,
    persist: async json => {
      if (failWrites) throw new Error("Access is denied. (os error 5)");
      writes += 1;
      writeFileSync(`${cacheFile}.tmp`, json);
      renameSync(`${cacheFile}.tmp`, cacheFile);
    },
  });

let settings = new SettingsStore(settingsFile);
let lyricsCache = makeCache();
let lyricsService = new LyricsService(fakeStore, lyricsCache);

/** Rebuilds every main-process module from the files on disk — an actual app relaunch. */
const coldStart = async () => {
  await lyricsCache.persistNow().catch(() => {});
  settings = new SettingsStore(settingsFile);
  lyricsCache = makeCache();
  lyricsService = new LyricsService(fakeStore, lyricsCache);
};

/** Entries currently in the cache file, as the next cold start would read them. */
const cacheFileEntries = (): string[] => {
  if (!existsSync(cacheFile)) return [];
  try {
    return Object.keys(JSON.parse(readFileSync(cacheFile, "utf8")).entries ?? {});
  } catch {
    return ["<unparseable>"];
  }
};

/* --------------------------------------------------------------- fake network */

const realFetch = globalThis.fetch.bind(globalThis);
const apiCalls: string[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("betterlyrics.org") && !url.includes("lrclib.net") && !url.includes("binimum.org")) {
    return realFetch(input as RequestInfo, init);
  }
  apiCalls.push(url);
  const parsed = new URL(url);
  if (parsed.hostname === "api.betterlyrics.org" && parsed.pathname === "/getLyrics") {
    return json({ ttml: TTML_LINE });
  }
  if (parsed.hostname.includes("binimum.org")) return json({ total: 0, source: "HIT-LOCAL-LIBSQL", results: [] });
  return json({ error: "not found" }, 404);
}) as typeof fetch;

/* ------------------------------------------------------------------- server */

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const sendJson = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname.startsWith("/api/")) {
    try {
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
      if (url.pathname === "/api/library") return sendJson(snapshot);
      if (url.pathname === "/api/settings") return sendJson(settings.get());
      if (url.pathname === "/api/settings/patch") return sendJson(settings.patch(body));
      if (url.pathname === "/api/settings/reset") return sendJson(settings.reset());
      if (url.pathname === "/api/lyrics/resolve") {
        const result = await lyricsService.resolve(body as LyricsResolveRequest, settings.get().lyrics.providerOrder);
        lyricsCache.flush();
        return sendJson(result);
      }
      if (url.pathname === "/api/lyrics/search") {
        const result = await lyricsService.searchLyrics(body as LyricsSearchRequest, settings.get().lyrics.providerOrder);
        return sendJson(result);
      }
      if (url.pathname === "/api/lyrics/clear-cache") {
        // Exactly what src/tauri/bridge.ts does, including propagating a failed write.
        const removedEntries = await lyricsService.clearCache();
        return sendJson({ removedEntries });
      }
      return sendJson({ error: "unknown endpoint" }, 404);
    } catch (error) {
      return sendJson({ error: (error as Error).message }, 500);
    }
  }

  let file: string | null = null;
  if (url.pathname.startsWith("/audio/") || url.pathname.startsWith("/media/")) {
    file = join(audioDir, decodeURIComponent(url.pathname.slice(7)));
  } else if (url.pathname.startsWith("/artwork/")) {
    file = join(harnessDir, decodeURIComponent(url.pathname.slice(9)));
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

await new Promise<void>(done => server.listen(4794, "0.0.0.0", () => done()));
const base = "http://127.0.0.1:4794";

/* ------------------------------------------------------------------ browser */

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
    // The Tauri bridge rejects when the backend fails; the harness must behave the same way.
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
    },
    player: {
      prepareAlacSource: async () => "/audio/fixture.wav",
      reportState: async () => undefined,
      onCommand: () => () => {},
    },
    decodeTester: { deleteFiles: async () => [], exportFileList: async () => ({ canceled: true }) },
    app: {
      openExternal: async () => undefined,
      openPath: async () => undefined,
      chooseLyricsFile: async () => ({ canceled: true }),
      window: async () => undefined,
      isFullScreen: async () => false,
      initialWindowChrome: { ...chrome },
      windowChrome: async () => ({ ...chrome }),
      onWindowChromeChange: () => () => {},
    },
  };
});

/* -------------------------------------------------------------------- utils */

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
  await wait(250);
};
const playTrack = async (title: string) => {
  await nav("Songs");
  for (const row of await page.$$('[data-testid="track-row"]')) {
    const text = await row.$eval(".title-text", node => node.textContent?.trim());
    if (text === title) {
      await row.click();
      await wait(900);
      return;
    }
  }
  throw new Error(`No track row ${title}`);
};
/** Waits for the Now Playing dock to show rendered lyric lines. */
const lyricLineCount = async () => {
  await nav("Now Playing");
  await wait(600);
  return page.$$eval('[data-testid="braccato-lyrics"] .blyrics--line', nodes => nodes.length).catch(() => 0);
};
const openAbout = async () => {
  await nav("Settings");
  await clickText(".settings-tabs button", "About");
  await wait(250);
};
/** Clicks the danger button and returns the toast the user actually sees (or ""). */
const clickClearCache = async (accept: boolean) => {
  page.once("dialog", async dialog => {
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await clickText(".settings-section.about button.danger", "Clear lyrics cache", false);
  let toast = "";
  for (let attempt = 0; attempt < 40 && !toast; attempt += 1) {
    toast = await page.$eval('[data-testid="app-toast"]', node => node.textContent?.trim() ?? "").catch(() => "");
    if (!toast) await wait(100);
  }
  return toast;
};

/* ------------------------------------------------------------------- script */

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sidebar", { timeout: 60_000 });
await wait(900);

/* 1. Populate the cache through the real provider pipeline. */
await playTrack("Fixture MP3");
const linesBefore = await lyricLineCount();
await playTrack("Fixture FLAC");
await lyricLineCount();
await wait(400);
const populated = cacheFileEntries();
check("cache-file-populated", populated.length >= 2 && linesBefore > 0, `${populated.length} entries, ${linesBefore} lines`);
const callsAfterPopulate = apiCalls.length;

/* 2. A cancelled confirmation must not touch anything. */
await openAbout();
await shot("01-settings-about");
const cancelToast = await clickClearCache(false);
await wait(400);
check(
  "cancel-keeps-cache",
  cancelToast === "" && cacheFileEntries().length === populated.length,
  `toast=${JSON.stringify(cancelToast)} entries=${cacheFileEntries().length}`
);

/* 3. Confirming shows feedback that names what was removed… */
const clearToast = await clickClearCache(true);
await shot("02-cleared-toast");
check(
  "clear-shows-feedback",
  /^Lyrics cache cleared \(\d+ cached songs? removed\)$/.test(clearToast),
  JSON.stringify(clearToast)
);

/* 4. …and the file on disk is really empty by the time the toast appears. */
const afterClear = cacheFileEntries();
check("clear-empties-cache-file", afterClear.length === 0, JSON.stringify(afterClear));

/* 5. Clearing again is an honest no-op. */
await wait(2800); // let the first toast expire
const secondToast = await clickClearCache(true);
check("second-clear-reports-empty", secondToast === "Lyrics cache was already empty", JSON.stringify(secondToast));

/* 6. Restart the app: the cache must still be empty, and lyrics must be fetched again. */
await coldStart();
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sidebar", { timeout: 60_000 });
await wait(900);
check("restart-keeps-cache-cleared", cacheFileEntries().length === 0, JSON.stringify(cacheFileEntries()));

const callsBeforeRefetch = apiCalls.length;
check("no-network-between-clear-and-restart", callsBeforeRefetch === callsAfterPopulate, `${callsAfterPopulate} -> ${callsBeforeRefetch}`);
await playTrack("Fixture MP3");
const linesAfterRestart = await lyricLineCount();
await shot("03-refetched-after-restart");
check(
  "lyrics-refetched-after-restart",
  apiCalls.length > callsBeforeRefetch && linesAfterRestart > 0,
  `${apiCalls.length - callsBeforeRefetch} provider calls, ${linesAfterRestart} lines`
);
await wait(400);
check("cache-repopulates-normally", cacheFileEntries().length > 0, JSON.stringify(cacheFileEntries()));

/* 7. A failing disk write must be reported, not swallowed as success. */
await wait(2800);
const entriesBeforeFailure = cacheFileEntries();
const writesBeforeFailure = writes;
failWrites = true;
await openAbout();
const failureToast = await clickClearCache(true);
await shot("04-failed-clear-toast");
check(
  "failed-clear-reports-error",
  failureToast.startsWith("Could not clear the lyrics cache:") && failureToast.includes("Access is denied"),
  JSON.stringify(failureToast)
);
check(
  "failed-clear-keeps-cache-on-disk",
  cacheFileEntries().length === entriesBeforeFailure.length && writes === writesBeforeFailure,
  `${cacheFileEntries().length}/${entriesBeforeFailure.length} entries, ${writes - writesBeforeFailure} writes`
);

/* 8. Once the disk recovers, the retry succeeds and the file is emptied for real. */
failWrites = false;
await wait(2800);
const retryToast = await clickClearCache(true);
check("retry-after-failure-succeeds", /Lyrics cache cleared/.test(retryToast), JSON.stringify(retryToast));
check("retry-empties-cache-file", cacheFileEntries().length === 0, JSON.stringify(cacheFileEntries()));

/* -------------------------------------------------------------------- report */

const failures = Object.entries(results).filter(([, entry]) => !entry.value);
console.log(`\n${Object.keys(results).length - failures.length}/${Object.keys(results).length} checks passed`);
if (failures.length) {
  console.log("Failures:");
  for (const [name, entry] of failures) console.log(`  ${name}: ${entry.detail}`);
  console.log("Console log tail:", logs.slice(-12).join("\n"));
}
console.log(`Provider calls: ${apiCalls.length}; cache writes: ${writes}`);
console.log(`Cache file: ${cacheFile}`);
console.log(`Screenshots: ${shotDir}`);

await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
