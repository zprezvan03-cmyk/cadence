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
        version: "0.1.0",
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
      player: {
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
  window.cadence.library.addFolder = async () => { state.calls.push(["add-folder"]); return { canceled: true, folders: [...state.folders] }; };
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
  window.cadence.lyrics.clearCache = async () => { state.calls.push(["clear-lyrics-cache"]); };
  window.cadence.app.chooseLyricsFile = async trackId => { state.calls.push(["choose-lyrics", trackId]); return structuredClone(state.chooseLyricsResult); };
  window.cadence.app.openExternal = async url => { state.calls.push(["open-external", url]); };
}
await page.evaluate(installAuditBridge);
await page.evaluateOnNewDocument(installAuditBridge);

/* --------------------------------------------------------- audit utils */
const auditDir = join(root, ".artifacts/ui-audit");
mkdirSync(auditDir, { recursive: true });
const auditShot = async name => page.screenshot({ path: join(auditDir, `${name}.png`) });
const clickText = async (selector, wanted, exact = true) => {
  const handles = await page.$$(selector);
  for (const handle of handles) {
    const text = await handle.evaluate(node => node.textContent?.replace(/\s+/g, " ").trim() ?? "");
    if (exact ? text === wanted : text.includes(wanted)) { await handle.click(); await wait(90); return handle; }
  }
  throw new Error(`No ${selector} with text ${JSON.stringify(wanted)}; saw ${JSON.stringify(await page.$$eval(selector, nodes => nodes.map(node => node.textContent?.replace(/\s+/g, " ").trim())))}`);
};
const nav = async label => { await clickText(".sidebar .nav-item", label); await wait(140); };
const settingsTab = async label => { await clickText(".settings-tabs button", label); await wait(80); };
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
const revealFullscreenControls = async () => { await page.mouse.move(740, 840); await wait(350); };
const openQueue = async () => {
  if (!(await page.$('[data-testid="queue-panel"]'))) {
    if (await page.$(".lyrics-view.is-fullscreen")) await revealFullscreenControls();
    const selector = await page.$('.player-bar button[aria-label="Queue"]')
      ? '.player-bar button[aria-label="Queue"]'
      : '[data-testid="fullscreen-controls"] button[aria-label="Queue"]';
    await page.click(selector);
  }
  await wait(100);
};
const closeQueue = async () => { if (await page.$('[data-testid="queue-panel"]')) await page.click('button[aria-label="Close queue"]'); await wait(80); };
const storedSettings = async () => page.evaluate(() => JSON.parse(localStorage.getItem("cadence.harness.settings.v1") || "{}"));
const storedSession = async () => page.evaluate(() => JSON.parse(localStorage.getItem("cadence.session.v1") || "null"));
const runSection = async (name, fn) => {
  if (process.env.AUDIT_ONLY && process.env.AUDIT_ONLY !== name) return;
  try { await fn(); } catch (error) {
    check(name, false, `${error.message}; route=${await page.evaluate(() => location.hash)}`);
    await auditShot(`error-${name}`);
  }
};

await runSection("sidebar-new-playlist-completes", async () => {
  await nav("Playlists");
  await page.click('.sidebar button[aria-label="New playlist"]');
  await wait(120);
  check("sidebar-new-playlist-opens-form", Boolean(await page.$(".inline-create input")), "sidebar + should open the playlist-name form");
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
  await page.click(".view-heading button"); await wait(150);
  const resetState = await page.evaluate(() => ({ rate: document.querySelector("audio")?.playbackRate,
    repeat: document.querySelector('.player-bar button[aria-label^="Repeat:"]')?.getAttribute("aria-label"),
    shuffle: document.querySelector('.player-bar button[aria-label="Shuffle"]')?.getAttribute("aria-pressed") }));
  check("reset-all-applies-playback-defaults", resetState.rate === 1 && resetState.repeat === "Repeat: off" && resetState.shuffle === "false", JSON.stringify(resetState));
});

await runSection("appearance-settings-completes", async () => {
  await settingsTab("Appearance");
  const before = await page.$eval(".sidebar", node => node.getBoundingClientRect().width);
  await toggleSetting("Compact sidebar");
  const after = await page.$eval(".sidebar", node => node.getBoundingClientRect().width);
  check("compact-sidebar-changes-layout", after < before, `${before}px → ${after}px`);
  await toggleSetting("Compact sidebar");
  await toggleSetting("Verbose shader logs"); await nav("Now Playing"); await wait(500);
  const verboseLogs = logs.filter(line => /kawarp|shader/i.test(line) && /debug|log/i.test(line));
  check("verbose-shader-logs-produce-diagnostics", verboseLogs.length > 0, JSON.stringify(verboseLogs.slice(-3)));
});

