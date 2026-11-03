/**
 * Repro/QA harness for YouTube Music result navigation: boots the real production renderer
 * bundle in headless Chromium, stubs only the network boundary (window.fetch answers
 * music.youtube.com InnerTube calls with recorded-shape fixtures) and window.cadence (IPC),
 * then clicks each search-result type and records console errors, page errors and what the
 * content area actually renders.
 *
 * Usage: npm run build:web && node tests/browser/ytm-nav.mjs
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const root = resolve(import.meta.dirname, "../..");
const dist = join(root, "dist");
const shotDir = join(root, ".artifacts/screens");
mkdirSync(shotDir, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };

/* ------------------------------------------------------------- InnerTube fixtures */

const song = (id, title, artist = "Rick Astley", album = "Whenever You Need Somebody") => ({
  musicResponsiveListItemRenderer: {
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
      {
        musicResponsiveListItemFlexColumnRenderer: {
          text: {
            runs: [
              { text: artist, navigationEndpoint: { browseEndpoint: { browseId: "UCuAXFkgsw1L7xaCfnd5JJOw", browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } } } },
              { text: " • " },
              album ? { text: album, navigationEndpoint: { browseEndpoint: { browseId: "MPREb_album1", browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } } } } } : { text: "" },
              { text: " • " },
              { text: "3:32" },
            ],
          },
        },
      },
    ],
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/x/hq.jpg", width: 120, height: 90 }] } } },
    navigationEndpoint: { watchEndpoint: { videoId: id, playlistId: "OLAK5uy_pl1", watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_ATV" } } } },
    playlistItemData: { videoId: id, playlistId: "OLAK5uy_pl1" },
  },
});

const twoRow = (id, title, pageType, sub) => ({
  musicTwoRowItemRenderer: {
    title: { runs: [{ text: title }] },
    subtitle: { runs: [{ text: sub }] },
    thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/y/mq.jpg", width: 226, height: 226 }] } } },
    navigationEndpoint: { browseEndpoint: { browseId: id, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType } } } },
  },
});

const continuation = token => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });

const searchResponse = {
  contents: {
    tabbedSearchResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            selected: true,
            content: {
              sectionListRenderer: {
                contents: [
                  { musicCardShelfRenderer: { title: { runs: [{ text: "Never Gonna Give You Up" }] }, subtitle: { runs: [{ text: "Song • Rick Astley" }] }, thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/x/mq.jpg" }] }, onTap: { watchEndpoint: { videoId: "dQw4w9WgXcQ", watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_ATV" } } } } } },
                  { musicShelfRenderer: { title: { runs: [{ text: "Songs" }] }, contents: [song("s1", "Never Gonna Give You Up"), song("s2", "Together Forever"), song("s3", "Whenever You Need Somebody")] } },
                  { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Albums" }] } } }, contents: [twoRow("MPREb_album1", "Whenever You Need Somebody", "MUSIC_PAGE_TYPE_ALBUM", "Album • 1987")] } },
                  { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Artists" }] } } }, contents: [twoRow("UCuAXFkgsw1L7xaCfnd5JJOw", "Rick Astley", "MUSIC_PAGE_TYPE_ARTIST", "2.5M subscribers")] } },
                  { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Playlists" }] } } }, contents: [twoRow("VLPLtest1", "Rick Astley Mix", "MUSIC_PAGE_TYPE_PLAYLIST", "Playlist • 50 songs")] } },
                ],
                continuations: [continuation("SEARCH_TOK")],
              },
            },
          },
        },
      ],
    },
  },
};

const searchContinuation = {
  continuationContents: {
    musicShelfContinuation: {
      contents: [song("s4", "Cry for Help"), song("s5", "Keep Singing"), continuation("SEARCH_TOK2")],
      continuations: [continuation("SEARCH_TOK2")],
    },
  },
};

const artistPage = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        { tabRenderer: { content: { sectionListRenderer: {
          header: { musicImmersiveHeaderRenderer: { title: { runs: [{ text: "Rick Astley" }] }, subtitle: { runs: [{ text: "2.5M subscribers" }] }, thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/b/big.jpg" }] } } } } },
          contents: [
            { musicShelfRenderer: { title: { runs: [{ text: "Popular" }] }, contents: [song("s1", "Never Gonna Give You Up"), song("s2", "Together Forever")] } },
            { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Albums" }] } } }, contents: [twoRow("MPREb_album1", "Whenever You Need Somebody", "MUSIC_PAGE_TYPE_ALBUM", "Album • 1987")] } },
          ],
        } } } },
      ],
    },
  },
};

