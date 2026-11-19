/**
 * Interactive application harness.
 *
 * Boots the production renderer bundle (`dist`) in headless Chromium with:
 *   - a stub `window.cadence` that speaks the same contract as the Tauri bridge, backed by a
 *     snapshot produced by the real main-process scanner (`tests/browser/build-library.ts`),
 *   - real generated audio files served with HTTP Range support,
 *   - the real audio engine, lyrics renderer and shader engine.
 *
 * Native window actions and dialogs are simulated. Playback, artwork decoding, lyric parsing and
 * shader rendering are the shipped code paths, not stand-ins.
 *
 * Usage (after building the renderer and preparing the audio fixtures):
 *   npx vite-node tests/browser/build-library.ts && node tests/browser/audit-ui.mjs
 * AUDIT_ONLY accepts a comma-separated list of section names.
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
const { snapshot, defaultSettings: fixtureDefaults } = JSON.parse(readFileSync(snapshotFile, "utf8"));
if (!fixtureDefaults) throw new Error("Refresh the test fixture: npx vite-node tests/browser/build-library.ts");
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
[au:Audit Writer]
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
  opus: byTitle("Fixture Opus")?.id,
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
  ".webm": "video/webm",
};

const missing = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const decode = value => decodeURIComponent(value);
  let file = null;
  if (url.pathname.startsWith("/audio/")) file = join(audioDir, decode(url.pathname.slice(7)));
  else if (url.pathname.startsWith("/media/")) file = join(audioDir, decode(url.pathname.slice(7)));
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
  results[name] = { value, status: value ? "PASS" : "FAIL", detail };
  console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const blocked = (name, detail) => {
  results[name] = { value: null, status: "BLOCKED", detail };
  console.log(`BLOCKED ${name} — ${detail}`);
};
const notTested = (name, detail) => {
  results[name] = { value: null, status: "NOT TESTED", detail };
  console.log(`NOT TESTED ${name} — ${detail}`);
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

/* Stub bridge: same contract as src/tauri/bridge.ts, backed by real library data. */
await page.evaluateOnNewDocument(
  data => {
    const { snapshot, lyricsByTrack, fixtureDefaults } = data;
    // Mirrors the Windows shell: undecorated window, so the renderer draws the title bar.
    window.__chrome = { undecorated: true, maximized: false, fullscreen: false, focused: true };
    window.__chromeListeners = new Set();
    window.__cadenceWindowActions = [];
    const SETTINGS_KEY = "cadence.harness.settings.v1";
    const defaultSettings = {
      ...fixtureDefaults,
      // This audit represents an existing install, even after the last folder is removed.
      general: { ...fixtureDefaults.general, onboardingCompleted: true },
      playback: {
        ...fixtureDefaults.playback, resumeOnLaunch: false, autoPlay: false, smartShufflePopularity: false,
      },
      appearance: { ...fixtureDefaults.appearance, accent: "#ff3d71", blurArtwork: true },
      artistImages: { ...fixtureDefaults.artistImages, enabled: false, autoFetch: false },
      lyrics: {
        ...fixtureDefaults.lyrics,
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
        ...fixtureDefaults.shaders,
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
    };
    const historyKey = "cadence.audit.history.v1";
    const readHistory = () => JSON.parse(localStorage.getItem(historyKey) ?? "[]");
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
      },
      history: {
        list: async () => readHistory(),
        add: async entry => {
          const history = readHistory();
          history.unshift({ ...entry, id: (history[0]?.id ?? 0) + 1 });
          localStorage.setItem(historyKey, JSON.stringify(history));
        },
        clear: async () => localStorage.removeItem(historyKey),
      },
      player: {
        // Stand in for the native ALAC bridge with the matching PCM fixture in this browser harness.
        prepareAlacSource: async () => "/audio/fixture.wav",
        reportState: async () => undefined,
        onCommand: listener => {
          window.__mediaCommandListener = listener;
          return () => {
            if (window.__mediaCommandListener === listener) window.__mediaCommandListener = null;
          };
        },
      },
      app: {
        openExternal: async () => undefined,
        openPath: async () => undefined,
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
      onMenuAction: listener => {
        window.__menuActionListener = listener;
        return () => {
          if (window.__menuActionListener === listener) window.__menuActionListener = null;
        };
      },
    };
  },
  { snapshot, lyricsByTrack, fixtureDefaults }
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

/* -------------------------------------------------------- audit bridge */

/** Mutable native-service stand-in; the audit itself still operates the visible production UI. */
async function installAuditBridge() {
  if (window.__audit) return;
  const initial = await window.cadence.library.snapshot();
  const LIBRARY_KEY = "cadence.audit.library.v1";
  let restored = null;
  try { restored = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "null"); } catch { restored = null; }
  const state = {
    tracks: restored?.tracks ?? structuredClone(initial.tracks),
    folders: restored?.folders ?? structuredClone(initial.folders),
    playlists: restored?.playlists ?? [],
    calls: [], delays: { search: 0, youtube: 0 }, settingsDelays: [], failSearch: false, failYoutube: false,
    chooseLyricsResult: { canceled: true }, scanErrors: structuredClone(initial.scan.errors),
  };
  const originalSettingsPatch = window.cadence.settings.patch.bind(window.cadence.settings);
  window.cadence.settings.patch = async patch => {
    const delayMs = state.settingsDelays.shift() ?? 0;
    state.calls.push(["settings-patch-start", delayMs, Date.now(), patch]);
    const result = await originalSettingsPatch(patch);
    if (delayMs) await delay(delayMs);
    state.calls.push(["settings-patch-end", delayMs, Date.now(), patch]);
    return result;
  };
  const originalResolve = window.cadence.lyrics.resolve.bind(window.cadence.lyrics);
  const originalTranslate = window.cadence.lyrics.translate.bind(window.cadence.lyrics);
  const originalRomanize = window.cadence.lyrics.romanize.bind(window.cadence.lyrics);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const persist = () => localStorage.setItem(LIBRARY_KEY, JSON.stringify({ tracks: state.tracks, folders: state.folders, playlists: state.playlists }));
  const publicPlaylist = playlist => {
    const tracks = playlist.trackIds.map(id => state.tracks.find(track => track.id === id)).filter(Boolean);
    return { id: playlist.id, name: playlist.name, description: "", createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt, trackCount: tracks.length,
      duration: tracks.reduce((sum, track) => sum + track.duration, 0), artworkUrl: tracks[0]?.artworkUrl ?? null };
  };
  const getSnapshot = () => {
    const tracks = state.tracks;
    const albums = initial.albums.filter(album => tracks.some(track => `${track.albumArtist || track.artist}\u0000${track.album}` === album.id));
    const artists = initial.artists.filter(artist => tracks.some(track => track.artist === artist.id));
    return { ...initial, tracks: structuredClone(tracks), albums: structuredClone(albums), artists: structuredClone(artists),
      playlists: state.playlists.map(publicPlaylist), folders: [...state.folders],
      counts: { ...initial.counts, tracks: tracks.length, albums: albums.length, artists: artists.length,
        playlists: state.playlists.length, duration: tracks.reduce((sum, track) => sum + track.duration, 0) },
      scan: { ...initial.scan, errors: structuredClone(state.scanErrors) } };
  };
  window.__audit = { state, getSnapshot };
  window.cadence.library.snapshot = async () => getSnapshot();
  window.cadence.library.search = async query => {
    const needle = query.toLocaleLowerCase();
    return state.tracks.filter(track => [track.title, track.artist, track.album].some(value => value.toLocaleLowerCase().includes(needle)));
  };
  window.cadence.library.setFavorite = async (id, favorite) => {
    state.calls.push(["favorite", id, favorite]);
    const track = state.tracks.find(entry => entry.id === id);
    if (track) track.favorite = favorite;
    persist();
  };
  window.cadence.library.recordPlay = async id => {
    state.calls.push(["record-play", id]);
    const track = state.tracks.find(entry => entry.id === id);
    if (track) { track.lastPlayedAt = Date.now(); track.playCount += 1; persist(); }
  };
  window.cadence.library.addFolder = async () => {
    state.calls.push(["add-folder"]);
    if (state.holdAddFolder) await new Promise(resolve => { state.finishAddFolder = resolve; });
    return { canceled: true, folders: [...state.folders] };
  };
  window.cadence.library.removeFolder = async path => {
    state.calls.push(["remove-folder", path]);
    state.folders = state.folders.filter(folder => folder !== path); state.tracks = []; state.playlists = []; persist();
    return getSnapshot();
  };
  window.cadence.library.rescan = async () => { state.calls.push(["rescan"]); return { added: 0, updated: 0, removed: 0, errors: [], durationMs: 1 }; };
  window.cadence.playlists = {
    list: async () => state.playlists.map(publicPlaylist),
    create: async (name, trackIds = []) => {
      const playlist = { id: Math.max(0, ...state.playlists.map(entry => entry.id)) + 1, name,
        trackIds: [...new Set(trackIds)], createdAt: Date.now(), updatedAt: Date.now() };
      state.playlists.unshift(playlist); state.calls.push(["playlist-create", name, [...trackIds]]); persist();
      return publicPlaylist(playlist);
    },
    rename: async (id, name) => {
      const playlist = state.playlists.find(entry => entry.id === id);
      if (playlist) { playlist.name = name; playlist.updatedAt = Date.now(); }
      state.calls.push(["playlist-rename", id, name]); persist();
    },
    remove: async id => { state.playlists = state.playlists.filter(entry => entry.id !== id); state.calls.push(["playlist-remove", id]); persist(); },
    addTracks: async (id, trackIds) => {
      const playlist = state.playlists.find(entry => entry.id === id);
      if (playlist) { playlist.trackIds.push(...trackIds.filter(trackId => !playlist.trackIds.includes(trackId))); playlist.updatedAt = Date.now(); }
      state.calls.push(["playlist-add", id, [...trackIds]]); persist();
    },
    removeTrack: async (id, trackId) => {
      const playlist = state.playlists.find(entry => entry.id === id);
      if (playlist) { playlist.trackIds = playlist.trackIds.filter(entry => entry !== trackId); playlist.updatedAt = Date.now(); }
      state.calls.push(["playlist-remove-track", id, trackId]); persist();
    },
    reorder: async () => undefined,
    tracks: async id => {
      const playlist = state.playlists.find(entry => entry.id === id);
      return (playlist?.trackIds ?? []).map(trackId => state.tracks.find(track => track.id === trackId)).filter(Boolean).map(track => structuredClone(track));
    },
  };
  window.cadence.lyrics.resolve = async request => {
    state.calls.push(["lyrics-resolve", request.trackId, Boolean(request.localOnly)]);
    if (request.title === "Fixture AAC") return { candidates: [{ source: "audit-instrumental", provider: "Audit instrumental",
      text: "Instrumental only", syncHint: "none", language: null, songwriters: ["Harness Artist"], sourceHref: null, cached: false }],
      providerStatus: [{ provider: "audit-instrumental", status: "hit" }] };
    const result = await originalResolve(request);
    if (request.title === "Fixture FLAC" && result.candidates.length > 0) result.candidates.push({ ...result.candidates[0],
      source: "audit-line-source", provider: "Audit line source", text: "[00:00.30]Alternate first line\n[00:01.60]Alternate second line", syncHint: "synced" });
    return result;
  };
  window.cadence.lyrics.search = async request => {
    state.calls.push(["lyrics-search", request.title]); await delay(state.delays.search);
    if (state.failSearch) throw new Error("Audit search failure");
    return { results: [{ source: "audit-manual-result", provider: "Audit manual provider",
      text: `[00:00.30]Manual ${request.title}\n[00:01.60]Manual second line`, syncHint: "synced", language: null,
      songwriters: [], sourceHref: null, cached: false, matchTitle: request.title, matchArtist: request.artist,
      matchAlbum: request.album, matchDuration: request.duration }], providerStatus: [{ provider: "audit-manual", status: "hit" }], cached: false };
  };
  window.cadence.lyrics.youtubeMetadata = async request => {
    state.calls.push(["youtube", request.url]); await delay(state.delays.youtube);
    if (state.failYoutube) return { ok: false, reason: "error", detail: "Audit YouTube failure" };
    return { ok: true, metadata: { videoId: "dQw4w9WgXcQ", title: "YouTube supplied title",
      artist: "YouTube supplied artist", durationSeconds: 213, thumbnailUrl: null } };
  };
  window.cadence.lyrics.translate = async request => { state.calls.push(["translate", request.targetLanguage]); return originalTranslate(request); };
  window.cadence.lyrics.romanize = async request => { state.calls.push(["romanize"]); return originalRomanize(request); };
  window.cadence.lyrics.saveSidecar = async (trackId, text) => { state.calls.push(["save-sidecar", trackId, text]); return { path: "/harness/lyrics.lrc" }; };
  window.cadence.lyrics.clearCache = async () => {
    state.calls.push(["clear-lyrics-cache"]);
    if (state.failClearCache) throw "Access is denied. (os error 5)";
    return { removedEntries: state.clearCacheRemovedEntries ?? 2 };
  };
  window.cadence.lyrics.listCache = async () => ({
    entries: [],
    stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 },
  });
  window.cadence.lyrics.getCacheEntry = async () => null;
  window.cadence.lyrics.removeCacheEntry = async () => ({
    removed: false,
    stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 },
  });
  window.cadence.lyrics.cacheChosenFile = async () => undefined;
  window.cadence.lyrics.rememberSelection = async () => undefined;
  window.cadence.app.chooseLyricsFile = async trackId => { state.calls.push(["choose-lyrics", trackId]); return structuredClone(state.chooseLyricsResult); };
  window.cadence.app.openExternal = async url => { state.calls.push(["open-external", url]); };
}
await page.evaluate(installAuditBridge);
await page.evaluateOnNewDocument(installAuditBridge);

