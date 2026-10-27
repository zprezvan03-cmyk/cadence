/**
 * Now Playing layout harness.
 *
 * Boots the production renderer in headless Chromium over a real library and a stub lyrics bridge
 * that can answer with synchronized lyrics, unsynchronized lyrics, no lyrics, a slow response
 * (loading) or an error. Screenshots and geometry are captured for every state so the layout can be
 * inspected instead of assumed.
 *
 * Usage: npm run build:web && npx vite-node tests/browser/now-playing-layout.ts
 */

import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";
import { LibraryStore } from "../../src/main/library/store";
import { scanLibrary } from "../../src/main/library/scanner";
import { SettingsStore } from "../../src/main/settings";
import type { LyricsResolveRequest } from "../../src/shared/types";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const fixtures = join(root, ".artifacts/fixtures/formats");
const shotDir = join(root, ".artifacts/now-playing-layout");
mkdirSync(shotDir, { recursive: true });

if (!existsSync(join(outDir, "index.html"))) throw new Error("Run: npm run build:web");
if (!existsSync(join(fixtures, "fixture.flac"))) throw new Error("Run: python3 tests/fixtures/generate-audio.py");

/* --------------------------------------------------------------- fixtures */

const SYNCED_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body dur="00:30.000"><div>
<p begin="00:00.400" end="00:01.800">Line one of the song</p>
<p begin="00:02.000" end="00:03.600">Line two of the song</p>
<p begin="00:04.000" end="00:05.400">Line three of the song</p>
</div></body></tt>`;

const PLAIN_LYRICS = "First unsynced line\nSecond unsynced line\nThird unsynced line";

const stateDir = mkdtempSync(join(tmpdir(), "cadence-np-layout-"));
const musicDir = join(stateDir, "music");
const artworkDir = join(stateDir, "artwork");
mkdirSync(musicDir, { recursive: true });
mkdirSync(artworkDir, { recursive: true });

const syncedPath = join(musicDir, "Synced Song.flac");
copyFileSync(join(fixtures, "fixture.flac"), syncedPath);
writeFileSync(join(musicDir, "Synced Song.ttml"), SYNCED_TTML, "utf8");
const plainPath = join(musicDir, "Plain Song.flac");
copyFileSync(join(fixtures, "fixture.flac"), plainPath);
writeFileSync(join(musicDir, "Plain Song.lrc"), PLAIN_LYRICS, "utf8");
const emptyPath = join(musicDir, "Empty Song.wav");
copyFileSync(join(fixtures, "fixture.wav"), emptyPath);

const store = new LibraryStore(join(stateDir, "library.db"), artworkDir, path => `media://${path}`);
const scan = await scanLibrary(store, { folders: [musicDir] });
if (scan.errors.length) console.log("scan errors:", scan.errors);

const idOf = (path: string) => {
  const track = store.getTrackByPath(path);
  if (!track) throw new Error(`No track for ${path}`);
  return track.id;
};
const ids = {
  synced: idOf(syncedPath),
  plain: idOf(plainPath),
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
    scan: { startedAt: Date.now(), finishedAt: Date.now(), filesSeen: tracks.length, errors: [] },
  };
};

const settings = new SettingsStore(join(stateDir, "settings.json"));

/* ------------------------------------------------------------------ server */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".woff2": "font/woff2",
};

const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
  new Promise(done => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => done(data));
  });