await runSection("recent-play-completes", async () => {
  await nav("Songs"); await setShuffle(false); await playTrack("Fixture FLAC");
  check("real-audio-started", !(await audioState()).paused, await playerTitle());
  await nav("Home");
  const recentText = await page.evaluate(() => [...document.querySelectorAll(".shelf")].find(node => node.querySelector("h2")?.textContent === "Recently played")?.textContent ?? "");
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
  await setShuffle(false); await nav("Songs"); await playTrack("Fixture FLAC"); await openQueue();
  const originalQueue = await queueState(); const secondTitle = originalQueue.titles[1];
  await page.$$eval(".queue-track", nodes => nodes[1]?.click()); await wait(400);
  const firstRemove = await page.$('.queue-list li:first-child button[aria-label^="Remove "]'); await firstRemove.click(); await wait(150);
  const removedState = { title: await playerTitle(), src: (await audioState()).src, queue: await queueState() };
  check("remove-earlier-queue-entry-preserves-current", removedState.title === secondTitle && removedState.queue.titles[removedState.queue.current] === secondTitle, `expected ${secondTitle}; ${JSON.stringify(removedState)}`);
  await closeQueue();
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
  await nav("Songs"); await playTrack("Fixture AAC"); await nav("Now Playing");
  await page.waitForSelector(".blyrics--line", { timeout: 8000 });
  const before = await page.$$eval(".blyrics--line", nodes => nodes.length);
  await nav("Settings"); await settingsTab("Appearance"); await toggleSetting("Hide instrumental-only placeholders"); await nav("Now Playing"); await wait(400);
  const after = await page.$$eval(".blyrics--line", nodes => nodes.length);
  check("hide-instrumental-only-hides-placeholder", before > 0 && after === 0, `${before} → ${after} lines`);
});

await runSection("lyrics-request-dedup-completes", async () => {
  await nav("Songs"); await playTrack("Fixture Opus"); await nav("Now Playing");
  await page.waitForFunction(() => document.querySelector('[data-testid="sync-label"]')?.textContent?.includes("Not found"), { timeout: 8000 });
  const count = () => page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve" && call[1] === 8).length);
  const before = await count(); await nav("Songs"); await nav("Now Playing"); await wait(500); const after = await count();
  check("empty-lyrics-remount-does-not-duplicate-request", before === 1 && after === before, `${before} → ${after} resolve calls`);
});