/* --------------------------------------------------------- audit utils */
const auditDir = join(root, ".artifacts/ui-audit");
mkdirSync(auditDir, { recursive: true });
const auditShot = async name => page.screenshot({ path: join(auditDir, `${name}.png`) });
const waitForDismissal = async selector => page.waitForSelector(selector, { hidden: true, timeout: 2500 }).then(() => true, () => false);
const clickText = async (selector, wanted, exact = true) => {
  const handles = await page.$$(selector);
  for (const handle of handles) {
    const text = await handle.evaluate(node => node.textContent?.replace(/\s+/g, " ").trim() ?? "");
    if (exact ? text === wanted : text.includes(wanted)) { await handle.click(); await wait(90); return handle; }
  }
  throw new Error(`No ${selector} with text ${JSON.stringify(wanted)}; saw ${JSON.stringify(await page.$$eval(selector, nodes => nodes.map(node => node.textContent?.replace(/\s+/g, " ").trim())))}`);
};
const leaveImmersive = async () => {
  if (await page.$('button.fs-exit')) {
    await page.click('button.fs-exit');
    await page.waitForSelector('.sidebar');
    await page.waitForSelector('[data-player-moving]', { hidden: true, timeout: 3000 });
  }
};
const openLegacyLyrics = async () => {
  await leaveImmersive();
  await page.evaluate(() => { location.hash = "#/lyrics"; });
  await page.waitForSelector('.lyrics-view:not(.is-fullscreen)', { timeout: 5000 });
  await wait(240);
};
const nav = async label => {
  await leaveImmersive();
  if (label === "Now Playing") {
    await page.click('[data-testid="open-now-playing"]');
    await page.waitForSelector('.lyrics-view.is-fullscreen');
    return;
  }
  if (label === "Playlists") {
    const disclosure = await page.$('.nav-section-toggle[title="Playlists"][aria-expanded="false"]');
    if (disclosure) { await disclosure.click(); await wait(210); }
    label = "All playlists";
  }
  await clickText(".sidebar .nav-item", label);
  await wait(140);
};
const settingsTab = async label => { await clickText(".settings-tabs button", label); await wait(80); };
const resetAllSettings = async () => {
  await settingsTab("About");
  page.once("dialog", dialog => dialog.accept());
  await page.click('[data-testid="settings-reset-all"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="app-toast"]')?.textContent?.includes("restored to defaults"), { timeout: 4000 });
};
const settingRow = async label => {
  for (const row of await page.$$(".setting-row")) {
    const strong = await row.$("strong");
    const text = strong ? await strong.evaluate(node => node.textContent?.trim()) : "";
    if (text === label) return row;
  }
  throw new Error(`No setting row ${label}`);
};
const toggleSetting = async label => { const row = await settingRow(label); const input = await row.$('input[type="checkbox"]'); await input.click(); await wait(100); };
const selectSetting = async (label, value) => { const row = await settingRow(label); const input = await row.$("select"); await input.select(String(value)); await wait(100); };
const rangeSetting = async (label, key = "End") => {
  const row = await settingRow(label); const input = await row.$('input[type="range"]');
  await input.focus(); await page.keyboard.press(key); await wait(100);
  return input.evaluate(node => ({ value: node.value, output: node.closest(".setting-row")?.querySelector("output")?.textContent }));
};
const trackRow = async title => {
  for (const row of await page.$$('[data-testid="track-row"]')) if ((await row.$eval(".title-text", node => node.textContent?.trim())) === title) return row;
  throw new Error(`No track row ${title}`);
};
const playTrack = async title => { const row = await trackRow(title); await row.click(); await wait(650); };
const pausePlayback = async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await audioState()).paused) return;
    await page.click('[data-testid="play-toggle"]');
    await wait(250);
  }
};
const openTrackMenu = async title => { const row = await trackRow(title); const more = await row.$('button[aria-label="More actions"]'); await more.click(); await page.waitForSelector(".context-menu"); await wait(60); };
const playerTitle = async () => page.$eval(".player-title", node => node.textContent?.trim());
const setShuffle = async wanted => {
  const button = await page.$('.player-bar button[aria-label="Shuffle"]');
  if ((await button.evaluate(node => node.getAttribute("aria-pressed") === "true")) !== wanted) await button.click();
  await wait(100);
};
const queueState = async () => page.evaluate(() => {
  const rows = [...document.querySelectorAll(".queue-list li")];
  return { titles: rows.map(row => row.querySelector(".queue-track strong")?.textContent?.trim()), current: rows.findIndex(row => row.classList.contains("current")) };
});
const queuePanel = '[data-testid="queue-panel"]';
const openQueue = async () => {
  if (await page.$(`${queuePanel}.is-exiting`)) await page.waitForSelector(queuePanel, { hidden: true });
  if (!(await page.$(queuePanel))) {
    const immersive = Boolean(await page.$('.lyrics-view.is-fullscreen'));
    const selector = `${immersive ? '[data-testid="fullscreen-controls"]' : '.player-bar'} button[aria-label="Queue"]`;
    if (immersive) {
      const point = await page.$eval(selector, node => {
        const box = node.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      await page.mouse.move(100, 180);
      await page.mouse.move(point.x, point.y);
      await page.waitForFunction(sel => {
        const node = document.querySelector(sel);
        const box = node?.getBoundingClientRect();
        return box && node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }, { timeout: 4000 }, selector);
    }
    await page.click(selector);
  }
  await page.waitForSelector(`${queuePanel}[data-presence="entered"]`);
};
const closeQueue = async () => {
  if (await page.$(`${queuePanel}:not(.is-exiting)`)) await page.click('button[aria-label="Close queue"]');
  await page.waitForSelector(queuePanel, { hidden: true });
};
const openLyricsSources = async () => {
  await clickText(".dock-button", "Source", false);
  await page.waitForSelector('.dock-sources[data-presence="entered"]', { timeout: 4000 });
};
const openManualLyricsSearch = async () => {
  await openLyricsSources();
  await clickText(".dock-sources .manual-search-entry", "Search Manually", false);
  await page.waitForSelector('.dock-search[data-presence="entered"]', { timeout: 4000 });
};
const storedSettings = async () => page.evaluate(() => JSON.parse(localStorage.getItem("cadence.harness.settings.v1") || "{}"));
const storedSession = async () => page.evaluate(() => JSON.parse(localStorage.getItem("cadence.session.v1") || "null"));
const selectedSections = new Set(process.env.AUDIT_ONLY?.split(",").map(name => name.trim()).filter(Boolean));
const unmatchedSections = new Set(selectedSections);
const runSection = async (name, fn) => {
  if (selectedSections.size && !selectedSections.has(name)) return;
  unmatchedSections.delete(name);
  try { await fn(); } catch (error) {
    check(name, false, `${error.message}; route=${await page.evaluate(() => location.hash)}`);
    await auditShot(`error-${name}`);
  }
};

await runSection("sidebar-disclosures-complete", async () => {
  await page.evaluate(async () => {
    const { state } = window.__audit;
    state.tracks.forEach((track, i) => { track.addedAt = 10_000 + i; });
    for (let i = 1; i <= 10; i++) await window.cadence.playlists.create(`Disclosure fixture ${i}`);
  });
  await page.reload({ waitUntil: "networkidle0" });
  await nav("Recently Added");
  const newestFirst = await page.evaluate(() => {
    const expected = [...window.__audit.state.tracks].sort((a, b) => b.addedAt - a.addedAt).map(track => track.title);
    const rendered = [...document.querySelectorAll('.library-view .track-row .title-text')].map(node => node.textContent.trim());
    return rendered.length > 0 && rendered.every((title, i) => title === expected[i]);
  });
  check("sidebar-recently-added-is-newest-first", newestFirst);
  await nav("Playlists");
  const inventory = await page.evaluate(() => ({
    linked: [...document.querySelectorAll('#sidebar-playlists .sidebar-link')].map(node => node.title),
    expected: window.__audit.state.playlists.map(playlist => playlist.name),
  }));
  check("sidebar-lists-all-playlists", inventory.linked.length >= 10 && JSON.stringify(inventory.linked) === JSON.stringify(inventory.expected), JSON.stringify(inventory));
  await page.click('.nav-section-toggle[title="Playlists"]');
  await wait(230);
  check("collapsed-playlists-keeps-route-and-hides-links", await page.evaluate(() => document.getElementById("sidebar-playlists").inert && location.hash.endsWith("/playlists")));
  const target = await page.evaluate(() => window.__audit.state.playlists.at(-1));
  await page.setViewport({ width: 1040, height: 680 });
  await page.evaluate(id => { location.hash = `#/playlist/${id}`; }, target.id);
  await page.waitForSelector('#sidebar-playlists .sidebar-link[aria-current="location"]', { timeout: 3000 });
  const visibleTarget = await page.$eval('#sidebar-playlists .sidebar-link[aria-current="location"]', node => {
    node.scrollIntoView({ block: "nearest" });
    return node.title === "Disclosure fixture 1" && node.getBoundingClientRect().bottom <= document.querySelector(".sidebar-scroll").getBoundingClientRect().bottom + 1;
  });
  check("playlist-deep-link-expands-section-and-is-reachable-by-scroll", visibleTarget, target.name);
  await page.setViewport({ width: 1440, height: 900 });
  await nav("Home");
});

await runSection("sidebar-fetch-all-completes", async () => {
  await page.evaluate(() => {
    const build = state => ({ jobId: "sidebar-audit", state, total: 10, processed: 5, found: 3, notFound: 1, failed: 1, skipped: 0,
      currentTrack: { id: 3, title: "Fixture MP3", artist: "Harness Artist" }, startedAt: Date.now(), finishedAt: null });
    window.cadence.lyrics.fetchAll = {
      stats: async () => ({ totalTracks: 10, withLyrics: 3, needsSearch: 7, fullyProcessed: 5 }),
      // Autofetch calls this during playback, including when provider priority changes.
      promote: async () => undefined,
    };
    for (const [action, state] of Object.entries({ start: "running", pause: "paused", resume: "running", retryFailed: "running", cancel: "canceled" })) {
      window.cadence.lyrics.fetchAll[action] = async () => {
        window.__audit.state.calls.push([`fetch-${action}`]);
        return build(state);
      };
    }
  });
  await page.setViewport({ width: 1040, height: 680 });
  await nav("Settings"); await settingsTab("Lyrics");
  await page.click('[data-testid="fetch-all-start"]');
  await page.waitForSelector('.sidebar-tools [data-testid="fetch-all-indicator"][data-state="running"]');
  await nav("Home");
  await page.click('[data-testid="fetch-all-indicator"]');
  await page.waitForSelector('.fetch-panel:not([inert])'); await wait(210);
  const bounds = await page.$eval(".fetch-panel", node => {
    const { left, right, top, bottom } = node.getBoundingClientRect();
    return { left, right, top, bottom, room: left >= 0 && right <= innerWidth && top >= 0 && bottom < innerHeight };
  });
  check("sidebar-fetch-all-popover-not-clipped", bounds.room && Boolean(await page.$('[data-testid="fetch-count-found"]')), JSON.stringify(bounds));
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="fetch-all-panel"]', { hidden: true });
  check("sidebar-fetch-all-keyboard-focus-returns", await page.evaluate(() => document.activeElement?.matches('[data-testid="fetch-all-indicator"]')));
  await page.keyboard.press("Enter");
  await page.waitForSelector('.fetch-panel:not([inert])');
  await clickText(".fetch-panel button", "Pause");
  await clickText(".fetch-panel button", "Resume");
  await clickText(".fetch-panel button", "Pause");
  await page.click('[data-testid="fetch-retry-failed"]');
  await page.click('[data-testid="fetch-cancel"]');
  await page.waitForSelector('[data-testid="fetch-all-panel"]', { hidden: true });
  const actions = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0].startsWith("fetch-")).map(call => call[0]));
  check("sidebar-fetch-all-commands", actions.join(",") === "fetch-start,fetch-pause,fetch-resume,fetch-pause,fetch-retryFailed,fetch-cancel", actions.join(","));
  await page.setViewport({ width: 1480, height: 900 });
});

await runSection("sidebar-new-playlist-completes", async () => {
  await nav("Playlists");
  await page.click('.sidebar button[aria-label="New playlist"]');
  await wait(120);
  check("sidebar-new-playlist-opens-form", Boolean(await page.$(".inline-create input")), "sidebar + should open the playlist-name form");
  await page.type('.inline-create input[placeholder="Playlist name"]', "Sidebar Mix");
  await clickText(".inline-create button", "Create");
  await page.waitForSelector('.detail-view .detail-meta h1');
  check("sidebar-new-playlist-creates-and-opens-the-real-playlist", await page.evaluate(() =>
    location.hash.startsWith("#/playlist/") &&
    document.querySelector('.detail-meta h1')?.textContent === "Sidebar Mix" &&
    Boolean(document.querySelector('.sidebar-link[aria-current="location"][title="Sidebar Mix"]'))));
});