/** The lyrics answer for the current track, controlled per scenario. */
type LyricsMode = "synced" | "plain" | "empty" | "error" | "slow";
let mode: LyricsMode = "synced";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const sendJson = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname.startsWith("/api/")) {
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    if (url.pathname === "/api/library") return sendJson(snapshot());
    if (url.pathname === "/api/settings") return sendJson(settings.get());
    if (url.pathname === "/api/settings/patch") return sendJson(settings.patch(body));
    if (url.pathname === "/api/settings/reset") return sendJson(settings.reset());
    if (url.pathname === "/api/lyrics/resolve") {
      const request = body as LyricsResolveRequest;
      if (mode === "slow") await new Promise(done => setTimeout(done, 1500));
      if (mode === "error") return sendJson({ error: "Lyrics lookup failed (harness)" }, 500);
      const candidates =
        mode === "synced"
          ? [
              {
                source: "local-rich",
                provider: "Local TTML/QRC",
                text: SYNCED_TTML,
                syncHint: "synced",
                language: "en",
                songwriters: [],
                sourceHref: syncedPath,
                cached: true,
              },
            ]
          : mode === "plain"
            ? [
                {
                  source: "local-lrc",
                  provider: "Local LRC",
                  text: PLAIN_LYRICS,
                  syncHint: "none",
                  language: "en",
                  songwriters: [],
                  sourceHref: plainPath,
                  cached: true,
                },
              ]
            : [];
      if (request.trackId === ids.synced && mode === "synced") return sendJson({ candidates, providerStatus: [] });
      if (request.trackId === ids.plain && mode === "plain") return sendJson({ candidates, providerStatus: [] });
      return sendJson({ candidates: [], providerStatus: [] });
    }
    if (url.pathname === "/api/lyrics/search") return sendJson({ results: [], providerStatus: [], cached: false });
    if (url.pathname === "/api/lyrics/translate") return sendJson({ translations: [], detectedLanguage: "en" });
    if (url.pathname === "/api/lyrics/romanize") return sendJson({ romanizations: [], detectedLanguage: "en" });
    if (url.pathname.startsWith("/api/lyrics/")) return sendJson({ entries: [], stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 } });
    return sendJson({});
  }

  if (url.pathname.startsWith("/audio/")) {
    const id = Number(url.pathname.split("/")[2]);
    const track = store.getTrack(id);
    const file = track?.path ?? emptyPath;
    const size = statSync(file).size;
    const headers = {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "accept-ranges": "bytes",
    };
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)!;
      const start = Number(match[1] || 0);
      const end = match[2] ? Number(match[2]) : size - 1;
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(file).pipe(res);
    return;
  }

  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(outDir, path);
  if (!file.startsWith(outDir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});

await new Promise<void>(done => server.listen(4796, "0.0.0.0", () => done()));
const base = "http://127.0.0.1:4796";

/* ----------------------------------------------------------------- browser */