const albumPage = {
  contents: {
    singleColumnBrowseResultsRenderer: {
      tabs: [
        { tabRenderer: { content: { sectionListRenderer: {
          header: { musicResponsiveHeaderRenderer: { title: { runs: [{ text: "Whenever You Need Somebody" }] }, subtitle: { runs: [{ text: "Rick Astley" }, { text: " • " }, { text: "1987" }, { text: " • " }, { text: "12 songs" }] }, thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/a/big.jpg" }] } } },
          contents: [{ musicShelfRenderer: { title: { runs: [{ text: "Songs" }] }, contents: [song("s1", "Never Gonna Give You Up"), song("s2", "Together Forever"), song("s3", "Whenever You Need Somebody")] } }],
        } } } },
      ],
    },
  },
};

const playlistPage = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: { contents: [song("s1", "Never Gonna Give You Up"), song("s2", "Together Forever")], continuations: [continuation("PL_TOK")] } }] } } } }],
      header: { musicEditablePlaylistDetailHeaderRenderer: { title: { runs: [{ text: "Rick Astley Mix" }] }, subtitle: { runs: [{ text: "Rick Astley", navigationEndpoint: { browseEndpoint: { browseId: "UCuAXFkgsw1L7xaCfnd5JJOw", browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } } } }, { text: " • " }, { text: "50 songs" }] }, thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/p/big.jpg" }] } } },
    },
  },
};

const playerResponse = {
  playabilityStatus: { status: "OK" },
  videoDetails: { videoId: "s1", title: "Never Gonna Give You Up", author: "Rick Astley", lengthSeconds: "212" },
  streamingData: { adaptiveFormats: [{ itag: 140, url: "https://rr1---sn.example/videoplayback?itag=140", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129812, approxDurationMs: "212000" }] },
};

const homeResponse = { contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { title: { runs: [{ text: "Quick picks" }] }, contents: [song("s1", "Never Gonna Give You Up")] } }] } } } }] } } };

function innertubeResponse(url, bodyText) {
  if (url.includes("sw.js_data")) return { text: `)]}'\n${JSON.stringify([["x"], ["y"], ["CgtTEST123", "z"]])}`, contentType: "text/javascript" };
  const body = bodyText ? JSON.parse(bodyText) : {};
  if (url.includes("/youtubei/v1/search")) {
    return { json: url.includes("continuation=") ? searchContinuation : searchResponse };
  }
  if (url.includes("/youtubei/v1/browse")) {
    const id = body.browseId ?? body.continuation ?? "";
    if (String(id).startsWith("UC")) return { json: artistPage };
    if (String(id).startsWith("MPREb_") || String(id).startsWith("OLAK")) return { json: albumPage };
    if (String(id).startsWith("VL") || String(id).startsWith("PL")) return { json: playlistPage };
    return { json: homeResponse };
  }
  if (url.includes("/youtubei/v1/next")) return { json: { contents: {} } };
  if (url.includes("/youtubei/v1/player")) return { json: playerResponse };
  if (url.includes("get_search_suggestions")) return { json: { contents: [{ searchSuggestionsSectionRenderer: { contents: [{ searchSuggestionRenderer: { suggestion: { runs: [{ text: "rick astley" }] } } }] } }] } };
  return { json: {} };
}

/* ------------------------------------------------------------- page injection */

await import("node:fs").then(fs => fs.promises.writeFile(join(shotDir, "ytm-nav-fixtures.json"), JSON.stringify({ searchResponse, artistPage, albumPage, playlistPage })));