await runSection("playback-settings-completes", async () => {
  await nav("Settings"); await settingsTab("Playback");
  await selectSetting("Playback speed", 2);
  check("playback-speed-applies-live", (await page.$eval("audio", node => node.playbackRate)) === 2, `audio rate=${await page.$eval("audio", node => node.playbackRate)}`);
  await selectSetting("Repeat", "one");
  check("repeat-setting-synchronizes-transport", Boolean(await page.$('.player-bar button[aria-label="Repeat: one"]')), "Playback repeat selector should drive the transport");
  const shuffleRow = await settingRow("Shuffle by default");
  if (!(await shuffleRow.$eval('input[type="checkbox"]', node => node.checked))) await toggleSetting("Shuffle by default");
  check("shuffle-setting-synchronizes-transport", (await page.$eval('.player-bar button[aria-label="Shuffle"]', node => node.getAttribute("aria-pressed"))) === "true", "setting enabled");
  const repeatBefore = await page.$eval('.player-bar button[aria-label^="Repeat:"]', node => node.getAttribute("aria-label"));
  await page.click('.player-bar button[aria-label^="Repeat:"]');
  const repeatAfter = await page.$eval('.player-bar button[aria-label^="Repeat:"]', node => node.getAttribute("aria-label"));
  const expectedRepeat = repeatAfter.replace("Repeat: ", "");
  const shownRepeat = await (await settingRow("Repeat")).$eval("select", node => node.value);
  check("transport-repeat-synchronizes-setting", shownRepeat === expectedRepeat, `${repeatBefore} → ${repeatAfter}; settings=${shownRepeat}`);
  await nav("Songs"); await setShuffle(true); await nav("Settings"); await settingsTab("Playback");
  await resetAllSettings();
  const resetState = await page.evaluate(() => ({ rate: document.querySelector("audio")?.playbackRate,
    repeat: document.querySelector('.player-bar button[aria-label^="Repeat:"]')?.getAttribute("aria-label"),
    shuffle: document.querySelector('.player-bar button[aria-label="Shuffle"]')?.getAttribute("aria-pressed") }));
  check("reset-all-applies-playback-defaults", resetState.rate === 1 && resetState.repeat === "Repeat: off" && resetState.shuffle === "false", JSON.stringify(resetState));
});

await runSection("appearance-settings-completes", async () => {
  await nav("Settings"); await settingsTab("Appearance");
  const before = await page.$eval(".sidebar", node => node.getBoundingClientRect().width);
  await toggleSetting("Compact sidebar");
  const after = await page.$eval(".sidebar", node => node.getBoundingClientRect().width);
  check("compact-sidebar-changes-layout", after < before, `${before}px → ${after}px`);
  await toggleSetting("Compact sidebar");
  await toggleSetting("Verbose shader logs"); await openLegacyLyrics(); await wait(500);
  const verboseLogs = logs.filter(line => /kawarp|shader/i.test(line) && /debug|log/i.test(line));
  check("verbose-shader-logs-produce-diagnostics", verboseLogs.length > 0, JSON.stringify(verboseLogs.slice(-3)));
});

await runSection("recent-play-completes", async () => {
  await nav("Songs"); await setShuffle(false); await playTrack("Fixture FLAC");
  check("real-audio-started", !(await audioState()).paused, await playerTitle());
  await nav("Home");
  const recentText = await page.$eval('[data-testid="home-recently-played"]', node => node.textContent ?? "");
  check("recently-played-records-real-playback", recentText.includes("Fixture FLAC"), recentText || "Recently played shelf missing");
});

await runSection("queue-regressions-completes", async () => {
  await nav("Songs"); await setShuffle(true); await playTrack("Fixture FLAC");
  const before = { title: await playerTitle(), src: (await audioState()).src };
  await setShuffle(false);
  const after = { title: await playerTitle(), src: (await audioState()).src };
  check("shuffle-off-preserves-current-track", before.title === after.title && before.src === after.src, `${before.title} → ${after.title}; audio ${before.src.split("/").pop()} → ${after.src.split("/").pop()}`);
  await playTrack("Fixture FLAC"); await openTrackMenu("Fixture Opus"); await clickText(".context-menu button", "Play next"); await openQueue();
  const queue = await queueState();
  check("play-next-moves-existing-track", queue.titles[queue.current + 1] === "Fixture Opus", `current=${queue.titles[queue.current]}, next=${queue.titles[queue.current + 1]}`);
  await closeQueue();
  await page.click("#global-search"); await page.type("#global-search", "Fixture "); await wait(500);
  await setShuffle(true); await playTrack("Fixture MP3");
  const shuffledBefore = { title: await playerTitle(), src: (await audioState()).src };
  await nav("Songs"); await openTrackMenu("broken"); await clickText(".context-menu button", "Play next");
  const shuffledAfter = { title: await playerTitle(), src: (await audioState()).src };
  check("play-next-shuffled-preserves-current-track", shuffledBefore.title === shuffledAfter.title && shuffledBefore.src === shuffledAfter.src, `${shuffledBefore.title} → ${shuffledAfter.title}`);
  await setShuffle(false); await nav("Songs");
  // Use a known playable track with an earlier row in title order. Queue jumps have their
  // own check; removing an earlier row should not reload or advance the current occurrence.
  const currentTitle = "Fixture FLAC";
  const currentSrc = new URL(byTitle(currentTitle).streamUrl, base).href;
  const row = await trackRow(currentTitle);
  await (await row.$(".track-play")).click();
  await page.waitForFunction(src => {
    const audio = document.querySelector("audio");
    return audio?.currentSrc === src && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }, { timeout: 4000 }, currentSrc);
  await pausePlayback();
  await openQueue();
  try {
    const original = await queueState();
    if (original.current < 1 || original.titles[original.current] !== currentTitle) {
      throw new Error(`Expected ${currentTitle} with an earlier queue entry; ${JSON.stringify(original)}`);
    }
    await page.click('.queue-list li:first-child button[aria-label^="Remove "]');
    await page.waitForFunction(count => document.querySelectorAll('.queue-list li').length === count, { timeout: 4000 }, original.titles.length - 1);
    const removedState = { title: await playerTitle(), src: (await audioState()).src, queue: await queueState() };
    check("remove-earlier-queue-entry-preserves-current", removedState.title === currentTitle && removedState.src === currentSrc &&
      removedState.queue.current === original.current - 1 && removedState.queue.titles[removedState.queue.current] === currentTitle,
    JSON.stringify(removedState));
  } finally {
    await closeQueue();
  }
});

await runSection("session-position-completes", async () => {
  await nav("Settings"); await settingsTab("Playback");
  const row = await settingRow("Restore the last session on launch");
  if (!(await row.$eval('input[type="checkbox"]', node => node.checked))) await toggleSetting("Restore the last session on launch");
  await nav("Songs"); await setShuffle(false); await playTrack("Fixture FLAC"); await wait(1700);
  const session = await storedSession();
  check("playback-position-persists-continuously", (session?.position ?? 0) > 0.5, `stored position=${session?.position}`);
});

await runSection("instrumental-setting-completes", async () => {
  await nav("Songs"); await playTrack("Fixture AAC"); await pausePlayback(); await openLegacyLyrics();
  await page.waitForSelector(`.lyrics-view[data-current-source-key="local:${ids.aac}"] .blyrics--line`, { timeout: 8000 });
  const before = await page.$$eval(".blyrics--line", nodes => nodes.length);
  await nav("Settings"); await settingsTab("Lyrics"); await toggleSetting("Hide instrumental-only placeholders"); await openLegacyLyrics(); await wait(400);
  const after = await page.$$eval(".blyrics--line", nodes => nodes.length);
  check("hide-instrumental-only-hides-placeholder", before > 0 && after === 0, `${before} → ${after} lines`);
});

await runSection("lyrics-request-dedup-completes", async () => {
  await nav("Songs");
  if (await playerTitle() === "Fixture Opus") await playTrack("Fixture FLAC");
  const count = () => page.evaluate(id => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve" && call[1] === id).length, ids.opus);
  const initial = await count();
  // Online autofetch starts a local fallback and then the full resolve. Neither should
  // be issued again when the lyrics route remounts.
  const expected = await page.evaluate(async () => (await window.cadence.settings.get()).lyrics.autoFetch ? 2 : 1);
  await playTrack("Fixture Opus"); await pausePlayback(); await openLegacyLyrics();
  await page.waitForSelector(`.lyrics-view[data-current-source-key="local:${ids.opus}"] [data-testid="lyrics-empty-panel"]`, { timeout: 8000 });
  const before = await count(); await nav("Songs"); await openLegacyLyrics(); await wait(500); const after = await count();
  check("empty-lyrics-remount-does-not-duplicate-request", before - initial === expected && after === before, `${initial} → ${before} → ${after} resolve calls`);
});

await runSection("manual-search-clear-completes", async () => {
  await closeQueue();
  await openManualLyricsSearch();
  await page.evaluate(() => { window.__audit.state.delays.youtube = 900; });
  await page.type('input[aria-label="YouTube link (optional)"]', "https://youtu.be/dQw4w9WgXcQ"); await wait(680);
  await page.click('button[aria-label="Clear query and results"]'); await wait(1150);
  check("clear-search-invalidates-pending-youtube", !(await page.$('[data-testid="youtube-metadata"]')), "no stale YouTube card after clear");
  await page.evaluate(() => { window.__audit.state.delays.search = 900; window.__audit.state.delays.youtube = 0; });
  await (await page.$(".search-submit")).click(); await wait(80); await page.click('button[aria-label="Clear query and results"]'); await wait(1100);
  const manualFeedback = await page.evaluate(() => ({ results: document.querySelectorAll(".dock-search > .source-row").length,
    feedback: document.querySelector(".search-feedback")?.textContent ?? "" }));
  check("clear-search-invalidates-pending-manual-search", manualFeedback.results === 0 && !manualFeedback.feedback.includes("Manual"), JSON.stringify(manualFeedback));
});

await runSection("shader-static-opacity-completes", async () => {
  await nav("Songs"); await playTrack("Fixture FLAC"); await nav("Settings"); await settingsTab("Appearance");
  await selectSetting("Performance mode", "off"); await rangeSetting("Opacity", "Home"); await openLegacyLyrics(); await wait(250);
  const opacity = await page.$eval(".kawarp-bg", node => getComputedStyle(node).opacity);
  check("static-shader-opacity-applies", Number(opacity) < 0.05, `computed opacity=${opacity}`);
});

await runSection("keyboard-and-menu-completes", async () => {
  await nav("Songs"); await playTrack("Fixture FLAC"); const beforeTitle = await playerTitle();
  const next = await page.$('.player-bar button[aria-label="Next track"]'); await next.focus(); await page.keyboard.press("Space"); await wait(500);
  check("space-activates-focused-transport-button", (await playerTitle()) !== beforeTitle, `${beforeTitle} → ${await playerTitle()}`);
  await page.setViewport({ width: 800, height: 600 }); await nav("Songs");
  await page.evaluate(() => { const scroller = document.querySelector(".content-scroll"); scroller.scrollTop = scroller.scrollHeight; }); await wait(250);
  await openTrackMenu("fixture");
  const menuBox = await page.$eval(".context-menu", node => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight }; });
  check("context-menu-stays-in-viewport", menuBox.top >= 0 && menuBox.bottom <= menuBox.viewport, JSON.stringify(menuBox));
  await page.keyboard.press("Escape"); await page.setViewport({ width: 1480, height: 900 });
});

await runSection("blur-artwork-completes", async () => {
  await nav("Songs"); await playTrack("Fixture FLAC");
  const style = await page.$eval(".player-bar", node => ({ before: getComputedStyle(node, "::before").backgroundImage, own: getComputedStyle(node).backgroundImage }));
  check("blur-artwork-has-visible-artwork-layer", `${style.before} ${style.own}`.includes("artwork"), JSON.stringify(style));
});

/* --------------------------------------------------- exhaustive UI flow */

await runSection("expanded-navigation-completes", async () => {
  await nav("Settings"); await resetAllSettings();
  const destinations = [
    ["Home", "home-view"], ["History", "history-view"], ["Stats", "stats-view"],
    ["Songs", "library-view-songs"], ["Albums", "library-view-albums"],
    ["Artists", "library-view-artists"], ["Recently Added", "library-view-recently-added"], ["Playlists", "library-view-playlists"],
    ["Liked songs", "library-view-favorites"], ["Now Playing", "lyrics-view"], ["Settings", "settings-view"],
  ];
  for (const [label, testId] of destinations) {
    await nav(label);
    check(`nav-${testId}`, Boolean(await page.$(`[data-testid="${testId}"]`)), label);
  }
  await nav("Albums"); await nav("Artists");
  await page.click('.title-bar-nav button[aria-label="Back"]'); await wait(150);
  check("titlebar-back", Boolean(await page.$('[data-testid="library-view-albums"]')), await page.evaluate(() => location.hash));
  await page.click('.title-bar-nav button[aria-label="Forward"]'); await wait(150);
  check("titlebar-forward", Boolean(await page.$('[data-testid="library-view-artists"]')), await page.evaluate(() => location.hash));
  const brand = await page.$(".brand"); await brand.focus(); await page.keyboard.press("Enter"); await wait(120);
  check("brand-enter-home", Boolean(await page.$('[data-testid="home-view"]')), "Enter");
  await nav("Songs"); await brand.focus(); await page.keyboard.press("Space"); await wait(120);
  check("brand-space-home", Boolean(await page.$('[data-testid="home-view"]')), "Space");
  await nav("Home");
  check("home-no-shortcut-row-or-recently-added", !(await page.$(".quick-row")) &&
    !(await page.$$eval(".home-view h2", headings => headings.some(node => node.textContent?.toLowerCase().includes("recently added")))));
  const recents = '[data-testid="home-recently-played"]';
  if (!(await page.$(recents))) {
    await nav("Songs"); await playTrack("Fixture FLAC"); await nav("Home");
  }
  await clickText(`${recents} .shelf-heading button`, "History");
  check("recently-played-history-link", Boolean(await page.$('[data-testid="history-view"]')), "opens listening history");
  await nav("Home"); await page.click(`${recents} [data-testid="recently-played-item"]`); await wait(400);
  check("recently-played-track-plays", !(await audioState()).paused, await playerTitle());
  await clickText(".home-albums .shelf-heading button", "All albums");
  check("albums-show-all", Boolean(await page.$('[data-testid="library-view-albums"]')), "All albums");
});

