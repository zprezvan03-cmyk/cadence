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
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";
import { PNG } from "pngjs";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
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
  [ids.flac]: { text: RICH_LRC, source: "local-rich", provider: "Local TTML/QRC" },
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

// Decode Tester fixture: a real FLAC cut to 70% of its bytes — enough for the demuxer to open and
// the start to decode, so the failure only shows towards the end of the stream. Served from the
// harness work dir so the library scanner (which only walks the formats dir) never indexes it.
const decodeAudioDir = join(harnessDir, "decode-audio");
mkdirSync(decodeAudioDir, { recursive: true });
{
  const fullFlac = readFileSync(join(audioDir, "fixture.flac"));
  writeFileSync(join(decodeAudioDir, "truncated.flac"), fullFlac.subarray(0, Math.floor(fullFlac.length * 0.7)));
}

const missing = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const decode = value => decodeURIComponent(value);
  let file = null;
  if (url.pathname.startsWith("/audio/")) {
    const name = decode(url.pathname.slice(7));
    const decodeFixture = join(decodeAudioDir, name);
    file = existsSync(decodeFixture) ? decodeFixture : join(audioDir, name);
  }
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

// `@sparticuz/chromium` only unpacks its bundled NSS/NSPR libraries on Amazon Linux; elsewhere the
// browser dies with `libnspr4.so: cannot open shared object file`. Unpack them and point the
// dynamic loader at them before launching.
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
    // Mirrors the Windows shell: undecorated window, so the renderer draws the title bar.
    window.__chrome = { undecorated: true, maximized: false, fullscreen: false, focused: true };
    window.__chromeListeners = new Set();
    window.__cadenceWindowActions = [];
    const SETTINGS_KEY = "cadence.harness.settings.v1";
    const defaultSettings = {
      version: 1,
      playback: { volume: 0.85, muted: false, shuffle: false, repeat: "off", playbackRate: 1, resumeOnLaunch: false },
      appearance: { accent: "#ff3d71", reduceMotion: false, compactSidebar: false, blurArtwork: true },
      lyrics: {
        providerOrder: ["local-rich", "blyrics-richsynced", "unison-richsynced", "binimum-richsynced", "blyrics-wordsynced", "local-lrc", "blyrics-line", "unison-synced", "blyrics-synced", "qq-line", "lrclib-synced", "lrclib-plain", "embedded-tag"],
        autoFetch: true,
        offsetMs: 0,
        translationLanguage: "en",
        romanization: false,
        themeId: "default",
        customThemeCss: "",
        fontSizeRem: 1.6,
        translationFontSizePx: 32,
        romanizationFontSizePx: 26,
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

    // Decode Tester harness state: recorded native calls plus synthetic truncated/missing tracks
    // that can be appended after every track-count-sensitive check has already run.
    window.__decodeCalls = { delete: [], export: [] };
    window.__alacPrepareCalls = [];
    window.__alacPrepareFailure = false;
    window.__openedPaths = [];
    window.__decodeDeleteAllSucceeds = false;
    window.__libraryChangedListeners = new Set();
    window.__addDecodeFixtureTracks = () => {
      if (snapshot.tracks.some(track => track.title === "Truncated FLAC")) return;
      const base = snapshot.tracks.find(track => track.title === "Fixture FLAC");
      const maxId = Math.max(...snapshot.tracks.map(track => track.id));
      const dir = base.path.slice(0, Math.max(base.path.lastIndexOf("/"), base.path.lastIndexOf("\\")) + 1);
      snapshot.tracks.push(
        {
          ...structuredClone(base),
          id: maxId + 1,
          title: "Truncated FLAC",
          path: `${dir}truncated.flac`,
          streamUrl: "/audio/truncated.flac",
          codec: "FLAC",
          duration: base.duration,
        },
        {
          ...structuredClone(base),
          id: maxId + 2,
          title: "Missing File",
          path: `${dir}missing-file.flac`,
          streamUrl: "/audio/missing-file.flac",
          codec: "FLAC",
          duration: base.duration,
        }
      );
      snapshot.counts.tracks = snapshot.tracks.length;
      for (const listener of window.__libraryChangedListeners) listener();
    };

    const resolveLyrics = request => {
      const entry = lyricsByTrack[request?.trackId];
      if (!entry) {
        return {
          candidates: [],
          providerStatus: [
            { provider: "local-rich", status: "miss" },
            { provider: "local-lrc", status: "miss" },
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
        version: "0.2.0",
        platform: "browser-harness",
        tauri: "2.12 (Chromium harness)",
        electron: "",
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
        onChanged: listener => {
          window.__libraryChangedListeners.add(listener);
          return () => window.__libraryChangedListeners.delete(listener);
        },
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
        search: async () => ({ results: [], providerStatus: [], cached: false }),
        youtubeMetadata: async () => ({
          ok: false,
          reason: "error",
          detail: "YouTube metadata is unavailable in the harness",
        }),
        translate: async request => ({
          translations: request.lines.map(line => `[translated] ${line}`),
          targetLanguage: request.targetLanguage,
          provider: "harness",
        }),
        romanize: async request => ({ romanizations: request.lines.map(line => `[romanized] ${line}`) }),
        saveSidecar: async () => "/harness/lyrics.lrc",
        // Mirrors the real contract: resolves with what was removed, rejects when the write fails.
        clearCache: async () => {
          const removedEntries = Object.keys(lyricsByTrack).length;
          window.__clearCacheCalls = (window.__clearCacheCalls ?? 0) + 1;
          return { removedEntries };
        },
        // The in-page harness keeps lyrics in memory only; Settings -> Cache stays empty here.
        listCache: async () => ({
          entries: [],
          stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 },
        }),
        getCacheEntry: async () => null,
        removeCacheEntry: async () => ({
          removed: false,
          stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 },
        }),
        cacheChosenFile: async () => undefined,
        rememberSelection: async () => undefined,
      },
      player: {
        // The browser-only harness cannot call Rust, so hand off the matching lossless PCM fixture.
        // Native Symphonia decoding is covered separately by src-tauri/src/alac.rs tests.
        prepareAlacSource: async path => {
          window.__alacPrepareCalls.push(path);
          if (window.__alacPrepareFailure) throw new Error("fixture ALAC decoder failure");
          return "/audio/fixture.wav";
        },
        reportState: async () => undefined,
        onCommand: () => () => {},
      },
      decodeTester: {
        // Mirrors the Rust contract: one outcome per path; deleted tracks leave the library,
        // failures (here: the already-missing file) are reported, never thrown for the batch.
        deleteFiles: async paths => {
          window.__decodeCalls.delete.push([...paths]);
          const outcomes = paths.map(path =>
            !window.__decodeDeleteAllSucceeds && path.includes("missing-file")
              ? { path, deleted: false, error: "The system cannot find the file specified. (os error 2)" }
              : { path, deleted: true, error: null }
          );
          const deleted = new Set(outcomes.filter(outcome => outcome.deleted).map(outcome => outcome.path));
          snapshot.tracks = snapshot.tracks.filter(track => !deleted.has(track.path));
          snapshot.counts.tracks = snapshot.tracks.length;
          for (const listener of window.__libraryChangedListeners) listener();
          return outcomes;
        },
        exportFileList: async paths => {
          window.__decodeCalls.export.push([...paths]);
          return { canceled: false, path: "/harness/cadence-decode-problems.txt" };
        },
      },
      app: {
        openExternal: async () => undefined,
        openPath: async path => {
          window.__openedPaths.push(path);
        },
        chooseLyricsFile: async () => null,
        window: async action => {
          window.__cadenceWindowActions.push(action);
          if (action === "maximize") window.__chrome.maximized = true;
          if (action === "restore") window.__chrome.maximized = false;
          if (action === "fullscreen") window.__chrome.fullscreen = true;
          if (action === "exitFullscreen") window.__chrome.fullscreen = false;
          for (const listener of window.__chromeListeners) listener({ ...window.__chrome });
        },
        isFullScreen: async () => window.__chrome.fullscreen,
        initialWindowChrome: { ...window.__chrome },
        windowChrome: async () => ({ ...window.__chrome }),
        onWindowChromeChange: listener => {
          window.__chromeListeners.add(listener);
          return () => window.__chromeListeners.delete(listener);
        },
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

/* ------------------------------------------------- integrated title bar */

const layout = await page.evaluate(() => {
  const box = selector => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
  };
  return {
    width: window.innerWidth,
    bar: box(".window-title-bar"),
    brand: box(".title-bar-brand"),
    sidebar: box(".sidebar"),
    topBar: box(".top-bar"),
    controls: [...document.querySelectorAll(".window-control")].map(node => {
      const rect = node.getBoundingClientRect();
      return {
        label: node.getAttribute("aria-label"),
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        dragRegion: node.hasAttribute("data-tauri-drag-region"),
      };
    }),
    barDragRegion: document.querySelector(".window-title-bar")?.hasAttribute("data-tauri-drag-region") ?? false,
  };
});

check("titlebar-present", layout.bar !== null, "undecorated window draws its own title bar");
check(
  "titlebar-spans-window",
  Math.abs(layout.bar.top) < 1 && Math.abs(layout.bar.width - layout.width) < 1,
  `bar ${layout.bar.width}x${layout.bar.height} at ${layout.bar.top}`
);
check(
  "titlebar-no-overlap",
  layout.sidebar.top >= layout.bar.bottom - 1 && layout.topBar.top >= layout.bar.bottom - 1,
  `sidebar ${layout.sidebar.top}, top bar ${layout.topBar.top}, bar bottom ${layout.bar.bottom}`
);
check("titlebar-drag-region", layout.barDragRegion, "title bar is a Tauri drag region");
check(
  "window-controls-corner",
  layout.controls.length === 3 &&
    Math.abs(layout.controls.at(-1).right - layout.width) < 1 &&
    Math.abs(layout.controls[0].top) < 1 &&
    layout.controls.every(control => control.dragRegion === false),
  `controls at ${layout.controls.map(control => control.label).join(", ")}; none are drag regions`
);
check(
  "window-controls-styled",
  await page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="Window controls"]');
    const close = document.querySelector(".window-control.is-close");
    if (!group || !close) return false;
    return getComputedStyle(close).backgroundColor === "rgba(0, 0, 0, 0)";
  }),
  "window controls sit in a labelled group and rest without a fill"
);

