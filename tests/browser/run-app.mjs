/**
 * Interactive application harness.
 *
 * Electron's binary cannot be downloaded in this environment, so this script boots the *real*
 * production renderer bundle (`out/renderer`) in headless Chromium with:
 *   - a stub `window.cadence` that speaks the same IPC contract as the preload script, backed by a
 *     snapshot produced by the real main-process scanner (`tests/browser/build-library.ts`),
 *   - real generated audio files served with HTTP Range support,
 *   - the real audio engine, lyrics renderer and shader engine.
 *
 * The stub replaces only the Electron IPC transport (dialogs, filesystem and SQLite live in the
 * main process, which cannot run without Electron). Playback, artwork decoding, lyric parsing and
 * shader rendering are the shipped code paths, not stand-ins.
 *
 * Usage: npx vite-node tests/browser/build-library.ts && node tests/browser/run-app.mjs
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { PNG } from "pngjs";
import chromium from "@sparticuz/chromium";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "out/renderer");
const harnessDir = join(root, ".artifacts/harness");
const audioDir = join(root, ".artifacts/fixtures/formats");
const shotDir = join(root, ".artifacts/screens");
mkdirSync(shotDir, { recursive: true });

const snapshotFile = join(harnessDir, "library.json");
if (!existsSync(snapshotFile)) throw new Error("Run: npx vite-node tests/browser/build-library.ts");
const { snapshot } = JSON.parse(readFileSync(snapshotFile, "utf8"));
const byTitle = title => snapshot.tracks.find(track => track.title === title);

const PLAIN_LRC = `[ti:Fixture FLAC]
[ar:Harness Artist]
[al:Test Bench]
[00:00.30]First line of the fixture
[00:01.60]Second line arrives later
[00:03.20]Third line keeps the pace
[00:04.60]Fourth line closes it out
`;
const RICH_LRC = `[ti:Fixture FLAC]
[ar:Harness Artist]
[al:Test Bench]
[00:00.30]<00:00.30>Word <00:00.60>level <00:01.00>timings <00:01.30>arrive
[00:01.70]<00:01.70>Every <00:02.00>single <00:02.40>word <00:02.70>lights
[00:03.20]<00:03.20>Karaoke <00:03.60>follows <00:04.00>the <00:04.20>clock
[00:04.80]<00:04.80>Last <00:05.10>line <00:05.40>of <00:05.60>the <00:05.80>song
`;

/** Track ids from the generated library, resolved by title so the harness never hardcodes ids. */
const ids = {
  flac: byTitle("Fixture FLAC")?.id,
  mp3: byTitle("Fixture MP3")?.id,
  ogg: byTitle("Fixture Ogg Vorbis")?.id,
  aac: byTitle("Fixture AAC")?.id,
  wav: byTitle("fixture")?.id,
};
const lyricsByTrack = {
  [ids.flac]: { text: RICH_LRC, source: "local-sidecar", provider: "Local file" },
  [ids.wav]: { text: PLAIN_LRC, source: "embedded-tag", provider: "Embedded tag" },
  [ids.mp3]: { text: "Plain unsynced lyrics for the MP3 fixture\nno timings here", source: "lrclib-plain", provider: "LRCLIB" },
};

/* ------------------------------------------------------------------- server */

const MIME = {
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

const missing = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const decode = value => decodeURIComponent(value);
  let file = null;
  if (url.pathname.startsWith("/audio/")) file = join(audioDir, decode(url.pathname.slice(7)));
  else if (url.pathname.startsWith("/artwork/")) file = join(harnessDir, decode(url.pathname.slice(9)));
  else {
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    file = join(outDir, path);
    if (!file.startsWith(outDir)) file = null;
  }

  if (!file || !existsSync(file) || statSync(file).isDirectory()) {
    missing.push(url.pathname);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  const size = statSync(file).size;
  const headers = {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "content-range, accept-ranges, content-length",
    "cache-control": "no-store",
  };
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = Number(match[1] || 0);
    const end = match[2] ? Number(match[2]) : size - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(file).pipe(res);
  }
});

await new Promise(r => server.listen(4791, "0.0.0.0", r));
const base = "http://127.0.0.1:4791";

/* ------------------------------------------------------------------ browser */

chromium.setGraphicsMode = true;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  args: [...chromium.args, "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader"],
  defaultViewport: { width: 1480, height: 900 },
  protocolTimeout: 180_000,
});