await runSection("expanded-library-completes", async () => {
  await nav("Songs");
  const readTitles = () => page.$$eval('[data-testid="library-track-list"] .title-text', nodes => nodes.map(node => node.textContent.trim()));
  const sorts = ["title", "artist", "album", "added", "duration"];
  for (const sort of sorts) {
    await page.select(".sort-select select", sort); await wait(100);
    const titles = await readTitles();
    check(`library-sort-${sort}`, titles.length === 8 && (await page.$eval(".sort-select select", node => node.value)) === sort, `${titles[0]} … ${titles.at(-1)}`);
  }
  await page.type('input[placeholder="Filter songs"]', "opus"); await wait(200);
  check("library-filter", (await readTitles()).join(",") === "Fixture Opus", (await readTitles()).join(","));
  const filter = await page.$('input[placeholder="Filter songs"]'); await filter.focus();
  await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control"); await page.keyboard.press("Backspace"); await wait(150);
  check("library-filter-clear", (await readTitles()).length === 8, `${(await readTitles()).length} rows`);
  const flacRow = await trackRow("Fixture FLAC");
  await (await flacRow.$('button[aria-label="Add to favourites"]')).click(); await wait(120);
  await nav("Liked songs");
  check("favourite-appears-in-liked", Boolean(await trackRow("Fixture FLAC")), "hearted row");
  const likedRow = await trackRow("Fixture FLAC");
  await (await likedRow.$('button[aria-label="Remove from favourites"]')).click(); await wait(120);
  check("favourite-removes-from-liked", (await page.$$('[data-testid="library-track-list"] [data-testid="track-row"]')).length === 0, "empty liked list");
  await nav("Songs"); await openTrackMenu("Fixture FLAC"); await clickText(".context-menu button", "Go to album");
  check("context-go-to-album", (await page.$eval(".detail-meta h1", node => node.textContent.trim())) === "Test Bench", await page.evaluate(() => location.hash));
  await page.click('.title-bar-nav button[aria-label="Back"]'); await wait(500);
  check("detail-back", Boolean(await page.$('[data-testid="library-view-songs"]')), await page.evaluate(() => location.hash));
  await nav("Albums");
  const albumCard = await page.$('[data-testid="album-card"] .card-open'); await albumCard.focus(); await page.keyboard.press("Enter"); await wait(150);
  check("album-card-keyboard-open", Boolean(await page.$(".detail-hero")), "Enter");
  await page.click(".detail-path button"); await wait(150);
  check("album-breadcrumb-opens-collection", Boolean(await page.$('[data-testid="library-view-albums"]')), await page.evaluate(() => location.hash));
  await nav("Artists"); const artistCard = await page.$(".artist-card"); await artistCard.focus(); await page.keyboard.press("Space"); await wait(150);
  check("artist-card-keyboard-open", Boolean(await page.$(".detail-hero")), "Space");
});

await runSection("expanded-playlist-completes", async () => {
  await nav("Playlists"); await clickText(".heading-actions button", "New playlist");
  await clickText(".inline-create button", "Cancel");
  check("playlist-create-cancel", !(await page.$(".inline-create")), "form closed");
  await clickText(".heading-actions button", "New playlist");
  await clickText(".inline-create button", "Create");
  check("playlist-blank-name-stays", Boolean(await page.$(".inline-create")), "blank name not submitted");
  await page.type('.inline-create input[placeholder="Playlist name"]', "Audit Mix");
  await clickText(".inline-create button", "Create"); await wait(250);
  check("playlist-create", (await page.$eval(".detail-meta h1", node => node.textContent.trim())) === "Audit Mix", "detail opened");
  await clickText(".detail-hero button", "Rename");
  await clickText(".inline-create button", "Cancel");
  check("playlist-rename-cancel", (await page.$eval(".detail-meta h1", node => node.textContent.trim())) === "Audit Mix", "unchanged");
  await clickText(".detail-hero button", "Rename");
  const rename = await page.$('.inline-create input[name="name"]'); await rename.focus();
  await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control"); await page.keyboard.type("Audit Mix Renamed");
  await clickText(".inline-create button", "Save"); await wait(200);
  check("playlist-rename-save", (await page.$eval(".detail-meta h1", node => node.textContent.trim())) === "Audit Mix Renamed", "saved title");
  await clickText(".detail-hero button", "Add songs", false); await page.type('.modal input[placeholder="Search your library"]', "FLAC"); await wait(100);
  check("playlist-add-search", (await page.$$(".modal-row")).length === 1, `${(await page.$$(".modal-row")).length} candidate`);
  await (await page.$(".modal-row")).click(); await wait(180); await page.click('.modal-header button[aria-label="Close"]');
  check("playlist-add-song", Boolean(await trackRow("Fixture FLAC")), "track row added");
  await clickText(".detail-hero button", "Add songs", false);
  await page.mouse.click(5, 120);
  check("playlist-add-backdrop-close", await waitForDismissal(".modal-backdrop"), "backdrop");
  await openTrackMenu("Fixture FLAC"); await clickText(".context-menu button", "Remove"); await wait(180);
  check("playlist-remove-song", (await page.$$('[data-testid="playlist-track-list"] [data-testid="track-row"]')).length === 0, "empty playlist");
  await nav("Songs"); await openTrackMenu("Fixture FLAC"); await clickText(".context-menu button", "Add to playlist…");
  await clickText(".modal-row.simple", "Audit Mix Renamed", false); await wait(150);
  check("playlist-picker-add-existing", (await page.evaluate(() => window.__audit.state.playlists.find(list => list.name === "Audit Mix Renamed")?.trackIds.length)) === 1, "one track");
  await clickText(".sidebar-link", "Audit Mix Renamed");
  check("sidebar-playlist-link", Boolean(await trackRow("Fixture FLAC")), "dynamic sidebar destination");
  await nav("Playlists");
  check("playlist-row-visible", Boolean(await clickText(".playlist-open", "Audit Mix Renamed", false)), "open row");
  await nav("Songs"); await openTrackMenu("Fixture MP3"); await clickText(".context-menu button", "Add to playlist…");
  await page.type('.modal input[placeholder="New playlist name"]', "Picker Mix"); await clickText(".modal .inline-create button", "Create", false); await wait(180);
  check("playlist-picker-create", (await page.evaluate(() => window.__audit.state.playlists.find(list => list.name === "Picker Mix")?.trackIds.length)) === 1, "created with selected track");
  await nav("Playlists");
  const deleteButton = await page.$('button[aria-label="Delete Picker Mix"]'); await deleteButton.click(); await wait(180);
  check("playlist-delete", !(await page.$('button[aria-label="Delete Picker Mix"]')), "deleted row");
});

await runSection("expanded-settings-completes", async () => {
  await nav("Settings"); await resetAllSettings(); await settingsTab("Appearance");
  const expectations = [];
  const selectedSettingsTab = () => page.$eval('.settings-tabs [aria-current="location"]', node => node.textContent.trim());
  const remember = async (label, kind = "value") => {
    const row = await settingRow(label); const input = await row.$("input, select, textarea");
    expectations.push({ label, kind, tab: await selectedSettingsTab(), value: kind === "checked" ? await input.evaluate(node => node.checked) : await input.evaluate(node => node.value) });
  };
  await selectSetting("Font", "monospace");
  check("font-applies-globally", (await page.$eval(".font-preview", node => getComputedStyle(node).fontFamily)).includes("monospace"), await page.$eval(".font-preview", node => getComputedStyle(node).fontFamily));
  await remember("Font");
  await toggleSetting("Reduce motion");
  check("reduce-motion-applies", (await page.$eval("html", node => node.dataset.reduceMotion)) === "true", "root dataset");
  await remember("Reduce motion", "checked");
  check("appearance-only-has-visual-controls", Boolean(await page.$('[data-testid="settings-now-playing"]')) &&
    Boolean(await page.$('[data-testid="settings-shaders"]')) && !(await page.$('[data-testid="settings-lyrics"], [data-testid="settings-reset-all"]')));
  await settingsTab("Lyrics");
  check("lyrics-controls-are-in-the-lyrics-tab", Boolean(await page.$('[data-testid="settings-lyrics"] .provider-order')) &&
    await page.$$eval('[data-testid="settings-lyrics"] .lyrics-ai-section h3', nodes => nodes.map(node => node.textContent).join(", ")) === "AI Translation, AI Romanization");
  await nav("Home"); await nav("Settings");
  check("settings-recall-the-lyrics-tab", await selectedSettingsTab() === "Lyrics");
  await toggleSetting("Fetch lyrics online"); await remember("Fetch lyrics online", "checked");
  await toggleSetting("Romanize non-Latin lyrics"); await remember("Romanize non-Latin lyrics", "checked");
  await toggleSetting("Show songwriters"); await remember("Show songwriters", "checked");
  await toggleSetting("Auto-scroll unsynced lyrics"); await remember("Auto-scroll unsynced lyrics", "checked");
  await toggleSetting("Hide instrumental-only placeholders"); await remember("Hide instrumental-only placeholders", "checked");
  await selectSetting("Translation language", "es"); await remember("Translation language");
  await selectSetting("Theme", "custom");
  check("custom-theme-editor-opens", Boolean(await page.$('.settings-lyrics textarea, [data-testid="settings-lyrics"] textarea')), "textarea");
  await page.type('[data-testid="settings-lyrics"] textarea', ".blyrics-container { --audit-theme: 1; }");
  const customCss = await page.$eval('[data-testid="settings-lyrics"] textarea', node => node.value);
  check("custom-theme-css-persist-write", (await storedSettings()).lyrics.customThemeCss === customCss, customCss);

  const rangeGroups = [
    ["Font size", "lyrics"], ["Translation Font Size", "lyrics"], ["Romanization Font Size", "lyrics"],
    ["Font weight", "lyrics"], ["Line height", "lyrics"], ["Active line opacity", "lyrics"],
    ["Inactive line opacity", "lyrics"], ["Scroll target", "lyrics"], ["Timing offset", "lyrics"],
    ["Opacity", "shaders"], ["Warp intensity", "shaders"], ["Blur passes", "shaders"],
    ["Animation speed", "shaders"], ["Transition duration", "shaders"], ["Saturation", "shaders"],
    ["Dithering", "shaders"], ["Beat threshold", "shaders"], ["Beat speed multiplier", "shaders"],
    ["Beat zoom boost (%)", "shaders"], ["Dim strength", "shaders"],
  ];
  for (const [label, group] of rangeGroups) {
    const tab = group === "lyrics" ? "Lyrics" : "Appearance";
    if (await selectedSettingsTab() !== tab) await settingsTab(tab);
    const row = await settingRow(label); const input = await row.$('input[type="range"]');
    await input.focus(); await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight"); await wait(60);
    const value = await input.evaluate(node => node.value);
    const output = await row.$eval("output", node => node.textContent.trim());
    const stored = await storedSettings();
    const property = ({ "Font size": "fontSizeRem", "Translation Font Size": "translationFontSizePx",
      "Romanization Font Size": "romanizationFontSizePx", "Font weight": "fontWeight", "Line height": "lineHeight",
      "Active line opacity": "activeOpacity", "Inactive line opacity": "inactiveOpacity", "Scroll target": "targetScrollRatio",
      "Timing offset": "offsetMs", Opacity: "kawarpOpacity", "Warp intensity": "kawarpWarpIntensity", "Blur passes": "kawarpBlurPasses",
      "Animation speed": "kawarpAnimationSpeed", "Transition duration": "kawarpTransitionDuration", Saturation: "kawarpSaturation",
      Dithering: "kawarpDithering", "Beat threshold": "audioBeatThreshold", "Beat speed multiplier": "audioSpeedMultiplier",
      "Beat zoom boost (%)": "kawarpAudioScaleBoost", "Dim strength": "autoDimStrength" })[label];
    check(`setting-range-${group}-${property}`, Number(value) === Number(stored[group]?.[property]) && output.length > 0, `${label}: ${value}, output=${output}, stored=${stored[group]?.[property]}`);
    expectations.push({ label, kind: "value", tab, value });
  }

  await settingsTab("Lyrics");
  const firstProviders = () => page.$$eval(".provider-order .provider-name", nodes => nodes.slice(0, 2).map(node => node.textContent.trim()));
  const activateProviderButton = selector => page.locator(selector).setTimeout(4000).click();
  const waitForProviderOrder = expected => page.waitForFunction(names => {
    const first = [...document.querySelectorAll('.provider-order .provider-name')].slice(0, 2);
    return names.every((name, i) => first[i]?.textContent.trim() === name);
  }, { timeout: 4000 }, expected).then(() => true, () => false);
  const waitForProviderCount = expected => page.waitForFunction(count =>
    document.querySelectorAll('.provider-order li').length === count, { timeout: 4000 }, expected).then(() => true, () => false);
  const providerNames = await firstProviders();
  await activateProviderButton('.provider-order li:nth-child(2) button[aria-label="Move up"]');
  const swapped = await waitForProviderOrder([providerNames[1], providerNames[0]]);
  check("provider-move-up", swapped, `${providerNames.join(" / ")} → ${(await firstProviders()).join(" / ")}`);
  await activateProviderButton('.provider-order li:nth-child(1) button[aria-label="Move down"]');
  check("provider-move-down", await waitForProviderOrder(providerNames), (await firstProviders()).join(" / "));
  const providerCount = (await page.$$(".provider-order li")).length;
  await activateProviderButton('.provider-order li:first-child button[aria-label="Remove from order"]');
  const removed = await waitForProviderCount(providerCount - 1);
  const pool = await page.$(".provider-pool-chip");
  check("provider-remove", removed && Boolean(pool), "removed to pool");
  if (pool) await activateProviderButton(".provider-pool-chip");
  check("provider-add", Boolean(pool) && await waitForProviderCount(providerCount), "added from pool");
  await activateProviderButton(".provider-restore");
  check("provider-restore-defaults", (await storedSettings()).lyrics.providerOrder.length === 13, `${(await page.$$(".provider-order li")).length} rows`);

  await settingsTab("Appearance");
  await selectSetting("Performance mode", "off"); await remember("Performance mode");
  await toggleSetting("Enable shader background"); await remember("Enable shader background", "checked");
  await toggleSetting("React to the audio"); await remember("React to the audio", "checked");
  await toggleSetting("Pause when playback stops"); await remember("Pause when playback stops", "checked");
  await toggleSetting("Dim bright artwork"); await remember("Dim bright artwork", "checked");
  await toggleSetting("Animated artwork"); await remember("Animated artwork", "checked");
  await settingsTab("Playback");
  for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
    await selectSetting("Playback speed", rate);
    check(`playback-rate-option-${rate}`, (await page.$eval("audio", node => node.playbackRate)) === rate, `${rate}×`);
  }
  for (const repeat of ["all", "one", "off"]) {
    await selectSetting("Repeat", repeat);
    check(`playback-repeat-option-${repeat}`, Boolean(await page.$(`.player-bar button[aria-label="Repeat: ${repeat}"]`)), repeat);
  }
  await toggleSetting("Shuffle by default");
  check("playback-shuffle-toggle-live", (await page.$eval('.player-bar button[aria-label="Shuffle"]', node => node.getAttribute("aria-pressed"))) === "true", "enabled");
  await toggleSetting("Restore the last session on launch"); await remember("Restore the last session on launch", "checked");
  await remember("Playback speed"); await remember("Repeat");
  await page.evaluate(() => {
    if (window.__audit.state.scanErrors.length === 0) {
      window.__audit.state.scanErrors = [{ path: "/fixtures/broken.flac", reason: "Invalid FLAC preamble" }];
    }
  });
  await settingsTab("Library");
  const rescansBefore = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "rescan").length);
  await clickText(".heading-actions button", "Rescan now"); await wait(120);
  check("settings-rescan", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "rescan").length)) === rescansBefore + 1, "bridge call");
  if (await page.$(".scan-errors summary")) {
    await page.click(".scan-errors summary");
    check("scan-errors-disclosure", await page.$eval(".scan-errors", node => node.open), "details opened");
  } else check("scan-errors-disclosure", false, "expected broken fixture error details");
  await settingsTab("About");
  await clickText(".about-links button", "Better Lyrics on GitHub");
  await clickText(".about-links button", "Better Lyrics Shaders on GitHub");
  const external = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "open-external").map(call => call[1]));
  check("about-external-links", external.some(url => url.endsWith("better-lyrics")) && external.some(url => url.endsWith("shaders")), JSON.stringify(external));
  const clearsBefore = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "clear-lyrics-cache").length);
  page.once("dialog", dialog => dialog.dismiss()); await clickText("button.danger", "Clear lyrics cache", false); await wait(100);
  check("clear-cache-cancel", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "clear-lyrics-cache").length)) === clearsBefore, "confirmation cancelled");
  page.once("dialog", dialog => dialog.accept()); await clickText("button.danger", "Clear lyrics cache", false); await wait(100);
  check("clear-cache-confirm", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "clear-lyrics-cache").length)) === clearsBefore + 1, "cache clear bridge call");

  await settingsTab("Appearance"); await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="settings-view"]'); await wait(500);
  const mismatches = [];
  for (const expected of expectations) {
    if (await selectedSettingsTab() !== expected.tab) await settingsTab(expected.tab);
    const row = await settingRow(expected.label); const input = await row.$("input, select, textarea");
    const actual = expected.kind === "checked" ? await input.evaluate(node => node.checked) : await input.evaluate(node => node.value);
    if (actual !== expected.value) mismatches.push(`${expected.label}: ${expected.value} → ${actual}`);
  }
  check("settings-restart-persistence", mismatches.length === 0, mismatches.join("; ") || `${expectations.length} changed controls restored`);
  await settingsTab("About");
  check("reset-all-is-last-in-about", await page.$eval('[data-testid="settings-reset-all"]', button =>
    button.closest('[data-testid="settings-about"]')?.lastElementChild === button.parentElement));
  const savedBeforeCancel = await storedSettings();
  let cancelPrompt = "";
  page.once("dialog", dialog => { cancelPrompt = dialog.message(); return dialog.dismiss(); });
  await page.click('[data-testid="settings-reset-all"]');
  await settingsTab("Appearance");
  const fontAfterCancel = await (await settingRow("Font")).$eval("select", node => node.value);
  check("reset-all-cancel-keeps-saved-and-live-settings", cancelPrompt.includes("Reset all settings") &&
    fontAfterCancel === "monospace" && JSON.stringify(await storedSettings()) === JSON.stringify(savedBeforeCancel),
  `confirmation: ${Boolean(cancelPrompt)}; font: ${fontAfterCancel}`);
  await resetAllSettings();
  const defaults = await storedSettings();
  check("reset-all-clears-saved-overrides", Object.keys(defaults).length === 0, "harness reset removes the saved override object");
});