await runSection("manual-search-clear-completes", async () => {
  await clickText(".dock-button", "Source", false); await clickText(".manual-search-entry", "Search Manually", false);
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
  await selectSetting("Performance mode", "off"); await rangeSetting("Opacity", "Home"); await nav("Now Playing"); await wait(250);
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
  await nav("Settings"); await page.click(".view-heading button"); await wait(150);
  const destinations = [
    ["Home", "home-view"], ["Songs", "library-view-songs"], ["Albums", "library-view-albums"],
    ["Artists", "library-view-artists"], ["Playlists", "library-view-playlists"],
    ["Liked songs", "library-view-favorites"], ["Now Playing", "lyrics-view"], ["Settings", "settings-view"],
  ];
  for (const [label, testId] of destinations) {
    await nav(label);
    check(`nav-${testId}`, Boolean(await page.$(`[data-testid="${testId}"]`)), label);
  }
  await nav("Albums"); await nav("Artists");
  await page.click('.top-bar button[aria-label="Back"]'); await wait(150);
  check("topbar-back", Boolean(await page.$('[data-testid="library-view-albums"]')), await page.evaluate(() => location.hash));
  await page.click('.top-bar button[aria-label="Forward"]'); await wait(150);
  check("topbar-forward", Boolean(await page.$('[data-testid="library-view-artists"]')), await page.evaluate(() => location.hash));
  const brand = await page.$(".brand"); await brand.focus(); await page.keyboard.press("Enter"); await wait(120);
  check("brand-enter-home", Boolean(await page.$('[data-testid="home-view"]')), "Enter");
  await nav("Songs"); await brand.focus(); await page.keyboard.press("Space"); await wait(120);
  check("brand-space-home", Boolean(await page.$('[data-testid="home-view"]')), "Space");
  await clickText(".quick-card", "Liked songs", false);
  check("home-quick-liked", Boolean(await page.$('[data-testid="library-view-favorites"]')), "quick card");
  await nav("Home"); await clickText(".quick-card", "Now Playing", false);
  check("home-quick-now-playing", Boolean(await page.$('[data-testid="lyrics-view"]')), "quick card");
  await nav("Home"); await clickText(".quick-card", "Playlists", false);
  check("home-quick-playlists", Boolean(await page.$('[data-testid="library-view-playlists"]')), "quick card");
  await nav("Home");
  if (await page.$(".quick-track")) {
    await clickText(".shelf-heading .link", "Show all");
    check("recently-played-show-all", Boolean(await page.$('[data-testid="library-view-songs"]')), "Show all");
    await nav("Home"); await (await page.$(".quick-track")).click(); await wait(400);
    check("recently-played-track-plays", !(await audioState()).paused, await playerTitle());
  } else check("recently-played-track-plays", false, "no recent track button");
  await nav("Home");
  const albumLinks = await page.$$(".shelf-heading .link");
  for (const link of albumLinks) {
    const shelf = await link.evaluate(node => node.closest(".shelf")?.querySelector("h2")?.textContent);
    if (shelf === "Your albums") { await link.click(); break; }
  }
  await wait(120);
  check("albums-show-all", Boolean(await page.$('[data-testid="library-view-albums"]')), "Show all");
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
  if (process.env.AUDIT_DEBUG) console.log("BACK BEFORE", await page.evaluate(() => { const button = document.querySelector('.detail-hero button[aria-label="Back"]'); const rect = button?.getBoundingClientRect(); return { hash: location.hash, length: history.length, rect: rect?.toJSON(), hit: rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML.slice(0, 180) : null }; }));
  await page.click('.detail-hero button[aria-label="Back"]'); await wait(500);
  if (process.env.AUDIT_DEBUG) console.log("BACK AFTER", await page.evaluate(() => ({ hash: location.hash, length: history.length })));
  check("detail-back", Boolean(await page.$('[data-testid="library-view-songs"]')), await page.evaluate(() => location.hash));
  await nav("Albums");
  const albumCard = await page.$('[data-testid="album-card"]'); await albumCard.focus(); await page.keyboard.press("Enter"); await wait(150);
  check("album-card-keyboard-open", Boolean(await page.$(".detail-hero")), "Enter");
  await nav("Artists"); const artistCard = await page.$(".artist-card"); await artistCard.focus(); await page.keyboard.press("Space"); await wait(150);
  check("artist-card-keyboard-open", Boolean(await page.$(".detail-hero")), "Space");
});

