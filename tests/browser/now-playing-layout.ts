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
import { PNG } from "pngjs";
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
type LyricsMode = "synced" | "plain" | "empty" | "error" | "slow" | "wordsynced" | "linemotion";

/**
 * Word-timed TTML shaped like the Apple Music files users actually load (a real one
 * found the karaoke-style cache bug): two lines, each opening with one long word, so
 * a mid-word screenshot can measure how much of that word the highlight has covered.
 */
const WORD_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body dur="00:06.000"><div>
<p begin="00:00.400" end="00:03.000"><span begin="00:00.400" end="00:02.400">Alpha</span> <span begin="00:02.400" end="00:02.700">be</span> <span begin="00:02.700" end="00:03.000">ta</span></p>
<p begin="00:03.800" end="00:06.000"><span begin="00:03.800" end="00:05.400">Alpha</span> <span begin="00:05.400" end="00:05.700">ep</span> <span begin="00:05.700" end="00:06.000">si</span></p>
</div></body></tt>`;

/**
 * Four evenly spaced lines for the line-transition probe: three line changes inside
 * the 6-second fixture, one per built-in transition style (Scale, Slide, Fade), with
 * profile switches in the gaps between them.
 */
const LINE_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body dur="00:06.000"><div>
<p begin="00:00.400" end="00:01.700"><span begin="00:00.400" end="00:01.200">Alpha</span> <span begin="00:01.200" end="00:01.450">be</span> <span begin="00:01.450" end="00:01.700">ta</span></p>
<p begin="00:02.000" end="00:03.300"><span begin="00:02.000" end="00:02.800">Alpha</span> <span begin="00:02.800" end="00:03.050">ep</span> <span begin="00:03.050" end="00:03.300">si</span></p>
<p begin="00:03.600" end="00:04.900"><span begin="00:03.600" end="00:04.400">Alpha</span> <span begin="00:04.400" end="00:04.650">ga</span> <span begin="00:04.650" end="00:04.900">mma</span></p>
<p begin="00:05.100" end="00:05.900"><span begin="00:05.100" end="00:05.600">Alpha</span> <span begin="00:05.600" end="00:05.750">de</span> <span begin="00:05.750" end="00:05.900">lta</span></p>
</div></body></tt>`;
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
            : mode === "wordsynced" || mode === "linemotion"
              ? [
                  {
                    source: "local-rich",
                    provider: "Local TTML/QRC",
                    text: mode === "linemotion" ? LINE_TTML : WORD_TTML,
                    syncHint: "synced",
                    language: "en",
                    songwriters: [],
                    sourceHref: plainPath,
                    cached: true,
                  },
                ]
              : [];
      if (request.trackId === ids.synced && mode === "synced") return sendJson({ candidates, providerStatus: [] });
      if (request.trackId === ids.plain && mode === "plain") return sendJson({ candidates, providerStatus: [] });
      // Word-sync scenarios ride the plain track so the mode switch resolves fresh lyrics.
      if (request.trackId === ids.plain && (mode === "wordsynced" || mode === "linemotion"))
        return sendJson({ candidates, providerStatus: [] });
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
      backgroundMode: view?.dataset.profileBackground ?? "",
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

/* 9. Customization Studio. Balanced must open read-only; Duplicate creates the
   editable copy; slider/select edits preview live on the same tree; Save persists
   the custom profile through the real settings store. React controlled inputs are
   driven with the native value setter, the standard way to synthesize real input. */