await runSection("expanded-ai-settings-completes", async () => {
  await nav("Settings"); await settingsTab("Lyrics");
  await page.evaluate(() => {
    window.cadence.lyrics.aiModels = async kind => [{ id: `fixture-${kind}`, name: `Fixture ${kind}` }];
    window.cadence.lyrics.aiTestConnection = async kind => `Fixture ${kind} connected`;
  });
  await toggleSetting("Enable AI translation");
  const afterTranslation = (await storedSettings()).lyrics;
  await toggleSetting("Enable AI romanization");
  const afterRomanization = (await storedSettings()).lyrics;
  check("ai-enablement-is-independent", afterTranslation.aiTranslation.enabled && !afterTranslation.aiRomanization.enabled &&
    afterRomanization.aiTranslation.enabled && afterRomanization.aiRomanization.enabled);
  for (const kind of ["translation", "romanization"]) {
    const panel = `.lyrics-ai-section:has(input[list="ai-models-${kind}"])`;
    await clickText(`${panel} button`, "Models");
    await page.waitForSelector(`#ai-models-${kind} option[value="fixture-${kind}"]`, { timeout: 4000 });
    await clickText(`${panel} button`, "Test connection");
    const result = await page.waitForFunction((selector, value) =>
      document.querySelector(selector)?.textContent.includes(value), { timeout: 4000 }, panel, `Fixture ${kind} connected`);
    check(`ai-${kind}-dispatches-to-its-own-provider`, Boolean(result), "model discovery and connection check used the correct profile");
  }
  await resetAllSettings();
});