await runSection("expanded-playlist-completes", async () => {
  await nav("Playlists"); await clickText(".list-toolbar button", "New playlist", false);
  await clickText(".inline-create button", "Cancel");
  check("playlist-create-cancel", !(await page.$(".inline-create")), "form closed");
  await clickText(".list-toolbar button", "New playlist", false);
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
  await page.mouse.click(5, 120); await wait(100);
  check("playlist-add-backdrop-close", !(await page.$(".modal-backdrop")), "backdrop");
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
  await nav("Settings"); await page.click(".view-heading button"); await wait(150); await settingsTab("Appearance");
  const expectations = [];
  const remember = async (label, kind = "value") => {
    const row = await settingRow(label); const input = await row.$("input, select, textarea");
    expectations.push({ label, kind, value: kind === "checked" ? await input.evaluate(node => node.checked) : await input.evaluate(node => node.value) });
  };
  await selectSetting("Font", "monospace");
  check("font-applies-globally", (await page.$eval(".font-preview", node => getComputedStyle(node).fontFamily)).includes("monospace"), await page.$eval(".font-preview", node => getComputedStyle(node).fontFamily));
  await remember("Font");
  await toggleSetting("Reduce motion");
  check("reduce-motion-applies", (await page.$eval("html", node => node.dataset.reduceMotion)) === "true", "root dataset");
  await remember("Reduce motion", "checked");
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
    expectations.push({ label, kind: "value", value });
  }

  const providerNames = await page.$$eval(".provider-order .provider-name", nodes => nodes.slice(0, 2).map(node => node.textContent.trim()));
  await page.click('.provider-order li:nth-child(2) button[aria-label="Move up"]'); await wait(80);
  const movedUp = await page.$$eval(".provider-order .provider-name", nodes => nodes.slice(0, 2).map(node => node.textContent.trim()));
  check("provider-move-up", movedUp[0] === providerNames[1], `${providerNames[0]} ↔ ${providerNames[1]}`);
  await page.click('.provider-order li:nth-child(1) button[aria-label="Move down"]'); await wait(80);
  const movedDown = await page.$$eval(".provider-order .provider-name", nodes => nodes.slice(0, 2).map(node => node.textContent.trim()));
  check("provider-move-down", movedDown[0] === providerNames[0], "restored original first two");
  const providerCount = (await page.$$(".provider-order li")).length;
  await page.click('.provider-order li:first-child button[aria-label="Remove from order"]'); await wait(80);
  check("provider-remove", (await page.$$(".provider-order li")).length === providerCount - 1 && Boolean(await page.$(".provider-pool-chip")), "removed to pool");
  await (await page.$(".provider-pool-chip")).click(); await wait(80);
  check("provider-add", (await page.$$(".provider-order li")).length === providerCount, "added from pool");
  await page.click(".provider-restore"); await wait(80);
  check("provider-restore-defaults", (await storedSettings()).lyrics.providerOrder.length === 13, `${(await page.$$(".provider-order li")).length} rows`);

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
    await settingsTab(["Playback speed", "Repeat", "Restore the last session on launch"].includes(expected.label) ? "Playback" : "Appearance");
    const row = await settingRow(expected.label); const input = await row.$("input, select, textarea");
    const actual = expected.kind === "checked" ? await input.evaluate(node => node.checked) : await input.evaluate(node => node.value);
    if (actual !== expected.value) mismatches.push(`${expected.label}: ${expected.value} → ${actual}`);
  }
  check("settings-restart-persistence", mismatches.length === 0, mismatches.join("; ") || `${expectations.length} changed controls restored`);
  await page.click(".view-heading button"); await wait(150);
  const defaults = await storedSettings();
  check("reset-all-clears-saved-overrides", Object.keys(defaults).length === 0, "harness reset removes the saved override object");
});