await inflate(join(root, "node_modules/@sparticuz/chromium/bin/al2023.tar.br"));
setupLambdaEnvironment(join(tmpdir(), "al2023", "lib"));
chromium.setGraphicsMode = true;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  args: [...chromium.args, "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader"],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 180_000,
});
const page = await browser.newPage();
const logs: string[] = [];
page.on("console", message => logs.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", (error: unknown) => logs.push(`[pageerror] ${String(error)}`));
page.on("requestfailed", request => logs.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText}`));
page.on("response", response => {
  if (response.status() >= 400) logs.push(`[http ${response.status()}] ${response.url()}`);
});

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
      getTrack: async (id: number) => (await call("/api/library")).tracks.find((track: { id: number }) => track.id === id) ?? null,
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
      clearCache: async () => ({ removedEntries: 0 }),
      listCache: async () => ({ entries: [], stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 } }),
      getCacheEntry: async () => null,
      removeCacheEntry: async () => ({ removed: false, stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 } }),
      cacheChosenFile: async () => undefined,
      rememberSelection: async () => undefined,
    },
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
    player: {
      prepareAlacSource: async () => "/audio/fixture.wav",
      reportState: async () => undefined,
      onCommand: () => () => {},
    },
    decodeTester: { deleteFiles: async () => [], exportFileList: async () => ({ canceled: true }) },
  };
});

/* ------------------------------------------------------------------ helpers */

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
      await wait(150);
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

const playTrackId = async (trackId: number) => {
  await nav("Songs");
  const row = await page.$(`[data-testid="track-row"][data-track-id="${trackId}"]`);
  if (!row) throw new Error(`No track row ${trackId}`);
  await row.click();
  await wait(700);
  await page.evaluate(() => document.querySelector("audio")?.pause());
  await wait(150);
};

/**
 * Geometry of the pieces that make the page look intentional: the lyrics column, the empty/error
 * panel, the dock/footer, the track heading and the player bar.
 */
const geometry = () =>
  page.evaluate(() => {
    const rect = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        centerX: Math.round(box.x + box.width / 2),
        centerY: Math.round(box.y + box.height / 2),
        bottom: Math.round(box.bottom),
      };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      view: rect(".lyrics-view"),
      body: rect(".lyrics-body"),
      panel: rect(".lyrics-empty-panel"),
      footer: rect(".lyrics-footer"),
      player: rect('[data-testid="player-bar"]'),
      heading: rect(".lyrics-heading"),
      lyricsHost: rect("braccato-lyrics"),
      lineCount: document.querySelectorAll(".blyrics--line").length,
    };
  });

const inBody = (panel: { y: number; bottom: number } | null, body: { y: number; bottom: number } | null) =>
  Boolean(panel && body && panel.y >= body.y - 1 && panel.bottom <= body.bottom + 1);
const centeredIn = (panel: { centerX: number } | null, body: { centerX: number } | null, tolerance = 24) =>
  Boolean(panel && body && Math.abs(panel.centerX - body.centerX) <= tolerance);
const verticallyCenteredIn = (panel: { centerY: number } | null, body: { centerY: number } | null, tolerance = 40) =>
  Boolean(panel && body && Math.abs(panel.centerY - body.centerY) <= tolerance);

/* ------------------------------------------------------------------- script */

await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sidebar", { timeout: 60_000 });
await wait(900);

/* 1. Synchronized lyrics: the reference layout. */
mode = "synced";
await playTrackId(ids.synced);
await nav("Now Playing");
await page.waitForSelector(".blyrics--line", { timeout: 20_000 });
await wait(600);
await shot("01-synced-lyrics");
const synced = await geometry();
check("synced-shows-lines", synced.lineCount > 0, `${synced.lineCount} lines`);

/* 2. Unsynced (plain) lyrics: same container, no timing. */
mode = "plain";
await playTrackId(ids.plain);
await nav("Now Playing");
await page.waitForSelector(".blyrics--line", { timeout: 20_000 });
await wait(500);
await shot("02-unsynced-lyrics");
const unsynced = await geometry();
check("unsynced-shows-lines", unsynced.lineCount > 0, `${unsynced.lineCount} lines`);
check(
  "unsynced-keeps-the-same-body",
  JSON.stringify(unsynced.body) === JSON.stringify(synced.body),
  `${JSON.stringify(synced.body)} vs ${JSON.stringify(unsynced.body)}`
);

/* 3. No lyrics: the empty state must fill the lyrics area deliberately. */
mode = "empty";
await playTrackId(ids.empty);
await nav("Now Playing");
await page.waitForSelector(".lyrics-empty-panel", { timeout: 20_000 });
await wait(700);
await shot("03-no-lyrics");
const empty = await geometry();
check("no-lyrics-panel-present", Boolean(empty.panel), "");
check("no-lyrics-has-no-lines", empty.lineCount === 0, `${empty.lineCount} lines`);

/* 4. Loading: a slow lookup shows the loader without moving the frame. */
mode = "slow";
await nav("Songs");
await page.click(`[data-testid="track-row"][data-track-id="${ids.synced}"]`);
await nav("Now Playing");
const loadingShown = await page
  .waitForSelector('[data-testid="lyrics-loading-panel"]', { timeout: 8_000 })
  .then(() => true)
  .catch(() => false);
check("loading-panel-shown-for-slow-lookups", loadingShown, loadingShown ? "" : "no loading card appeared");
await shot("04-loading");
const loading = await geometry();
check(
  "loading-panel-inside-lyrics-area",
  inBody(loading.panel, loading.body) && centeredIn(loading.panel, loading.body),
  `${JSON.stringify(loading.panel)} vs ${JSON.stringify(loading.body)}`
);
await wait(2200);
const afterLoad = await geometry();
mode = "empty";

/* 5. Error: same footprint as the empty state. */
mode = "error";
await nav("Songs");
await page.click(`[data-testid="track-row"][data-track-id="${ids.plain}"]`);
await nav("Now Playing");
await page.waitForSelector(".lyrics-empty-panel.error", { timeout: 20_000 });
await wait(600);
await shot("05-error");
const error = await geometry();

/* 6. Fullscreen with no lyrics. */
mode = "empty";
await nav("Songs");
await page.click(`[data-testid="track-row"][data-track-id="${ids.empty}"]`);
await nav("Now Playing");
await page.waitForSelector(".lyrics-empty-panel", { timeout: 20_000 });
await page.click('button[aria-label="Fullscreen lyrics"]');
await page.waitForSelector(".lyrics-view.is-fullscreen", { timeout: 10_000 });
await wait(900);
await shot("06-fullscreen-no-lyrics");
const fullscreen = await geometry();
// Leave fullscreen again so the harness never depends on the previous scenario's mode.
await page.click("button.fs-exit");
await wait(600);

/* ------------------------------------------------------------------ report */

console.log(JSON.stringify({ synced, unsynced, empty, loading, afterLoad, error, fullscreen }, null, 1));

check("empty-panel-inside-lyrics-area", inBody(empty.panel, empty.body), `${JSON.stringify(empty.panel)} vs ${JSON.stringify(empty.body)}`);
check("empty-panel-centered", centeredIn(empty.panel, empty.body), `${empty.panel?.centerX} vs ${empty.body?.centerX}`);
check("empty-panel-vcentered", verticallyCenteredIn(empty.panel, empty.body), `${empty.panel?.centerY} vs ${empty.body?.centerY}`);
check(
  "empty-panel-above-footer",
  Boolean(empty.panel && empty.footer && empty.panel.bottom <= empty.footer.y + 1),
  `panel bottom ${empty.panel?.bottom} footer top ${empty.footer?.y}`
);
check("error-panel-inside-lyrics-area", inBody(error.panel, error.body), "");
check("error-panel-centered", centeredIn(error.panel, error.body), "");
check(
  "no-layout-jump-between-states",
  Boolean(
    synced.heading &&
      empty.heading &&
      synced.heading.y === empty.heading.y &&
      synced.footer?.y === empty.footer?.y &&
      synced.player?.y === empty.player?.y &&
      synced.body?.y === empty.body?.y &&
      synced.body?.height === empty.body?.height
  ),
  `heading ${synced.heading?.y}/${empty.heading?.y} footer ${synced.footer?.y}/${empty.footer?.y} body ${JSON.stringify(synced.body)}/${JSON.stringify(empty.body)}`
);
check("loading-keeps-frame", loading.heading?.y === afterLoad.heading?.y && loading.body?.height === afterLoad.body?.height, "");
check(
  "fullscreen-panel-centered",
  Boolean(
    fullscreen.panel &&
      fullscreen.body &&
      Math.abs(fullscreen.panel.centerX - fullscreen.body.centerX) <= 24 &&
      Math.abs(fullscreen.panel.centerY - fullscreen.body.centerY) <= 40
  ),
  `panel ${JSON.stringify(fullscreen.panel)} body ${JSON.stringify(fullscreen.body)}`
);
check(
  "fullscreen-panel-above-controls",
  Boolean(fullscreen.panel && fullscreen.footer && fullscreen.panel.bottom <= fullscreen.footer.y + 1),
  `panel bottom ${fullscreen.panel?.bottom} footer top ${fullscreen.footer?.y}`
);

const failures = Object.entries(results).filter(([, entry]) => !entry.value);
console.log(`\n${Object.keys(results).length - failures.length}/${Object.keys(results).length} checks passed`);
if (failures.length) {
  console.log("Failures:");
  for (const [name, entry] of failures) console.log(`  ${name}: ${entry.detail}`);
}
console.log("Console log tail:", logs.slice(-6).join("\n"));
console.log(`Screenshots: ${shotDir}`);

await browser.close();
server.close();
rmSync(stateDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