await runSection("expanded-lyrics-completes", async () => {
  await nav("Songs"); await setShuffle(false); await playTrack("Fixture FLAC"); await openLegacyLyrics();
  await page.waitForSelector(".blyrics--line", { timeout: 8000 });
  await pausePlayback();
  check("lyrics-rich-source-ready", (await page.$eval('[data-testid="sync-label"]', node => node.textContent)).includes("Word synced"), "real parsed lyrics");
  const offset = () => page.$eval(".offset-value", node => node.textContent.trim());
  const offsetBefore = await offset(); await page.click(".dock-offset button:first-child");
  check("lyrics-offset-minus", (await offset()) !== offsetBefore, `${offsetBefore} → ${await offset()}`);
  const offsetMinus = await offset(); await page.click(".dock-offset button:last-child");
  check("lyrics-offset-plus", (await offset()) !== offsetMinus, `${offsetMinus} → ${await offset()}`);
  const openTranslationMenu = async () => {
    await page.click('button[title="Translate lyrics"]');
    await page.waitForSelector('.dock-languages[data-presence="entered"]', { timeout: 4000 });
  };
  await openTranslationMenu(); await clickText(".dock-languages .source-row", "Off");
  check("dock-translate-off", (await storedSettings()).lyrics.translationLanguage === "", "Off selected");
  await openTranslationMenu(); await clickText(".dock-languages .source-row", "Spanish", false); await wait(350);
  check("dock-translate-language", (await storedSettings()).lyrics.translationLanguage === "es" && Boolean(await page.$(".blyrics--translated")), "Spanish translation rendered");
  await page.click('button[title="Romanize lyrics"]'); await wait(300);
  check("dock-romanize", (await storedSettings()).lyrics.romanization === true && Boolean(await page.$(".blyrics--romanized")), "romanized lines rendered");
  await page.click('button[title="Romanize lyrics"]'); await wait(150);
  check("dock-romanize-off-keeps-translation", !(await page.$(".blyrics--romanized")) && Boolean(await page.$(".blyrics--translated")), "decorations independent");

  await openLyricsSources();
  await clickText(".dock-sources .source-row", "Audit line source", false); await wait(180);
  check("lyrics-source-selection", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Alternate first line"), "alternate source rendered");
  await nav("Songs"); await openLegacyLyrics();
  check("lyrics-source-survives-navigation", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Alternate first line"), "selected source retained");
  const resolveBefore = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve").length);
  await page.click('button[title="Reload lyrics"]'); await wait(300);
  check("lyrics-reload", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve").length)) === resolveBefore + 1, "one reload request");
  await page.click('button[title="Save lyrics next to the track"]');
  await page.waitForSelector(".dock-save-popover .source-row");
  await clickText(".dock-save-popover .source-row", "LRC", false);
  check("lyrics-save-sidecar", await page.evaluate(() => window.__audit.state.calls.some(call => call[0] === "save-sidecar" && String(call[2]).includes("Alternate"))), "selected text saved");
  await page.evaluate(() => { window.__audit.state.chooseLyricsResult = { canceled: true }; });
  await page.click('button[title="Open a lyrics file"]'); await wait(100);
  check("lyrics-file-cancel", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Alternate first line"), "cancel leaves lyrics unchanged");
  await page.evaluate(() => { window.__audit.state.chooseLyricsResult = { canceled: false, path: "/chosen.lrc", text: "[au:Audit Writer]\n[00:00.30]Chosen file line\n[00:01.60]Chosen second line" }; });
  await page.click('button[title="Open a lyrics file"]'); await wait(180);
  check("lyrics-file-open", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Chosen file line"), "chosen file rendered");

  // The dock Style popover was removed; its sliders/toggles are audited via Settings below.

  await nav("Settings"); await settingsTab("Lyrics"); await selectSetting("Theme", "custom");
  await page.type('[data-testid="settings-lyrics"] textarea', ".blyrics-container { --audit-theme: 42; }");
  await openLegacyLyrics(); await wait(200);
  check("custom-theme-applies-to-renderer", (await page.$eval("braccato-lyrics", node => node.theme)).includes("--audit-theme: 42"), "custom CSS handed to Braccato");
  await nav("Settings"); await settingsTab("Lyrics"); await toggleSetting("Fetch lyrics online");
  // Recovery must override both a remembered category and a deep scroll in Lyrics.
  await page.$eval(".content-scroll", node => node.scrollTo({ top: 1250, behavior: "instant" }));
  await wait(100);
  await settingsTab("Appearance");
  await nav("Songs"); await playTrack("Fixture Opus"); await openLegacyLyrics(); await wait(350); await pausePlayback();
  const lastResolve = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve").at(-1));
  check("offline-lyrics-resolve", lastResolve?.[2] === true, JSON.stringify(lastResolve));
  await clickText(".empty-actions button", "Enable online lyrics in settings");
  const openedLyricsSettings = await page.waitForSelector('[data-testid="settings-lyrics"]', { timeout: 4000 }).then(() => true, () => false);
  const scroll = await page.$eval(".content-scroll", node => node.scrollTop);
  check("offline-enable-settings-action", openedLyricsSettings && scroll === 0, `opens Lyrics at the online-fetch switch; scrollTop=${scroll}`);
  await toggleSetting("Fetch lyrics online");
});

await runSection("expanded-manual-lyrics-completes", async () => {
  await nav("Songs"); await playTrack("Fixture Opus"); await openLegacyLyrics(); await wait(300); await pausePlayback();
  if (process.env.AUDIT_DEBUG) console.log("MANUAL PAUSED", await audioState());
  const beforeRetry = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve").length);
  if (await page.$(".lyrics-empty-panel button:not(.primary)")) await clickText(".lyrics-empty-panel button", "Try again", false);
  check("empty-lyrics-try-again", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve").length)) === beforeRetry + 1, "retry control operated");
  await page.evaluate(() => { window.__audit.state.chooseLyricsResult = { canceled: false, path: "/empty-chosen.lrc", text: "Chosen empty-state lyrics" }; });
  if (await page.$(".lyrics-empty-panel .empty-actions")) await clickText(".lyrics-empty-panel .empty-actions button", "Choose a lyrics file", false);
  check("empty-lyrics-choose-file", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Chosen empty-state lyrics"), "empty-state file action");
  await openManualLyricsSearch();
  const title = await page.$('input[aria-label="Song title"]'); await title.focus();
  await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control"); await page.keyboard.press("Backspace");
  check("manual-search-requires-title", await page.$eval(".search-submit", node => node.disabled), "submit disabled");
  await page.type('input[aria-label="Song title"]', "Manual Song");
  await page.type('input[aria-label="Artist (optional)"]', "Manual Artist");
  await page.type('input[aria-label="Album (optional)"]', "Manual Album");
  await page.type('input[aria-label="YouTube link (optional)"]', "not-a-url"); await wait(650);
  check("manual-youtube-invalid", (await page.$eval(".yt-card", node => node.textContent)).includes("valid YouTube"), "inline validation");
  const youtube = await page.$('input[aria-label="YouTube link (optional)"]'); await youtube.focus();
  await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control"); await page.keyboard.type("https://youtu.be/dQw4w9WgXcQ"); await wait(700);
  check("manual-youtube-metadata", Boolean(await page.$('[data-testid="youtube-metadata"]')), "metadata card");
  check("manual-user-fields-win", (await page.$eval(".effective-line .effective-value", node => node.textContent.trim())) === "Manual Song", "YouTube did not overwrite typed title");
  await page.click(".search-submit"); await wait(200); await clickText(".dock-search > .source-row", "Manual Song", false); await wait(150);
  check("manual-search-select-result", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Manual Manual Song"), "manual result promoted");
  await openManualLyricsSearch();
  check("manual-draft-survives-panel", (await page.$eval('input[aria-label="Song title"]', node => node.value)) === "Manual Song", "draft restored");
  await nav("Settings"); await settingsTab("Playback");
  const resumeRow = await settingRow("Restore the last session on launch");
  if (!(await resumeRow.$eval('input[type="checkbox"]', node => node.checked))) await toggleSetting("Restore the last session on launch");
  await openLegacyLyrics();
  if (process.env.AUDIT_DEBUG) console.log("MANUAL BEFORE RELOAD", await page.evaluate(() => ({ session: localStorage.getItem("cadence.session.v1"), settings: localStorage.getItem("cadence.harness.settings.v1"), title: document.querySelector(".player-title")?.textContent })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await wait(500);
  if (process.env.AUDIT_DEBUG) console.log("MANUAL AFTER RELOAD", await page.evaluate(() => ({ session: localStorage.getItem("cadence.session.v1"), settings: localStorage.getItem("cadence.harness.settings.v1"), title: document.querySelector(".player-title")?.textContent, audit: window.__audit?.state?.tracks?.length }))); await page.waitForSelector('[data-testid="lyrics-dock"]'); await wait(600);
  await openManualLyricsSearch();
  check("manual-draft-survives-restart", (await page.$eval('input[aria-label="Song title"]', node => node.value)) === "Manual Song", "localStorage draft restored");
  await page.evaluate(() => { window.__audit.state.failSearch = true; }); await page.click(".search-submit"); await wait(150);
  check("manual-search-error", (await page.$eval(".search-error", node => node.textContent)).includes("Audit search failure"), "inline error");
  await page.evaluate(() => { window.__audit.state.failSearch = false; }); await clickText(".search-retry", "Retry", false); await wait(150);
  check("manual-search-retry", Boolean(await page.$(".dock-search > .source-row")), "retry returns results");
  await page.click('button[aria-label="Clear query and results"]');
  check("manual-clear-resets-draft", (await page.$eval('input[aria-label="Song title"]', node => node.value)) === "Fixture Opus", "track defaults restored");
  await page.click('.search-panel-head button[title="Back to sources"]');
  await page.waitForSelector('.dock-sources[data-presence="entered"]', { timeout: 4000 });
  check("manual-back-to-sources", await waitForDismissal('[data-testid="manual-search"]'), "source popover restored and manual panel closed");
});

await runSection("expanded-fullscreen-completes", async () => {
  await nav("Songs"); await playTrack("Fixture FLAC");
  await page.click('[data-testid="open-now-playing"]'); await wait(250);
  check("fullscreen-enter-control", Boolean(await page.$(".lyrics-view.is-fullscreen")), "immersive view");
  await openQueue();
  if (process.env.AUDIT_DEBUG) console.log("ESC BEFORE", await page.evaluate(() => ({ queue: Boolean(document.querySelector('[data-testid="queue-panel"]')), fullscreen: Boolean(document.querySelector('.lyrics-view.is-fullscreen')), active: document.activeElement?.outerHTML.slice(0, 160) })));
  await page.keyboard.press("Escape"); await wait(250);
  if (process.env.AUDIT_DEBUG) console.log("ESC AFTER", await page.evaluate(() => ({ queue: Boolean(document.querySelector('[data-testid="queue-panel"]')), fullscreen: Boolean(document.querySelector('.lyrics-view.is-fullscreen')), native: window.__chrome.fullscreen })));
  check("escape-closes-queue-before-fullscreen", !(await page.$('[data-testid="queue-panel"]')) && Boolean(await page.$(".lyrics-view.is-fullscreen")), "queue closed, fullscreen retained");
  if (await page.$('[data-testid="queue-panel"]')) await closeQueue();
  await page.keyboard.press("F11"); await wait(200);
  const f11 = await page.evaluate(() => ({ immersive: Boolean(document.querySelector(".lyrics-view.is-fullscreen")), native: window.__chrome.fullscreen }));
  check("f11-native-and-immersive-toggle", f11.immersive && f11.native, JSON.stringify(f11));
  await page.click('[data-testid="lyrics-mode-off"]'); await wait(150);
  check("fullscreen-lyrics-off-panel", Boolean(await page.$(".lyrics-view.is-lyrics-off")), "panel layout");
  await page.click('[data-testid="lyrics-mode-on"]'); await wait(150);
  check("fullscreen-lyrics-on-panel", !(await page.$(".lyrics-view.is-lyrics-off")), "lyrics restored");
  await page.click('button[aria-label="Exit Now Playing"]'); await wait(120);
  check("fullscreen-exit-control", !(await page.$(".lyrics-view.is-fullscreen")), "normal chrome restored");
});

await runSection("expanded-animated-art-completes", async () => {
  await page.evaluate(() => {
    const track = window.__audit.state.tracks.find(entry => entry.title === "Fixture FLAC");
    track.animatedArtUrl = "/audio/cover.webm";
  });
  await nav("Settings"); await settingsTab("Library"); await clickText(".heading-actions button", "Rescan now");
  await settingsTab("Appearance"); const animatedRow = await settingRow("Animated artwork");
  if (!(await animatedRow.$eval('input[type="checkbox"]', node => node.checked))) await toggleSetting("Animated artwork");
  await nav("Songs"); await playTrack("Fixture FLAC"); await openLegacyLyrics(); await wait(500);
  const before = await page.evaluate(() => ({ videos: document.querySelectorAll("video").length, paused: document.querySelector("video")?.paused }));
  check("animated-artwork-video-loads", before.videos === 1 && before.paused === false, JSON.stringify(before));
  if (!(await audioState()).paused) await page.click('[data-testid="play-toggle"]'); await wait(150);
  const after = await page.evaluate(() => ({ videos: document.querySelectorAll("video").length, paused: document.querySelector("video")?.paused }));
  check("animated-artwork-pauses-with-playback", after.videos === 1 && after.paused === true, JSON.stringify(after));
  await nav("Settings"); await settingsTab("Appearance"); await toggleSetting("Animated artwork");
});

await runSection("expanded-queue-and-errors-completes", async () => {
  await nav("Songs"); await playTrack("Fixture FLAC"); await openQueue();
  await page.click('button[aria-label="Clear queue"]'); await wait(100);
  check("queue-clear", (await page.$eval(".queue-header", node => node.textContent)).includes("0 songs") && (await audioState()).paused, "empty and stopped");
  await closeQueue();
  await nav("Home"); if (await page.$(".home-shelf-track .home-track-card .card-open")) await page.click(".home-shelf-track .home-track-card .card-open"); await wait(350);
  await nav("Songs"); await openTrackMenu("Fixture MP3"); await clickText(".context-menu button", "Add to queue"); await openQueue();
  check("context-add-to-queue", (await queueState()).titles.filter(title => title === "Fixture MP3").length === 1, (await queueState()).titles.join(","));
  await closeQueue(); await nav("Songs"); await playTrack("Fixture FLAC");
  const seek = await page.$('.player-bar input[aria-label="Seek"]'); const box = await seek.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5); await wait(100);
  await openQueue();
  const currentRemove = await page.$('.queue-list li.current button[aria-label^="Remove "]'); await currentRemove.click(); await wait(250);
  const positionAfterRemove = (await audioState()).currentTime;
  check("remove-current-starts-next-at-zero", positionAfterRemove < 0.75, `new track position=${positionAfterRemove}`);
  await closeQueue(); await nav("Songs"); await playTrack("Fixture ALAC"); await wait(250);
  const alacPlayback = await audioState();
  check(
    "alac-playback-through-bridge-handoff",
    !alacPlayback.paused && alacPlayback.currentTime > 0.3 && !(await page.$(".error-banner")),
    `PCM handoff playing at ${alacPlayback.currentTime.toFixed(2)}s`
  );
  await page.click('button[aria-label="Next track"]'); await wait(350);
  const afterAlacNext = await audioState();
  check(
    "alac-next-track-transition",
    (await playerTitle()) !== "Fixture ALAC" && !afterAlacNext.paused && afterAlacNext.currentTime > 0.2,
    `${await playerTitle()} at ${afterAlacNext.currentTime.toFixed(2)}s`
  );
  await page.click('button[aria-label="Previous track"]'); await wait(350);
  const afterAlacPrevious = await audioState();
  check(
    "alac-previous-track-transition",
    (await playerTitle()) === "Fixture ALAC" && !afterAlacPrevious.paused && afterAlacPrevious.currentTime > 0.2,
    `back to ALAC at ${afterAlacPrevious.currentTime.toFixed(2)}s`
  );
});

await runSection("expanded-shuffle-actions-completes", async () => {
  await nav("Songs"); await setShuffle(false);
  await clickText(".library-view .heading-actions button", "Shuffle");
  await wait(250);
  check("library-shuffle-randomizes-order", (await page.$eval('.player-bar button[aria-label="Shuffle"]', node => node.getAttribute("aria-pressed"))) === "true", "transport shuffle enabled");
  await setShuffle(false); await nav("Home"); await clickText(".home-view .heading-actions button", "Play library", false); await wait(200);
  await openQueue(); check("home-play-library", (await queueState()).titles.length === 8, `${(await queueState()).titles.length} queued`); await closeQueue();
  await setShuffle(false); await clickText(".home-view .heading-actions button", "Shuffle");
  check("home-shuffle-randomizes-order", (await page.$eval('.player-bar button[aria-label="Shuffle"]', node => node.getAttribute("aria-pressed"))) === "true", "transport shuffle enabled");
  await setShuffle(false); await nav("Albums"); await page.click('[data-testid="album-card"] .card-open'); await wait(120);
  await clickText(".detail-hero .heading-actions button", "Shuffle");
  check("album-shuffle-randomizes-order", (await page.$eval('.player-bar button[aria-label="Shuffle"]', node => node.getAttribute("aria-pressed"))) === "true", "transport shuffle enabled");
  await clickText(".detail-hero .heading-actions button", "Play"); await wait(150);
  check("album-play", !(await audioState()).paused, await playerTitle());
  await clickText(".detail-hero .heading-actions button", "Now Playing", false);
  check("album-now-playing", Boolean(await page.$('[data-testid="lyrics-view"]')), "hero action");
  await nav("Artists"); await setShuffle(false); await page.click(".artist-card"); await wait(120);
  await clickText(".detail-hero .heading-actions button", "Shuffle");
  check("artist-shuffle-randomizes-order", (await page.$eval('.player-bar button[aria-label="Shuffle"]', node => node.getAttribute("aria-pressed"))) === "true", "transport shuffle enabled");
  await clickText(".detail-hero .heading-actions button", "Play"); await wait(120);
  check("artist-play", !(await audioState()).paused, await playerTitle());
});

await runSection("expanded-keyboard-completes", async () => {
  await nav("Songs"); await setShuffle(false); await playTrack("Fixture FLAC");
  await page.keyboard.down("Control"); await page.keyboard.press("K"); await page.keyboard.up("Control");
  check("shortcut-ctrl-k", (await page.evaluate(() => document.activeElement?.id)) === "global-search", "search focused");
  await page.keyboard.press("Escape"); await (await page.$(".view-heading h1")).click();
  const foldersBefore = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "add-folder").length);
  await page.keyboard.down("Control"); await page.keyboard.press("O"); await page.keyboard.up("Control"); await wait(100);
  check("shortcut-ctrl-o", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "add-folder").length)) === foldersBefore + 1, "add folder command");
  const rescansBefore = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "rescan").length);
  await page.keyboard.down("Control"); await page.keyboard.down("Shift"); await page.keyboard.press("R"); await page.keyboard.up("Shift"); await page.keyboard.up("Control"); await wait(100);
  check("shortcut-ctrl-shift-r", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "rescan").length)) === rescansBefore + 1, "rescan command");
  const pausedBefore = (await audioState()).paused;
  await page.keyboard.down("Control"); await page.keyboard.press("P"); await page.keyboard.up("Control"); await wait(100);
  check("shortcut-ctrl-p", (await audioState()).paused !== pausedBefore, "play/pause");
  await page.keyboard.press("M"); await wait(80);
  check("shortcut-m", await page.$eval("audio", node => node.muted), "muted");
  await page.keyboard.press("M");
  const volumeBefore = await page.$eval("audio", node => node.volume); await page.keyboard.press("ArrowUp"); await wait(60);
  check("shortcut-volume-up", (await page.$eval("audio", node => node.volume)) > volumeBefore, `${volumeBefore} → ${await page.$eval("audio", node => node.volume)}`);
  const volumeHigh = await page.$eval("audio", node => node.volume); await page.keyboard.press("ArrowDown"); await wait(60);
  check("shortcut-volume-down", (await page.$eval("audio", node => node.volume)) < volumeHigh, "volume reduced");
  const positionBefore = (await audioState()).currentTime; await page.keyboard.press("ArrowRight"); await wait(60);
  check("shortcut-seek-forward", (await audioState()).currentTime > positionBefore, `${positionBefore} → ${(await audioState()).currentTime}`);
  const positionHigh = (await audioState()).currentTime; await page.keyboard.press("ArrowLeft"); await wait(60);
  check("shortcut-seek-back", (await audioState()).currentTime < positionHigh, "seek reduced");
  const titleBefore = await playerTitle(); await page.keyboard.down("Shift"); await page.keyboard.press("ArrowRight"); await page.keyboard.up("Shift"); await wait(250);
  check("shortcut-shift-next", (await playerTitle()) !== titleBefore, `${titleBefore} → ${await playerTitle()}`);
  const titleNext = await playerTitle(); await page.keyboard.down("Shift"); await page.keyboard.press("ArrowLeft"); await page.keyboard.up("Shift"); await wait(250);
  check("shortcut-shift-previous", (await playerTitle()) !== titleNext, `${titleNext} → ${await playerTitle()}`);
  await page.keyboard.press("L"); await wait(100); check("shortcut-l", Boolean(await page.$('[data-testid="lyrics-view"]')), "Now Playing");
  await page.keyboard.press("Q"); await wait(80); check("shortcut-q-open", Boolean(await page.$('[data-testid="queue-panel"]')), "queue open");
  await page.keyboard.press("Q");
  await page.waitForSelector('[data-testid="queue-panel"]', { hidden: true, timeout: 2000 });
  check("shortcut-q-close", !(await page.$('[data-testid="queue-panel"]')), "queue closed after its exit");
  await page.keyboard.press("Escape"); await page.waitForSelector('.player-bar');
  await page.keyboard.press("N"); await wait(100); check("shortcut-n", Boolean(await page.$(".lyrics-view.is-fullscreen")), "immersive");
  await page.keyboard.press("Escape"); await wait(100); check("shortcut-escape-fullscreen", !(await page.$(".lyrics-view.is-fullscreen")), "normal view");
  await page.keyboard.press("F"); await wait(100); check("shortcut-f", Boolean(await page.$(".lyrics-view.is-fullscreen")), "immersive");
  await page.keyboard.press("Escape");
  const shuffleBefore = await page.$eval('.player-bar button[aria-label="Shuffle"]', node => node.getAttribute("aria-pressed"));
  await page.keyboard.press("S"); await wait(80);
  check("shortcut-s", (await page.$eval('.player-bar button[aria-label="Shuffle"]', node => node.getAttribute("aria-pressed"))) !== shuffleBefore, "shuffle toggled");
  const repeatBefore = await page.$eval('.player-bar button[aria-label^="Repeat:"]', node => node.getAttribute("aria-label"));
  await page.keyboard.press("R"); await wait(80);
  check("shortcut-r", (await page.$eval('.player-bar button[aria-label^="Repeat:"]', node => node.getAttribute("aria-label"))) !== repeatBefore, "repeat cycled");
  await page.evaluate(() => document.activeElement?.blur());
  const pauseBeforeSpace = (await audioState()).paused; await page.keyboard.press("Space"); await wait(100);
  check("shortcut-space-body", (await audioState()).paused !== pauseBeforeSpace, "global play/pause");
  await page.click("#global-search"); await page.keyboard.press("Q"); await wait(80);
  check("shortcuts-ignore-text-input", !(await page.$('[data-testid="queue-panel"]')) && (await page.$eval("#global-search", node => node.value)).toLowerCase().endsWith("q"), "typing preserved");
});