// The conventional close treatment: red fill on hover.
await page.hover(".window-control.is-close");
await wait(180);
const closeHover = await page.evaluate(
  () => getComputedStyle(document.querySelector(".window-control.is-close")).backgroundColor
);
check("close-hover-treatment", closeHover === "rgb(196, 43, 28)", `close hover background ${closeHover}`);

// Maximize flips to the restore glyph through the native window-state round trip.
await page.click(".window-control[aria-label='Maximize']");
await wait(120);
const maximizeState = await page.evaluate(() => ({
  actions: window.__cadenceWindowActions,
  label: document.querySelectorAll(".window-control")[1].getAttribute("aria-label"),
}));
check(
  "maximize-round-trip",
  maximizeState.actions.at(0) === "maximize" && maximizeState.label === "Restore down",
  `actions ${maximizeState.actions.join(",")}; label ${maximizeState.label}`
);
await page.click(".window-control[aria-label='Restore down']");
await wait(120);
check(
  "restore-round-trip",
  (await page.evaluate(() => document.querySelectorAll(".window-control")[1].getAttribute("aria-label"))) === "Maximize",
  "restore returns the maximize label"
);
await page.hover(".top-bar");
await page.screenshot({ path: join(shotDir, "00-title-bar.png"), clip: { x: 0, y: 0, width: 1480, height: 140 } });
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
  { title: "Fixture ALAC", format: "ALAC (M4A)", expect: true },
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

const alacHandoff = await page.evaluate(() => window.__alacPrepareCalls.some(path => path.endsWith("fixture-alac.m4a")));
check("alac-uses-alac-bridge-handoff", alacHandoff, "metadata-identified ALAC went through the Tauri bridge contract");
const aacStayedOnChromium = await page.evaluate(() => !window.__alacPrepareCalls.some(path => path.endsWith("fixture-aac.m4a")));
check("aac-m4a-stays-on-chromium", aacStayedOnChromium, "AAC/M4A did not enter the ALAC bridge");

await clickTrackQuiet("Fixture ALAC");
await wait(350);
const alacSeek = await page.$('.player-bar input[aria-label="Seek"]');
const alacSeekBox = await alacSeek.boundingBox();
await page.mouse.click(alacSeekBox.x + alacSeekBox.width * 0.75, alacSeekBox.y + alacSeekBox.height / 2);
await wait(350);
const alacSeekState = await audioState();
check(
  "alac-seeking-through-pcm-handoff",
  alacSeekState.currentTime > 4.0 && !alacSeekState.paused,
  `75% seek moved shared audio clock to ${alacSeekState.currentTime.toFixed(2)}s`
);
await clickTrackQuiet("Fixture FLAC");
await page.evaluate(() => { window.__alacPrepareFailure = true; });
await clickTrackQuiet("Fixture ALAC");
await wait(250);
const alacFailure = await page.$eval(".error-banner", node => node.textContent.trim()).catch(() => "");
check(
  "alac-preparation-failure-is-actionable",
  /Could not prepare Apple Lossless audio.*fixture ALAC decoder failure/s.test(alacFailure),
  alacFailure || "no error banner"
);
if (await page.$(".error-banner")) await page.evaluate(() => document.querySelector(".error-banner button")?.click());
await page.evaluate(() => { window.__alacPrepareFailure = false; });

// ALAC is handled by the native bridge, so it must not be shown as a no-decoder file.
const alacBadge = await page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-testid="track-row"]')].find(node => node.textContent.includes("Fixture ALAC"));
  return row?.querySelector(".badge.warn")?.textContent?.trim() ?? null;
});
check("alac-not-labelled-unsupported", alacBadge !== "no decoder", JSON.stringify(alacBadge));

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
// Restart the 6-second fixture and halve its rate for this section: clicking the
// already-current track does not restart it, so on a slow machine it can be
// seconds from ending here — it then ends mid-section, the player advances to
// the MP3 fixture, and every downstream lyrics assertion silently measures the
// wrong track. The rate is restored at the pause after the seek checks below.
await page.evaluate(() => {
  const audio = document.querySelector("audio");
  if (audio) {
    audio.currentTime = 0.3;
    audio.playbackRate = 0.5;
  }
});
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

// Fullscreen buttons on the page: the top-of-page pill and the dock button are gone, so the player-bar
// button is the only entry point. In fullscreen the player bar is hidden and only the exit button remains.
const fullscreenButtonsOn = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter(node => /fullscreen/i.test(`${node.title} ${node.getAttribute("aria-label") ?? ""} ${node.textContent}`))
      .map(node => node.title || node.textContent.trim())
  );
const normalFullscreen = await fullscreenButtonsOn();
check("top-fullscreen-removed", !(await page.$(".sync-pill")) && normalFullscreen.length === 1, JSON.stringify(normalFullscreen));
check("bottom-fullscreen-only", normalFullscreen.length === 1 && normalFullscreen[0].startsWith("Fullscreen lyrics"), JSON.stringify(normalFullscreen));

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
await page.evaluate(() => {
  const audio = document.querySelector("audio");
  audio.pause();
  audio.playbackRate = 1;
});

/* ------------------------------------------- inline translation / romanization */

// Translation is enabled in the harness settings and the stub translator prefixes each line, so
// every line must carry its translation as a secondary line inside the line itself (Better Lyrics
// style) — never as extra lyric entries after the list.
const readDecorations = () =>
  page.evaluate(() => {
    const host = document.querySelector("braccato-lyrics");
    const lines = [...(host?.querySelectorAll(".blyrics--line") ?? [])];
    return {
      lineCount: lines.length,
      perLine: lines.map(line => ({
        childClasses: [...line.children].map(node =>
          node.classList.contains("blyrics--romanized")
            ? "romanized"
            : node.classList.contains("blyrics--translated")
              ? "translated"
              : node.classList.contains("blyrics-line-main")
                ? "main"
                : node.className
        ),
        romanized: line.querySelector(":scope > .blyrics--romanized")?.textContent?.trim() ?? null,
        translated: line.querySelector(":scope > .blyrics--translated")?.textContent?.trim() ?? null,
      })),
      stray: [...(host?.querySelectorAll(".blyrics--translated, .blyrics--romanized") ?? [])].filter(
        node => !node.closest(".blyrics--line")
      ).length,
    };
  });