const setControlValue = async (selector: string, value: string) => {
  await page.$eval(selector, (node, next) => {
    const element = node as HTMLInputElement | HTMLSelectElement;
    const proto =
      element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(element, next);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
};

const studioBefore = await profileProbe();
await page.click('[data-testid="customize-now-playing"]');
await page.waitForSelector('[data-testid="customization-studio"]', { timeout: 10_000 });
await wait(450);
await shot("17-studio-builtin-readonly");
const studioBuiltIn = await page.evaluate(() => ({
  savePresent: Boolean(document.querySelector('[data-testid="studio-save"]')),
  profileRows: document.querySelectorAll(".studio-profile-row").length,
  profileListHeight:
    document.querySelector(".studio-profiles")?.getBoundingClientRect().height ?? 0,
  lyricsScaleDisabled:
    document.querySelector('[data-testid="studio-lyrics-scale"]')?.matches(":disabled") ?? null,
  protectedNote:
    document
      .querySelector('[data-testid="customization-studio"]')
      ?.textContent?.includes("Built-in (protected)") ?? false,
}));

await page.click('[data-testid="studio-duplicate"]');
await wait(350);
await setControlValue('[data-testid="studio-lyrics-scale"]', "1.3");
await wait(600);
const studioPreview = await profileProbe();

await setControlValue('[data-testid="studio-background-mode"]', "solid");
await wait(450);
await shot("18-studio-custom-preview");
const studioCustomPreview = await profileProbe();

await page.click('[data-testid="studio-save"]');
await page.waitForFunction(
  () => !document.querySelector('[data-testid="customization-studio"]'),
  { timeout: 10_000 }
);
await wait(700);
const studioSaved = await profileProbe();
const studioSavedSettings = await page.evaluate(async () => {
  const cadence = (
    window as unknown as {
      cadence: { settings: { get: () => Promise<{ nowPlayingProfiles: unknown }> } };
    }
  ).cadence;
  const settings = await cadence.settings.get();
  const profiles = settings.nowPlayingProfiles as {
    activeProfileId: string;
    customProfiles: {
      id: string;
      name: string;
      windowed: { backgroundMode: string; lyricsScale: number };
    }[];
  };
  return {
    activeProfileId: profiles.activeProfileId,
    customs: profiles.customProfiles.map(profile => ({
      id: profile.id,
      name: profile.name,
      backgroundMode: profile.windowed.backgroundMode,
      lyricsScale: profile.windowed.lyricsScale,
    })),
  };
});
await selectNowPlayingProfile("balanced");
const studioRestored = await profileProbe();

/* 10. Fullscreen surface: per-profile backgrounds and the Studio itself. Lyrics
   Focus ships blurred artwork, Immersive the (opt-in) canvas visualizer; both must
   mount over the shared tree without disturbing playback or the active line. */
await enterFullscreen();
await page.setViewport({ width: 1920, height: 1080 });
await wait(500);
await selectNowPlayingProfile("lyrics-focus");
await wait(600);
await shot("19-fullscreen-blurred-background");
const fullscreenParticles = await profileProbe();

await selectNowPlayingProfile("immersive");
await wait(600);
await shot("20-fullscreen-visualizer-background");
const fullscreenVisualizer = await profileProbe();

await page.click('[data-testid="customize-now-playing"]');
await page.waitForSelector('[data-testid="customization-studio"]', { timeout: 10_000 });
await wait(450);
await shot("21-fullscreen-studio");
const fullscreenStudioOpen = await page.evaluate(
  () => Boolean(document.querySelector('[data-testid="customization-studio"]'))
);
await page.mouse.click(30, 30);
await page.waitForFunction(
  () => !document.querySelector('[data-testid="customization-studio"]'),
  { timeout: 10_000 }
);
await selectNowPlayingProfile("balanced");
await exitFullscreen();
const fullscreenEffectsRestored = await profileProbe();

/* 11. Studio feature matrix. Every Customization Studio control is driven through the
   real UI (aria-label selectors, native value setters for React controlled inputs) and
   verified against computed styles / geometry on the live tree — not just unit-tested.
   Runs windowed at 1920x1080 unless a step explicitly enters fullscreen. */

const mxOpenStudio = async () => {
  await page.click('[data-testid="customize-now-playing"]');
  await page.waitForSelector('[data-testid="customization-studio"]', { timeout: 10_000 });
  await wait(450);
};
const mxCloseStudioBySave = async () => {
  await page.click('[data-testid="studio-save"]');
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="customization-studio"]'),
    { timeout: 10_000 }
  );
  await wait(500);
};
const mxSetControl = async (sectionTitle: string | null, label: string, value: string) => {
  await page.evaluate(
    (args: { sectionTitle: string | null; label: string; value: string }) => {
      const scope = args.sectionTitle
        ? [...document.querySelectorAll(".studio-section")].find(
            s => s.querySelector("h3")?.textContent?.trim() === args.sectionTitle
          )
        : document.querySelector('[data-testid="customization-studio"]');
      const el = scope?.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[aria-label="${args.label}"]`
      );
      if (!el) throw new Error(`control "${args.label}" not found in ${args.sectionTitle ?? "studio"}`);
      el.scrollIntoView({ block: "center" });
      const proto =
        el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, args.value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { sectionTitle, label, value }
  );
  await wait(300);
  // Range sliders record an undo point on commit (pointerup/blur); fire it after React settles.
  await page.evaluate(
    (args: { sectionTitle: string | null; label: string }) => {
      const scope = args.sectionTitle
        ? [...document.querySelectorAll(".studio-section")].find(
            s => s.querySelector("h3")?.textContent?.trim() === args.sectionTitle
          )
        : document.querySelector('[data-testid="customization-studio"]');
      const el = scope?.querySelector<HTMLElement>(`[aria-label="${args.label}"]`);
      el?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      el?.blur();
    },
    { sectionTitle, label }
  );
  await wait(200);
};
const mxToggle = async (label: string) => {
  const found = await page.evaluate((ariaLabel: string) => {
    const el = document.querySelector<HTMLInputElement>(`[aria-label="${ariaLabel}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  }, label);
  if (!found) throw new Error(`toggle "${label}" not found`);
  await wait(350);
};
const mxClickStudioButton = async (text: string) => {
  const found = await page.evaluate((wanted: string) => {
    const root = document.querySelector('[data-testid="customization-studio"]');
    const btn = [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      b => b.textContent?.replace(/\s+/g, " ").trim() === wanted
    );
    if (!btn) return false;
    btn.scrollIntoView({ block: "center" });
    btn.click();
    return true;
  }, text);
  if (!found) throw new Error(`studio button "${text}" not found`);
  await wait(350);
};
const mxStyle = () =>
  page.evaluate(() => {
    const view = document.querySelector<HTMLElement>(".lyrics-view")!;
    const container = document.querySelector(".blyrics-container");
    const containerCs = container ? getComputedStyle(container) : null;
    const lines = [...document.querySelectorAll(".blyrics--line")];
    const active = document.querySelector(".blyrics--active");
    const inactive =
      lines.find(line => !line.classList.contains("blyrics--active")) ?? null;
    const firstLineCs = lines[0] ? getComputedStyle(lines[0]) : null;
    return {
      profileId: view.dataset.nowPlayingProfile ?? "",
      background: view.dataset.profileBackground ?? "",
      blur: view.dataset.profileBlur ?? "",
      align: getComputedStyle(document.querySelector("braccato-lyrics")!).textAlign,
      lineAlign: firstLineCs?.textAlign ?? "",
      lineFont: firstLineCs?.fontFamily ?? "",
      lineWeight: firstLineCs?.fontWeight ?? "",
      lineLetterSpacing: firstLineCs?.letterSpacing ?? "",
      lineHeightPx: firstLineCs ? Number.parseFloat(firstLineCs.lineHeight) || 0 : 0,
      activeColor: active ? getComputedStyle(active).color : "",
      // The renderer paints the active colour on inner word spans, not the line box.
      activeSpanColors: active
        ? [...active.querySelectorAll("*")].map(node => getComputedStyle(node).color)
        : [],
      inactiveColor: inactive ? getComputedStyle(inactive).color : "",
      inactiveOpacity: inactive ? Number.parseFloat(getComputedStyle(inactive).opacity) || 0 : 0,
      inactiveFilter: inactive ? getComputedStyle(inactive).filter : "",
      rootActiveScale: view.style.getPropertyValue("--np-active-line-scale").trim(),
      rootSwipe: view.style.getPropertyValue("--np-karaoke-swipe").trim(),
      rootDuration: view.style.getPropertyValue("--np-motion-duration").trim(),
      containerActiveScale:
        containerCs?.getPropertyValue("--blyrics-active-scale").trim() ?? "",
      containerActiveColorVar:
        containerCs?.getPropertyValue("--blyrics-lyric-active-color").trim() ?? "",
      containerHighlightVar:
        containerCs?.getPropertyValue("--blyrics-highlight-color").trim() ?? "",
      containerSwipe:
        containerCs?.getPropertyValue("--blyrics-animate-highlight-swipe").trim() ?? "",
      containerDuration:
        containerCs?.getPropertyValue("--blyrics-transition-duration").trim() ?? "",
      gradientFill: (() => {
        const fill = document.querySelector(".np-bg-fill");
        return fill ? getComputedStyle(fill).backgroundImage : "";
      })(),
      effectCanvas: Boolean(document.querySelector(".np-bg-canvas")),
    };
  });
const mxLayout = () =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        right: Math.round(rect.right),
        display: getComputedStyle(node).display,
      };
    };
    const heading = document.querySelector(".lyrics-heading");
    return {
      side: box(".fs-side"),
      body: box(".lyrics-body"),
      artwork: box(".fs-artwork"),
      dock: box(".lyrics-dock"),
      fsControls: box(".lyrics-footer .fs-controls"),
      sideHeading: Boolean(document.querySelector(".fs-side .lyrics-heading")),
      headerHeading: Boolean(document.querySelector(".lyrics-header .lyrics-heading")),
      headingVisible: Boolean(
        heading &&
          getComputedStyle(heading).display !== "none" &&
          heading.getBoundingClientRect().width > 0
      ),
    };
  });