await runSection("expanded-window-and-media-completes", async () => {
  await nav("Songs"); await playTrack("Fixture FLAC");
  const actionsBefore = await page.evaluate(() => window.__cadenceWindowActions.length);
  await page.click('button[aria-label="Minimize"]'); await page.click('button[aria-label="Maximize"]'); await page.click('button[aria-label="Restore down"]'); await page.click('button[aria-label="Close"]');
  const actions = await page.evaluate(() => window.__cadenceWindowActions.slice());
  check("window-controls-dispatch", actions.length === actionsBefore + 4 && actions.slice(-4).join(",") === "minimize,maximize,restore,close", actions.slice(-4).join(","));
  const mediaTitleBefore = await playerTitle();
  await page.evaluate(() => window.__mediaCommandListener?.("next")); await wait(250);
  check("renderer-media-command-next", (await playerTitle()) !== mediaTitleBefore, `${mediaTitleBefore} → ${await playerTitle()}`);
  await page.evaluate(() => window.__menuActionListener?.("toggle-fullscreen-lyrics")); await wait(120);
  check("renderer-menu-fullscreen", await page.evaluate(() => window.__chrome.fullscreen && Boolean(document.querySelector(".lyrics-view.is-fullscreen"))), "native menu action path");
  await page.keyboard.press("Escape");
});

await runSection("expanded-sidebar-search-completes", async () => {
  await nav("Songs");
  const searchFor = async value => {
    const input = await page.$("#global-search");
    await input.click();
    await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control");
    if (value) await page.keyboard.type(value); else await page.keyboard.press("Backspace");
    await wait(450);
  };
  await searchFor("FLAC");
  check("global-search-results", Boolean(await page.$('[data-testid="search-view"]')) && (await page.$$eval('[data-testid="search-track-list"] .title-text', nodes => nodes.map(node => node.textContent.trim()))).includes("Fixture FLAC"), "track result rendered");
  await page.click('button[aria-label="Clear search"]'); await wait(150);
  check("global-search-clear", !(await page.$('[data-testid="search-view"]')) && (await page.$eval("#global-search", node => node.value)) === "", "cleared and returned home");
  await searchFor("Fixture");
  await clickText(".search-view .shelf-heading .link", "Play all"); await wait(500);
  check("search-play-all", !(await audioState()).paused && (await page.evaluate(() => location.hash)).startsWith("#/search/"), "search queue starts playing");
  await pausePlayback();
  await searchFor("Harness Artist");
  check("search-artist-album-results", Boolean(await page.$(".search-view .artist-card")) && Boolean(await page.$(".search-view [data-testid=\"album-card\"]")), "artist and album shelves");
  await page.click('.search-view [data-testid="album-card"] .card-open'); await wait(150);
  check("search-album-card-opens", Boolean(await page.$(".detail-hero")), "album detail");
  check("search-field-clears-on-browse", (await page.$eval("#global-search", node => node.value)) === "", "no stale search term on album page");
  await nav("Songs"); await searchFor("zzzz-no-match");
  check("search-no-results", (await page.$eval(".search-view", node => node.textContent)).includes("No matches"), "empty result message");
  await page.click('button[aria-label="Clear search"]'); await wait(120);
  await nav("Songs");
  const addsBefore = await page.evaluate(() => {
    window.__audit.state.holdAddFolder = true;
    return window.__audit.state.calls.filter(call => call[0] === "add-folder").length;
  });
  await clickText(".library-view .heading-actions button", "Add folder");
  await page.waitForSelector(".sidebar-tools .scan-indicator");
  check("library-add-music", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "add-folder").length)) === addsBefore + 1, "folder picker request");
  check("add-folder-disabled-while-scanning", await page.$$eval(".library-view .heading-actions button", nodes => nodes.some(node => node.textContent?.includes("Add folder") && node.disabled)));
  await page.evaluate(() => window.__audit.state.finishAddFolder());
  await page.waitForSelector(".sidebar-tools .scan-indicator", { hidden: true });
  await nav("Settings"); await settingsTab("Appearance");
  await toggleSetting("Compact sidebar");
  await toggleSetting("Expand compact sidebar on hover");
  await page.mouse.move(700, 400);
  await page.evaluate(() => document.activeElement?.blur());
  await wait(400);
  const collapsedWidth = await page.$eval(".sidebar", node => node.getBoundingClientRect().width);
  await page.keyboard.down("Control"); await page.keyboard.press("K"); await page.keyboard.up("Control");
  await page.waitForFunction(() => document.activeElement?.id === "global-search" && document.querySelector(".sidebar").getBoundingClientRect().width > 215);
  await page.keyboard.type("Fixture");
  await page.waitForSelector(".search-view");
  const compactSearch = await page.evaluate(() => ({ rail: document.querySelector(".sidebar").getBoundingClientRect().width,
    main: document.querySelector(".app-main").getBoundingClientRect().left, value: document.querySelector("#global-search").value }));
  check("compact-search-expands-without-hover-or-content-reflow", collapsedWidth === 68 && compactSearch.main === 68 &&
    compactSearch.rail > compactSearch.main && compactSearch.value === "Fixture", JSON.stringify({ collapsedWidth, ...compactSearch }));
  await nav("Settings"); await settingsTab("Appearance");
  await toggleSetting("Expand compact sidebar on hover");
  await toggleSetting("Compact sidebar");
});

await runSection("expanded-player-controls-completes", async () => {
  await nav("Songs"); await setShuffle(false); await playTrack("Fixture FLAC");
  const metadata = await page.evaluate(() => ({ title: navigator.mediaSession?.metadata?.title, artist: navigator.mediaSession?.metadata?.artist, artwork: navigator.mediaSession?.metadata?.artwork?.[0]?.src ?? "" }));
  check("media-session-track-metadata", metadata.title === "Fixture FLAC" && metadata.artist === "Harness Artist" && metadata.artwork.includes("/artwork/"), JSON.stringify(metadata));
  const wasPaused = (await audioState()).paused;
  await page.click('[data-testid="play-toggle"]'); await wait(180);
  check("player-play-pause", (await audioState()).paused !== wasPaused, "transport toggles audio");
  await page.click('[data-testid="play-toggle"]'); await wait(180);
  check("player-play-resume", !(await audioState()).paused, "transport resumes audio");
  const seek = await page.$('.player-bar input[aria-label="Seek"]'); const seekBox = await seek.boundingBox();
  await page.mouse.click(seekBox.x + seekBox.width * 0.55, seekBox.y + seekBox.height * 0.5); await wait(150);
  check("player-seek", (await audioState()).currentTime > 0.5, `position=${(await audioState()).currentTime}`);
  const volume = await page.$('.player-bar input[aria-label="Volume"]'); await volume.focus(); await page.keyboard.press("End"); await wait(100);
  check("player-volume-slider", (await page.$eval("audio", node => node.volume)) === 1, "volume End sets maximum");
  await page.click('.player-bar button[aria-label="Mute"]'); await wait(80);
  check("player-mute", await page.$eval("audio", node => node.muted), "mute applied");
  await page.click('.player-bar button[aria-label="Unmute"]'); await wait(80);
  check("player-unmute", !(await page.$eval("audio", node => node.muted)), "unmute applied");
  await page.click('.player-bar button[aria-label="Next track"]'); await wait(400);
  const nextTitle = await playerTitle();
  check("player-next", nextTitle !== "Fixture FLAC", nextTitle);
  await page.click('.player-bar button[aria-label="Previous track"]'); await wait(400);
  check("player-previous", (await playerTitle()) === "Fixture FLAC", await playerTitle());
  const repeatBefore = await page.$eval('.player-bar button[aria-label^="Repeat:"]', node => node.getAttribute("aria-label"));
  await page.click('.player-bar button[aria-label^="Repeat:"]'); await wait(80);
  check("player-repeat-cycle", (await page.$eval('.player-bar button[aria-label^="Repeat:"]', node => node.getAttribute("aria-label"))) !== repeatBefore, "repeat advances");
  await page.click('.player-bar button[aria-label="Add to favourites"]'); await wait(120);
  check("player-favorite", Boolean(await page.$('.player-bar button[aria-label="Remove from favourites"]')), "favorite state applied");
  await page.click('.player-bar button[aria-label="Remove from favourites"]'); await wait(120);
  check("player-unfavorite", Boolean(await page.$('.player-bar button[aria-label="Add to favourites"]')), "favorite state cleared");
  await page.click('.player-bar button[aria-label="Now Playing"]'); await wait(120);
  check("player-now-playing", Boolean(await page.$('[data-testid="lyrics-view"]')), "lyrics destination");
  await nav("Songs"); await openQueue();
  check("player-queue-open", Boolean(await page.$('[data-testid="queue-panel"]')), "queue button");
  await closeQueue();
  await page.click('[data-testid="open-now-playing"]'); await wait(150);
  check("player-fullscreen-open", Boolean(await page.$(".lyrics-view.is-fullscreen")), "fullscreen button");
  await page.click('button[aria-label="Exit Now Playing"]'); await wait(120);
  check("player-fullscreen-close", !(await page.$(".lyrics-view.is-fullscreen")), "exit button");
  await pausePlayback();
});

