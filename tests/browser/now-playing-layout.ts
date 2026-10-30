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

/**
 * Responsive probes for the container-based scale. Unlike `geometry()`, these record the
 * actual app-content box (`.content-scroll`), computed type sizes and both horizontal
 * edges, so a test can prove that large displays grow the useful pieces without letting
 * the lyric measure or controls stretch without limit.
 */
const responsiveGeometry = () =>
  page.evaluate(() => {
    const rect = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        right: Math.round(box.right),
        bottom: Math.round(box.bottom),
        width: Math.round(box.width),
        height: Math.round(box.height),
        centerX: Math.round(box.x + box.width / 2),
        centerY: Math.round(box.y + box.height / 2),
        display: style.display,
        visibility: style.visibility,
      };
    };
    const fontSize = (selector: string) => {
      const node = document.querySelector(selector);
      return node ? Number.parseFloat(getComputedStyle(node).fontSize) || 0 : 0;
    };
    const content = document.querySelector(".content-scroll");
    const view = document.querySelector(".lyrics-view");
    const controlsRow = document.querySelector(".fs-controls-row");
    const audio = document.querySelector("audio");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      content: content ? { width: content.clientWidth, height: content.clientHeight } : null,
      view: rect(".lyrics-view"),
      body: rect(".lyrics-body"),
      artwork: rect(".fs-artwork .artwork-hero"),
      host: rect("braccato-lyrics"),
      controls: rect(".fs-controls"),
      dock: rect(".lyrics-dock"),
      play: rect(".fs-controls .play-button"),
      icon: rect(".fs-controls .icon-button"),
      titleFontPx: Math.round(fontSize(".lyrics-heading h1") * 10) / 10,
      metaFontPx: Math.round(fontSize(".lyrics-heading p") * 10) / 10,
      lyricFontPx: Math.round(fontSize(".blyrics--line") * 10) / 10,
      lineCount: document.querySelectorAll(".blyrics--line").length,
      titleText: document.querySelector(".lyrics-heading h1")?.textContent?.trim() ?? "",
      profileId: (view as HTMLElement | null)?.dataset.nowPlayingProfile ?? "",
      profileMode: (view as HTMLElement | null)?.dataset.profileMode ?? "",
      fullscreen: view?.classList.contains("is-fullscreen") ?? false,
      controlsColumns: controlsRow ? getComputedStyle(controlsRow).gridTemplateColumns : "",
      horizontalOverflow:
        Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) >
        window.innerWidth + 1,
      audio: audio
        ? { currentTime: audio.currentTime, paused: audio.paused, src: audio.currentSrc }
        : null,
    };
  });

/**
 * Profile-switch probes. These exercise the actual dock button and popover rather than
 * patching settings behind the UI, and record the audio element/active line so a switch
 * cannot silently pass by remounting playback or resetting lyric synchronization.
 */
const profileProbe = () =>
  page.evaluate(() => {
    const fontSize = (selector: string) => {
      const node = document.querySelector(selector);
      return node ? Number.parseFloat(getComputedStyle(node).fontSize) || 0 : 0;
    };
    const width = (selector: string) => {
      const node = document.querySelector(selector);
      return node ? Math.round(node.getBoundingClientRect().width) : 0;
    };
    const view = document.querySelector<HTMLElement>(".lyrics-view");
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="now-playing-profile-button"]'
    );
    const audio = document.querySelector("audio");
    return {
      profileId: view?.dataset.nowPlayingProfile ?? "",
      profileMode: view?.dataset.profileMode ?? "",
      profileButtonTitle: button?.title ?? "",
      profileButtonExpanded: button?.getAttribute("aria-expanded") ?? "",
      switcherPresent: Boolean(
        document.querySelector('[data-testid="now-playing-profile-switcher"]')
      ),
      rows: [...document.querySelectorAll<HTMLButtonElement>(".profile-row")].map(row => ({
        id: row.dataset.profileId ?? "",
        text: row.textContent?.replace(/\s+/g, " ").trim() ?? "",
        pressed: row.getAttribute("aria-pressed"),
        active: row.classList.contains("active"),
        hasThumbnail: Boolean(row.querySelector(".profile-thumb-art")),
        hasCheck: Boolean(row.querySelector("svg")),
      })),
      lyricFontPx: Math.round(fontSize(".blyrics--line") * 10) / 10,
      titleFontPx: Math.round(fontSize(".lyrics-heading h1") * 10) / 10,
      hostWidth: width("braccato-lyrics"),
      artworkWidth: width(".fs-artwork .artwork-hero"),
      controlsWidth: width(".fs-controls"),
      playWidth: width(".fs-controls .play-button"),
      activeLineText:
        document
          .querySelector("braccato-lyrics .blyrics--active")
          ?.textContent?.replace(/\s+/g, " ")
          .trim() ?? "",
      lineCount: document.querySelectorAll(".blyrics--line").length,
      audio: audio
        ? { currentTime: audio.currentTime, paused: audio.paused, src: audio.currentSrc }
        : null,
    };
  });