const mxMessage = () =>
  page.evaluate(
    () => document.querySelector(".studio-message")?.textContent?.replace(/\s+/g, " ").trim() ?? ""
  );
const mxProfilesSettings = () =>
  page.evaluate(async () => {
    const cadence = (
      window as unknown as {
        cadence: { settings: { get: () => Promise<{ nowPlayingProfiles: unknown }> } };
      }
    ).cadence;
    const settings = await cadence.settings.get();
    return settings.nowPlayingProfiles as {
      activeProfileId: string;
      contextSwitching: { enabled: boolean; windowedProfileId: string; fullscreenProfileId: string };
      customProfiles: {
        id: string;
        name: string;
        windowed: Record<string, unknown>;
        fullscreen: Record<string, unknown>;
      }[];
    };
  });

await setViewport(1920, 1080);
await mxOpenStudio();

// New profile: creates an editable "My profile" draft.
await mxClickStudioButton("New");
const mxNewDraft = await page.evaluate(() => ({
  name: (document.querySelector('[data-testid="studio-profile-name"]') as HTMLInputElement | null)
    ?.value,
  header: document.querySelector(".studio-header p")?.textContent?.trim() ?? "",
}));

// Back to Balanced, duplicate it, rename the copy.
await page.click('.studio-profile-row[data-profile-id="balanced"]');
await wait(300);
await page.click('[data-testid="studio-duplicate"]');
await wait(350);
const mxMatrixId = (await profileProbe()).profileId;
await page.evaluate(() => {
  const el = document.querySelector<HTMLInputElement>('[data-testid="studio-profile-name"]')!;
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    el,
    "Matrix Test"
  );
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.blur();
});
await wait(300);

// Typography: serif font, weight 900, letter spacing, line spacing (all windowed).
const mxTypeBefore = await mxStyle();
await mxSetControl("Typography", "Lyrics font", "georgia");
await mxSetControl("Typography", "Lyrics weight", "900");
await mxSetControl("Typography", "Letter spacing", "0.05");
await mxSetControl("Typography", "Line spacing", "1.25");
const mxTypeAfter = await mxStyle();
await shot("22-studio-matrix-typography");

// Alignment + custom colours.
await mxSetControl("Layout", "Lyrics alignment", "center");
await mxSetControl("Lyrics appearance", "Active line colour", "#ff8800");
await mxSetControl("Lyrics appearance", "Inactive line colour", "#4466ff");
const mxColorAfter = await mxStyle();
await shot("23-studio-matrix-centre-colours");

// Inactive blur + opacity, active line scale.
await mxSetControl("Lyrics appearance", "Inactive blur", "3");
await mxSetControl("Lyrics appearance", "Inactive opacity", "0.5");
await mxSetControl("Lyrics appearance", "Active line scale", "1.15");
const mxAppearanceAfter = await mxStyle();

// Karaoke flags: minimal kills the swipe; glow restores it.
await mxSetControl("Karaoke highlight", "Style", "minimal");
const mxKaraokeMinimal = await mxStyle();
await mxSetControl("Karaoke highlight", "Style", "glow");
const mxKaraokeGlow = await mxStyle();

// Motion: slide transition at 150% duration.
await mxSetControl("Motion", "Line transition", "slide");
await mxSetControl("Motion", "Duration", "1.5");
const mxMotionAfter = await mxStyle();

// Backgrounds: gradient, then particles (canvas mounts).
await mxSetControl("Background", "Mode", "gradient");
const mxGradient = await mxStyle();
await shot("24-studio-matrix-gradient");
await mxSetControl("Background", "Mode", "particles");
const mxParticles = await mxStyle();
await shot("25-studio-matrix-particles");

// Undo returns to gradient; redo reapplies particles.
await page.evaluate(() => {
  document
    .querySelector<HTMLButtonElement>('[data-testid="customization-studio"] [aria-label="Undo"]')
    ?.click();
});
await wait(400);
const mxAfterUndo = await mxStyle();
await page.evaluate(() => {
  document
    .querySelector<HTMLButtonElement>('[data-testid="customization-studio"] [aria-label="Redo"]')
    ?.click();
});
await wait(400);
const mxAfterRedo = await mxStyle();

// Save the windowed matrix edits.
await mxCloseStudioBySave();
const mxSavedSettings = await mxProfilesSettings();
const mxSavedMatrix = mxSavedSettings.customProfiles.find(p => p.id === mxMatrixId);

// Layout slots in fullscreen: artwork to the right column, title to the top bar.
await enterFullscreen();
await mxOpenStudio();
await page.evaluate(() => {
  const chipEl = [...document.querySelectorAll<HTMLElement>(".studio-chip")].find(
    c => c.textContent?.trim() === "Artwork"
  );
  chipEl?.scrollIntoView({ block: "center" });
  chipEl?.click();
});
await wait(200);
await page.evaluate(() => {
  document.querySelector<HTMLElement>(".studio-slot.slot-right")?.click();
});
await wait(400);
await page.evaluate(() => {
  const chipEl = [...document.querySelectorAll<HTMLElement>(".studio-chip")].find(
    c => c.textContent?.trim() === "Title & artist"
  );
  chipEl?.click();
});
await wait(200);
await page.evaluate(() => {
  document.querySelector<HTMLElement>(".studio-slot.slot-top")?.click();
});
await wait(400);
await mxCloseStudioBySave();
const mxSlotsLayout = await mxLayout();
await shot("26-fullscreen-artwork-right-metadata-top");

// Visibility toggles: hide dock, controls, artwork and metadata; verify; restore.
await mxOpenStudio();
await mxToggle("Show lyrics dock");
await mxToggle("Show playback controls");
await mxToggle("Show artwork");
await mxToggle("Show title & artist");
await mxCloseStudioBySave();
const mxHiddenLayout = await mxLayout();
await shot("27-fullscreen-components-hidden");

await mxOpenStudio();
await mxToggle("Show lyrics dock");
await mxToggle("Show playback controls");
await mxToggle("Show artwork");
await mxToggle("Show title & artist");