await runSection("expanded-queue-controls-completes", async () => {
  await nav("Songs"); await setShuffle(false); await playTrack("Fixture FLAC"); await openQueue();
  const queueTracks = await page.$$(".queue-track"); await queueTracks[1].click(); await wait(400);
  const jumped = await queueState();
  check("queue-jump-to-track", jumped.current === 1 && (await playerTitle()) === jumped.titles[1], JSON.stringify(jumped));
  const beforeRemoval = await queueState();
  const currentTitle = jumped.titles[jumped.current];
  const removeIndex = jumped.current === 0 ? 1 : 0;
  await (await page.$(`.queue-list li:nth-child(${removeIndex + 1}) button[aria-label^="Remove "]`)).click(); await wait(150);
  const afterRemoval = await queueState();
  check("queue-remove-noncurrent", afterRemoval.titles.length === beforeRemoval.titles.length - 1 && afterRemoval.titles[afterRemoval.current] === currentTitle, "current track preserved");
  await closeQueue(); await nav("Songs"); await openQueue(); await page.click('button[aria-label="Clear queue"]'); await wait(100); await closeQueue();
  await page.click("#global-search"); await page.keyboard.type("Fixture FLAC"); await wait(450); await (await trackRow("Fixture FLAC")).click(); await wait(400);
  await page.click('button[aria-label="Clear search"]'); await wait(100); await nav("Songs");
  await openTrackMenu("Fixture MP3"); await clickText(".context-menu button", "Add to queue"); await openQueue();
  const two = await queueState();
  await closeQueue(); await nav("Songs"); await openTrackMenu("Fixture MP3"); await clickText(".context-menu button", "Add to queue"); await openQueue();
  const deduped = await queueState();
  check("queue-add-and-dedupe", two.titles.length === 2 && deduped.titles.length === 2 && deduped.titles.filter(title => title === "Fixture MP3").length === 1, JSON.stringify(deduped));
  await page.keyboard.press("Escape");
  check("queue-escape-close", await waitForDismissal(queuePanel) && !(await page.$(".lyrics-view.is-fullscreen")), "Escape closes only queue");
  await pausePlayback();
});

await runSection("expanded-dialog-and-menu-completes", async () => {
  await nav("Songs"); await openTrackMenu("Fixture FLAC"); await page.keyboard.press("Escape");
  check("context-menu-escape", await waitForDismissal(".context-menu"), "menu closed");
  await openTrackMenu("Fixture FLAC"); await page.mouse.click(1000, 120);
  check("context-menu-outside-click", await waitForDismissal(".context-menu"), "outside click closed");
  await openTrackMenu("Fixture FLAC"); await clickText(".context-menu button", "Add to playlist…");
  check("playlist-picker-opens", Boolean(await page.$(".modal-backdrop")), "picker opened");
  await page.click('.modal-header button[aria-label="Close"]');
  check("playlist-picker-close-button", await waitForDismissal(".modal-backdrop"), "close button");
  await openTrackMenu("Fixture FLAC"); await clickText(".context-menu button", "Add to playlist…"); await page.keyboard.press("Escape");
  check("playlist-picker-escape", await waitForDismissal(".modal-backdrop"), "Escape closes picker");
  await openTrackMenu("Fixture FLAC"); await clickText(".context-menu button", "Add to playlist…"); await page.mouse.click(1000, 120);
  check("playlist-picker-backdrop", await waitForDismissal(".modal-backdrop"), "backdrop closes picker");
  await nav("Playlists"); await clickText(".heading-actions button", "New playlist"); await page.type('.inline-create input[placeholder="Playlist name"]', "Modal Mix"); await clickText(".inline-create button", "Create"); await wait(200);
  await clickText(".detail-hero button", "Add songs", false); await page.keyboard.press("Escape");
  check("playlist-add-escape", await waitForDismissal(".modal-backdrop"), "Escape closes add-songs dialog");
  await clickText(".detail-hero button", "Add songs", false); await page.click('.modal-header button[aria-label="Close"]');
  check("playlist-add-close-button", await waitForDismissal(".modal-backdrop"), "close button");
  await nav("Playlists"); const deleteButton = await page.$('button[aria-label="Delete Modal Mix"]'); if (deleteButton) await deleteButton.click();
});

await runSection("expanded-appearance-controls-completes", async () => {
  await nav("Settings"); await resetAllSettings(); await settingsTab("Appearance");
  const currentAccent = await page.evaluate(async () => (await window.cadence.settings.get()).appearance.accent);
  check("appearance-accent-display", (await page.$eval('input[type="color"]', node => node.value)) === currentAccent, `native color input reflects applied accent ${currentAccent}`);
  const fontValues = await page.$eval('[data-testid="font-select"]', node => [...node.options].map(option => option.value));
  for (const value of fontValues) {
    await selectSetting("Font", value);
    check(`appearance-font-option-${value}`, (await storedSettings()).appearance?.fontFamily === value, value);
  }
  await selectSetting("Font", "system");
  await toggleSetting("Blur artwork behind the player");
  check("appearance-blur-toggle-live", (await page.$eval("html", node => node.dataset.blurArtwork)) === "false", "artwork layer disabled");
  await toggleSetting("Blur artwork behind the player");
  await toggleSetting("Reduce motion");
  check("appearance-reduce-motion-live", (await page.$eval("html", node => node.dataset.reduceMotion)) === "true", "reduced motion root state");
  await toggleSetting("Reduce motion");
  await toggleSetting("Compact sidebar");
  check("appearance-compact-live", (await page.$eval("html", node => node.dataset.compactSidebar)) === "true", "compact root state");
  await toggleSetting("Compact sidebar");
  await toggleSetting("Enable shader background");
  check("appearance-shader-disable", (await storedSettings()).shaders?.enabled === false, "shader setting disabled");
  await toggleSetting("Enable shader background");
  for (const mode of ["high", "balanced", "low", "off"]) {
    await selectSetting("Performance mode", mode);
    check(`appearance-performance-${mode}`, (await storedSettings()).shaders?.performanceMode === mode, mode);
  }
  await selectSetting("Performance mode", "balanced");
  for (const label of ["React to the audio", "Pause when playback stops", "Dim bright artwork", "Animated artwork"]) {
    const before = (await storedSettings()).shaders;
    await toggleSetting(label);
    const after = (await storedSettings()).shaders;
    const key = { "React to the audio": "audioResponsive", "Pause when playback stops": "pauseOnInactive", "Dim bright artwork": "autoDimBrightArtwork", "Animated artwork": "enableAnimatedArt" }[label];
    check(`appearance-toggle-${key}`, after?.[key] === !before?.[key], `${label} stored=${after?.[key]}`);
    await toggleSetting(label);
  }
  await settingsTab("Playback");
  await toggleSetting("Restore the last session on launch");
  check("appearance-playback-resume-toggle", (await storedSettings()).playback?.resumeOnLaunch === true, "resume setting stored");
  await toggleSetting("Restore the last session on launch");
  await settingsTab("Lyrics");
  const themeValues = await page.$$eval('.setting-row select', nodes => {
    const row = nodes.find(node => node.closest(".setting-row")?.querySelector("strong")?.textContent === "Theme");
    return row ? [...row.options].map(option => option.value) : [];
  });
  for (const theme of themeValues) {
    await selectSetting("Theme", theme);
    check(`lyrics-theme-${theme}`, (await storedSettings()).lyrics?.themeId === theme, theme);
  }
  await resetAllSettings();
});

await runSection("expanded-album-fallback-completes", async () => {
  await page.evaluate(() => {
    const state = window.__audit.state;
    state.albumBackup = structuredClone(state.tracks);
    const track = state.tracks.find(entry => entry.title === "Fixture FLAC");
    if (track) track.albumArtist = null;
  });
  try {
    await nav("Settings"); await settingsTab("Library"); await clickText(".heading-actions button", "Rescan now"); await wait(150);
    await nav("Albums");
    const cards = await page.$$('[data-testid="album-card"] .card-open');
    let albumCard = null;
    for (const card of cards) if ((await card.$eval(".card-title", node => node.textContent.trim())) === "Test Bench") { albumCard = card; break; }
    if (!albumCard) throw new Error("Test Bench card missing after albumArtist fallback");
    await albumCard.click(); await wait(150);
    check("album-fallback-detail-tracks", Boolean(await trackRow("Fixture FLAC")), "album detail retains track with missing albumArtist");
    await clickText(".detail-hero .heading-actions button", "Play"); await wait(400);
    check("album-fallback-play", !(await audioState()).paused, "album Play uses displayed album key");
    await pausePlayback(); await nav("Songs"); await openTrackMenu("Fixture FLAC"); await clickText(".context-menu button", "Go to album");
    check("album-fallback-context-route", Boolean(await trackRow("Fixture FLAC")), "Go to album uses the same fallback key");
  } finally {
    await page.evaluate(() => { const state = window.__audit.state; if (state.albumBackup) { state.tracks = state.albumBackup; delete state.albumBackup; } });
    await nav("Settings"); await settingsTab("Library"); await clickText(".heading-actions button", "Rescan now"); await wait(150);
  }
});

await runSection("expanded-empty-library-completes", async () => {
  await page.evaluate(() => { window.__audit.state.folders = ["/fixtures"]; });
  await nav("Settings"); await settingsTab("Library"); await clickText(".heading-actions button", "Rescan now"); await wait(200);
  if (process.env.AUDIT_DEBUG) console.log("EMPTY BEFORE", await page.evaluate(() => ({ folders: window.__audit.state.folders, tracks: window.__audit.state.tracks.length, buttons: [...document.querySelectorAll("button")].map(node => node.getAttribute("aria-label") || node.textContent?.trim()).filter(Boolean) })));
  await page.waitForSelector('button[aria-label="Remove folder"]');
  await page.click('button[aria-label="Remove folder"]');
  await page.waitForSelector('button[aria-label="Remove folder"]', { hidden: true });
  if (process.env.AUDIT_DEBUG) console.log("EMPTY AFTER REMOVE", await page.evaluate(() => ({ folders: window.__audit.state.folders, tracks: window.__audit.state.tracks.length, body: document.querySelector('[data-testid="settings-library"]')?.textContent })));
  await nav("Home");
  check("remove-folder-empty-home", Boolean(await page.$('[data-testid="home-empty"]')), "empty-state rendered");
  const addsBefore = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "add-folder").length);
  await clickText(".empty-actions button", "Add music folder", false); await wait(100);
  check("empty-home-add-folder", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "add-folder").length)) === addsBefore + 1, "native picker request (cancelled)");
});

await runSection("expanded-async-settings-completes", async () => {
  await nav("Settings"); await settingsTab("Appearance");
  await page.evaluate(() => { window.__audit.state.settingsDelays = [1200, 0]; });
  const reduce = await settingRow("Reduce motion");
  const compact = await settingRow("Compact sidebar");
  await (await reduce.$('input[type="checkbox"]')).click();
  await (await compact.$('input[type="checkbox"]')).click();
  await wait(1500);
  const saved = await storedSettings();
  if (process.env.AUDIT_DEBUG) console.log("ASYNC SETTINGS", await page.evaluate(() => window.__audit.state.calls.filter(call => call[0].startsWith("settings-patch"))));
  const live = await page.evaluate(() => ({ reduce: document.documentElement.dataset.reduceMotion, compact: document.documentElement.dataset.compactSidebar }));
  check("settings-out-of-order-patches-keep-latest", saved.appearance?.reduceMotion === true && saved.appearance?.compactSidebar === true && live.reduce === "true" && live.compact === "true", JSON.stringify({ saved: saved.appearance, live }));
  await resetAllSettings();
});

for (const name of unmatchedSections) check(name, false, "Unknown AUDIT_ONLY section");
const rendererErrors = logs.filter(line => line.startsWith("[pageerror]"));
check("no-unhandled-renderer-errors", rendererErrors.length === 0, rendererErrors.slice(0, 3).join("; "));


blocked("native-windows-smtc", "No Windows host is available; actual SMTC flyout, AUMID registration, media keys, and native metadata remain unverified.");
blocked("native-window-and-os-dialogs", "Chromium exercises renderer dispatch and stubbed dialogs only; native Tauri window controls, fullscreen, and filesystem dialogs require Windows.");
blocked("physical-media-keys", "MediaSession metadata and renderer command dispatch are tested; physical keyboard/media-key delivery requires a Windows session.");
blocked("live-online-lyrics-providers", "External provider services and credentials are unavailable; local/embedded and fixture-backed provider paths are tested instead.");
notTested("native-accent-color-picker", "The accent input value is synchronized, but changing it through the native OS color picker was not possible in headless Chromium.");
notTested("windows-installer-shortcut-aumid", "The unpacked/installed Windows shortcut and process AUMID association were not exercised without a Windows host.");
notTested("hardware-gpu-memory-and-long-run", "SwiftShader smoke coverage is complete, but physical GPU performance, RAM growth, and long-running native freeze/leak behavior were not measured.");
await auditShot("final-audit-state");
const phase = process.env.AUDIT_PHASE || "targeted";
writeFileSync(join(auditDir, `${phase}-results.json`), JSON.stringify({ results, logs }, null, 2));
const summary = Object.values(results).reduce((acc, result) => {
  if (result.status === "BLOCKED") acc.blocked += 1;
  else if (result.status === "NOT TESTED") acc.notTested += 1;
  else if (result.value) acc.passed += 1;
  else acc.failed += 1;
  return acc;
}, { passed: 0, failed: 0, blocked: 0, notTested: 0 });
console.log(`Audit ${phase}: ${summary.passed} passed, ${summary.failed} failed, ${summary.blocked} blocked, ${summary.notTested} not tested`);
await browser.close(); server.close();
if (summary.failed > 0) process.exitCode = 1;