await page.waitForFunction(
  () => document.querySelectorAll("braccato-lyrics .blyrics--translated").length >= 4,
  { timeout: 10_000 }
).catch(() => {});
const translatedState = await readDecorations();
check(
  "translation-inline-under-line",
  translatedState.lineCount === 4 &&
    translatedState.perLine.every((line, index) => line.translated === `[translated] ${["Word level timings arrive", "Every single word lights", "Karaoke follows the clock", "Last line of the song"][index]}`) &&
    translatedState.perLine.every(line => line.childClasses[0] === "main" && line.childClasses.at(-1) === "translated") &&
    translatedState.stray === 0,
  JSON.stringify(translatedState)
);

// Toggling romanization on adds a romanized line above the translation in the same line group;
// toggling it back off removes only the romanization.
await page.click('[data-testid="lyrics-dock"] button[title="Romanize lyrics"]');
await page.waitForFunction(
  () => document.querySelectorAll("braccato-lyrics .blyrics--romanized").length >= 4,
  { timeout: 10_000 }
).catch(() => {});
const romanizedState = await readDecorations();
check(
  "romanization-inline-above-translation",
  romanizedState.lineCount === 4 &&
    romanizedState.perLine.every(line => (line.romanized ?? "").startsWith("[romanized] ")) &&
    romanizedState.perLine.every(
      line =>
        line.childClasses.indexOf("romanized") > 0 &&
        line.childClasses.indexOf("romanized") < line.childClasses.indexOf("translated")
    ) &&
    romanizedState.stray === 0,
  JSON.stringify(romanizedState)
);
await page.click('[data-testid="lyrics-dock"] button[title="Romanize lyrics"]');
await page.waitForFunction(
  () => document.querySelectorAll("braccato-lyrics .blyrics--romanized").length === 0,
  { timeout: 10_000 }
).catch(() => {});
const romanizationOffState = await readDecorations();
check(
  "romanization-toggle-off-keeps-translation",
  romanizationOffState.perLine.every(line => line.romanized === null && (line.translated ?? "").startsWith("[translated] ")),
  JSON.stringify(romanizationOffState)
);

/* --------------------------- translation / romanization font sizes */

// One pair of settings behind both the Styles (dock) sliders and the Settings sliders. The
// renderer reads the sizes from the theme CSS, so they apply live, independently, and the
// original lines never move.
const decoFontSizes = () =>
  page.evaluate(() => {
    const px = selector => {
      const node = document.querySelector(selector);
      return node ? parseFloat(getComputedStyle(node).fontSize) : null;
    };
    // Legacy lyric sizes are reference values at a 48px fluid base. The rendered
    // size is that reference multiplied by clamp(30px, 6cqh, 84px) / 48, where
    // cqh is the actual route-content height in windowed or fullscreen mode.
    const contentHeight = document.querySelector(".content-scroll")?.clientHeight ?? 0;
    const fluidBase = Math.min(84, Math.max(30, contentHeight * 0.06));
    return {
      main: px(".blyrics--line .blyrics-line-main"),
      translated: px("braccato-lyrics .blyrics--translated"),
      romanized: px("braccato-lyrics .blyrics--romanized"),
      responsiveScale: fluidBase / 48,
    };
  });