await runSection("expanded-lyrics-completes", async () => {
  await nav("Songs"); await setShuffle(false); await playTrack("Fixture FLAC"); await nav("Now Playing");
  await page.waitForSelector(".blyrics--line", { timeout: 8000 });
  await pausePlayback();
  check("lyrics-rich-source-ready", (await page.$eval('[data-testid="sync-label"]', node => node.textContent)).includes("Word synced"), "real parsed lyrics");
  const offset = () => page.$eval(".offset-value", node => node.textContent.trim());
  const offsetBefore = await offset(); await page.click(".dock-offset button:first-child");
  check("lyrics-offset-minus", (await offset()) !== offsetBefore, `${offsetBefore} → ${await offset()}`);
  const offsetMinus = await offset(); await page.click(".dock-offset button:last-child");
  check("lyrics-offset-plus", (await offset()) !== offsetMinus, `${offsetMinus} → ${await offset()}`);
  await page.click('button[title="Translate lyrics"]'); await clickText(".dock-languages .source-row", "Off");
  check("dock-translate-off", (await storedSettings()).lyrics.translationLanguage === "", "Off selected");
  await page.click('button[title="Translate lyrics"]'); await clickText(".dock-languages .source-row", "Spanish", false); await wait(350);
  check("dock-translate-language", (await storedSettings()).lyrics.translationLanguage === "es" && Boolean(await page.$(".blyrics--translated")), "Spanish translation rendered");
  await page.click('button[title="Romanize lyrics"]'); await wait(300);
  check("dock-romanize", (await storedSettings()).lyrics.romanization === true && Boolean(await page.$(".blyrics--romanized")), "romanized lines rendered");
  await page.click('button[title="Romanize lyrics"]'); await wait(150);
  check("dock-romanize-off-keeps-translation", !(await page.$(".blyrics--romanized")) && Boolean(await page.$(".blyrics--translated")), "decorations independent");

  await clickText(".dock-button", "Source", false);
  await clickText(".dock-sources .source-row", "Audit line source", false); await wait(180);
  check("lyrics-source-selection", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Alternate first line"), "alternate source rendered");
  await nav("Songs"); await nav("Now Playing");
  check("lyrics-source-survives-navigation", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Alternate first line"), "selected source retained");
  const resolveBefore = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve").length);
  await page.click('button[title="Reload lyrics"]'); await wait(300);
  check("lyrics-reload", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve").length)) === resolveBefore + 1, "one reload request");
  await page.click('button[title="Save lyrics next to the track"]'); await wait(100);
  check("lyrics-save-sidecar", await page.evaluate(() => window.__audit.state.calls.some(call => call[0] === "save-sidecar" && String(call[2]).includes("Alternate"))), "selected text saved");
  await page.evaluate(() => { window.__audit.state.chooseLyricsResult = { canceled: true }; });
  await page.click('button[title="Open a lyrics file"]'); await wait(100);
  check("lyrics-file-cancel", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Alternate first line"), "cancel leaves lyrics unchanged");
  await page.evaluate(() => { window.__audit.state.chooseLyricsResult = { canceled: false, path: "/chosen.lrc", text: "[00:00.30]Chosen file line\n[00:01.60]Chosen second line" }; });
  await page.click('button[title="Open a lyrics file"]'); await wait(180);
  check("lyrics-file-open", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Chosen file line"), "chosen file rendered");

  await clickText(".dock-button", "Style", false);
  const dockSliders = ["Font size", "Translation Font Size", "Romanization Font Size", "Weight", "Line height", "Active", "Inactive"];
  for (const label of dockSliders) {
    const handles = await page.$$(".dock-appearance .slider-row");
    let found = false;
    for (const row of handles) {
      if ((await row.$eval("span", node => node.textContent.trim())) !== label) continue;
      const input = await row.$('input[type="range"]'); await input.focus(); await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight"); await wait(50);
      const value = await input.evaluate(node => node.value); const output = await row.$eval("output", node => node.textContent.trim());
      check(`dock-style-${label.replaceAll(" ", "-").toLowerCase()}`, output.length > 0 && Number.isFinite(Number(value)), `${value}; ${output}`);
      found = true; break;
    }
    if (!found) check(`dock-style-${label}`, false, "slider not found");
  }
  const creditToggle = await page.$('.dock-appearance .toggle-row input');
  await creditToggle.click(); await wait(150);
  check("dock-show-songwriters-off", !(await page.$(".blyrics-credits")), "credits hidden");
  await creditToggle.click(); await wait(150);
  check("dock-show-songwriters-on", Boolean(await page.$(".blyrics-credits")), "credits restored");
  const passive = (await page.$$(".dock-appearance .toggle-row input"))[1]; await passive.click();
  check("dock-passive-scroll-setting", (await storedSettings()).lyrics.passiveScroll === false, "toggle stored");
  await clickText(".dock-button", "Style", false);

  await nav("Settings"); await settingsTab("Appearance"); await selectSetting("Theme", "custom");
  await page.type('[data-testid="settings-lyrics"] textarea', ".blyrics-container { --audit-theme: 42; }");
  await nav("Now Playing"); await wait(200);
  check("custom-theme-applies-to-renderer", (await page.$eval("braccato-lyrics", node => node.theme)).includes("--audit-theme: 42"), "custom CSS handed to Braccato");
  await nav("Settings"); await settingsTab("Appearance"); await toggleSetting("Fetch lyrics online");
  await nav("Songs"); await playTrack("Fixture Opus"); await nav("Now Playing"); await wait(350); await pausePlayback();
  const lastResolve = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve").at(-1));
  check("offline-lyrics-resolve", lastResolve?.[2] === true, JSON.stringify(lastResolve));
  check("offline-enable-settings-action", Boolean(await clickText(".empty-actions button", "Enable online lyrics in settings")) && Boolean(await page.$('[data-testid="settings-view"]')), "opens Settings");
  await settingsTab("Appearance"); await toggleSetting("Fetch lyrics online");
});

await runSection("expanded-manual-lyrics-completes", async () => {
  await nav("Songs"); await playTrack("Fixture Opus"); await nav("Now Playing"); await wait(300); await pausePlayback();
  if (process.env.AUDIT_DEBUG) console.log("MANUAL PAUSED", await audioState());
  const beforeRetry = await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve").length);
  if (await page.$(".lyrics-empty-panel button:not(.primary)")) await clickText(".lyrics-empty-panel button", "Try again", false);
  check("empty-lyrics-try-again", (await page.evaluate(() => window.__audit.state.calls.filter(call => call[0] === "lyrics-resolve").length)) === beforeRetry + 1, "retry control operated");
  await page.evaluate(() => { window.__audit.state.chooseLyricsResult = { canceled: false, path: "/empty-chosen.lrc", text: "Chosen empty-state lyrics" }; });
  if (await page.$(".lyrics-empty-panel .primary")) await clickText(".lyrics-empty-panel .primary", "Choose a lyrics file", false);
  check("empty-lyrics-choose-file", (await page.$eval(".lyrics-body", node => node.textContent)).includes("Chosen empty-state lyrics"), "empty-state file action");
  await clickText(".dock-button", "Source", false); await clickText(".manual-search-entry", "Search Manually", false);
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
  await clickText(".dock-button", "Source", false); await clickText(".manual-search-entry", "Search Manually", false);
  check("manual-draft-survives-panel", (await page.$eval('input[aria-label="Song title"]', node => node.value)) === "Manual Song", "draft restored");
  await nav("Settings"); await settingsTab("Playback");
  const resumeRow = await settingRow("Restore the last session on launch");
  if (!(await resumeRow.$eval('input[type="checkbox"]', node => node.checked))) await toggleSetting("Restore the last session on launch");
  await nav("Now Playing");
  if (process.env.AUDIT_DEBUG) console.log("MANUAL BEFORE RELOAD", await page.evaluate(() => ({ session: localStorage.getItem("cadence.session.v1"), settings: localStorage.getItem("cadence.harness.settings.v1"), title: document.querySelector(".player-title")?.textContent })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await wait(500);
  if (process.env.AUDIT_DEBUG) console.log("MANUAL AFTER RELOAD", await page.evaluate(() => ({ session: localStorage.getItem("cadence.session.v1"), settings: localStorage.getItem("cadence.harness.settings.v1"), title: document.querySelector(".player-title")?.textContent, audit: window.__audit?.state?.tracks?.length }))); await page.waitForSelector('[data-testid="lyrics-dock"]'); await wait(600);
  await clickText(".dock-button", "Source", false); await clickText(".manual-search-entry", "Search Manually", false);
  check("manual-draft-survives-restart", (await page.$eval('input[aria-label="Song title"]', node => node.value)) === "Manual Song", "localStorage draft restored");
  await page.evaluate(() => { window.__audit.state.failSearch = true; }); await page.click(".search-submit"); await wait(150);
  check("manual-search-error", (await page.$eval(".search-error", node => node.textContent)).includes("Audit search failure"), "inline error");
  await page.evaluate(() => { window.__audit.state.failSearch = false; }); await clickText(".search-retry", "Retry", false); await wait(150);
  check("manual-search-retry", Boolean(await page.$(".dock-search > .source-row")), "retry returns results");
  await page.click('button[aria-label="Clear query and results"]');
  check("manual-clear-resets-draft", (await page.$eval('input[aria-label="Song title"]', node => node.value)) === "Fixture Opus", "track defaults restored");
  await page.click('.search-panel-head button[title="Back to sources"]');
  check("manual-back-to-sources", Boolean(await page.$(".dock-sources")), "source popover restored");
});

await runSection("expanded-fullscreen-completes", async () => {
  await nav("Songs"); await playTrack("Fixture FLAC");
  await page.click('.player-bar button[aria-label="Fullscreen lyrics"]'); await wait(250);
  check("fullscreen-enter-control", Boolean(await page.$(".lyrics-view.is-fullscreen")), "immersive view");
  await openQueue();
  if (process.env.AUDIT_DEBUG) console.log("ESC BEFORE", await page.evaluate(() => ({ queue: Boolean(document.querySelector('[data-testid="queue-panel"]')), fullscreen: Boolean(document.querySelector('.lyrics-view.is-fullscreen')), active: document.activeElement?.outerHTML.slice(0, 160) })));
  await page.keyboard.press("Escape"); await wait(250);
  if (process.env.AUDIT_DEBUG) console.log("ESC AFTER", await page.evaluate(() => ({ queue: Boolean(document.querySelector('[data-testid="queue-panel"]')), fullscreen: Boolean(document.querySelector('.lyrics-view.is-fullscreen')), native: window.__chrome.fullscreen })));
  check("escape-closes-queue-before-fullscreen", !(await page.$('[data-testid="queue-panel"]')) && Boolean(await page.$(".lyrics-view.is-fullscreen")), "queue closed, fullscreen retained");
  if (await page.$('[data-testid="queue-panel"]')) await closeQueue();
  await page.keyboard.press("F11"); await wait(200);
  const f11 = await page.evaluate(() => ({ immersive: Boolean(document.querySelector(".lyrics-view.is-fullscreen")), native: window.__chrome.fullscreen }));
  check("f11-native-and-immersive-toggle", !f11.immersive && f11.native, JSON.stringify(f11));
  if (!(await page.$(".lyrics-view.is-fullscreen"))) await page.keyboard.press("F11"); await wait(250);
  await revealFullscreenControls();
  await page.click('[data-testid="fullscreen-lyrics-toggle"]'); await wait(150);
  check("fullscreen-lyrics-off-panel", Boolean(await page.$(".lyrics-view.is-lyrics-off")), "panel layout");
  await revealFullscreenControls();
  await page.click('[data-testid="fullscreen-lyrics-toggle"]'); await wait(150);
  check("fullscreen-lyrics-on-panel", !(await page.$(".lyrics-view.is-lyrics-off")), "lyrics restored");
  await page.click('button[aria-label="Exit fullscreen lyrics"]'); await wait(120);
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
  await nav("Songs"); await playTrack("Fixture FLAC"); await nav("Now Playing"); await wait(500);
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
  await nav("Home"); if (await page.$(".quick-track")) await (await page.$(".quick-track")).click(); await wait(350);
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
  check("playback-error-banner", Boolean(await page.$(".error-banner")), "unsupported fixture reports error");
  if (await page.$(".error-banner")) await clickText(".error-banner button", "Dismiss");
  check("playback-error-dismiss", !(await page.$(".error-banner")), "banner dismissed");
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
  await setShuffle(false); await nav("Albums"); await (await page.$('[data-testid="album-card"]')).click(); await wait(120);
  await clickText(".detail-hero .heading-actions button", "Shuffle");
  check("album-shuffle-randomizes-order", (await page.$eval('.player-bar button[aria-label="Shuffle"]', node => node.getAttribute("aria-pressed"))) === "true", "transport shuffle enabled");
  await clickText(".detail-hero .heading-actions button", "Play"); await wait(150);
  check("album-play", !(await audioState()).paused, await playerTitle());
  await clickText(".detail-hero .heading-actions button", "Now Playing", false);
  check("album-now-playing", Boolean(await page.$('[data-testid="lyrics-view"]')), "hero action");
  await setShuffle(false); await nav("Artists"); await (await page.$(".artist-card")).click(); await wait(120);
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
  await page.keyboard.press("Q"); await wait(80); check("shortcut-q-close", !(await page.$('[data-testid="queue-panel"]')), "queue closed");
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
  check("renderer-menu-fullscreen", Boolean(await page.$(".lyrics-view.is-fullscreen")), "native menu action path");
  await page.keyboard.press("Escape");
});

await runSection("expanded-empty-library-completes", async () => {
  await page.evaluate(() => { window.__audit.state.folders = ["/fixtures"]; });
  await nav("Settings"); await settingsTab("Library"); await clickText(".heading-actions button", "Rescan now"); await wait(200);
  if (process.env.AUDIT_DEBUG) console.log("EMPTY BEFORE", await page.evaluate(() => ({ folders: window.__audit.state.folders, tracks: window.__audit.state.tracks.length, buttons: [...document.querySelectorAll("button")].map(node => node.getAttribute("aria-label") || node.textContent?.trim()).filter(Boolean) })));
  if (await page.$('button[aria-label="Remove folder"]')) await page.click('button[aria-label="Remove folder"]'); await wait(400);
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
  await page.click(".view-heading button"); await wait(180);
});

await auditShot("final-audit-state");
const phase = process.env.AUDIT_PHASE || "targeted";
writeFileSync(join(auditDir, `${phase}-results.json`), JSON.stringify({ results, logs }, null, 2));
const summary = Object.entries(results).reduce((acc, [, result]) => { acc[result.value ? "passed" : "failed"] += 1; return acc; }, { passed: 0, failed: 0 });
console.log(`Audit ${phase}: ${summary.passed} passed, ${summary.failed} failed`);
await browser.close(); server.close();
if (summary.failed > 0) process.exitCode = 1;