const openProfileSwitcher = async () => {
  const center = await page.$eval('[data-testid="now-playing-profile-button"]', node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(center.x, center.y);
  await wait(550);
  await page.mouse.click(center.x, center.y);
  await page.waitForSelector('[data-testid="now-playing-profile-switcher"]', {
    timeout: 10_000,
  });
  await wait(300);
};

const selectNowPlayingProfile = async (profileId: string) => {
  await openProfileSwitcher();
  await page.click(`[data-profile-id="${profileId}"]`);
  await page.waitForFunction(
    (expected: string) =>
      document.querySelector<HTMLElement>(".lyrics-view")?.dataset.nowPlayingProfile === expected,
    { timeout: 10_000 },
    profileId
  );
  await wait(900);
};

const setViewport = async (width: number, height: number) => {
  await page.setViewport({ width, height });
  await wait(700);
};
const enterFullscreen = async () => {
  if (await page.$(".lyrics-view.is-fullscreen")) return;
  await page.click('button[aria-label="Fullscreen lyrics"]');
  await page.waitForSelector(".lyrics-view.is-fullscreen", { timeout: 10_000 });
  await wait(800);
};
const exitFullscreen = async () => {
  if (!(await page.$(".lyrics-view.is-fullscreen"))) return;
  await page.click("button.fs-exit");
  await page.waitForSelector(".lyrics-view:not(.is-fullscreen)", { timeout: 10_000 });
  await wait(600);
};
const between = (value: number, min: number, max: number) => value >= min && value <= max;
const separatedHorizontally = (
  left: { right: number; width: number } | null,
  right: { x: number; width: number } | null
) => Boolean(!left || !right || left.width === 0 || right.width === 0 || left.right <= right.x + 1);

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

/* 7. Responsive container scale. The same synced track stays loaded while only the
   viewport and windowed/fullscreen presentation change, which also proves those
   transitions do not replace the track or rewind the shared audio element. */
mode = "synced";
await playTrackId(ids.synced);
await nav("Now Playing");
await page.waitForSelector(".blyrics--line", { timeout: 20_000 });
await wait(600);
const playbackBeforeResponsive = await page.evaluate(() => {
  const audio = document.querySelector("audio");
  return audio ? { currentTime: audio.currentTime, paused: audio.paused, src: audio.currentSrc } : null;
});

await setViewport(1366, 768);
await shot("07-responsive-windowed-1366x768");
const responsive1366Windowed = await responsiveGeometry();

await setViewport(1920, 1080);
await shot("08-responsive-windowed-1920x1080");
const responsive1920Windowed = await responsiveGeometry();

await enterFullscreen();
await shot("09-responsive-fullscreen-1920x1080");
const responsive1920Fullscreen = await responsiveGeometry();

await setViewport(2560, 1440);
await shot("10-responsive-fullscreen-2560x1440");
const responsive2560Fullscreen = await responsiveGeometry();

await setViewport(3440, 1440);
await shot("11-responsive-fullscreen-ultrawide");
const responsiveUltrawideFullscreen = await responsiveGeometry();

await setViewport(1080, 1920);
await shot("12-responsive-fullscreen-portrait");
const responsivePortraitFullscreen = await responsiveGeometry();

await setViewport(800, 1000);
await shot("13-responsive-fullscreen-narrow");
const responsiveNarrowFullscreen = await responsiveGeometry();

/* 8. Now Playing profiles. Starting from the same paused synced track in fullscreen,
   use the dock's quick switcher itself. The profile changes should be visible in the
   shared tree's proportions while the audio element and active line stay put. */
await setViewport(1920, 1080);
const profileBefore = await profileProbe();
await openProfileSwitcher();
await shot("14-profile-switcher-fullscreen");
const profileSwitcherOpen = await profileProbe();

await page.click('[data-profile-id="lyrics-focus"]');
await page.waitForFunction(
  () =>
    document.querySelector<HTMLElement>(".lyrics-view")?.dataset.nowPlayingProfile ===
    "lyrics-focus",
  { timeout: 10_000 }
);
await wait(900);
await shot("15-profile-lyrics-focus-fullscreen");
const profileLyricsFocus = await profileProbe();

await selectNowPlayingProfile("artwork-focus");
await shot("16-profile-artwork-focus-fullscreen");
const profileArtworkFocus = await profileProbe();

await exitFullscreen();
const profileArtworkWindowed = await profileProbe();
await selectNowPlayingProfile("balanced");
const profileBalancedRestored = await profileProbe();

const playbackAfterResponsive = await page.evaluate(() => {
  const audio = document.querySelector("audio");
  return audio ? { currentTime: audio.currentTime, paused: audio.paused, src: audio.currentSrc } : null;
});
await exitFullscreen();
await setViewport(1440, 900);

/* ------------------------------------------------------------------ report */

console.log(
  JSON.stringify(
    {
      synced,
      unsynced,
      empty,
      loading,
      afterLoad,
      error,
      fullscreen,
      responsive1366Windowed,
      responsive1920Windowed,
      responsive1920Fullscreen,
      responsive2560Fullscreen,
      responsiveUltrawideFullscreen,
      responsivePortraitFullscreen,
      responsiveNarrowFullscreen,
      profileBefore,
      profileSwitcherOpen,
      profileLyricsFocus,
      profileArtworkFocus,
      profileArtworkWindowed,
      profileBalancedRestored,
      playbackBeforeResponsive,
      playbackAfterResponsive,
    },
    null,
    1
  )
);

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

check(
  "responsive-windowed-uses-app-content",
  Boolean(
    responsive1366Windowed.content &&
      responsive1366Windowed.view &&
      responsive1366Windowed.content.width < responsive1366Windowed.viewport.width &&
      Math.abs(responsive1366Windowed.view.height - responsive1366Windowed.content.height) <= 2
  ),
  `content ${JSON.stringify(responsive1366Windowed.content)} viewport ${JSON.stringify(responsive1366Windowed.viewport)} view ${JSON.stringify(responsive1366Windowed.view)}`
);
check(
  "responsive-windowed-large-scales",
  Boolean(
    (responsive1920Windowed.host?.width ?? 0) > (responsive1366Windowed.host?.width ?? 0) + 250 &&
      responsive1920Windowed.lyricFontPx > responsive1366Windowed.lyricFontPx + 12 &&
      responsive1920Windowed.titleFontPx > responsive1366Windowed.titleFontPx + 8
  ),
  `1366 host/font/title ${responsive1366Windowed.host?.width}/${responsive1366Windowed.lyricFontPx}/${responsive1366Windowed.titleFontPx} vs 1920 ${responsive1920Windowed.host?.width}/${responsive1920Windowed.lyricFontPx}/${responsive1920Windowed.titleFontPx}`
);
check(
  "responsive-fullscreen-1080p-scales",
  Boolean(
    between(responsive1920Fullscreen.artwork?.width ?? 0, 400, 530) &&
      between(responsive1920Fullscreen.host?.width ?? 0, 980, 1120) &&
      between(responsive1920Fullscreen.lyricFontPx, 58, 70) &&
      between(responsive1920Fullscreen.titleFontPx, 38, 48) &&
      between(responsive1920Fullscreen.controls?.width ?? 0, 1150, 1260) &&
      between(responsive1920Fullscreen.play?.width ?? 0, 58, 68)
  ),
  `art ${responsive1920Fullscreen.artwork?.width} host ${responsive1920Fullscreen.host?.width} lyric/title ${responsive1920Fullscreen.lyricFontPx}/${responsive1920Fullscreen.titleFontPx} controls/play ${responsive1920Fullscreen.controls?.width}/${responsive1920Fullscreen.play?.width}`
);
check(
  "responsive-1440p-uses-caps-without-overstretch",
  Boolean(
    between(responsive2560Fullscreen.artwork?.width ?? 0, 580, 625) &&
      between(responsive2560Fullscreen.host?.width ?? 0, 980, 1120) &&
      between(responsive2560Fullscreen.lyricFontPx, 78, 86) &&
      between(responsive2560Fullscreen.controls?.width ?? 0, 1200, 1250) &&
      between(responsive2560Fullscreen.play?.width ?? 0, 70, 80)
  ),
  `art ${responsive2560Fullscreen.artwork?.width} host ${responsive2560Fullscreen.host?.width} lyric ${responsive2560Fullscreen.lyricFontPx} controls/play ${responsive2560Fullscreen.controls?.width}/${responsive2560Fullscreen.play?.width}`
);
check(
  "responsive-ultrawide-keeps-readable-measure",
  Boolean(
    between(responsiveUltrawideFullscreen.artwork?.width ?? 0, 580, 625) &&
      (responsiveUltrawideFullscreen.host?.width ?? 0) <= 1120 &&
      (responsiveUltrawideFullscreen.controls?.width ?? 0) <= 1250 &&
      separatedHorizontally(
        responsiveUltrawideFullscreen.artwork,
        responsiveUltrawideFullscreen.body
      )
  ),
  `art ${responsiveUltrawideFullscreen.artwork?.width} host ${responsiveUltrawideFullscreen.host?.width} controls ${responsiveUltrawideFullscreen.controls?.width}`
);
check(
  "responsive-portrait-keeps-artwork-and-lyrics-separated",
  Boolean(
    between(responsivePortraitFullscreen.artwork?.width ?? 0, 290, 350) &&
      between(responsivePortraitFullscreen.host?.width ?? 0, 560, 720) &&
      separatedHorizontally(responsivePortraitFullscreen.artwork, responsivePortraitFullscreen.body)
  ),
  `art ${responsivePortraitFullscreen.artwork?.width} host ${responsivePortraitFullscreen.host?.width} body ${JSON.stringify(responsivePortraitFullscreen.body)}`
);
check(
  "responsive-narrow-hides-artwork-and-stacks-controls",
  Boolean(
    (responsiveNarrowFullscreen.artwork?.width ?? 0) === 0 &&
      (responsiveNarrowFullscreen.host?.width ?? 0) <= 720 &&
      responsiveNarrowFullscreen.controlsColumns.trim().split(/\s+/).length === 1
  ),
  `art ${responsiveNarrowFullscreen.artwork?.width} host ${responsiveNarrowFullscreen.host?.width} columns ${responsiveNarrowFullscreen.controlsColumns}`
);
check(
  "responsive-fullscreen-no-artwork-lyrics-overlap",
  [
    responsive1920Fullscreen,
    responsive2560Fullscreen,
    responsiveUltrawideFullscreen,
    responsivePortraitFullscreen,
    responsiveNarrowFullscreen,
  ].every(snapshot => separatedHorizontally(snapshot.artwork, snapshot.body)),
  ""
);
check(
  "responsive-no-horizontal-overflow",
  [
    responsive1366Windowed,
    responsive1920Windowed,
    responsive1920Fullscreen,
    responsive2560Fullscreen,
    responsiveUltrawideFullscreen,
    responsivePortraitFullscreen,
    responsiveNarrowFullscreen,
  ].every(snapshot => !snapshot.horizontalOverflow && snapshot.lineCount > 0),
  ""
);
check(
  "responsive-resizing-preserves-playback",
  Boolean(
    playbackBeforeResponsive &&
      playbackAfterResponsive &&
      playbackAfterResponsive.src === playbackBeforeResponsive.src &&
      playbackAfterResponsive.paused === playbackBeforeResponsive.paused &&
      playbackAfterResponsive.currentTime + 0.05 >= playbackBeforeResponsive.currentTime &&
      responsiveNarrowFullscreen.titleText === responsive1366Windowed.titleText
  ),
  `before ${JSON.stringify(playbackBeforeResponsive)} after ${JSON.stringify(playbackAfterResponsive)} titles ${responsive1366Windowed.titleText}/${responsiveNarrowFullscreen.titleText}`
);

const balancedProfileRow = profileSwitcherOpen.rows.find(row => row.id === "balanced");
check(
  "profile-default-balanced-fullscreen",
  Boolean(
    profileBefore.profileId === "balanced" &&
      profileBefore.profileMode === "fullscreen" &&
      profileBefore.profileButtonTitle.includes("Balanced") &&
      profileBefore.lineCount > 0
  ),
  `profile ${profileBefore.profileId}/${profileBefore.profileMode} button ${JSON.stringify(profileBefore.profileButtonTitle)} lines ${profileBefore.lineCount}`
);
check(
  "profile-switcher-lists-built-ins-with-thumbnails",
  Boolean(
    profileSwitcherOpen.switcherPresent &&
      profileSwitcherOpen.profileButtonExpanded === "true" &&
      profileSwitcherOpen.rows.map(row => row.id).join(",") ===
        "balanced,lyrics-focus,artwork-focus,immersive,minimal" &&
      profileSwitcherOpen.rows.every(row => row.hasThumbnail && row.text.length > 0)
  ),
  `rows ${JSON.stringify(profileSwitcherOpen.rows)}`
);
check(
  "profile-switcher-marks-active-profile",
  Boolean(
    balancedProfileRow?.active &&
      balancedProfileRow.pressed === "true" &&
      balancedProfileRow.hasCheck &&
      profileSwitcherOpen.rows.filter(row => row.active).length === 1 &&
      profileSwitcherOpen.rows
        .filter(row => row.id !== "balanced")
        .every(row => row.pressed === "false" && !row.active)
  ),
  `balanced row ${JSON.stringify(balancedProfileRow)}`
);
check(
  "profile-lyrics-focus-scales-shared-tree",
  Boolean(
    profileLyricsFocus.profileId === "lyrics-focus" &&
      profileLyricsFocus.profileMode === "fullscreen" &&
      profileLyricsFocus.lyricFontPx > profileBefore.lyricFontPx + 5 &&
      profileLyricsFocus.artworkWidth < profileBefore.artworkWidth - 50 &&
      profileLyricsFocus.titleFontPx < profileBefore.titleFontPx - 2 &&
      profileLyricsFocus.hostWidth > profileBefore.hostWidth + 40
  ),
  `before lyric/art/title/host ${profileBefore.lyricFontPx}/${profileBefore.artworkWidth}/${profileBefore.titleFontPx}/${profileBefore.hostWidth} after ${profileLyricsFocus.lyricFontPx}/${profileLyricsFocus.artworkWidth}/${profileLyricsFocus.titleFontPx}/${profileLyricsFocus.hostWidth}`
);
check(
  "profile-artwork-focus-rebalances-layout",
  Boolean(
    profileArtworkFocus.profileId === "artwork-focus" &&
      profileArtworkFocus.profileMode === "fullscreen" &&
      profileArtworkFocus.lyricFontPx < profileBefore.lyricFontPx - 4 &&
      profileArtworkFocus.titleFontPx > profileBefore.titleFontPx + 2 &&
      profileArtworkFocus.hostWidth < profileBefore.hostWidth - 80
  ),
  `before lyric/title/host ${profileBefore.lyricFontPx}/${profileBefore.titleFontPx}/${profileBefore.hostWidth} after ${profileArtworkFocus.lyricFontPx}/${profileArtworkFocus.titleFontPx}/${profileArtworkFocus.hostWidth}`
);
check(
  "profile-switching-preserves-playback-and-active-line",
  Boolean(
    profileBefore.audio &&
      profileBefore.activeLineText &&
      [
        profileLyricsFocus,
        profileArtworkFocus,
        profileArtworkWindowed,
        profileBalancedRestored,
      ].every(
        snapshot =>
          snapshot.audio?.src === profileBefore.audio?.src &&
          snapshot.audio?.paused === profileBefore.audio?.paused &&
          (snapshot.audio?.currentTime ?? -1) + 0.05 >=
            (profileBefore.audio?.currentTime ?? 0) &&
          snapshot.activeLineText === profileBefore.activeLineText &&
          snapshot.lineCount === profileBefore.lineCount
      )
  ),
  `before ${JSON.stringify(profileBefore.audio)} active ${JSON.stringify(profileBefore.activeLineText)} restored ${JSON.stringify(profileBalancedRestored.audio)} active ${JSON.stringify(profileBalancedRestored.activeLineText)}`
);
check(
  "profile-windowed-mode-uses-windowed-config",
  Boolean(
    profileArtworkWindowed.profileId === "artwork-focus" &&
      profileArtworkWindowed.profileMode === "windowed" &&
      profileBalancedRestored.lyricFontPx > profileArtworkWindowed.lyricFontPx + 2 &&
      profileBalancedRestored.titleFontPx < profileArtworkWindowed.titleFontPx - 1
  ),
  `artwork windowed lyric/title ${profileArtworkWindowed.lyricFontPx}/${profileArtworkWindowed.titleFontPx} balanced ${profileBalancedRestored.lyricFontPx}/${profileBalancedRestored.titleFontPx}`
);
check(
  "profile-balanced-restores-reference-proportions",
  Boolean(
    profileBalancedRestored.profileId === "balanced" &&
      profileBalancedRestored.profileMode === "windowed" &&
      Math.abs(profileBalancedRestored.lyricFontPx - responsive1920Windowed.lyricFontPx) <= 0.2 &&
      Math.abs(profileBalancedRestored.titleFontPx - responsive1920Windowed.titleFontPx) <= 0.2 &&
      Math.abs(
        profileBalancedRestored.hostWidth - (responsive1920Windowed.host?.width ?? 0)
      ) <= 2
  ),
  `restored lyric/title/host ${profileBalancedRestored.lyricFontPx}/${profileBalancedRestored.titleFontPx}/${profileBalancedRestored.hostWidth} reference ${responsive1920Windowed.lyricFontPx}/${responsive1920Windowed.titleFontPx}/${responsive1920Windowed.host?.width}`
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