const nearPx = (actual, expected) => actual !== null && Math.abs(actual - expected) < 0.05;
const setRange = (selector, value) =>
  page.$eval(
    selector,
    (input, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value
  );
const readSettingsRange = label =>
  page.evaluate(text => {
    const row = [...document.querySelectorAll(".range-row")].find(
      node => node.querySelector("strong")?.textContent === text
    );
    return {
      value: row?.querySelector('input[type="range"]')?.value ?? null,
      output: row?.querySelector("output")?.textContent ?? null,
    };
  }, label);
const setSettingsRange = (label, value) =>
  page.evaluate(
    (text, v) => {
      const row = [...document.querySelectorAll(".range-row")].find(
        node => node.querySelector("strong")?.textContent === text
      );
      const input = row?.querySelector('input[type="range"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    label,
    value
  );

// The dock's Style popover was removed; its sliders live in Settings, so the size
// checks below detour there and back to the lyrics.
const openSettingsView = async () => {
  await page.click('aside.sidebar button[title="Settings"]');
  await page.waitForSelector('[data-testid="settings-view"]');
  await page.evaluate(() => {
    const appearanceTab = [...document.querySelectorAll(".settings-tabs button")].find(node =>
      /appearance/i.test(node.textContent ?? "")
    );
    appearanceTab?.click();
  });
  await wait(400);
};
const backToNowPlaying = async () => {
  await page.evaluate(() => {
    const item = [...document.querySelectorAll("aside.sidebar .nav-item")].find(node =>
      node.textContent.includes("Now Playing")
    );
    item?.click();
  });
  await page.waitForSelector(".lyrics-view", { timeout: 10_000 }).catch(() => null);
  await wait(500);
};

await page.click('[data-testid="lyrics-dock"] button[title="Romanize lyrics"]');
await page.waitForFunction(() => document.querySelectorAll("braccato-lyrics .blyrics--romanized").length >= 4, {
  timeout: 10_000,
}).catch(() => {});
const defaultSizes = await decoFontSizes();
check(
  "secondary-font-size-defaults",
  nearPx(defaultSizes.main, 25.6 * defaultSizes.responsiveScale) &&
    nearPx(defaultSizes.translated, 32 * defaultSizes.responsiveScale) &&
    nearPx(defaultSizes.romanized, 26 * defaultSizes.responsiveScale),
  JSON.stringify(defaultSizes)
);

await openSettingsView();
await setSettingsRange("Translation Font Size", 18);
await backToNowPlaying();
const translationSized = await decoFontSizes();
check(
  "translation-font-size-live-and-independent",
  nearPx(translationSized.translated, 18 * translationSized.responsiveScale) &&
    translationSized.romanized === defaultSizes.romanized &&
    translationSized.main === defaultSizes.main,
  `before=${JSON.stringify(defaultSizes)} after=${JSON.stringify(translationSized)}`
);
await openSettingsView();
await setSettingsRange("Romanization Font Size", 14);
await backToNowPlaying();
const romanizationSized = await decoFontSizes();
check(
  "romanization-font-size-live-and-independent",
  nearPx(romanizationSized.romanized, 14 * romanizationSized.responsiveScale) &&
    nearPx(romanizationSized.translated, 18 * romanizationSized.responsiveScale) &&
    romanizationSized.main === defaultSizes.main,
  JSON.stringify(romanizationSized)
);
const persistedSizes = await page.evaluate(
  () => JSON.parse(localStorage.getItem("cadence.harness.settings.v1") ?? "{}")?.lyrics ?? {}
);
check(
  "secondary-font-sizes-persisted",
  persistedSizes.translationFontSizePx === 18 && persistedSizes.romanizationFontSizePx === 14,
  JSON.stringify(persistedSizes)
);

// Fullscreen renders through the same theme and settings; its larger content height
// therefore rescales the same reference sizes instead of replacing them.
await page.click('button[aria-label="Fullscreen lyrics"]');
await page.waitForSelector(".lyrics-view.is-fullscreen", { timeout: 5000 }).catch(() => null);
await wait(600);
const fullscreenSizes = await decoFontSizes();
check(
  "secondary-font-sizes-in-fullscreen",
  nearPx(fullscreenSizes.main, 25.6 * fullscreenSizes.responsiveScale) &&
    nearPx(fullscreenSizes.translated, 18 * fullscreenSizes.responsiveScale) &&
    nearPx(fullscreenSizes.romanized, 14 * fullscreenSizes.responsiveScale),
  JSON.stringify(fullscreenSizes)
);
await page.keyboard.press("Escape");
await wait(500);

// Settings still shows the values just set, and driving it from there lands back
// on the lyrics.
await openSettingsView();
const settingsTranslation = await readSettingsRange("Translation Font Size");
const settingsRomanization = await readSettingsRange("Romanization Font Size");
check(
  "font-size-settings-shown",
  settingsTranslation.value === "18" &&
    settingsTranslation.output === "18 px" &&
    settingsRomanization.value === "14" &&
    settingsRomanization.output === "14 px",
  `translation=${JSON.stringify(settingsTranslation)} romanization=${JSON.stringify(settingsRomanization)}`
);
await setSettingsRange("Translation Font Size", 22);
await wait(300);
await backToNowPlaying();
const settingsDriven = await decoFontSizes();
check(
  "settings-font-size-drives-lyrics",
  nearPx(settingsDriven.translated, 22 * settingsDriven.responsiveScale) &&
    nearPx(settingsDriven.romanized, 14 * settingsDriven.responsiveScale),
  JSON.stringify(settingsDriven)
);

// Restore the defaults and the pre-section dock state for the checks that follow.
await openSettingsView();
await setSettingsRange("Translation Font Size", 32);
await setSettingsRange("Romanization Font Size", 26);
await backToNowPlaying();
await page.click('[data-testid="lyrics-dock"] button[title="Romanize lyrics"]');
await page.waitForFunction(() => document.querySelectorAll("braccato-lyrics .blyrics--romanized").length === 0, {
  timeout: 10_000,
}).catch(() => {});

/* ------------------------------------------------------- unified fullscreen */

// The controls show only while the pointer is over them, so a click first moves the pointer onto its
// target (which reveals the controls) and waits out the fade-in before clicking.
const wakeClick = async selector => {
  const point = await page.$eval(selector, node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await wait(350);
  await page.click(selector);
};

await wakeClick('button[aria-label="Fullscreen lyrics"]');
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
const playCentre = await page.$eval('[data-testid="fullscreen-controls"] .play-button', node => {
  const rect = node.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
});
await page.mouse.move(playCentre.x, playCentre.y);
await wait(350);
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
  // Audio-reactive shaders have quiet frames; sample several windows and retain the strongest
  // motion measurement. A static/black control still has no window that can pass the thresholds.
  let strongest = null;
  for (let sample = 0; sample < 3; sample += 1) {
    // Keep the cursor over the controls so the idle-conceal fade cannot fire mid-sample:
    // a fade during the black-fill baseline reveals the moving shader and contaminates it.
    await page.mouse.move(box.x + box.width / 2, box.y + 6);
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
    const result = { mean: sum / pixels / 3, avgDiff: diffSum / pixels, movedRatio: moved / pixels };
    if (!strongest || result.avgDiff > strongest.avgDiff) strongest = result;
  }
  return strongest;
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
// Pin the bar visible with no fade for the whole measurement: an idle-conceal (or re-show)
// transition inside a sample window swamps the backdrop signal this check exists to measure.
await page.evaluate(() => {
  const node = document.querySelector('[data-testid="fullscreen-controls"]');
  node.style.opacity = "1";
  node.style.transition = "none";
});
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
  node.style.opacity = "";
  node.style.transition = "";
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

// Lyrics off: the artwork sits beside the title and the controls. No lyrics footer or dock is shown.
const offPanel = await page.evaluate(() => {
  const box = selector => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
  };
  return {
    lyricsOff: document.querySelector(".lyrics-view")?.classList.contains("is-lyrics-off") ?? false,
    footer: Boolean(document.querySelector(".lyrics-footer")),
    dock: Boolean(document.querySelector('[data-testid="lyrics-dock"]')),
    art: box(".fs-panel-art .artwork-hero"),
    panel: box(".fs-panel"),
    controls: box('[data-testid="fullscreen-controls"]'),
    exit: Boolean(document.querySelector(".lyrics-view .fs-exit")),
    eyebrow: document.querySelector(".fs-eyebrow")?.textContent?.trim() ?? null,
    // The toggle sits in the transport row, directly after the repeat button.
    toggle: (() => {
      const toggleNode = document.querySelector('[data-testid="fullscreen-controls"] [data-testid="fullscreen-lyrics-toggle"]');
      const repeatNode = document.querySelector('[data-testid="fullscreen-controls"] button[aria-label^="Repeat"]');
      return Boolean(toggleNode && repeatNode && repeatNode.nextElementSibling === toggleNode && toggleNode.closest(".transport"));
    })(),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  };
});
check(
  "lyrics-off-panel",
  offPanel.lyricsOff &&
    !offPanel.footer &&
    !offPanel.dock &&
    Boolean(offPanel.art) &&
    Boolean(offPanel.panel) &&
    Boolean(offPanel.controls) &&
    offPanel.art.right <= offPanel.panel.left &&
    offPanel.controls.bottom <= offPanel.innerHeight &&
    offPanel.panel.right <= offPanel.innerWidth &&
    offPanel.exit &&
    offPanel.toggle &&
    offPanel.eyebrow === "Now playing",
  JSON.stringify(offPanel)
);

// The exit button is the top element at its centre, and a click leaves fullscreen. Fullscreen is entered
// again afterwards, still with lyrics off, so the checks below run as before.
const exitTarget = await page.evaluate(() => {
  const node = document.querySelector(".lyrics-view .fs-exit");
  const box = node.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, hit: Boolean(hit && (hit === node || node.contains(hit))) };
});
await page.mouse.move(exitTarget.x, exitTarget.y);
await wait(300);
await page.mouse.click(exitTarget.x, exitTarget.y);
await wait(700);
const exitClosed = !(await page.$(".lyrics-view.is-fullscreen"));
check("exit-closes-lyrics-off", exitTarget.hit && exitClosed, `hit ${exitTarget.hit}, fullscreen closed ${exitClosed}`);
await wakeClick('button[aria-label="Fullscreen lyrics"]');
await wait(700);
check("fullscreen-reentered-lyrics-off", Boolean(await page.$(".lyrics-view.is-fullscreen.is-lyrics-off")), "lyrics off kept on re-entry");

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
  (activeAt49 ?? "").includes("Last") && (activeAt10 ?? "").toLowerCase().includes("word"),
  `1.0s → ${JSON.stringify(activeAt10)}, 4.9s → ${JSON.stringify(activeAt49)}; header ${await page.$eval(".lyrics-heading h1", n => n.textContent)}, ${await page.$$eval("braccato-lyrics .blyrics--line", n => n.length)} lines`
);
await wakeClick('[data-testid="fullscreen-controls"] .play-button');
await wait(900);
const clockAfterResume = await audioState();
check("clock-continues-after-toggle", !clockAfterResume.paused && clockAfterResume.currentTime > 1.0, `${clockAfterResume.currentTime.toFixed(2)}s`);

/* ------------------------------------------------- fullscreen hover controls */

// The controls show while the pointer is over the controls area and fade out when it leaves. Hidden
// controls take no pointer input, so the lyrics under them stay clickable.
const controlState = () =>
  page.evaluate(() => {
    const node = document.querySelector('[data-testid="fullscreen-controls"]');
    const style = node ? getComputedStyle(node) : null;
    return {
      concealed: node?.classList.contains("is-concealed") ?? null,
      opacity: style ? Number(style.opacity) : null,
      visibility: style?.visibility ?? null,
      pointerEvents: style?.pointerEvents ?? null,
      dockConcealed: document.querySelector('[data-testid="lyrics-dock"]')?.classList.contains("is-concealed") ?? null,
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
// The fade is a CSS transition; under shader load the frames can lag, so poll until it settles.
// Waits for the fade to finish: opacity near the target, and for a hidden target the visibility switch too,
// which the transition applies only at the end of the 250 ms fade.
const settleOpacity = async target => {
  const settled = state =>
    Math.abs((state.opacity ?? -1) - target) <= 0.02 && (target > 0.5 ? state.visibility === "visible" : state.visibility === "hidden");
  let state = await controlState();
  for (let waited = 0; waited < 2000 && !settled(state); waited += 100) {
    await wait(100);
    state = await controlState();
  }
  return state;
};
const centreOf = selector =>
  page.$eval(selector, node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
// A point over the lyrics, outside the controls area at every window size the harness uses.
const pointerAway = async () => {
  await page.mouse.move(100, 200);
};

// Pointer over the lyrics only: the controls stay hidden and take no input.
await pointerAway();
const awayState = await settleOpacity(0);
const awayHit = await hitsControls();
check(
  "hover-lyrics-keeps-controls-hidden",
  awayState.concealed === true && awayState.opacity < 0.02 && awayState.visibility === "hidden" && awayState.pointerEvents === "none" && !awayHit,
  JSON.stringify({ ...awayState, hitsControls: awayHit })
);

// Playback continues while the controls are hidden.
const hiddenStart = await audioState();
await wait(2000);
const hiddenEnd = await audioState();
const hiddenDelta = hiddenEnd.currentTime - hiddenStart.currentTime;
const hiddenAdvance = hiddenDelta < 0 ? hiddenDelta + hiddenEnd.duration : hiddenDelta; // repeat-one can wrap the 6 s fixture
check(
  "hover-hidden-playback-continues",
  !hiddenEnd.paused && hiddenAdvance > 1.5 && hiddenAdvance < 2.5,
  `advanced ${hiddenAdvance.toFixed(2)}s over 2 s, paused=${hiddenEnd.paused}`
);

// Roaming over the lyrics, including the point just above the controls' top edge, does not reveal them.
// Derive that edge from the rendered footer: its height is intentionally fluid now, so a fixed
// y-coordinate from the old laptop-sized control stack can land inside the controls themselves.
const roamControlsTop = await page.$eval('[data-testid="fullscreen-controls"]', node =>
  node.getBoundingClientRect().top
);
for (const [x, y] of [[300, 250], [640, 420], [900, 600], [640, Math.max(0, roamControlsTop - 8)]]) {
  await page.mouse.move(x, y);
  await wait(40);
}
const roamState = await controlState();
check(
  "hover-lyrics-roam-stays-hidden",
  roamState.concealed === true && roamState.opacity < 0.02 && roamState.pointerEvents === "none",
  JSON.stringify(roamState)
);

// The shader keeps moving behind the hidden controls: the bottom-left corner is clear of lyrics and controls.
const hiddenShader = await motionOf({ x: 0, y: 760, width: 260, height: 140 });
check("hover-hidden-shader-keeps-rendering", hiddenShader.avgDiff > 0.5, `avg frame change ${hiddenShader.avgDiff.toFixed(2)} over the hidden control area`);
await page.screenshot({ path: join(shotDir, "05c-fullscreen-controls-hidden.png") });

// Hovering the controls shows them; the fade completes within 250 ms.
const playPoint = await centreOf('[data-testid="fullscreen-controls"] .play-button');
await page.mouse.move(playPoint.x, playPoint.y);
const revealedState = await settleOpacity(1);
const revealedHit = await hitsControls();
check(
  "hover-reveals-controls",
  revealedState.concealed === false && revealedState.opacity > 0.95 && revealedState.visibility === "visible" && revealedState.pointerEvents === "auto" && revealedHit,
  JSON.stringify({ ...revealedState, hitsControls: revealedHit })
);

// Moving across the control bar, the gap between it and the dock, and the dock keeps them shown.
const seekPoint = await centreOf('[data-testid="fullscreen-controls"] .seek-row');
const dockPoint = await centreOf('[data-testid="lyrics-dock"]');
const controlsBottom = await page.$eval('[data-testid="fullscreen-controls"]', node => node.getBoundingClientRect().bottom);
const dockTop = await page.$eval('[data-testid="lyrics-dock"]', node => node.getBoundingClientRect().top);
const gapPoint = { x: dockPoint.x, y: (controlsBottom + dockTop) / 2 };
const withinStates = [];
for (const point of [seekPoint, gapPoint, dockPoint]) {
  await page.mouse.move(point.x, point.y);
  await wait(60);
  withinStates.push(await controlState());
}
check(
  "hover-within-area-stays-visible",
  withinStates.every(state => state.concealed === false && state.opacity > 0.95),
  `opacity ${withinStates.map(state => state.opacity).join(", ")}`
);

// Leaving the area fades the controls out again.
await pointerAway();
const leftState = await settleOpacity(0);
check(
  "hover-leave-hides-controls",
  leftState.concealed === true && leftState.opacity < 0.02 && leftState.visibility === "hidden" && leftState.dockConcealed === true,
  JSON.stringify(leftState)
);

// The fade is opacity and visibility only, 240 ms (`--dur-3` since the Stage 1 token
// normalization): no transform, scale or layout transition.
const fade = await page.evaluate(() => {
  const style = getComputedStyle(document.querySelector('[data-testid="fullscreen-controls"]'));
  return { properties: style.transitionProperty, durations: style.transitionDuration };
});
check(
  "hover-fade-is-opacity-only",
  fade.properties === "opacity, visibility" && fade.durations === "0.24s, 0.24s",
  JSON.stringify(fade)
);

// An open dock popover keeps the controls visible while the pointer is elsewhere; closing it lets them go.
await wakeClick('button[title="Lyrics source"]');
await pointerAway();
await wait(400);
const pinnedState = await controlState();
const sourcesOpen = Boolean(await page.$(".dock-sources"));
check(
  "hover-popover-pins-controls",
  sourcesOpen && pinnedState.concealed === false && pinnedState.opacity > 0.95 && pinnedState.dockConcealed === false,
  `popover open=${sourcesOpen}; concealed=${pinnedState.concealed}, dock concealed=${pinnedState.dockConcealed}`
);
await wakeClick('button[title="Lyrics source"]');
await pointerAway();
const closedState = await settleOpacity(0);
check(
  "hover-popover-closed-hides-controls",
  !(await page.$(".dock-sources")) && closedState.concealed === true,
  `concealed=${closedState.concealed}, opacity ${closedState.opacity}`
);

// Exit fullscreen with the controls hidden. The normal page keeps its dock visible, before and after 4 s.
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
      dockConcealed: dock?.classList.contains("is-concealed") ?? null,
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
  "fullscreen-exit-page-visible",
  !normalNow.fullscreen && !normalNow.controls && normalNow.dock && normalNow.dockConcealed === false && normalNow.opacity > 0.95 && normalNow.visibility === "visible" && normalLater.dockConcealed === false && normalLater.opacity > 0.95,
  JSON.stringify({ now: normalNow, after4s: normalLater })
);

// Re-enter fullscreen for the checks below.
await wakeClick('button[aria-label="Fullscreen lyrics"]');
await wait(700);
check("fullscreen-reentry", Boolean(await page.$(".lyrics-view.is-fullscreen")), "fullscreen again");

/* ------------------------------------------------------- fullscreen layout */

// The lyrics body runs to the bottom edge of the viewport, the controls overlay it, and showing or
// hiding them moves nothing. Geometry is read after the 250 ms fade has settled.
const fullscreenLayout = () =>
  page.evaluate(() => {
    const rect = selector => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height };
    };
    const controls = document.querySelector('[data-testid="fullscreen-controls"]');
    const dock = document.querySelector('[data-testid="lyrics-dock"]');
    const footerTop = Math.min(
      controls?.getBoundingClientRect().top ?? Infinity,
      dock?.getBoundingClientRect().top ?? Infinity
    );
    const active = document.querySelector(".blyrics--active")?.getBoundingClientRect() ?? null;
    return {
      viewport: window.innerHeight,
      view: rect(".lyrics-view"),
      body: rect(".lyrics-body"),
      footerTop,
      scrollPaddingBottom: parseFloat(getComputedStyle(document.querySelector(".lyrics-body")).scrollPaddingBottom),
      activeBottom: active ? active.bottom : null,
    };
  });

// Showing and hiding the controls: the body and the footer must not move.
const shownPoint = await centreOf('[data-testid="fullscreen-controls"] .play-button');
await page.mouse.move(shownPoint.x, shownPoint.y);
const layoutShownState = await settleOpacity(1);
const layoutShown = await fullscreenLayout();
await pointerAway();
const layoutHiddenState = await settleOpacity(0);
const layoutHidden = await fullscreenLayout();
check(
  "controls-overlay-without-shift",
  layoutShownState.concealed === false && layoutHiddenState.concealed === true && layoutShown.body.top === layoutHidden.body.top && layoutShown.body.bottom === layoutHidden.body.bottom && layoutShown.footerTop === layoutHidden.footerTop,
  `shown=${!layoutShownState.concealed}, hidden=${layoutHiddenState.concealed}; body ${layoutShown.body.top}→${layoutShown.body.bottom} shown, ${layoutHidden.body.top}→${layoutHidden.body.bottom} hidden; footer top ${layoutShown.footerTop} / ${layoutHidden.footerTop}`
);

// At each size: the body fills the viewport, the scroll band matches the controls, and the active lyric line
// sits above the controls. The position is seeked and paused, so the measurement is steady.
const layoutAtSize = async (width, height) => {
  await page.setViewport({ width, height });
  await wait(500);
  await page.evaluate(() => {
    const audio = document.querySelector("audio");
    audio.pause();
    audio.currentTime = 2.5;
  });
  await wait(1200);
  await pointerAway();
  await wait(350);
  const layout = await fullscreenLayout();
  const fills = Math.abs(layout.body.bottom - layout.viewport) < 1 && Math.abs(layout.view.height - layout.viewport) < 1;
  const padded = Math.abs(layout.scrollPaddingBottom - (layout.viewport - layout.footerTop)) <= 2;
  // The line box may reach a few pixels over the footer's top edge at the smallest size (the glyphs stay
  // clear, as before the header change); the tolerance is 4 px.
  const clear = layout.activeBottom !== null && layout.activeBottom <= layout.footerTop + 4;
  check(
    `fullscreen-layout-${width}x${height}`,
    fills && padded && clear,
    `body bottom ${layout.body.bottom.toFixed(0)} of ${layout.viewport}, scroll-padding ${layout.scrollPaddingBottom}px vs controls ${(layout.viewport - layout.footerTop).toFixed(0)}px, active line bottom ${layout.activeBottom?.toFixed(0)} vs footer top ${layout.footerTop.toFixed(0)}`
  );
  // Left column: the artwork and the title form one block, centred between the header and the controls
  // (wide windows); at 900 px and below the artwork is hidden and the title stays at the top. The lyrics
  // column keeps the title out of the header. The active line's left edge is recorded for the record.
  const art = await page.evaluate(() => {
    const side = document.querySelector(".fs-side");
    if (!side) return { present: false };
    const sideBox = side.getBoundingClientRect();
    const artNode = document.querySelector(".fs-artwork");
    const artBox = artNode.getBoundingClientRect();
    const artVisible = getComputedStyle(artNode).display !== "none" && artBox.width > 0;
    const heading = document.querySelector(".fs-side .lyrics-heading").getBoundingClientRect();
    const body = document.querySelector(".lyrics-body").getBoundingClientRect();
    const header = document.querySelector(".lyrics-header").getBoundingClientRect();
    const activeLine = document.querySelector(".blyrics--active")?.getBoundingClientRect() ?? null;
    const exitNode = document.querySelector(".lyrics-view .fs-exit");
    const exitBox = exitNode?.getBoundingClientRect() ?? null;
    const exitHit = exitBox
      ? (() => {
          const hit = document.elementFromPoint(exitBox.left + exitBox.width / 2, exitBox.top + exitBox.height / 2);
          return Boolean(hit && (hit === exitNode || exitNode.contains(hit)));
        })()
      : false;
    const inactiveLine = document.querySelector(".blyrics-container > div:not(.blyrics--active)")?.getBoundingClientRect() ?? null;
    const bodyStyle = getComputedStyle(document.querySelector(".lyrics-body"));
    const lyricsFaded = bodyStyle.maskImage.includes("calc") && bodyStyle.maskImage !== "none";
    return {
      present: true,
      artVisible,
      artLeft: artBox.left,
      artRight: artBox.right,
      artBottom: artBox.bottom,
      artWidth: artBox.width,
      sideTop: sideBox.top,
      sideBottom: sideBox.bottom,
      headingTop: heading.top,
      headingInHeader: Boolean(document.querySelector(".lyrics-header .lyrics-heading")),
      bodyLeft: body.left,
      headerBottom: header.bottom,
      activeLeft: activeLine ? activeLine.left : null,
      lyricsFaded,
      maskImage: bodyStyle.maskImage.slice(0, 220),
      viewport: window.innerHeight,
      viewportWidth: window.innerWidth,
      bodyRight: body.right,
      activeRight: activeLine ? activeLine.right : null,
      exitRight: exitBox ? exitBox.right : null,
      exitTop: exitBox ? exitBox.top : null,
      exitHit,
      inactiveLeft: inactiveLine ? inactiveLine.left : null,
      bodyPaddingRight: parseFloat(getComputedStyle(document.querySelector(".lyrics-body")).paddingRight),
      activeLeft: activeLine ? activeLine.left : null,
      footerTop: Math.min(
        document.querySelector('[data-testid="fullscreen-controls"]')?.getBoundingClientRect().top ?? Infinity,
        document.querySelector('[data-testid="lyrics-dock"]')?.getBoundingClientRect().top ?? Infinity
      ),
    };
  });
  const artOk =
    width <= 900
      ? art.present && !art.artVisible && !art.headingInHeader && art.sideTop >= 0 && art.headingTop < art.sideBottom
      : art.present &&
        art.artVisible &&
        !art.headingInHeader &&
        art.artRight <= art.bodyLeft &&
        art.headingTop >= art.artBottom &&
        art.sideTop >= art.headerBottom - 1 &&
        art.sideBottom <= art.footerTop &&
        Math.abs((art.sideTop + art.sideBottom) / 2 - art.viewport / 2) < 2 &&
        art.lyricsFaded &&
        Math.abs((art.artLeft + art.bodyRight) / 2 - art.viewportWidth / 2) < 2;
  check(`fullscreen-artwork-${width}x${height}`, artOk, JSON.stringify(art));
  // The lyrics' right edge is the same distance from the window's right edge as the artwork's left edge, and the
  // active line reaches that edge (the renderer's line scale is anchored on the right). Wide layouts only.
  if (width > 900) {
    // The renderer's box ends where the artwork's left margin ends. Its line scale (0.95) can pull the
    // unscaled lines in by a few percent, so the check is on the box and on the active line not passing it.
    const edgeOk =
      art.bodyPaddingRight === 0 &&
      Math.abs(art.viewportWidth - art.bodyRight - art.artLeft) < 2 &&
      art.activeRight !== null &&
      art.activeRight <= art.bodyRight + 1;
    check(`lyrics-right-edge-${width}x${height}`, edgeOk, `body right ${art.bodyRight?.toFixed(1)}, art left ${art.artLeft?.toFixed(1)}, window ${art.viewportWidth}, active right ${art.activeRight?.toFixed(1)}, body padding-right ${art.bodyPaddingRight}`);
    // The active line keeps the same left edge as the other lines: it grows to the right, not outwards.
    const alignedOk = art.activeLeft !== null && art.inactiveLeft !== null && Math.abs(art.activeLeft - art.inactiveLeft) < 2;
    check(`lyrics-active-not-offset-${width}x${height}`, alignedOk, `active left ${art.activeLeft?.toFixed(1)}, other lines left ${art.inactiveLeft?.toFixed(1)}`);
  }
  // The exit button is in the top-right corner of the window, with lyrics on or off.
  const exitOk = art.exitRight !== null && art.viewportWidth - art.exitRight <= 60 && art.exitTop < 40 && art.exitHit;
  check(`exit-top-right-${width}x${height}`, exitOk, `exit right ${art.exitRight?.toFixed(0)} of ${art.viewportWidth}, top ${art.exitTop?.toFixed(0)}`);
};
await layoutAtSize(1280, 720);
await layoutAtSize(800, 600);
await layoutAtSize(1480, 900);
await layoutAtSize(1100, 700);
await layoutAtSize(1568, 889);
await page.evaluate(() => document.querySelector("audio").play());
await wait(300);

// The queue opens from fullscreen and must sit above the fullscreen view. Move the
// pointer away first: wakeClick's wake depends on a real move event, and if the
// pointer is already resting where the Queue button sits, the synthetic move is a
// no-op and the click lands on still-concealed controls.
await pointerAway();
await wait(200);
await wakeClick('[data-testid="fullscreen-controls"] button[aria-label="Queue"]');
await wait(700);
const queueLayer = await page.evaluate(() => {
  const panel = document.querySelector(".queue-panel");
  if (!panel) return null;
  const rect = panel.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return { topmost: panel.contains(hit), bottomGap: Math.round(window.innerHeight - rect.bottom) };
});
check("queue-opens-over-fullscreen", queueLayer?.topmost === true && queueLayer.bottomGap === 0, JSON.stringify(queueLayer));
if (await page.$('.queue-panel button[aria-label="Close queue"]')) {
  await wakeClick('.queue-panel button[aria-label="Close queue"]');
  await wait(200);
}

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
await wakeClick('button[aria-label="Fullscreen lyrics"]');
await wait(500);
await wakeClick('[data-testid="fullscreen-lyrics-toggle"]');
await wait(300);
await wakeClick('[data-testid="fullscreen-controls"] button[aria-label="Repeat: one"]');
await wait(200);
await page.keyboard.press("Escape");
await wait(400);

/* ------------------------------------------- one fullscreen entry point */

// From another page, the player bar's fullscreen button opens the Now Playing view in fullscreen.
await page.click('aside.sidebar button[title="Settings"]');
await page.waitForSelector('[data-testid="settings-view"]');
await wait(300);
await page.click('button[aria-label="Fullscreen lyrics"]');
await page.waitForSelector(".lyrics-view.is-fullscreen", { timeout: 5000 }).catch(() => null);
await wait(900);
const fromSettings = await page.evaluate(() => ({
  hash: location.hash,
  fullscreen: Boolean(document.querySelector(".lyrics-view.is-fullscreen")),
  playerBar: Boolean(document.querySelector('[data-testid="player-bar"]')),
  overlay: Boolean(document.querySelector('[data-testid="now-playing"]')),
}));
check(
  "player-button-enters-fullscreen",
  fromSettings.hash === "#/lyrics" && fromSettings.fullscreen && !fromSettings.playerBar && !fromSettings.overlay,
  JSON.stringify(fromSettings)
);
await page.screenshot({ path: join(shotDir, "06-fullscreen-from-player.png") });

// The N key is the same single toggle: it leaves fullscreen and enters it again.
await page.keyboard.press("Escape");
await wait(400);
await page.keyboard.press("n");
await wait(400);
check("n-key-toggles-fullscreen", Boolean(await page.$(".lyrics-view.is-fullscreen")), "N entered fullscreen");
await page.keyboard.press("Escape");
await wait(400);
check("fullscreen-exit-after-n", !(await page.$(".lyrics-view.is-fullscreen")), "Escape left fullscreen");

/* -------------------------------------------------------------- settings */

await page.click('aside.sidebar button[title="Settings"]');
await page.waitForSelector('[data-testid="settings-view"]');
await wait(500);
const settingsTabs = await page.$$eval(".settings-tabs button", buttons => buttons.map(button => button.textContent?.trim()));
const shaderSection = await page.$('[data-testid="settings-shaders"]');
const lyricsSection = await page.$('[data-testid="settings-lyrics"]');
check(
  "settings-tabs-consolidated",
  settingsTabs.length === 5 &&
    ["Appearance", "Library", "Playback", "Cache", "About"].every(tab => settingsTabs.includes(tab)) &&
    !settingsTabs.includes("Lyrics") &&
    !settingsTabs.includes("Shaders"),
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
  // Select by label, not "first range in the section": the Not-Found cooldown slider now sits
  // ahead of Font size in the Lyrics settings, and grabbing it would silently set days not rem.
  const row = [...document.querySelectorAll('[data-testid="settings-lyrics"] .range-row')].find(
    node => node.querySelector("strong")?.textContent === "Font size"
  );
  const slider = row?.querySelector('input[type="range"]');
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
// Same by-label selection as above: the first range/output in the Lyrics section is now the
// Not-Found cooldown control, so reading positionally would check days instead of rem.
const fontSizeRange = await readSettingsRange("Font size");
const fontSize = {
  stored: await page.evaluate(
    () => JSON.parse(localStorage.getItem("cadence.harness.settings.v1") ?? "{}")?.lyrics?.fontSizeRem ?? null
  ),
  slider: fontSizeRange.value,
  output: fontSizeRange.output,
};
check("settings-survive-reload", fontSize.stored === 2.4 && fontSize.slider === "2.4", `stored=${fontSize.stored}, slider=${fontSize.slider}, shown=${fontSize.output}`);
const reloadedSecondary = {
  translation: await readSettingsRange("Translation Font Size"),
  romanization: await readSettingsRange("Romanization Font Size"),
};
check(
  "secondary-font-sizes-survive-reload",
  reloadedSecondary.translation.value === "32" &&
    reloadedSecondary.translation.output === "32 px" &&
    reloadedSecondary.romanization.value === "26" &&
    reloadedSecondary.romanization.output === "26 px",
  `translation=${JSON.stringify(reloadedSecondary.translation)} romanization=${JSON.stringify(reloadedSecondary.romanization)}`
);

/* ----------------------------------------------------------- decode tester */

// Real Chromium decoding through the same playback source resolution. The browser-only native
// bridge stub returns a real PCM WAV for ALAC; corrupt/truncated/missing files retain their failure
// classifications. Runs last: it appends synthetic tracks and deletes library entries in the stub.
await page.evaluate(() => window.__addDecodeFixtureTracks());
await wait(500);
const audioSrcBeforeDecode = await page.$eval("audio", node => node.currentSrc || node.src).catch(() => "");

check(
  "decode-tester-not-in-sidebar",
  (await page.$$('aside.sidebar button[title="Decode Tester"]')).length === 0,
  "the tester is only reachable from Settings"
);
await page.click('aside.sidebar button[title="Settings"]');
await wait(250);
await page.evaluate(() => {
  [...document.querySelectorAll(".settings-tabs button")]
    .find(node => /library/i.test(node.textContent ?? ""))
    ?.click();
});
await wait(300);
await page.screenshot({ path: join(shotDir, "07b-settings-library.png") });
await page.evaluate(() => {
  [...document.querySelectorAll('[data-testid="settings-library"] button')]
    .find(node => /decode tester/i.test(node.textContent ?? ""))
    ?.click();
});
await page.waitForSelector('[data-testid="decode-tester-view"]');
await wait(300);
check("decode-tester-route", (await page.evaluate(() => location.hash)) === "#/decode-tester", "Settings opens the Decode Tester");
check("decode-tester-idle-state", Boolean(await page.$('[data-testid="decode-empty-idle"]')), "pre-scan empty state");
check(
  "decode-tester-library-count",
  /10 files in your library/.test(await page.$eval('[data-testid="decode-status"]', node => node.textContent)),
  await page.$eval('[data-testid="decode-status"]', node => node.textContent.trim())
);

const readDecodeRows = () =>
  page.$$eval('[data-testid="decode-problem-row"]', rows =>
    rows.map(row => ({
      path: row.getAttribute("data-path") ?? "",
      kind: row.getAttribute("data-kind") ?? "",
      name: row.querySelector(".decode-row-title strong")?.textContent?.trim() ?? "",
      text: row.textContent ?? "",
    }))
  );
const waitForDecodeComplete = async () => {
  await page.waitForFunction(
    () => /Scan complete|Scan canceled|Scan failed/.test(document.querySelector('[data-testid="decode-status"]')?.textContent ?? ""),
    { timeout: 120_000 }
  );
  return page.$eval('[data-testid="decode-status"]', node => node.textContent.trim());
};

await page.click('[data-testid="decode-scan-button"]');
const progressSamples = [];
{
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => ({
      status: document.querySelector('[data-testid="decode-status"]')?.textContent ?? "",
      progress: document.querySelector('[data-testid="decode-progress"]')?.textContent?.trim() ?? null,
    }));
    if (snapshot.progress) progressSamples.push(snapshot.progress);
    if (/Scan complete|Scan canceled|Scan failed/.test(snapshot.status)) break;
    await wait(150);
  }
}
check(
  "decode-scan-progress",
  progressSamples.some(text => /Scanned \d+ of 10 files/.test(text)),
  progressSamples.at(-1) ?? "no progress element sampled"
);
const firstScanStatus = await page.$eval('[data-testid="decode-status"]', node => node.textContent.trim());
check("decode-scan-completes", /Scan complete — 10 files checked, 3 problematic/.test(firstScanStatus), firstScanStatus);

const rows = await readDecodeRows();
const byName = new Map(rows.map(row => [row.name, row]));
check("decode-scan-finds-problems", rows.length === 3, rows.map(row => `${row.name}:${row.kind}`).join(", "));
check("decode-corrupt-flac", byName.get("broken.flac")?.kind === "decode-error", JSON.stringify(byName.get("broken.flac")));
check(
  "decode-alac-handoff-path",
  !byName.has("fixture-alac.m4a") &&
    await page.evaluate(() => window.__alacPrepareCalls.some(path => path.endsWith("fixture-alac.m4a"))),
  "ALAC metadata selected the bridge stub and its real PCM fixture passed sampled decoding"
);
check(
  "decode-truncated-flac",
  ["truncated", "decode-error", "timeout"].includes(byName.get("truncated.flac")?.kind ?? ""),
  byName.get("truncated.flac")?.text?.slice(0, 160) ?? "row missing — truncated file passed the decoder"
);
check(
  "decode-missing-inaccessible",
  byName.get("missing-file.flac")?.kind === "inaccessible" && /could not be read from disk/i.test(byName.get("missing-file.flac")?.text ?? ""),
  byName.get("missing-file.flac")?.text?.slice(0, 160) ?? "row missing"
);
check(
  "decode-valid-files-pass",
  ["fixture.flac", "fixture.mp3", "fixture.wav", "fixture.ogg", "fixture.opus", "fixture-aac.m4a", "fixture-alac.m4a"].every(
    name => !byName.has(name)
  ),
  "no false positives for FLAC/MP3/WAV/Ogg/Opus/AAC/ALAC"
);
check(
  "decode-scan-leaves-player-alone",
  (await page.$$("audio")).length === 1 &&
    (await page.$eval("audio", node => node.currentSrc || node.src).catch(() => "")) === audioSrcBeforeDecode,
  "one shared playback element, source untouched"
);
await page.screenshot({ path: join(shotDir, "08-decode-tester.png") });

// Keep: mark, verify it stays listed, hide only via the explicit filter, then show again.
await page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-testid="decode-problem-row"]')].find(node =>
    node.getAttribute("data-path")?.endsWith("broken.flac")
  );
  row?.querySelector(".decode-keep")?.click();
});
await wait(250);
const keptState = await page.evaluate(() => ({
  rows: document.querySelectorAll('[data-testid="decode-problem-row"]').length,
  badge: Boolean(document.querySelector(".decode-kept-badge")),
  stored: localStorage.getItem("cadence.decodeTester.kept.v1") ?? "",
}));
check(
  "decode-keep-marks-without-hiding",
  keptState.rows === 3 && keptState.badge && keptState.stored.includes("broken.flac"),
  JSON.stringify(keptState)
);
await page.click('[data-testid="decode-hide-kept"]');
await wait(250);
check("decode-hide-kept-filter", (await readDecodeRows()).every(row => row.name !== "broken.flac") && (await readDecodeRows()).length === 2, "kept row hidden only by the filter");
await page.click('[data-testid="decode-hide-kept"]');
await wait(250);
check("decode-show-kept-again", (await readDecodeRows()).length === 3, "filter off restores the kept row");