const page = await browser.newPage();
const logs = [];
page.on("console", message => logs.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", error => logs.push(`[pageerror] ${error.message}`));

const results = {};
const check = (name, value, detail = "") => {
  results[name] = { value, detail };
  console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const audioState = () =>
  page.evaluate(() => {
    const audio = document.querySelector("audio");
    const finite = value => (Number.isFinite(value) ? value : -1);
    return {
      currentTime: finite(audio?.currentTime ?? -1),
      duration: finite(audio?.duration ?? -1),
      paused: audio?.paused ?? true,
      readyState: audio?.readyState ?? -1,
      src: audio?.currentSrc ?? audio?.src ?? "",
      error: audio?.error ? `${audio.error.code}: ${audio.error.message}` : null,
    };
  });

/* Stub bridge: same contract as src/preload/index.ts, backed by real library data. */
await page.evaluateOnNewDocument(
  data => {
    const { snapshot, lyricsByTrack } = data;
    const SETTINGS_KEY = "cadence.harness.settings.v1";
    const defaultSettings = {
      version: 1,
      playback: { volume: 0.85, muted: false, shuffle: false, repeat: "off", playbackRate: 1, resumeOnLaunch: false },
      appearance: { accent: "#ff3d71", reduceMotion: false, compactSidebar: false, blurArtwork: true },
      lyrics: {
        providerOrder: ["local-sidecar", "embedded-tag", "lrclib-synced", "lrclib-plain"],
        autoFetch: true,
        offsetMs: 0,
        translationLanguage: "en",
        romanization: false,
        themeId: "default",
        customThemeCss: "",
        fontSizeRem: 1.6,
        fontWeight: 700,
        lineHeight: 1.45,
        activeOpacity: 1,
        inactiveOpacity: 0.42,
        targetScrollRatio: 0.38,
        showCredits: true,
        hideInstrumentalOnly: false,
        passiveScroll: true,
        fullscreenOnOpen: false,
        showLyricsInFullscreen: true,
      },
      shaders: {
        enabled: true,
        kawarpOpacity: 0.8,
        kawarpWarpIntensity: 1,
        kawarpBlurPasses: 8,
        kawarpAnimationSpeed: 1,
        kawarpTransitionDuration: 900,
        kawarpSaturation: 1.5,
        kawarpDithering: 0.008,
        kawarpAudioScaleBoost: 2,
        videoEnabled: false,
        videoOpacity: 1,
        videoWarpIntensity: 1,
        videoBlurPasses: 4,
        videoAnimationSpeed: 1,
        videoSaturation: 1.5,
        videoDithering: 0.008,
        videoHdrDitheringScale: 1,
        videoDimStrength: 0.5,
        videoBrightnessTransition: 300,
        videoAudioResponsive: false,
        videoBeatSpeedMultiplier: 2,
        videoBeatZoom: 1.05,
        videoZoomAttack: 0.2,
        videoZoomRelease: 0.4,
        videoSampleWidth: 128,
        videoSampleHeight: 128,
        videoFrameRate: 30,
        videoColorResponse: 0.5,
        videoBrightnessSampleSize: 64,
        videoBrightnessInterval: 500,
        videoDownsampleFactor: 2,
        autoDimBrightArtwork: true,
        autoDimStrength: 0.5,
        audioResponsive: true,
        audioSpeedMultiplier: 4,
        audioBeatThreshold: 0.75,
        pauseOnInactive: true,
        showLogs: false,
        showOnBrowsePages: false,
        enableAnimatedArt: false,
        performanceMode: "balanced",
      },
      advanced: { showLogs: false },
    };
    const loadSettings = () => {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return structuredClone(defaultSettings);
        const mergeSaved = (base, saved) => {
          const result = Array.isArray(base) ? [...base] : { ...base };
          for (const [key, value] of Object.entries(saved ?? {})) {
            result[key] =
              value && typeof value === "object" && !Array.isArray(value) && base?.[key] && typeof base[key] === "object"
                ? mergeSaved(base[key], value)
                : value;
          }
          return result;
        };
        return mergeSaved(structuredClone(defaultSettings), JSON.parse(raw));
      } catch {
        return structuredClone(defaultSettings);
      }
    };
    // Mirrors the main process: nested objects merge with the defaults rather than replacing them.
    const mergeDeep = (base, patch) => {
      const result = Array.isArray(base) ? [...base] : { ...base };
      for (const [key, value] of Object.entries(patch ?? {})) {
        result[key] =
          value && typeof value === "object" && !Array.isArray(value) && base?.[key] && typeof base[key] === "object"
            ? mergeDeep(base[key], value)
            : value;
      }
      return result;
    };
    let settings = loadSettings();
    let playlists = structuredClone(snapshot.playlists);
    const trackById = id => snapshot.tracks.find(track => track.id === id) ?? null;

    const resolveLyrics = request => {
      const entry = lyricsByTrack[request?.trackId];
      if (!entry) {
        return {
          candidates: [],
          providerStatus: [
            { provider: "local-sidecar", status: "miss" },
            { provider: "lrclib", status: "miss", detail: "No match" },
          ],
        };
      }
      return {
        candidates: [
          {
            source: entry.source,
            provider: entry.provider,
            text: entry.text,
            syncHint: entry.text.includes("<00:") ? "richsync" : "synced",
            language: null,
            songwriters: ["Harness Artist"],
            sourceHref: null,
            cached: true,
          },
        ],
        providerStatus: [{ provider: entry.source, status: "hit", detail: entry.provider }],
      };
    };

    window.cadence = {
      info: async () => ({
        name: "Cadence",
        version: "0.1.0",
        platform: "browser-harness",
        electron: "n/a (Chromium harness)",
        chrome: navigator.userAgent,
        node: "n/a",
        userData: "/harness",
        libraryEngine: "sqlite",
        codecs: {},
      }),
      library: {
        snapshot: async () => structuredClone(snapshot),
        addFolder: async () => ({ canceled: true }),
        removeFolder: async () => structuredClone(snapshot),
        rescan: async () => ({ added: 0, updated: 0, removed: 0, errors: [], durationMs: 1 }),
        search: async query => {
          const needle = query.toLowerCase();
          return snapshot.tracks.filter(track =>
            [track.title, track.artist, track.album].some(value => String(value).toLowerCase().includes(needle))
          );
        },
        getTrack: async id => trackById(id),
        setFavorite: async () => undefined,
        recordPlay: async () => undefined,
        onScanProgress: () => () => {},
        onChanged: () => () => {},
      },
      playlists: {
        list: async () => playlists,
        create: async (name, trackIds = []) => {
          const playlist = { id: Date.now(), name, description: "", createdAt: Date.now(), updatedAt: Date.now(), trackCount: trackIds.length, duration: 0, artworkUrl: null };
          playlists = [playlist, ...playlists];
          return playlist;
        },
        rename: async (id, name) => {
          playlists = playlists.map(playlist => (playlist.id === id ? { ...playlist, name } : playlist));
          return playlists.find(playlist => playlist.id === id);
        },
        remove: async id => {
          playlists = playlists.filter(playlist => playlist.id !== id);
        },
        addTracks: async id => playlists.find(playlist => playlist.id === id),
        removeTrack: async id => playlists.find(playlist => playlist.id === id),
        reorder: async id => playlists.find(playlist => playlist.id === id),
        tracks: async id => (playlists.find(playlist => playlist.id === id)?.trackIds ?? []).map(trackById).filter(Boolean),
      },
      settings: {
        get: async () => structuredClone(settings),
        patch: async patch => {
          settings = mergeDeep(settings, patch);
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
          return structuredClone(settings);
        },
        reset: async () => {
          settings = structuredClone(defaultSettings);
          localStorage.removeItem(SETTINGS_KEY);
          return structuredClone(settings);
        },
      },
      lyrics: {
        resolve: async request => resolveLyrics(request),
        translate: async request => ({
          translations: request.lines.map(line => `[translated] ${line}`),
          targetLanguage: request.targetLanguage,
          provider: "harness",
        }),
        romanize: async request => ({ romanizations: request.lines.map(() => null) }),
        saveSidecar: async () => "/harness/lyrics.lrc",
      },
      player: {
        reportState: async () => undefined,
        onCommand: () => () => {},
      },
      app: {
        openExternal: async () => undefined,
        openPath: async () => undefined,
        chooseLyricsFile: async () => null,
        window: async () => undefined,
        isFullScreen: async () => false,
      },
      onMenuAction: () => () => {},
    };
  },
  { snapshot, lyricsByTrack }
);

await page.goto(base, { waitUntil: "networkidle0" });
await page.waitForSelector(".sidebar", { timeout: 20_000 }).catch(async () => {
  console.log("BOOT FAILED. body:", (await page.evaluate(() => document.body.innerText.slice(0, 500))));
  console.log("logs:", logs.slice(0, 20).join("\n"));
  console.log("html:", (await page.content()).slice(0, 800));
  await browser.close();
  server.close();
  process.exit(1);
});
await wait(600);
check("app-boots", (await page.$$(".nav-item")).length >= 6, `${(await page.$$(".sidebar-link")).length} playlists in sidebar`);
await page.screenshot({ path: join(shotDir, "01-home.png") });

/* ---------------------------------------------------------------- playback */

await page.click('aside.sidebar button[title="Songs"]');
await page.waitForSelector('[data-testid="track-row"]');
check("songs-list", (await page.$$('[data-testid="track-row"]')).length === 8, "8 rows from the real scan");

const clickTrackQuiet = async title => {
  await page.evaluate(t => {
    const row = [...document.querySelectorAll('[data-testid="track-row"]')].find(node => node.textContent.includes(t));
    if (!row) throw new Error(`row not found: ${t}`);
    row.click();
  }, title);
};
const clickTrack = clickTrackQuiet;

/* ------------------------------------------------- per-format playback probe */

// Claiming "format support" requires decoding each file through the app's own player, not the
// browser's capability strings. broken.flac is the negative control.
const formatCases = [
  { title: "Fixture FLAC", format: "FLAC", expect: true },
  { title: "Fixture Ogg Vorbis", format: "Ogg Vorbis", expect: true },
  { title: "Fixture Opus", format: "Opus", expect: true },
  { title: "fixture", format: "WAV (PCM)", expect: true },
  { title: "Fixture MP3", format: "MP3", expect: true },
  { title: "Fixture AAC", format: "AAC (M4A)", expect: true },
  { title: "Fixture ALAC", format: "ALAC (M4A)", expect: false, actionable: /ALAC.*FLAC/s },
  { title: "broken", format: "corrupt FLAC", expect: false, actionable: /corrupt/i },
];
let previousError = null;
for (const testCase of formatCases) {
  await page.evaluate(() => window.__harnessErrors?.length);
  await clickTrackQuiet(testCase.title);
  await wait(1400);
  const state = await audioState();
  const banner = await page.$eval(".error-banner", node => node.textContent.trim()).catch(() => null);
  if (banner) previousError = banner;
  const played = !state.paused && state.currentTime > 0.35;
  const actionable = testCase.expect ? true : testCase.actionable.test(banner ?? "");
  check(
    `format-${testCase.format.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    testCase.expect ? played : !played && Boolean(banner) && actionable,
    testCase.expect
      ? `${state.currentTime.toFixed(2)}s, readyState ${state.readyState}, error ${state.error ?? "none"}`
      : `decoder rejected it: ${JSON.stringify(state.error)}, banner ${JSON.stringify(banner)}`
  );
  if (banner) {
    await page.evaluate(() => document.querySelector(".error-banner button")?.click());
    await wait(150);
  }
}

// A file the decoder cannot handle must be labelled in the library, not silently listed as normal.
const alacBadge = await page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-testid="track-row"]')].find(node => node.textContent.includes("Fixture ALAC"));
  return row?.querySelector(".badge.warn")?.textContent?.trim() ?? null;
});
check("alac-labelled-in-library", alacBadge === "no decoder", JSON.stringify(alacBadge));

await clickTrack("Fixture FLAC");
await wait(1500);
let audio = await audioState();
if (!(audio.currentTime > 0.5)) console.log("DEBUG audio", audio, "logs:", logs.slice(-8).join("\n"));
check("playback-starts", audio.currentTime > 0.5 && !audio.paused, `${audio.currentTime.toFixed(2)}s of ${audio.duration.toFixed(2)}s, src=${audio.src.split("/").pop()}`);
check("playback-title", (await page.$eval(".player-title", node => node.textContent.trim())) === "Fixture FLAC", await page.$eval(".player-artist", n => n.textContent.trim()));
const positionLabel = await page.$eval('[data-testid="position"]', node => node.textContent.trim());
check("position-label-updates", positionLabel !== "0:00", `player bar shows ${positionLabel}`);

await page.click('button[aria-label="Pause"]');
await wait(400);
const paused = await audioState();
check("pause", paused.paused, `paused at ${paused.currentTime.toFixed(2)}s`);
await page.keyboard.press("Space");
await wait(600);
const resumed = await audioState();
check("spacebar-resumes", !resumed.paused && resumed.currentTime > paused.currentTime, `${paused.currentTime.toFixed(2)} → ${resumed.currentTime.toFixed(2)}s`);

const seekBox = await page.$eval(".seek", node => {
  const rect = node.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});
await page.mouse.click(seekBox.x + seekBox.width * 0.75, seekBox.y + seekBox.height / 2);
await wait(700);
const seeked = await audioState();
check("seek-by-click", seeked.currentTime > 4.0, `clicked 75% → ${seeked.currentTime.toFixed(2)}s`);

await page.click('button[aria-label="Next track"]');
await wait(900);
const nextTitle = await page.$eval(".player-title", node => node.textContent.trim());
check("next-track", nextTitle !== "Fixture FLAC", `now ${nextTitle}`);
await page.click('button[aria-label="Previous track"]');
await wait(900);
check("previous-track", (await page.$eval(".player-title", node => node.textContent.trim())) === "Fixture FLAC", "back to Fixture FLAC");

await page.click('button[aria-label="Mute"]');
await wait(200);
check("mute", await page.$eval("audio", node => node.muted), "audio element muted");
await page.click('button[aria-label="Unmute"]');

/* ------------------------------------------------------------------ search */

await page.click("#global-search");
await page.type("#global-search", "opus");
await wait(700);
const searchRows = await page.$$eval(".track-row", nodes => nodes.map(node => node.textContent));
console.log("DEBUG search rows", searchRows.length, searchRows.slice(0, 3), "query:", await page.$eval("#global-search", n => n.value), "heading:", await page.$eval(".search-view h1", n => n.textContent).catch(() => null));
check("search", searchRows.some(text => text.includes("Fixture Opus")), `${searchRows.length} result(s)`);
await page.screenshot({ path: join(shotDir, "02-search.png") });

/* ------------------------------------------------------------- browse views */

await page.click('aside.sidebar button[title="Albums"]');
await wait(500);
const albumCards = await page.$$(".media-card");
check("album-browsing", albumCards.length > 0, `${albumCards.length} albums`);
await albumCards[0].click();
await wait(600);
check("album-detail", Boolean(await page.$(".detail-hero")), await page.$eval(".detail-meta h1", n => n.textContent.trim()));
await page.screenshot({ path: join(shotDir, "03-album.png") });

await page.click('aside.sidebar button[title="Artists"]');
await wait(500);
const artistCards = await page.$$(".media-card");
await artistCards[0].click();
await wait(600);
check("artist-detail", Boolean(await page.$(".detail-hero")), await page.$eval(".detail-meta h1", n => n.textContent.trim()));

/* ------------------------------------------------------------------ lyrics */

await page.click('aside.sidebar button[title="Songs"]');
await page.waitForSelector('[data-testid="track-row"]');
await clickTrack("Fixture FLAC");
await wait(900);
await page.click('button[aria-label="Now Playing"]');
await page.waitForSelector(".lyrics-view", { timeout: 15_000 });
await wait(1800);

const navLabels = await page.$$eval("aside.sidebar .nav-item", nodes => nodes.map(node => node.textContent.trim()));
check(
  "page-renamed-now-playing",
  navLabels.includes("Now Playing") && !navLabels.includes("Lyrics") && Boolean(await page.$('.player-right button[aria-label="Now Playing"]')),
  JSON.stringify(navLabels)
);

const lyricState = await page.evaluate(() => {
  const host = document.querySelector("braccato-lyrics");
  const lines = [...(host?.querySelectorAll(".blyrics--line") ?? [])];
  const words = [...(host?.querySelectorAll(".blyrics--word") ?? [])];
  return {
    mounted: Boolean(host),
    lineCount: lines.length,
    activeLine: host?.querySelector(".blyrics--active")?.textContent?.trim() ?? null,
    words: words.length,
    wordDurations: words.map(node => Number(node.dataset.duration ?? -1)),
    syncLabel: document.querySelector('[data-testid="sync-label"]')?.textContent?.trim() ?? null,
    provider: document.querySelector(".dock-status")?.textContent?.trim() ?? null,
  };
});
check("lyrics-tab-renders", lyricState.mounted && lyricState.lineCount === 4, `${lyricState.lineCount} lines, sync=${lyricState.syncLabel}`);
check("lyrics-word-level", lyricState.wordDurations.some(duration => duration > 0), `${lyricState.words} word spans, durations ${JSON.stringify(lyricState.wordDurations.slice(0, 6))}`);
check("lyrics-active-line", Boolean(lyricState.activeLine), JSON.stringify(lyricState.activeLine));
const dock = await page.evaluate(() => {
  const node = document.querySelector('[data-testid="lyrics-dock"]');
  if (!node) return { present: false };
  const rect = node.getBoundingClientRect();
  return {
    present: true,
    visible: rect.bottom <= window.innerHeight + 1 && rect.top > 0,
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    viewport: window.innerHeight,
  };
});
check("lyrics-dock-visible", dock.present && dock.visible, JSON.stringify(dock));

// Fullscreen buttons on the page: the top-of-page pill is gone and the source popover has none, so the
// bottom dock button is the only one left.
const fullscreenButtonsOn = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".lyrics-view button")]
      .filter(node => /fullscreen/i.test(`${node.title} ${node.getAttribute("aria-label") ?? ""} ${node.textContent}`))
      .map(node => node.title || node.textContent.trim())
  );
const normalFullscreen = await fullscreenButtonsOn();
check("top-fullscreen-removed", !(await page.$(".sync-pill")) && normalFullscreen.length === 1, JSON.stringify(normalFullscreen));
check("bottom-fullscreen-only", normalFullscreen[0] === "Fullscreen lyrics", JSON.stringify(normalFullscreen));

await page.click('button[title="Lyrics source"]');
await wait(300);
const popoverFullscreen = await page.evaluate(() =>
  [...document.querySelectorAll(".dock-sources button")].filter(node => /fullscreen/i.test(node.textContent + node.title)).length
);
const popoverRows = await page.$$eval(".dock-sources .source-row", nodes => nodes.length);
check("no-fullscreen-in-source-popover", popoverFullscreen === 0 && popoverRows > 0, `${popoverRows} source rows, ${popoverFullscreen} fullscreen buttons`);
await page.click('button[title="Lyrics source"]');
await wait(200);

// Pause so the 6-second fixture cannot run past the end while the shader checks run.
await page.evaluate(() => document.querySelector("audio").pause());
await wait(250);

const shaderPixels = await page.evaluate(async () => {
  const canvas = document.querySelector(".kawarp-canvas");
  if (!canvas) return { mounted: false };
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const sample = () => {
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };
  const a = sample();
  await new Promise(r => setTimeout(r, 800));
  const b = sample();
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += a[i] + a[i + 1] + a[i + 2];
    if (Math.abs(a[i] - b[i]) > 6) changed += 1;
  }
  return { mounted: true, width: canvas.width, height: canvas.height, mean: sum / (a.length / 4), changedRatio: changed / (a.length / 4) };
});
const screenshot = await page.screenshot({ clip: { x: 0, y: 0, width: 1480, height: 700 } });
const png = PNG.sync.read(screenshot);
let screenshotSum = 0;
let screenshotMax = 0;
for (let i = 0; i < png.data.length; i += 4) {
  const value = png.data[i] + png.data[i + 1] + png.data[i + 2];
  screenshotSum += value;
  screenshotMax = Math.max(screenshotMax, value);
}
const visibleMean = screenshotSum / (png.width * png.height);
check(
  "lyrics-background-visible",
  visibleMean > 12 && screenshotMax > 90,
  `screenshot mean ${visibleMean.toFixed(1)}, peak ${screenshotMax}`
);
const shaderDom = await page.evaluate(() => ({
  bg: document.querySelector(".kawarp-bg")?.innerHTML?.slice(0, 300),
  canvasSize: (() => { const c = document.querySelector(".kawarp-canvas"); return c ? `${c.width}x${c.height} css ${c.clientWidth}x${c.clientHeight}` : null; })(),
  settings: document.querySelector(".lyrics-view")?.className,
}));
console.log("DEBUG shader dom", shaderDom);
if ((shaderPixels.mean ?? 0) < 8) console.log("DEBUG logs tail:", logs.slice(-12).join("\n"));
check("shader-behind-lyrics", shaderPixels.mounted && shaderPixels.mean > 8, `${shaderPixels.width}x${shaderPixels.height}, mean ${(shaderPixels.mean ?? 0).toFixed(1)}`);
check("shader-animated", (shaderPixels.changedRatio ?? 0) > 0.02, `${(100 * (shaderPixels.changedRatio ?? 0)).toFixed(1)}% pixels changed`);
await page.screenshot({ path: join(shotDir, "04-lyrics.png") });

// Seek while the lyrics tab is open: the highlight must follow the real clock. Seek back first so
// the 6-second fixture cannot run out mid-assertion.
const seekAndRead = async seconds => {
  await page.evaluate(value => {
    const audio = document.querySelector("audio");
    audio.currentTime = value;
  }, seconds);
  await wait(650);
  return page.evaluate(() => ({
    active: document.querySelector(".blyrics--active")?.textContent?.trim() ?? null,
    time: document.querySelector("audio")?.currentTime ?? -1,
  }));
};
const atOne = await seekAndRead(1.0);
const atFive = await seekAndRead(4.9);
const pausedSeek = (await audioState()).paused;
console.log("DEBUG paused-seek", pausedSeek, JSON.stringify({ atOne, atFive }));
check("lyrics-follow-seek", (atOne.active ?? "").includes("Word") && (atFive.active ?? "").includes("Last"), `1.0s → ${JSON.stringify(atOne.active)}, 4.9s → ${JSON.stringify(atFive.active)}`);
await page.evaluate(() => document.querySelector("audio").pause());

/* ------------------------------------------------------- unified fullscreen */

// Fullscreen controls fade after 3 s without activity and then ignore the pointer, so a click first
// moves the pointer (which reveals them) and waits out the fade-in before clicking.
const wakeClick = async selector => {
  await page.mouse.move(640, 420);
  await wait(350);
  await page.click(selector);
};

await wakeClick('button[title="Fullscreen lyrics"]');
await wait(700);
check("fullscreen-lyrics", Boolean(await page.$(".lyrics-view.is-fullscreen")), "immersive mode");

// Repeat-one keeps this 6-second fixture on the same track, so auto-advance cannot swap in a track
// without lyrics while the checks below run. It is switched back off before the run continues.
await wakeClick('[data-testid="fullscreen-controls"] button[aria-label="Repeat: off"]');
await wait(150);
await wakeClick('[data-testid="fullscreen-controls"] button[aria-label="Repeat: all"]');
await wait(150);
check("fullscreen-repeat-control", Boolean(await page.$('[data-testid="fullscreen-controls"] button[aria-label="Repeat: one"]')), "cycled off → all → one");

const fsButtons = await fullscreenButtonsOn();
check("single-fullscreen-button-in-fullscreen", fsButtons.length === 1, JSON.stringify(fsButtons));

const fsParts = await page.evaluate(() => {
  const root = document.querySelector('[data-testid="fullscreen-controls"]');
  const has = selector => Boolean(root?.querySelector(selector));
  return {
    present: Boolean(root),
    transport: has(".transport .play-button") && has('.transport button[aria-label="Next track"]'),
    seek: has(".seek-row input.seek"),
    volume: has(".volume-group input.volume"),
    favourite: has('button[aria-label="Add to favourites"], button[aria-label="Remove from favourites"]'),
    lyricsToggle: has('[data-testid="fullscreen-lyrics-toggle"]'),
    queue: has('button[aria-label="Queue"]'),
    lyricsDock: Boolean(document.querySelector('[data-testid="lyrics-dock"]')),
    playerBarHidden: !document.querySelector('[data-testid="player-bar"]'),
  };
});
check(
  "fullscreen-audio-and-lyrics-controls",
  fsParts.present && fsParts.transport && fsParts.seek && fsParts.volume && fsParts.lyricsToggle && fsParts.queue && fsParts.lyricsDock && fsParts.playerBarHidden,
  JSON.stringify(fsParts)
);
await page.screenshot({ path: join(shotDir, "05-lyrics-fullscreen.png") });

// Start playback from the fullscreen transport, so the controls and shader checks run while audio plays.
await page.evaluate(() => {
  document.querySelector("audio").currentTime = 0.5;
});
await wakeClick('[data-testid="fullscreen-controls"] .play-button');
await wait(900);
const fsPlaying = await audioState();
check("fullscreen-play-button", !fsPlaying.paused && fsPlaying.currentTime > 0.5, `${fsPlaying.currentTime.toFixed(2)}s`);

// The control backdrop must show the shader: not an opaque black fill, and changing frame to frame.
const glassStyle = await page.evaluate(() => {
  const node = document.querySelector('[data-testid="fullscreen-controls"]');
  const style = getComputedStyle(node);
  const match = /rgba?\(([^)]+)\)/.exec(style.backgroundColor);
  const alpha = match ? Number((match[1].split(",")[3] ?? "1").trim()) : 1;
  return { background: style.backgroundColor, alpha, backdrop: style.backdropFilter };
});
check("controls-not-black-fill", glassStyle.alpha <= 0.35 && /blur/.test(glassStyle.backdrop), JSON.stringify(glassStyle));

const regionSamples = async selector => {
  const box = await page.$eval(selector, node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const first = PNG.sync.read(await page.screenshot({ clip: box }));
  await wait(800);
  const second = PNG.sync.read(await page.screenshot({ clip: box }));
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < first.data.length; i += 4) {
    const a = first.data[i] + first.data[i + 1] + first.data[i + 2];
    const b = second.data[i] + second.data[i + 1] + second.data[i + 2];
    sum += a;
    if (Math.abs(a - b) > 12) changed += 1;
  }
  return { mean: sum / (first.width * first.height), changedRatio: changed / (first.width * first.height) };
};
// Animation through the backdrop: the glass must carry the moving shader, and an opaque black fill
// (the old treatment) must not. Both are measured on the same region, frame to frame.
const motionOf = async box => {
  const first = PNG.sync.read(await page.screenshot({ clip: box }));
  await wait(800);
  const second = PNG.sync.read(await page.screenshot({ clip: box }));
  let sum = 0;
  let diffSum = 0;
  let moved = 0;
  const pixels = first.width * first.height;
  for (let i = 0; i < first.data.length; i += 4) {
    const a = first.data[i] + first.data[i + 1] + first.data[i + 2];
    const b = second.data[i] + second.data[i + 1] + second.data[i + 2];
    sum += a;
    diffSum += Math.abs(a - b);
    if (Math.abs(a - b) > 3) moved += 1;
  }
  return { mean: sum / pixels / 3, avgDiff: diffSum / pixels, movedRatio: moved / pixels };
};
const fsBox = await page.$eval('[data-testid="fullscreen-controls"]', node => {
  const rect = node.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});
// Only the backdrop is measured: the controls' own children (seek time, progress) move with playback.
const hideContents = hidden => page.evaluate(value => {
  const node = document.querySelector('[data-testid="fullscreen-controls"]');
  for (const child of node.children) child.style.visibility = value ? "hidden" : "";
}, hidden);
await hideContents(true);
const glassMotion = await motionOf(fsBox);
await page.evaluate(() => {
  const node = document.querySelector('[data-testid="fullscreen-controls"]');
  node.style.background = "#000";
  node.style.backdropFilter = "none";
});
const blackMotion = await motionOf(fsBox);
await page.evaluate(() => {
  const node = document.querySelector('[data-testid="fullscreen-controls"]');
  node.style.background = "";
  node.style.backdropFilter = "";
});
await hideContents(false);
check(
  "controls-show-shader-through-glass",
  glassMotion.mean > 20 && glassMotion.avgDiff > 2 && glassMotion.avgDiff - blackMotion.avgDiff > 2,
  `glass: mean ${glassMotion.mean.toFixed(1)}/255, avg frame change ${glassMotion.avgDiff.toFixed(2)}, ${(100 * glassMotion.movedRatio).toFixed(1)}% pixels moved; black fill baseline: avg change ${blackMotion.avgDiff.toFixed(2)}`
);

// Lyrics on/off: hiding must not stop playback, reset the position, or break sync.
const lyricsVisibility = () =>
  page.evaluate(() => ({
    bodyHidden: document.querySelector(".lyrics-body")?.classList.contains("is-hidden") ?? null,
    visibility: document.querySelector("braccato-lyrics") ? getComputedStyle(document.querySelector("braccato-lyrics")).visibility : null,
    opacity: getComputedStyle(document.querySelector(".lyrics-body")).opacity,
    pressed: document.querySelector('[data-testid="fullscreen-lyrics-toggle"]')?.getAttribute("aria-pressed") ?? null,
    stored: JSON.parse(localStorage.getItem("cadence.harness.settings.v1") ?? "{}")?.lyrics?.showLyricsInFullscreen ?? null,
  }));

await page.evaluate(() => {
  document.querySelector("audio").currentTime = 0.5;
});
await wait(300);
const beforeHide = await audioState();
await wakeClick('[data-testid="fullscreen-lyrics-toggle"]');
await wait(900);
const hiddenState = await lyricsVisibility();
const afterHide = await audioState();
check(
  "lyrics-toggle-hides",
  hiddenState.bodyHidden === true && hiddenState.visibility === "hidden" && hiddenState.opacity === "0" && hiddenState.pressed === "false" && hiddenState.stored === false,
  JSON.stringify(hiddenState)
);
check(
  "lyrics-hide-keeps-playback",
  !afterHide.paused && afterHide.currentTime > beforeHide.currentTime && afterHide.currentTime - beforeHide.currentTime < 2.5,
  `${beforeHide.currentTime.toFixed(2)}s → ${afterHide.currentTime.toFixed(2)}s, paused=${afterHide.paused}`
);
await page.screenshot({ path: join(shotDir, "05b-fullscreen-lyrics-off.png") });

// Transport still works while lyrics are hidden.
await page.evaluate(() => {
  document.querySelector("audio").currentTime = 0.5;
});
await wait(200);
await wakeClick('[data-testid="fullscreen-controls"] .play-button');
await wait(300);
const pausedWhileHidden = await audioState();
await wakeClick('[data-testid="fullscreen-controls"] .play-button');
await wait(500);
const resumedWhileHidden = await audioState();
check(
  "transport-works-with-lyrics-hidden",
  pausedWhileHidden.paused && !resumedWhileHidden.paused && resumedWhileHidden.currentTime > pausedWhileHidden.currentTime,
  `paused ${pausedWhileHidden.paused}, resumed ${resumedWhileHidden.paused} at ${resumedWhileHidden.currentTime.toFixed(2)}s`
);

await wakeClick('[data-testid="fullscreen-lyrics-toggle"]');
await wait(700);
const shownState = await lyricsVisibility();
check(
  "lyrics-toggle-shows",
  shownState.bodyHidden === false && shownState.visibility === "visible" && shownState.pressed === "true" && shownState.stored === true,
  JSON.stringify(shownState)
);

// Sync after showing again: pause, seek, and read the highlighted line; then resume on the same clock.
await page.evaluate(() => document.querySelector("audio").pause());
await wait(250);
// The highlight may take a few frames to settle after a jump, so poll for the expected line (up to 3 s).
const settleActive = async (seconds, expected) => {
  await page.evaluate(value => {
    document.querySelector("audio").currentTime = value;
  }, seconds);
  let active = null;
  for (let waited = 0; waited < 3000; waited += 150) {
    await wait(150);
    active = await page.evaluate(() => document.querySelector(".blyrics--active")?.textContent?.trim() ?? null);
    if (active && active.includes(expected)) break;
  }
  return active;
};
const activeAt49 = await settleActive(4.9, "Last");
const activeAt10 = await settleActive(1.0, "Word");
check(
  "lyrics-sync-after-toggle",
  (activeAt49 ?? "").includes("Last") && (activeAt10 ?? "").includes("Word"),
  `1.0s → ${JSON.stringify(activeAt10)}, 4.9s → ${JSON.stringify(activeAt49)}; header ${await page.$eval(".lyrics-heading h1", n => n.textContent)}, ${await page.$$eval("braccato-lyrics .blyrics--line", n => n.length)} lines`
);
await wakeClick('[data-testid="fullscreen-controls"] .play-button');
await wait(900);
const clockAfterResume = await audioState();
check("clock-continues-after-toggle", !clockAfterResume.paused && clockAfterResume.currentTime > 1.0, `${clockAfterResume.currentTime.toFixed(2)}s`);

/* ----------------------------------------------------- fullscreen auto-hide */

// Computed state of the fullscreen controls. Read after the 250 ms fade, so the values are settled.
const controlState = () =>
  page.evaluate(() => {
    const node = document.querySelector('[data-testid="fullscreen-controls"]');
    const style = node ? getComputedStyle(node) : null;
    return {
      idle: node?.classList.contains("is-idle") ?? null,
      opacity: style ? Number(style.opacity) : null,
      visibility: style?.visibility ?? null,
      pointerEvents: style?.pointerEvents ?? null,
      dockIdle: document.querySelector('[data-testid="lyrics-dock"]')?.classList.contains("is-idle") ?? null,
    };
  });
// True when the play button's centre is hit-tested onto the control bar (i.e. the controls take input).
const hitsControls = () =>
  page.evaluate(() => {
    const button = document.querySelector('[data-testid="fullscreen-controls"] .play-button');
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return Boolean(hit && button.contains(hit));
  });
const movePointer = async (x, y) => {
  await page.mouse.move(x, y);
};
// The fade is a 250 ms CSS transition; under shader load the frames can lag, so poll until it settles.
const settleOpacity = async target => {
  let state = await controlState();
  for (let waited = 0; waited < 2000 && Math.abs((state.opacity ?? -1) - target) > 0.02; waited += 100) {
    await wait(100);
    state = await controlState();
  }
  return state;
};

// Visible while fullscreen is active and the pointer has just moved.
await movePointer(640, 420);
await wait(350);
const shownNow = await controlState();
const shownHit = await hitsControls();
check(
  "auto-hide-visible-while-active",
  shownNow.idle === false && shownNow.opacity === 1 && shownNow.visibility === "visible" && shownNow.pointerEvents !== "none" && shownHit,
  JSON.stringify({ ...shownNow, hitsControls: shownHit })
);

// Hidden 3 s after the last activity: faded out, not hit-testable, dock too, and playback keeps running.
const beforeFade = await audioState();
await wait(4000);
const hiddenNow = await controlState();
const hiddenHit = await hitsControls();
const afterFade = await audioState();
check(
  "auto-hide-fades-after-3s",
  hiddenNow.idle === true && hiddenNow.opacity === 0 && hiddenNow.visibility === "hidden" && hiddenNow.pointerEvents === "none" && hiddenNow.dockIdle === true && !hiddenHit,
  JSON.stringify({ ...hiddenNow, hitsControls: hiddenHit })
);
const fadeDelta = afterFade.currentTime - beforeFade.currentTime;
const fadeAdvance = fadeDelta < 0 ? fadeDelta + afterFade.duration : fadeDelta; // repeat-one can wrap the 6 s fixture
check(
  "auto-hide-playback-continues",
  !afterFade.paused && fadeAdvance > 3.0 && fadeAdvance < 5.0,
  `advanced ${fadeAdvance.toFixed(2)}s over the hidden interval, paused=${afterFade.paused}`
);
// The shader keeps moving behind the hidden controls: measure the bottom-left corner, which is clear of lyrics.
const shaderStrip = { x: 0, y: 760, width: 260, height: 140 };
const hiddenShader = await motionOf(shaderStrip);
check("auto-hide-shader-keeps-rendering", hiddenShader.avgDiff > 0.5, `avg frame change ${hiddenShader.avgDiff.toFixed(2)} over the hidden control area`);
await page.screenshot({ path: join(shotDir, "05c-fullscreen-auto-hidden.png") });

// Reveal on pointer movement. The class flips at once; the opacity fade takes 250 ms.
await page.mouse.move(300, 300);
await wait(60);
const revealImmediate = await controlState();
const revealed = await settleOpacity(1);
const revealedHit = await hitsControls();
check(
  "auto-hide-reveals-on-mouse",
  revealImmediate.idle === false && revealed.idle === false && revealed.opacity > 0.95 && revealedHit,
  `class at 60 ms: idle=${revealImmediate.idle}; settled opacity ${revealed.opacity}, hit=${revealedHit}`
);

// Countdown restarts: a move 2 s after the reveal restarts the 3 s count, so the controls are still
// shown 4 s after the reveal, and they hide 3 s after that last move.
await wait(1700);
await page.mouse.move(320, 320);
await wait(2000);
const restarted = await controlState();
await wait(1600);
const restartedLater = await controlState();
check(
  "auto-hide-countdown-restarts",
  restarted.idle === false && restarted.opacity === 1 && restartedLater.idle === true,
  `2 s after the last move: idle=${restarted.idle}; 3.6 s after: idle=${restartedLater.idle}`
);

// Keyboard input reveals the controls too.
const beforeKey = await controlState();
await page.keyboard.press("Shift");
const keyRevealed = await settleOpacity(1);
check(
  "auto-hide-reveals-on-keyboard",
  beforeKey.idle === true && keyRevealed.idle === false && keyRevealed.opacity > 0.95,
  `before key: idle=${beforeKey.idle}; after key: idle=${keyRevealed.idle}, opacity ${keyRevealed.opacity}`
);

// A popover in the dock pins the controls open, even well past the 3 s countdown.
await wakeClick('button[title="Lyrics source"]');
await wait(3800);
const pinnedOpen = await controlState();
const sourcesOpen = Boolean(await page.$(".dock-sources"));
check(
  "auto-hide-pinned-by-popover",
  sourcesOpen && pinnedOpen.idle === false && pinnedOpen.opacity === 1 && pinnedOpen.dockIdle === false,
  `popover open=${sourcesOpen}; idle=${pinnedOpen.idle}, dock idle=${pinnedOpen.dockIdle}`
);
await wakeClick('button[title="Lyrics source"]');
await wait(3800);
const popoverClosed = await controlState();
check(
  "auto-hide-resumes-after-popover",
  !(await page.$(".dock-sources")) && popoverClosed.idle === true && popoverClosed.dockIdle === true,
  `after close: idle=${popoverClosed.idle}`
);

// Exit fullscreen while the controls are hidden. The Escape keypress reveals them and then leaves.
await page.keyboard.press("Escape");
await wait(600);
const exitState = () =>
  page.evaluate(() => {
    const dock = document.querySelector('[data-testid="lyrics-dock"]');
    const style = dock ? getComputedStyle(dock) : null;
    return {
      fullscreen: Boolean(document.querySelector(".lyrics-view.is-fullscreen")),
      controls: Boolean(document.querySelector('[data-testid="fullscreen-controls"]')),
      dock: Boolean(dock),
      dockIdle: dock?.classList.contains("is-idle") ?? null,
      opacity: style ? Number(style.opacity) : null,
      visibility: style?.visibility ?? null,
    };
  });
// The dock fades back in over the same 250 ms transition, so poll (up to 3 s) for the settled state.
const settledExit = async () => {
  let state = await exitState();
  for (let waited = 0; waited < 3000 && Math.abs((state.opacity ?? -1) - 1) > 0.02; waited += 100) {
    await wait(100);
    state = await exitState();
  }
  return state;
};
const normalNow = await settledExit();
await wait(3800);
const normalLater = await exitState();
check(
  "auto-hide-exit-leaves-page-visible",
  !normalNow.fullscreen && !normalNow.controls && normalNow.dock && normalNow.dockIdle === false && normalNow.opacity === 1 && normalNow.visibility === "visible" && normalLater.dockIdle === false && normalLater.opacity === 1,
  JSON.stringify({ now: normalNow, after4s: normalLater })
);

// Re-enter fullscreen for the checks below: the controls start visible again.
await wakeClick('button[title="Fullscreen lyrics"]');
await wait(700);
const reentered = await controlState();
check("auto-hide-reentry-visible", reentered.idle === false && reentered.opacity === 1, JSON.stringify(reentered));

// The queue opens from fullscreen and must sit above the fullscreen view.
await wakeClick('[data-testid="fullscreen-controls"] button[aria-label="Queue"]');
await wait(400);
const queueLayer = await page.evaluate(() => {
  const panel = document.querySelector(".queue-panel");
  if (!panel) return null;
  const rect = panel.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return { topmost: panel.contains(hit), bottomGap: Math.round(window.innerHeight - rect.bottom) };
});
check("queue-opens-over-fullscreen", queueLayer?.topmost === true && queueLayer.bottomGap === 0, JSON.stringify(queueLayer));
await wakeClick('.queue-panel button[aria-label="Close queue"]');
await wait(200);

// Lyrics stay hidden only in fullscreen: switch them off, leave fullscreen, and the normal page still shows them.
await wakeClick('[data-testid="fullscreen-lyrics-toggle"]');
await wait(300);
await page.keyboard.press("Escape");
await wait(500);
const normalAfterFullscreen = await lyricsVisibility();
check(
  "fullscreen-exit",
  !(await page.$(".lyrics-view.is-fullscreen")) && !(await page.$('[data-testid="fullscreen-controls"]')),
  "escaped"
);
check(
  "normal-page-ignores-lyrics-toggle",
  normalAfterFullscreen.bodyHidden === false && normalAfterFullscreen.visibility === "visible" && normalAfterFullscreen.stored === false,
  JSON.stringify(normalAfterFullscreen)
);

// Restore the defaults (lyrics on, repeat off) for the rest of the run.
await wakeClick('button[title="Fullscreen lyrics"]');
await wait(500);
await wakeClick('[data-testid="fullscreen-lyrics-toggle"]');
await wait(300);
await wakeClick('[data-testid="fullscreen-controls"] button[aria-label="Repeat: one"]');
await wait(200);
await page.keyboard.press("Escape");
await wait(400);

/* ----------------------------------------------------------- now playing */

await page.click('button[aria-label="Now playing"]').catch(async () => {
  const buttons = await page.$$(".player-right .icon-button");
  await buttons[buttons.length - 1].click();
});
await wait(900);
check("now-playing-view", Boolean(await page.$(".now-playing")), await page.$eval(".now-playing .np-text h1", n => n.textContent.trim()));
await page.screenshot({ path: join(shotDir, "06-now-playing.png") });
await page.keyboard.press("Escape");
await wait(400);

/* -------------------------------------------------------------- settings */

await page.click('aside.sidebar button[title="Settings"]');
await page.waitForSelector('[data-testid="settings-view"]');
await wait(500);
const settingsTabs = await page.$$eval(".settings-tabs button", buttons => buttons.map(button => button.textContent?.trim()));
const shaderSection = await page.$('[data-testid="settings-shaders"]');
const lyricsSection = await page.$('[data-testid="settings-lyrics"]');
check(
  "settings-tabs-consolidated",
  settingsTabs.length === 4 && settingsTabs.includes("Appearance") && !settingsTabs.includes("Lyrics") && !settingsTabs.includes("Shaders"),
  `${settingsTabs.join(", ")}`
);
check("settings-appearance-subsections", Boolean(shaderSection) && Boolean(lyricsSection), "lyrics and shader controls in Appearance");
await page.screenshot({ path: join(shotDir, "07-settings.png") });

await page.evaluate(() => {
  const playbackTab = [...document.querySelectorAll(".settings-tabs button")].find(node => /playback/i.test(node.textContent ?? ""));
  playbackTab?.click();
});
await wait(300);
const playbackAppearanceControls = await page.evaluate(() => ({
  appearanceHeader: [...document.querySelectorAll("[data-testid=\"settings-playback\"] h2, [data-testid=\"settings-playback\"] h3")]
    .some(node => /appearance/i.test(node.textContent ?? "")),
  fontSelect: Boolean(document.querySelector('[data-testid="settings-playback"] [data-testid="font-select"]')),
}));
check("playback-appearance-removed", !playbackAppearanceControls.appearanceHeader && !playbackAppearanceControls.fontSelect, JSON.stringify(playbackAppearanceControls));
await page.evaluate(() => {
  const appearanceTab = [...document.querySelectorAll(".settings-tabs button")].find(node => /appearance/i.test(node.textContent ?? ""));
  appearanceTab?.click();
});
await wait(400);
const persisted = await page.evaluate(async () => {
  const slider = document.querySelector('[data-testid="settings-lyrics"] input[type="range"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(slider, "2.4");
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  return {
    settings: await window.cadence.settings.get(),
    stored: localStorage.getItem("cadence.harness.settings.v1"),
  };
});
check("settings-persist-write", JSON.parse(persisted.stored ?? "{}")?.lyrics?.fontSizeRem === 2.4, `fontSizeRem=${persisted.settings?.lyrics?.fontSizeRem}`);

const reloadMark = logs.length;
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector(".sidebar", { timeout: 15_000 }).catch(async () => {
  console.log("RELOAD BOOT FAILED:", (await page.evaluate(() => document.body.innerText.slice(0, 300))));
  console.log("url:", page.url());
  console.log("html:", (await page.content()).slice(0, 600));
  console.log("logs since reload:", logs.slice(reloadMark).join("\n"));
  await page.screenshot({ path: join(shotDir, "reload-failure.png") });
  await browser.close();
  server.close();
  process.exit(1);
});
await page.click('aside.sidebar button[title="Settings"]');
await page.waitForSelector('[data-testid="settings-view"]');
await wait(600);
const fontSize = await page.evaluate(() => {
  const section = document.querySelector('[data-testid="settings-lyrics"]');
  const slider = section?.querySelector('input[type="range"]');
  return {
    stored: JSON.parse(localStorage.getItem("cadence.harness.settings.v1") ?? "{}")?.lyrics?.fontSizeRem,
    slider: slider?.value ?? null,
    output: section?.querySelector("output")?.textContent ?? null,
  };
});
check("settings-survive-reload", fontSize.stored === 2.4 && fontSize.slider === "2.4", `stored=${fontSize.stored}, slider=${fontSize.slider}, shown=${fontSize.output}`);

/* --------------------------------------------------------------- the end */

writeFileSync(join(harnessDir, "app-console.log"), logs.join("\n"));
const errors = logs.filter(line => line.startsWith("[pageerror]") || line.startsWith("[error]"));
console.log(`\nconsole: ${logs.length} lines, ${errors.length} errors`);
if (errors.length) console.log(errors.slice(0, 10).join("\n"));
writeFileSync(join(harnessDir, "app-results.json"), JSON.stringify({ results, errors, logs }, null, 2));

if (missing.length) console.log("missing assets:", [...new Set(missing)].slice(0, 10));
const failures = Object.entries(results).filter(([, result]) => !result.value);
console.log(`${Object.keys(results).length - failures.length}/${Object.keys(results).length} checks passed`);
await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