// Mode separation: fullscreen lyrics 130% while this surface shows it live, then
// windowed 80% edited from the same fullscreen session without affecting the surface.
await mxSetControl("Typography", "Main lyrics size", "1.3");
const mxFullscreenScaled = await profileProbe();
await page.evaluate(() => {
  const btn = [...document.querySelectorAll<HTMLButtonElement>(".studio-mode-toggle button")].find(
    b => b.textContent?.trim() === "Windowed"
  );
  btn?.click();
});
await wait(300);
await mxSetControl("Typography", "Main lyrics size", "0.8");
const mxWindowedEditFromFullscreen = await profileProbe();
await mxCloseStudioBySave();
await exitFullscreen();
const mxWindowedSeparated = await profileProbe();
await shot("28-windowed-separated-config");
await enterFullscreen();
const mxFullscreenSeparated = await profileProbe();
await exitFullscreen();

// Section reset (Typography) reverts font + scale in the preview; discarding the
// Studio session must leave the saved profile untouched.
await mxOpenStudio();
await page.evaluate(() => {
  const btn = document.querySelector<HTMLButtonElement>('button[title="Reset Typography"]');
  btn?.scrollIntoView({ block: "center" });
  btn?.click();
});
await wait(450);
const mxAfterSectionReset = await mxStyle();
const mxResetFont = await profileProbe();
await mxClickStudioButton("Cancel");
const mxDiscardPrompt = await mxMessage();
await mxClickStudioButton("Discard changes");
await page.waitForFunction(
  () => !document.querySelector('[data-testid="customization-studio"]'),
  { timeout: 10_000 }
);
await wait(400);
const mxAfterDiscardSettings = await mxProfilesSettings();
const mxMatrixAfterDiscard = mxAfterDiscardSettings.customProfiles.find(
  p => p.id === mxMatrixId
);

// Export feedback, invalid import rejection, then a valid import saved as active.
await mxOpenStudio();
await page.click('[data-testid="studio-export"]');
await wait(500);
const mxExportMessage = await mxMessage();

const mxSetImportText = async (text: string) => {
  await page.evaluate((value: string) => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-testid="studio-import-text"]')!;
    el.scrollIntoView({ block: "center" });
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, text);
  await wait(300);
};
const mxCustomCountBeforeImport = (await mxProfilesSettings()).customProfiles.length;
await mxSetImportText('{"kind":"not-a-cadence-profile","version":1}');
await page.click('[data-testid="studio-import"]');
await wait(400);
const mxImportErrorMessage = await mxMessage();

await mxSetImportText(
  JSON.stringify({
    kind: "cadence-now-playing-profile",
    version: 1,
    profile: {
      id: "imported-matrix-1",
      name: "Imported Matrix",
      description: "Imported by the matrix harness",
      builtIn: false,
      windowed: { lyricsScale: 1.2, backgroundMode: "gradient" },
      fullscreen: { backgroundMode: "gradient" },
    },
  })
);
await page.click('[data-testid="studio-import"]');
await wait(400);
const mxImportOkMessage = await mxMessage();
await mxCloseStudioBySave();
const mxAfterImportSettings = await mxProfilesSettings();

// Quick Switcher lists both custom profiles.
await openProfileSwitcher();
const mxSwitcher = await profileProbe();
await shot("29-quick-switcher-custom-profiles");
// Close via the switcher's own button — a blind page click can land on sidebar nav.
await page.$eval('[data-testid="now-playing-profile-button"]', el =>
  (el as HTMLElement).click()
);
await wait(400);

// Context switching: windowed → Balanced, fullscreen → Matrix Test, automatically.
await mxOpenStudio();
await mxToggle("Use different profiles for windowed and fullscreen");
await mxSetControl(null, "Windowed profile", "balanced");
await mxSetControl(null, "Fullscreen profile", mxMatrixId);
await mxCloseStudioBySave();
const mxContextWindowed = await profileProbe();
await enterFullscreen();
const mxContextFullscreen = await profileProbe();
await shot("30-context-switching-fullscreen");
await exitFullscreen();
const mxContextBackWindowed = await profileProbe();

// Turn context switching back off and restore Balanced.
await mxOpenStudio();
await mxToggle("Use different profiles for windowed and fullscreen");
await mxCloseStudioBySave();
await selectNowPlayingProfile("balanced");
const mxContextDisabled = await profileProbe();

// Delete the imported profile (two-step confirm), keep Matrix Test.
await mxOpenStudio();
await page.click('.studio-profile-row[data-profile-id="imported-matrix-1"]');
await wait(350);
await mxClickStudioButton("Delete");
await mxClickStudioButton("Confirm delete");
const mxDeleteMessage = await mxMessage();
await mxCloseStudioBySave();
const mxAfterDeleteSettings = await mxProfilesSettings();
await selectNowPlayingProfile("balanced");
const mxRestored = await profileProbe();

const matrixSummary = {
  matrixId: mxMatrixId,
  newDraft: mxNewDraft,
  typeBefore: mxTypeBefore,
  typeAfter: mxTypeAfter,
  colorAfter: mxColorAfter,
  appearanceAfter: mxAppearanceAfter,
  karaokeMinimal: mxKaraokeMinimal,
  karaokeGlow: mxKaraokeGlow,
  motionAfter: mxMotionAfter,
  gradient: mxGradient,
  particles: mxParticles,
  afterUndo: mxAfterUndo.background,
  afterRedo: mxAfterRedo.background,
  savedMatrix: mxSavedMatrix
    ? { name: mxSavedMatrix.name, windowed: mxSavedMatrix.windowed }
    : null,
  slotsLayout: mxSlotsLayout,
  hiddenLayout: mxHiddenLayout,
  fullscreenScaledFont: mxFullscreenScaled.lyricFontPx,
  windowedEditFromFullscreenFont: mxWindowedEditFromFullscreen.lyricFontPx,
  windowedSeparatedFont: mxWindowedSeparated.lyricFontPx,
  fullscreenSeparatedFont: mxFullscreenSeparated.lyricFontPx,
  afterSectionReset: { font: mxAfterSectionReset.lineFont, fontPx: mxResetFont.lyricFontPx },
  discardPrompt: mxDiscardPrompt,
  matrixAfterDiscard: mxMatrixAfterDiscard
    ? {
        fontId: mxMatrixAfterDiscard.windowed.fontId,
        lyricsScale: mxMatrixAfterDiscard.windowed.lyricsScale,
      }
    : null,
  exportMessage: mxExportMessage,
  importErrorMessage: mxImportErrorMessage,
  importOkMessage: mxImportOkMessage,
  customCountBeforeImport: mxCustomCountBeforeImport,
  afterImport: {
    active: mxAfterImportSettings.activeProfileId,
    customs: mxAfterImportSettings.customProfiles.map(p => p.id),
  },
  switcherRows: mxSwitcher.rows.map(r => r.id),
  contextWindowed: mxContextWindowed.profileId,
  contextFullscreen: mxContextFullscreen.profileId,
  contextBackWindowed: mxContextBackWindowed.profileId,
  contextDisabled: mxContextDisabled.profileId,
  deleteMessage: mxDeleteMessage,
  afterDeleteCustoms: mxAfterDeleteSettings.customProfiles.map(p => p.id),
  restored: { id: mxRestored.profileId, background: mxRestored.backgroundMode },
};