// Export: every problematic path, kept included, goes to the native command.
await page.click('[data-testid="decode-export-button"]');
await wait(400);
const exportCalls = await page.evaluate(() => window.__decodeCalls.export);
const exportedPaths = new Set(exportCalls.at(-1) ?? []);
check(
  "decode-export-paths",
  exportedPaths.size === 3 &&
    [...exportedPaths].every(path => rows.some(row => row.path === path)) &&
    [...exportedPaths].some(path => path.endsWith("broken.flac")),
  JSON.stringify(exportCalls.at(-1) ?? [])
);
check(
  "decode-export-message",
  /Exported 3 problematic file paths/.test(await page.$eval('[data-testid="decode-action-message"]', node => node.textContent).catch(() => "")),
  "export outcome is reported in the UI"
);

// Reveal in folder goes through the existing openPath bridge call.
await page.evaluate(() => {
  document.querySelector('button[aria-label="Show broken.flac in folder"]')?.click();
});
await wait(250);
check(
  "decode-show-in-folder",
  (await page.evaluate(() => window.__openedPaths)).some(path => path.endsWith("broken.flac")),
  JSON.stringify(await page.evaluate(() => window.__openedPaths))
);

// Remove: cancel leaves everything untouched; confirm deletes, per-file failure stays visible.
await page.click('[data-testid="decode-select-all"]');
await wait(250);
check(
  "decode-select-all",
  /Remove selected \(3\)/.test(await page.$eval('[data-testid="decode-remove-selected"]', node => node.textContent)),
  "all three selected"
);
await page.click('[data-testid="decode-remove-selected"]');
await page.waitForSelector('[data-testid="decode-confirm-dialog"]');
const confirmItems = await page.$$eval('[data-testid="decode-confirm-list"] li', nodes => nodes.length);
check("decode-confirm-lists-files", confirmItems === 3, `${confirmItems} files listed before deletion`);
await page.screenshot({ path: join(shotDir, "09-decode-confirm.png") });
await page.click('[data-testid="decode-confirm-cancel"]');
await wait(300);
check(
  "decode-remove-cancel-safe",
  !(await page.$('[data-testid="decode-confirm-dialog"]')) &&
    (await readDecodeRows()).length === 3 &&
    (await page.evaluate(() => window.__decodeCalls.delete.length)) === 0,
  "cancel deletes nothing"
);