const inject = `(function () {
  const fixtures = ${JSON.stringify({ searchResponse, searchContinuation, artistPage, albumPage, playlistPage, playerResponse, homeResponse })};
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (url.includes("music.youtube.com")) {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (url.includes("sw.js_data")) {
        return new Response(")]}'" + "\n" + JSON.stringify([["x"], ["y"], ["CgtTEST123", "z"]]), { status: 200, headers: { "Content-Type": "text/javascript" } });
      }
      const body = bodyText ? JSON.parse(bodyText) : {};
      let payload = {};
      if (url.includes("/youtubei/v1/search")) payload = url.includes("continuation=") ? fixtures.searchContinuation : fixtures.searchResponse;
      else if (url.includes("/youtubei/v1/browse")) {
        const id = String(body.browseId ?? body.continuation ?? "");
        if (id.startsWith("UC")) payload = fixtures.artistPage;
        else if (id.startsWith("MPREb_") || id.startsWith("OLAK")) payload = fixtures.albumPage;
        else if (id.startsWith("VL") || id.startsWith("PL")) payload = fixtures.playlistPage;
        else payload = fixtures.homeResponse;
      } else if (url.includes("/youtubei/v1/player")) payload = fixtures.playerResponse;
      else if (url.includes("get_search_suggestions")) payload = { contents: [{ searchSuggestionsSectionRenderer: { contents: [{ searchSuggestionRenderer: { suggestion: { runs: [{ text: "rick astley" }] } } }] } }] };
      else if (url.includes("/youtubei/v1/next")) payload = { contents: {} };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  };

  // Minimal window.cadence IPC stub.
  const autoStub = () => new Proxy(async () => null, {
    get: (t, k) => (k === "then" ? undefined : autoStub()),
    apply: async () => null,
  });
  const defaultSettings = {
    version: 1,
    playback: { volume: 0.85, muted: false, shuffle: false, repeat: "off", playbackRate: 1, resumeOnLaunch: false, crossfadeSeconds: 0, gaplessPlayback: false, replayGainMode: "off", replayGainPreampDb: 0, replayGainPreventClipping: true, equalizer: { enabled: false, preampDb: 0, bandsDb: [0,0,0,0,0,0,0,0,0,0], presetId: "flat" } },
    appearance: { accent: "#ff3d71", reduceMotion: true, compactSidebar: false, blurArtwork: true },
    lyrics: { providerOrder: ["local-rich","lrclib-synced","lrclib-plain"], autoFetch: false, offsetMs: 0, translationLanguage: "en", romanization: false, themeId: "default", customThemeCss: "", fontSizeRem: 1.6, translationFontSizePx: 32, romanizationFontSizePx: 26, fontWeight: 700, lineHeight: 1.45, activeOpacity: 1, inactiveOpacity: 0.42, targetScrollRatio: 0.38, showCredits: true, hideInstrumentalOnly: false, passiveScroll: true, fullscreenOnOpen: false, showLyricsInFullscreen: true, notFoundCooldownDays: 7, fetchConcurrency: "balanced" },
    youtubeMusic: { visitorData: null, gl: "US", hl: "en", accountName: null },
    general: { onboardingCompleted: true, onboardingStep: 4 },
    scrobbling: { enabled: false, apiKey: "", apiSecret: "", sessionKey: "", username: "" },
    nowPlayingProfiles: [],
    shaders: { enabled: false },
    advanced: { showLogs: false },
  };
  let settings = structuredClone(defaultSettings);
  const snapshot = { folders: [], tracks: [], albums: [], artists: [], playlists: [], counts: { tracks: 0, albums: 0, artists: 0, playlists: 0, duration: 0 } };
  const explicit = {
    info: async () => ({ name: "Cadence", version: "0.2.0", platform: "browser-harness", tauri: "harness", electron: "", chrome: navigator.userAgent, node: "n/a", userData: "/harness", libraryEngine: "memory", codecs: {} }),
    library: {
      snapshot: async () => structuredClone(snapshot),
      onChanged: () => () => {},
      onScanProgress: () => () => {},
      search: async () => [],
      rescan: async () => ({ added: 0, updated: 0, removed: 0, errors: [], durationMs: 0 }),
    },
    history: { list: async () => [], add: async () => ({}), clear: async () => undefined, remove: async () => true },
    playlists: { list: async () => [], tracks: async () => [], create: async () => ({ id: 1 }), addTracks: async () => undefined, removeTrack: async () => undefined, rename: async () => undefined, delete: async () => undefined, createSmart: async () => ({ id: 1 }), updateSmart: async () => undefined },
    secrets: { store: async () => {}, get: async () => null, delete: async () => true },
    settings: {
      get: async () => structuredClone(settings),
      patch: async patch => { settings = { ...settings, ...patch }; return structuredClone(settings); },
      reset: async () => structuredClone(defaultSettings),
    },
    lyrics: {
      resolve: async () => ({ candidates: [], providerStatus: [], cached: false }),
      search: async () => ({ results: [], providerStatus: [], cached: false }),
      youtubeMetadata: async () => ({ ok: false, reason: "error", detail: "harness" }),
      translate: async r => ({ translations: r.lines, targetLanguage: r.targetLanguage, provider: "harness" }),
      romanize: async r => ({ romanizations: r.lines }),
      saveSidecar: async () => ({ path: "/harness/x.lrc" }),
      clearCache: async () => ({ removedEntries: 0 }),
      listCache: async () => ({ entries: [], stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 } }),
      getCacheEntry: async () => null,
      removeCacheEntry: async () => ({ removed: false, stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 } }),
      cacheChosenFile: async () => undefined,
      rememberSelection: async () => undefined,
      fetchAll: { start: async () => ({}), status: async () => ({ running: false }), cancel: async () => undefined, promote: async () => undefined, onProgress: () => () => {} },
    },
    player: { prepareAlacSource: async () => "/audio/none.wav", reportState: async () => undefined, onCommand: () => () => {} },
    app: { openExternal: async () => undefined, openPath: async () => undefined, chooseLyricsFile: async () => null, window: async () => undefined, isFullScreen: async () => false, initialWindowChrome: { maximized: false, fullscreen: false }, windowChrome: async () => ({ maximized: false, fullscreen: false }), onWindowChromeChange: () => () => {}, onMenuAction: () => () => {}, quit: async () => undefined },
    stats: { overview: async () => ({}), topTracks: async () => [], topArtists: async () => [], topAlbums: async () => [], recent: async () => [] },
    decodeTester: { deleteFiles: async () => [], exportFileList: async () => ({ canceled: true }) },
  };
  window.cadence = new Proxy(explicit, { get: (t, k) => (k in t ? t[k] : autoStub()) });
})();`;