const playbackAfterResponsive = await page.evaluate(() => {
  const audio = document.querySelector("audio");
  return audio ? { currentTime: audio.currentTime, paused: audio.paused, src: audio.currentSrc } : null;
});
await exitFullscreen();

/* 12. Karaoke styles, end to end. A user-supplied word-timed TTML exposed that the
   renderer caches the CSS values it reads into JS (karaoke swipe/glow switches,
   glow radius, word emphasis, transition transforms) and only re-reads them when
   a theme is applied — so profile karaoke/motion changes did nothing until the
   next track. This plays real word-timed lyrics, photographs the active line
   mid-way through a two-second word under Progressive sweep, switches the active
   profile to Solid mid-song (no track change, no reload), and photographs the
   same word in the next line: sweep must have covered roughly half the word,
   solid all of it. Runs after the playback-preservation capture above because it
   deliberately plays and seeks. */
mode = "wordsynced";
/** Bright-glyph coverage of the active line: highlighted glyphs over all glyphs. */
const kxBrightRatio = async () => {
  await page.waitForSelector("braccato-lyrics .blyrics--active", { timeout: 8_000 });
  const box = await page.$eval("braccato-lyrics .blyrics--active", node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const png = PNG.sync.read(await page.screenshot({ clip: box }));
  let bright = 0;
  let glyph = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const luminance = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
    if (luminance > 45) glyph += 1;
    if (luminance > 170) bright += 1;
  }
  return { bright, glyph, ratio: glyph ? bright / glyph : 0 };
};
/** Play to a media instant, then pause there so the capture is of a frozen frame. */
const kxFreezeAt = async (target: number) => {
  await page.waitForFunction(
    (wanted: number) => {
      const audio = document.querySelector("audio");
      return Boolean(audio && !audio.paused && audio.currentTime >= wanted);
    },
    { polling: 25, timeout: 20_000 },
    target
  );
  await page.evaluate(() => document.querySelector("audio")?.pause());
  await wait(300);
};

await setViewport(1920, 1080);
await selectNowPlayingProfile("balanced");
await playTrackId(ids.plain);
await nav("Now Playing");
await page.evaluate(() => {
  const audio = document.querySelector("audio")!;
  audio.currentTime = 0;
  void audio.play();
});
await page.waitForSelector("braccato-lyrics .blyrics--line", { timeout: 15_000 });
// If resolving ran long, rewind so the approach to the measured instant is clean.
await page.evaluate(() => {
  const audio = document.querySelector("audio")!;
  if (audio.currentTime > 1.1) audio.currentTime = 0.8;
});
await kxFreezeAt(1.35);
const kxSweep = await kxBrightRatio();
await shot("31-karaoke-sweep-midword");
// Switch style mid-song through the real quick switcher: same track, same lyrics
// payload — only the profile changes. Minimal is instant (no swipe).
await selectNowPlayingProfile("minimal");
await page.evaluate(() => {
  const audio = document.querySelector("audio")!;
  audio.currentTime = 3.82;
  void audio.play();
});
await kxFreezeAt(4.6);
const kxSolid = await kxBrightRatio();
await shot("32-karaoke-solid-midword");
mode = "synced";
await selectNowPlayingProfile("balanced");
await wait(400);
const kxSummary = { sweep: kxSweep, solid: kxSolid };

/* 13. Line transitions, end to end. "I see no difference between them, even at
   slower songs": the Scale/Slide/Fade options existed only as CSS variables in
   earlier probes, never as measured motion. Play four evenly spaced lines,
   sample each entering line's computed transform + WAAPI keyframes on every
   frame, and switch profiles in the gaps so line 1 runs Scale (Balanced),
   line 2 Slide (Immersive) and line 3 Fade (Minimal). Scale must dip the
   entering line to ~0.95 before growing it to full size, Slide must carry a
   ~12px translateY entrance, Fade must do neither. */
mode = "linemotion";
type LineProbeRecord = {
  text: string;
  mediaAt: number;
  profile: string;
  enterVar: string;
  minA: number;
  finalA: number;
  maxTy: number;
  keyframes: string[];
};
await playTrackId(ids.synced);
await playTrackId(ids.plain);
await nav("Now Playing");
await page.waitForSelector("braccato-lyrics .blyrics--line", { timeout: 15_000 });
await page.evaluate(() => {
  const audio = document.querySelector("audio")!;
  audio.currentTime = 0;
  audio.pause();
  const probe: { records: unknown[]; errors: string[]; snapshot: () => unknown[] } = {
    records: [],
    errors: [],
    snapshot: () => [],
  };
  (window as unknown as { __lineProbe?: unknown }).__lineProbe = probe;
  document.querySelector("braccato-lyrics")?.addEventListener("braccato:error", event => {
    const detail = (event as CustomEvent<{ phase?: unknown; error?: { message?: unknown } }>).detail;
    probe.errors.push(`${String(detail?.phase)}: ${String(detail?.error?.message ?? detail?.error)}`);
  });
  let active: Element | null = null;
  let rec: LineProbeRecord | null = null;
  const loop = () => {
    const el = document.querySelector("braccato-lyrics .blyrics--active");
    if (el !== active) {
      if (rec) probe.records.push(rec);
      active = el;
      const container = document.querySelector("braccato-lyrics .blyrics-container");
      rec = el
        ? {
            text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24),
            mediaAt: +(document.querySelector("audio")?.currentTime ?? 0).toFixed(2),
            profile:
              document.querySelector<HTMLElement>(".lyrics-view")?.dataset.nowPlayingProfile ?? "?",
            enterVar: container
              ? getComputedStyle(container)
                  .getPropertyValue("--blyrics-line-enter-transform-from")
                  .trim()
              : "?",
            minA: 1,
            finalA: 1,
            maxTy: 0,
            keyframes: [],
          }
        : null;
    }
    if (rec && el) {
      const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform ?? "");
      if (m) {
        const parts = m[1].split(",").map(Number);
        rec.minA = Math.min(rec.minA, parts[0]);
        rec.finalA = parts[0];
        rec.maxTy = Math.max(rec.maxTy, Math.abs(parts[5]));
      }
      for (const animation of el.getAnimations()) {
        try {
          for (const frame of animation.effect?.getKeyframes() ?? []) {
            const t = frame.transform;
            if (typeof t === "string" && t && !rec.keyframes.includes(t)) rec.keyframes.push(t);
          }
        } catch {
          /* finished animations can throw while being read */
        }
      }
    }
    requestAnimationFrame(loop);
  };
  probe.snapshot = () =>
    rec ? [...probe.records, { ...rec, keyframes: [...rec.keyframes] }] : [...probe.records];
  requestAnimationFrame(loop);
});
const ltWaitTime = (target: number) =>
  page.waitForFunction(
    (wanted: number) => {
      const audio = document.querySelector("audio");
      return Boolean(audio && audio.currentTime >= wanted);
    },
    { polling: 25, timeout: 20_000 },
    target
  );