await page.click('[data-testid="decode-remove-selected"]');
await page.waitForSelector('[data-testid="decode-confirm-delete"]');
await page.click('[data-testid="decode-confirm-delete"]');
await page.waitForFunction(
  () => /Deleted 2 of 3/.test(document.querySelector('[data-testid="decode-action-message"]')?.textContent ?? ""),
  { timeout: 15_000 }
);
const afterDeleteRows = await readDecodeRows();
check(
  "decode-remove-confirmed",
  afterDeleteRows.length === 1 &&
    afterDeleteRows[0].name === "missing-file.flac" &&
    /Could not delete this file/.test(afterDeleteRows[0].text),
  JSON.stringify(afterDeleteRows)
);
check(
  "decode-remove-updates-library",
  (await page.evaluate(async () => (await window.cadence.library.snapshot()).tracks.length)) === 8,
  "deleted tracks left the library; the failed one stayed"
);
check(
  "decode-kept-cleared-for-deleted",
  !(await page.evaluate(() => localStorage.getItem("cadence.decodeTester.kept.v1") ?? "")).includes("broken.flac"),
  "Keep marks do not outlive deleted files"
);

// Re-scan: only the still-missing file is flagged; nothing deleted reappears.
await page.click('[data-testid="decode-scan-button"]');
const rescanStatus = await waitForDecodeComplete();
const rescanRows = await readDecodeRows();
check(
  "decode-rescan-after-delete",
  /8 files checked/.test(rescanStatus) && rescanRows.length === 1 && rescanRows[0].kind === "inaccessible",
  `${rescanStatus}; rows=${rescanRows.map(row => row.name).join(",")}`
);

// Delete the last problem (stub now succeeds) and verify the clean-library empty state.
await page.evaluate(() => {
  window.__decodeDeleteAllSucceeds = true;
});
await page.click('[data-testid="decode-select-all"]');
await page.click('[data-testid="decode-remove-selected"]');
await page.waitForSelector('[data-testid="decode-confirm-delete"]');
await page.click('[data-testid="decode-confirm-delete"]');
await page.waitForFunction(
  () => /Deleted 1 file/.test(document.querySelector('[data-testid="decode-action-message"]')?.textContent ?? ""),
  { timeout: 15_000 }
);
await page.click('[data-testid="decode-scan-button"]');
const cleanStatus = await waitForDecodeComplete();
check(
  "decode-no-errors-state",
  /7 files checked, 0 problematic/.test(cleanStatus) && Boolean(await page.$('[data-testid="decode-empty-no-errors"]')),
  cleanStatus
);
await page.screenshot({ path: join(shotDir, "10-decode-clean.png") });

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