/* ------------------------------------------------------------- server + run */

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = join(dist, url.pathname === "/" ? "index.html" : url.pathname);
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(dist, "index.html");
  res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(res);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...chromium.args, "--no-sandbox"],
  headless: true,
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const logs = [];
page.on("console", msg => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", err => logs.push(`[PAGEERROR] ${err.message}\n${(err.stack ?? "").split("\n").slice(0, 6).join("\n")}`));
page.on("requestfailed", req => logs.push(`[REQFAIL] ${req.url().slice(0, 120)} ${req.failure()?.errorText}`));

await page.evaluateOnNewDocument(inject);
await page.goto(`${base}#/ytmusic/search/rick%20astley`, { waitUntil: "networkidle2", timeout: 30_000 }).catch(e => logs.push(`[goto] ${e.message}`));

const wait = ms => new Promise(r => setTimeout(r, ms));
await page.waitForSelector("[data-testid=ytm-track-row]", { timeout: 20_000 }).catch(() => logs.push("NO TRACK ROWS after search"));
await wait(500);

async function state(label) {
  const info = await page.evaluate(() => ({
    hash: location.hash,
    testid: document.querySelector(".content-scroll [data-testid], .view [data-testid]")?.getAttribute("data-testid") ?? null,
    text: (document.querySelector(".content-scroll")?.innerText ?? document.body.innerText).slice(0, 300),
    bodyChildren: document.querySelector(".content-scroll")?.children.length ?? -1,
  }));
  console.log(`\n=== ${label} ===\n hash: ${info.hash}\n testid: ${info.testid}\n children: ${info.bodyChildren}\n text: ${JSON.stringify(info.text)}`);
  await page.screenshot({ path: join(shotDir, `ytm-nav-${label.replace(/[^a-z0-9]+/gi, "-")}.png`) });
  return info;
}

await state("after-search");

const counts = await page.evaluate(() => ({
  rows: document.querySelectorAll("[data-testid=ytm-track-row]").length,
  cards: [...document.querySelectorAll("[data-testid=ytm-card]")].map(c => c.getAttribute("data-item-key")),
}));
console.log("search rows:", counts.rows, "cards:", JSON.stringify(counts.cards));

async function clickCard(keyPart) {
  const clicked = await page.evaluate(part => {
    const el = [...document.querySelectorAll("[data-testid=ytm-card]")].find(c => (c.getAttribute("data-item-key") ?? "").includes(part));
    if (!el) return false;
    el.click();
    return true;
  }, keyPart);
  console.log(`click card ${keyPart}: ${clicked}`);
  await wait(1200);
}

// Artist card
await clickCard("artist:");
await state("after-artist-click");
// Back to search via hash
await page.evaluate(() => { location.hash = "#/ytmusic/search/rick%20astley"; });
await wait(800);
await state("back-to-search");
// Album card
await clickCard("album:");
await state("after-album-click");
await page.evaluate(() => { location.hash = "#/ytmusic/search/rick%20astley"; });
await wait(800);
// Playlist card
await clickCard("playlist:");
await state("after-playlist-click");
await page.evaluate(() => { location.hash = "#/ytmusic/search/rick%20astley"; });
await wait(800);
// Song row click (playback; stream URL is a stub — playback failure must not black the screen)
await page.evaluate(() => document.querySelector("[data-testid=ytm-track-row]")?.querySelector("button")?.click());
await wait(1500);
await state("after-song-click");

console.log("\n=== console/page errors ===");
console.log(logs.filter(l => l.startsWith("[PAGEERROR]") || l.startsWith("[error]") || l.startsWith("[REQFAIL]")).slice(0, 30).join("\n") || "(none)");

await browser.close();
server.close();