const ltThemeKey = () =>
  page.$eval("braccato-lyrics", el => {
    const theme = (el as unknown as { theme?: string }).theme ?? "";
    return /cadence-anim-key: ([^*]+) \*\//.exec(theme)?.[1]?.trim() ?? `(no key; tail: ${theme.slice(-30)})`;
  });
const ltSnapshot = () =>
  page.evaluate(
    () =>
      (window as unknown as { __lineProbe?: { snapshot: () => unknown[] } }).__lineProbe?.snapshot() ?? []
  ) as Promise<LineProbeRecord[]>;
const ltPlay = () =>
  page.evaluate(() => {
    void document.querySelector("audio")!.play();
  });
const ltPause = () =>
  page.evaluate(() => {
    document.querySelector("audio")!.pause();
  });
// Switch profiles while paused between lines: the switcher takes ~1-2s of UI
// automation, and the engine starts a line's entrance animation ~0.6s before
// its first word, so switching during playback raced the very activations
// being measured. Paused switches exercise the same render/theme path.
const ltKeyBalanced = await ltThemeKey();
await page.evaluate(() => {
  const audio = document.querySelector("audio")!;
  audio.currentTime = 0;
  void audio.play();
});
await ltWaitTime(1.0); // line 1 has activated under Balanced (Scale)
await ltPause();
const ltAfterL1 = await ltSnapshot();
await selectNowPlayingProfile("immersive"); // Slide applies from line 2
const ltKeyImmersive = await ltThemeKey();
await ltPlay();
await ltWaitTime(2.7); // line 2 has activated under Immersive (Slide)
await ltPause();
const ltAfterL2 = await ltSnapshot();
await selectNowPlayingProfile("minimal"); // Fade applies from line 3
const ltKeyMinimal = await ltThemeKey();
await ltPlay();
await ltWaitTime(4.3); // line 3 has activated under Minimal (Fade)
await ltPause();
const ltAfterL3 = await ltSnapshot();
const ltErrors = (await page.evaluate(
  () => (window as unknown as { __lineProbe?: { errors: string[] } }).__lineProbe?.errors ?? []
)) as string[];
const ltFindIn = (records: LineProbeRecord[], needle: string) =>
  records.find(r => r.text.includes(needle));
const ltScale = ltFindIn(ltAfterL1, "be");
const ltSlide = ltFindIn(ltAfterL2, "ep");
const ltFade = ltFindIn(ltAfterL3, "ga");
const ltRecords = ltAfterL3;
mode = "synced";
await selectNowPlayingProfile("balanced");
await wait(400);
const ltSummary = {
  themeKeys: { balanced: ltKeyBalanced, immersive: ltKeyImmersive, minimal: ltKeyMinimal },
  braccatoErrors: ltErrors,
  records: ltRecords.map(r => ({
    text: r.text,
    mediaAt: r.mediaAt,
    profile: r.profile,
    enterVar: r.enterVar,
    minA: +r.minA.toFixed(3),
    finalA: +r.finalA.toFixed(3),
    maxTy: +r.maxTy.toFixed(1),
    keyframes: r.keyframes,
  })),
};
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
      studioBefore,
      studioBuiltIn,
      studioPreview,
      studioCustomPreview,
      studioSaved,
      studioSavedSettings,
      studioRestored,
      fullscreenParticles,
      fullscreenVisualizer,
      fullscreenStudioOpen,
      fullscreenEffectsRestored,
      matrixSummary,
      kxSummary,
      ltSummary,
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

check(
  "studio-opens-builtin-readonly",
  Boolean(
    studioBuiltIn.savePresent &&
      studioBuiltIn.profileRows === 5 &&
      studioBuiltIn.profileListHeight > 100 &&
      studioBuiltIn.lyricsScaleDisabled === true &&
      studioBuiltIn.protectedNote
  ),
  JSON.stringify(studioBuiltIn)
);
check(
  "studio-duplicate-previews-live-on-shared-tree",
  Boolean(
    studioPreview.profileId.startsWith("custom-") &&
      studioPreview.lyricFontPx > studioBefore.lyricFontPx + 10 &&
      studioPreview.audio?.src === studioBefore.audio?.src &&
      studioPreview.audio?.paused === studioBefore.audio?.paused &&
      Math.abs((studioPreview.audio?.currentTime ?? 0) - (studioBefore.audio?.currentTime ?? 0)) < 0.05 &&
      studioPreview.activeLineText === studioBefore.activeLineText
  ),
  `before ${studioBefore.profileId}/${studioBefore.lyricFontPx}px preview ${studioPreview.profileId}/${studioPreview.lyricFontPx}px`
);
check(
  "studio-background-preview-applies",
  studioCustomPreview.backgroundMode === "solid",
  `background ${studioCustomPreview.backgroundMode}`
);
check(
  "studio-save-persists-custom-profile",
  Boolean(
    studioSavedSettings.activeProfileId === studioSaved.profileId &&
      studioSavedSettings.customs.length === 1 &&
      studioSavedSettings.customs[0].backgroundMode === "solid" &&
      Math.abs(studioSavedSettings.customs[0].lyricsScale - 1.3) < 0.001 &&
      Math.abs(studioSaved.lyricFontPx - studioPreview.lyricFontPx) <= 0.2
  ),
  JSON.stringify(studioSavedSettings)
);
check(
  "studio-custom-can-switch-back-to-balanced",
  Boolean(
    studioRestored.profileId === "balanced" &&
      Math.abs(studioRestored.lyricFontPx - studioBefore.lyricFontPx) <= 0.2 &&
      studioRestored.backgroundMode === "fluid"
  ),
  `restored ${studioRestored.profileId}/${studioRestored.lyricFontPx}px/${studioRestored.backgroundMode}`
);
check(
  "fullscreen-canvas-backgrounds-and-studio",
  Boolean(
    fullscreenParticles.backgroundMode === "blurred-artwork" &&
      fullscreenParticles.profileMode === "fullscreen" &&
      fullscreenVisualizer.backgroundMode === "visualizer" &&
      fullscreenStudioOpen &&
      fullscreenEffectsRestored.profileId === "balanced" &&
      fullscreenEffectsRestored.backgroundMode === "fluid" &&
      fullscreenVisualizer.audio?.src === fullscreenParticles.audio?.src &&
      fullscreenVisualizer.activeLineText === fullscreenParticles.activeLineText
  ),
  `blurred ${fullscreenParticles.backgroundMode} visualizer ${fullscreenVisualizer.backgroundMode} studio ${fullscreenStudioOpen} restored ${fullscreenEffectsRestored.backgroundMode}`
);

/* Studio feature matrix assertions. */
check(
  "mx-new-profile-creates-editable-draft",
  Boolean(mxNewDraft.name === "My profile" && mxNewDraft.header.includes("Custom")),
  JSON.stringify(mxNewDraft)
);
check(
  "mx-typography-font-weight-spacing-live",
  Boolean(
    /Georgia/i.test(mxTypeAfter.lineFont) &&
      mxTypeAfter.lineWeight === "900" &&
      (Number.parseFloat(mxTypeAfter.lineLetterSpacing) || 0) > 1 &&
      mxTypeAfter.lineHeightPx > mxTypeBefore.lineHeightPx
  ),
  `font ${mxTypeAfter.lineFont} weight ${mxTypeAfter.lineWeight} ls ${mxTypeAfter.lineLetterSpacing} lh ${mxTypeBefore.lineHeightPx}->${mxTypeAfter.lineHeightPx}`
);
check(
  "mx-centre-alignment",
  Boolean(mxColorAfter.align === "center" && mxColorAfter.lineAlign === "center"),
  `host ${mxColorAfter.align} line ${mxColorAfter.lineAlign}`
);
const mxParseColor = (color: string) => {
  const rgb = /rgba?\(([^)]+)\)/.exec(color);
  if (rgb) {
    const parts = rgb[1].split(",").map(part => Number.parseFloat(part));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(color);
  if (srgb) {
    return {
      r: Math.round(Number.parseFloat(srgb[1]) * 255),
      g: Math.round(Number.parseFloat(srgb[2]) * 255),
      b: Math.round(Number.parseFloat(srgb[3]) * 255),
      a: srgb[4] ? Number.parseFloat(srgb[4]) : 1,
    };
  }
  return null;
};
const mxInactiveParsed = mxParseColor(mxColorAfter.inactiveColor);
const mxInactiveDimmedParsed = mxParseColor(mxAppearanceAfter.inactiveColor);
check(
  "mx-custom-lyric-colours",
  Boolean(
    // The renderer paints the active colour as a karaoke highlight gradient driven by
    // these container variables (screenshot 23 shows the orange line); the inactive
    // colour lands on the line boxes directly.
    mxColorAfter.containerActiveColorVar.toLowerCase() === "#ff8800" &&
      mxColorAfter.containerHighlightVar.toLowerCase() === "#ff8800" &&
      mxInactiveParsed &&
      mxInactiveParsed.r === 68 &&
      mxInactiveParsed.g === 102 &&
      mxInactiveParsed.b === 255
  ),
  `activeVar ${mxColorAfter.containerActiveColorVar} highlightVar ${mxColorAfter.containerHighlightVar} inactive ${mxColorAfter.inactiveColor}`
);
const mxAlphaOf = (color: string) => mxParseColor(color)?.a ?? 1;
check(
  "mx-inactive-blur-opacity-active-scale",
  Boolean(
    mxAppearanceAfter.blur === "on" &&
      mxAppearanceAfter.inactiveFilter.includes("blur(3px)") &&
      // Inactive dimming is the colour's alpha (derived from --blyrics-inactive-opacity),
      // halved here by the profile's 50% inactive-opacity scale.
      mxAlphaOf(mxAppearanceAfter.inactiveColor) < mxAlphaOf(mxColorAfter.inactiveColor) * 0.75 &&
      (mxAppearanceAfter.rootActiveScale === "1.15" ||
        mxAppearanceAfter.containerActiveScale === "1.15")
  ),
  `filter ${mxAppearanceAfter.inactiveFilter} alpha ${mxAlphaOf(mxColorAfter.inactiveColor)}->${mxAlphaOf(mxAppearanceAfter.inactiveColor)} (${mxAppearanceAfter.inactiveColor}) scale root ${mxAppearanceAfter.rootActiveScale} container ${mxAppearanceAfter.containerActiveScale}`
);
check(
  "mx-karaoke-style-flags",
  Boolean(
    (mxKaraokeMinimal.rootSwipe === "0" || mxKaraokeMinimal.containerSwipe === "0") &&
      (mxKaraokeGlow.rootSwipe === "1" || mxKaraokeGlow.containerSwipe === "1")
  ),
  `minimal root ${mxKaraokeMinimal.rootSwipe}/${mxKaraokeMinimal.containerSwipe} glow root ${mxKaraokeGlow.rootSwipe}/${mxKaraokeGlow.containerSwipe}`
);
check(
  "mx-motion-duration-scaled",
  Boolean(
    mxMotionAfter.rootDuration === "249ms" ||
      mxMotionAfter.containerDuration === "249ms" ||
      mxMotionAfter.containerDuration === "0.249s"
  ),
  `root ${mxMotionAfter.rootDuration} container ${mxMotionAfter.containerDuration}`
);
check(
  "mx-gradient-background-live",
  Boolean(mxGradient.background === "gradient" && mxGradient.gradientFill.includes("gradient")),
  `mode ${mxGradient.background} fill ${mxGradient.gradientFill.slice(0, 60)}`
);
check(
  "mx-particles-background-mounts-canvas",
  Boolean(mxParticles.background === "particles" && mxParticles.effectCanvas),
  `mode ${mxParticles.background} canvas ${mxParticles.effectCanvas}`
);
check(
  "mx-undo-redo-background",
  Boolean(mxAfterUndo.background === "gradient" && mxAfterRedo.background === "particles"),
  `undo ${mxAfterUndo.background} redo ${mxAfterRedo.background}`
);
check(
  "mx-save-persists-edited-profile",
  Boolean(
    mxSavedMatrix &&
      mxSavedMatrix.name === "Matrix Test" &&
      mxSavedMatrix.windowed.fontId === "georgia" &&
      mxSavedMatrix.windowed.activeColor === "#ff8800" &&
      mxSavedMatrix.windowed.backgroundMode === "particles" &&
      mxSavedSettings.activeProfileId === mxMatrixId
  ),
  JSON.stringify(mxSavedMatrix ? mxSavedMatrix.windowed : null)
);
check(
  "mx-artwork-right-and-metadata-top-slots",
  Boolean(
    mxSlotsLayout.side &&
      mxSlotsLayout.body &&
      mxSlotsLayout.side.x > mxSlotsLayout.body.x &&
      mxSlotsLayout.body.right <= mxSlotsLayout.side.x + 1 &&
      mxSlotsLayout.headerHeading &&
      !mxSlotsLayout.sideHeading
  ),
  JSON.stringify(mxSlotsLayout)
);
check(
  "mx-visibility-toggles-hide-components",
  Boolean(
    mxHiddenLayout.dock?.display === "none" &&
      mxHiddenLayout.fsControls?.display === "none" &&
      (mxHiddenLayout.artwork?.display === "none" || (mxHiddenLayout.artwork?.w ?? 0) === 0) &&
      !mxHiddenLayout.headingVisible
  ),
  JSON.stringify(mxHiddenLayout)
);
check(
  "mx-windowed-fullscreen-configs-independent",
  Boolean(
    Math.abs(mxFullscreenScaled.lyricFontPx - 84.2) <= 2.5 &&
      Math.abs(mxWindowedEditFromFullscreen.lyricFontPx - mxFullscreenScaled.lyricFontPx) <= 0.2 &&
      Math.abs(mxWindowedSeparated.lyricFontPx - 44.2) <= 2 &&
      Math.abs(mxFullscreenSeparated.lyricFontPx - 84.2) <= 2.5
  ),
  `fs ${mxFullscreenScaled.lyricFontPx}/${mxFullscreenSeparated.lyricFontPx} win ${mxWindowedSeparated.lyricFontPx} (edit-from-fs surface ${mxWindowedEditFromFullscreen.lyricFontPx})`
);
check(
  "mx-section-reset-reverts-typography",
  Boolean(
    !/Georgia/i.test(mxAfterSectionReset.lineFont) &&
      Math.abs(mxResetFont.lyricFontPx - 55.2) <= 1.5
  ),
  `font ${mxAfterSectionReset.lineFont} px ${mxResetFont.lyricFontPx}`
);
check(
  "mx-discard-leaves-saved-profile-untouched",
  Boolean(
    mxDiscardPrompt.includes("unsaved changes") &&
      mxMatrixAfterDiscard &&
      mxMatrixAfterDiscard.windowed.fontId === "georgia" &&
      Math.abs(Number(mxMatrixAfterDiscard.windowed.lyricsScale) - 0.8) < 0.001
  ),
  `prompt ${JSON.stringify(mxDiscardPrompt)} saved ${JSON.stringify(mxMatrixAfterDiscard?.windowed ?? null)}`
);
check(
  "mx-export-gives-feedback",
  mxExportMessage.includes("Profile JSON"),
  mxExportMessage
);
check(
  "mx-import-rejects-foreign-json",
  Boolean(
    mxImportErrorMessage.length > 0 &&
      !mxImportErrorMessage.includes("Imported") &&
      mxAfterImportSettings.customProfiles.filter(p => p.id === "imported-matrix-1").length === 1
  ),
  mxImportErrorMessage
);
check(
  "mx-import-valid-profile-saved-active",
  Boolean(
    mxImportOkMessage.includes("Imported Matrix") &&
      mxAfterImportSettings.activeProfileId === "imported-matrix-1" &&
      mxAfterImportSettings.customProfiles.some(p => p.id === "imported-matrix-1") &&
      mxAfterImportSettings.customProfiles.length === mxCustomCountBeforeImport + 1
  ),
  `msg ${mxImportOkMessage} active ${mxAfterImportSettings.activeProfileId} count ${mxCustomCountBeforeImport}->${mxAfterImportSettings.customProfiles.length}`
);
check(
  "mx-quick-switcher-lists-custom-profiles",
  Boolean(
    mxSwitcher.rows.some(r => r.id === mxMatrixId) &&
      mxSwitcher.rows.some(r => r.id === "imported-matrix-1")
  ),
  `rows ${mxSwitcher.rows.map(r => r.id).join(",")}`
);
check(
  "mx-context-switching-per-surface",
  Boolean(
    mxContextWindowed.profileId === "balanced" &&
      mxContextFullscreen.profileId === mxMatrixId &&
      mxContextBackWindowed.profileId === "balanced" &&
      mxContextFullscreen.audio?.src === mxContextWindowed.audio?.src
  ),
  `win ${mxContextWindowed.profileId} fs ${mxContextFullscreen.profileId} back ${mxContextBackWindowed.profileId}`
);
check(
  "mx-delete-custom-profile",
  Boolean(
    mxDeleteMessage.includes("Deleted") &&
      !mxAfterDeleteSettings.customProfiles.some(p => p.id === "imported-matrix-1") &&
      mxAfterDeleteSettings.customProfiles.some(p => p.id === mxMatrixId)
  ),
  `msg ${mxDeleteMessage} customs ${mxAfterDeleteSettings.customProfiles.map(p => p.id).join(",")}`
);
check(
  "mx-matrix-restores-balanced",
  Boolean(mxRestored.profileId === "balanced" && mxRestored.backgroundMode === "fluid"),
  `${mxRestored.profileId}/${mxRestored.backgroundMode}`
);
check(
  "kx-sweep-progresses-where-solid-is-instant",
  Boolean(
    kxSweep.bright > 150 &&
      kxSweep.ratio < 0.45 &&
      kxSolid.ratio > 0.4 &&
      kxSolid.ratio > kxSweep.ratio * 1.5
  ),
  `mid-word bright-glyph coverage: sweep ${(kxSweep.ratio * 100).toFixed(0)}% (${kxSweep.bright}/${kxSweep.glyph}) solid ${(kxSolid.ratio * 100).toFixed(0)}% (${kxSolid.bright}/${kxSolid.glyph}); same word at ~50% progress, profile switched mid-song`
);
const LT_TY = /translateY\(\s*-?(?:1[0-9]|2[0-9])(?:\.\d+)?px\s*\)/;
check(
  "lt-scale-shrinks-entering-line",
  Boolean(ltScale && ltFade && ltScale.minA <= 0.978 && ltScale.minA < ltFade.minA - 0.015),
  `entering-line min scale: Scale ${ltScale?.minA.toFixed(3)} vs Fade ${ltFade?.minA.toFixed(3)} (keyframes: ${ltScale?.keyframes.join(" | ")})`
);
check(
  "lt-slide-rides-vertically",
  Boolean(ltSlide && ltSlide.keyframes.some(k => LT_TY.test(k))),
  `Slide keyframes: ${ltSlide?.keyframes.join(" | ") || "(none captured)"}`
);
check(
  "lt-fade-has-no-line-motion",
  Boolean(ltFade && ltFade.minA >= 0.99 && !ltFade.keyframes.some(k => LT_TY.test(k))),
  `Fade min scale ${ltFade?.minA.toFixed(3)}, keyframes: ${ltFade?.keyframes.join(" | ") || "(none)"}`
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
