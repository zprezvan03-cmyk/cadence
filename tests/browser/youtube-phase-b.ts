/**
 * Browser QA for Stage 7's integrated YouTube provider (official Data API catalog + visible
 * IFrame mechanism inside Cadence's one queue, PlayerBar, Now Playing view, lyrics, and History).
 *
 * This boots the real production renderer, real local audio fixtures, real settings defaults,
 * real Braccato renderer, and the shipped unified player/clock adapter in headless Chromium.
 *
 * The sandbox used for Cadence development cannot reach youtube.com, so the IFrame API
 * script/cross-origin embed document are intercepted with a deterministic test double and the
 * desktop bridge's Data API returns deterministic catalog fixtures. That means this script
 * proves Cadence's catalog/player wrapper calls, clock/lyrics behaviour, sizes, cleanup, CSP
 * routing for the allowed hosts, and local-player interplay. It does NOT prove that a real
 * YouTube video or API key works; that still requires the packaged desktop app on a network
 * that can reach YouTube.
 *
 * Usage:
 *   npm run build:web
 *   npm run test:fixtures
 *   npx vite-node tests/browser/build-library.ts
 *   npx vite-node tests/browser/youtube-phase-b.ts
 */

import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";
import { SettingsStore } from "../../src/main/settings";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const harnessDir = join(root, ".artifacts/harness");
const audioDir = join(root, ".artifacts/fixtures/formats");
const shotDir = join(root, ".artifacts/youtube-phase-b");
mkdirSync(shotDir, { recursive: true });

if (!existsSync(join(outDir, "index.html"))) throw new Error("Run: npm run build:web");
if (!existsSync(join(harnessDir, "library.json"))) {
  throw new Error("Run: npm run test:fixtures && npx vite-node tests/browser/build-library.ts");
}

const { snapshot } = JSON.parse(readFileSync(join(harnessDir, "library.json"), "utf8")) as {
  snapshot: Record<string, unknown> & { tracks: Array<{ title: string }> };
};
if (!snapshot.tracks.some(track => track.title === "Fixture FLAC")) {
  throw new Error("The harness library does not contain Fixture FLAC");
}

const stateDir = mkdtempSync(join(tmpdir(), "cadence-youtube-phase-b-"));
const settingsStore = new SettingsStore(join(stateDir, "settings.json"));
settingsStore.patch({
  general: { onboardingCompleted: true, onboardingStep: 0 },
  lyrics: { translationLanguage: "es", romanization: true },
});
const initialSettings = structuredClone(settingsStore.get());

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
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let file: string | null = null;
  if (url.pathname.startsWith("/audio/")) {
    file = join(audioDir, basename(decodeURIComponent(url.pathname)));
  } else if (url.pathname.startsWith("/artwork/")) {
    file = join(harnessDir, basename(decodeURIComponent(url.pathname)));
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
  const headers = {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "content-range, accept-ranges, content-length",
  };
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = Number(match?.[1] || 0);
    const end = match?.[2] ? Number(match[2]) : size - 1;
    res.writeHead(206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": size });
  createReadStream(file).pipe(res);
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
const address = server.address();
if (!address || typeof address === "string") throw new Error("QA server did not bind a TCP port");
const base = `http://127.0.0.1:${address.port}`;

const results: Record<string, { value: boolean; detail: string }> = {};
const check = (name: string, value: boolean, detail = "") => {
  results[name] = { value: Boolean(value), detail };
  console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

// One-pixel PNG; Cadence's artwork element stretches it with object-fit, which is sufficient
// to prove the i.ytimg.com image path in this offline harness without generating a fixture.
const thumbnailPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64"
);

const fakeYouTubeApi = String.raw`
(() => {
  const METADATA = {
    dQw4w9WgXcQ: {
      title: "Never Gonna Give You Up (Official Video)",
      author: "Rick Astley - Topic",
      duration: 212,
    },
    video000003: {
      title: "Catalog Third Video",
      author: "Rick Astley - Topic",
      duration: 180,
    },
    video000004: {
      title: "Catalog Fourth Video",
      author: "Rick Astley - Topic",
      duration: 180,
    },
  };
  window.__fakeYouTubePlayers = [];
  class FakePlayer {
    constructor(element, options) {
      this.options = options;
      this.calls = [];
      this.state = -1;
      this.currentTime = 0;
      this.duration = 0;
      this.playbackRate = 1;
      this.volume = 80;
      this.muted = false;
      this.videoId = "";
      this.destroyed = false;
      this.startedAt = 0;
      this.baseTime = 0;
      this.iframe = document.createElement("iframe");
      this.iframe.width = String(options.width);
      this.iframe.height = String(options.height);
      this.iframe.style.width = options.width + "px";
      this.iframe.style.height = options.height + "px";
      this.iframe.src = (options.host || "https://www.youtube.com") + "/embed/?enablejsapi=1";
      element.parentNode.replaceChild(this.iframe, element);
      window.__fakeYouTubePlayers.push(this);
      setTimeout(() => this.options.events.onReady({ target: this }), 0);
    }
    syncTime() {
      if (this.state !== 1) return this.currentTime;
      const next = this.baseTime + ((Date.now() - this.startedAt) / 1000) * this.playbackRate;
      if (this.duration > 0 && next >= this.duration) {
        this.currentTime = this.duration;
        this.baseTime = this.duration;
        this.state = 0;
        this.options.events.onStateChange({ target: this, data: 0 });
        return this.currentTime;
      }
      this.currentTime = next;
      return this.currentTime;
    }
    emit(state) {
      if (state === 1) {
        this.baseTime = this.currentTime;
        this.startedAt = Date.now();
      } else {
        this.syncTime();
        this.baseTime = this.currentTime;
      }
      this.state = state;
      this.options.events.onStateChange({ target: this, data: state });
    }
    cueVideoById(videoId, startSeconds) {
      this.calls.push(["cueVideoById", videoId, startSeconds]);
      this.videoId = videoId;
      this.currentTime = startSeconds || 0;
      this.baseTime = this.currentTime;
      if (videoId === "error101XYZ" || videoId === "notfound123") {
        this.duration = 0;
        const code = videoId === "error101XYZ" ? 101 : 100;
        setTimeout(() => this.options.events.onError({ target: this, data: code }), 10);
        return;
      }
      const metadata = METADATA[videoId] || { title: "Phase B Test Song", author: "Cadence QA - Topic", duration: 180 };
      this.metadata = metadata;
      this.duration = metadata.duration;
      const origin = encodeURIComponent(this.options.playerVars.origin || "");
      this.iframe.src = (this.options.host || "https://www.youtube.com") + "/embed/" + videoId + "?enablejsapi=1&origin=" + origin;
      setTimeout(() => this.emit(5), 10);
    }
    loadVideoById(videoId, startSeconds) {
      this.calls.push(["loadVideoById", videoId, startSeconds]);
      this.cueVideoById(videoId, startSeconds);
      setTimeout(() => this.playVideo(), 15);
    }
    playVideo() {
      this.calls.push(["playVideo"]);
      if (this.state === 0 || this.currentTime >= this.duration) this.currentTime = 0;
      this.emit(3);
      setTimeout(() => { if (!this.destroyed && this.state === 3) this.emit(1); }, 20);
    }
    pauseVideo() {
      this.calls.push(["pauseVideo"]);
      this.syncTime();
      if (this.state !== 0) this.emit(2);
    }
    stopVideo() { this.pauseVideo(); this.currentTime = 0; }
    seekTo(seconds, allowSeekAhead) {
      this.calls.push(["seekTo", seconds, allowSeekAhead]);
      this.currentTime = Math.max(0, Math.min(seconds, this.duration || seconds));
      this.baseTime = this.currentTime;
      this.startedAt = Date.now();
      const resumeState = this.state;
      setTimeout(() => { if (!this.destroyed) this.emit(resumeState === 1 ? 1 : 2); }, 10);
    }
    setVolume(volume) { this.calls.push(["setVolume", volume]); this.volume = volume; if (volume > 0) this.muted = false; }
    getVolume() { return this.volume; }
    mute() { this.calls.push(["mute"]); this.muted = true; }
    unMute() { this.calls.push(["unMute"]); this.muted = false; }
    isMuted() { return this.muted; }
    setPlaybackRate(rate) {
      this.calls.push(["setPlaybackRate", rate]);
      this.syncTime();
      this.playbackRate = rate;
      this.baseTime = this.currentTime;
      this.startedAt = Date.now();
      this.options.events.onPlaybackRateChange({ target: this, data: rate });
    }
    getPlaybackRate() { return this.playbackRate; }
    getCurrentTime() { return this.syncTime(); }
    getDuration() { return this.duration; }
    getPlayerState() { this.syncTime(); return this.state; }
    getVideoData() {
      return {
        video_id: this.videoId,
        title: this.metadata ? this.metadata.title : "",
        author: this.metadata ? this.metadata.author : "",
      };
    }
    getIframe() { return this.iframe; }
    setSize(width, height) {
      this.calls.push(["setSize", width, height]);
      this.iframe.width = String(width);
      this.iframe.height = String(height);
      this.iframe.style.width = width + "px";
      this.iframe.style.height = height + "px";
    }
    destroy() {
      this.calls.push(["destroy"]);
      this.destroyed = true;
      this.state = -1;
      this.iframe.remove();
    }
  }
  window.YT = { Player: FakePlayer };
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);
})();
`;

let browser: Browser | null = null;
let page: Page | null = null;
const logs: string[] = [];
const interceptedEmbeds: string[] = [];

try {
  await inflate(join(root, "node_modules/@sparticuz/chromium/bin/al2023.tar.br"));
  setupLambdaEnvironment(join(tmpdir(), "al2023", "lib"));
  chromium.setGraphicsMode = true;
  browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    headless: true,
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--use-gl=angle",
      "--use-angle=swiftshader",
    ],
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 180_000,
  });
  page = await browser.newPage();
  page.on("console", message => logs.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error: unknown) => logs.push(`[pageerror] ${String(error)}`));

  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = request.url();
    void (async () => {
      try {
        if (request.isInterceptResolutionHandled()) return;
        if (url === "https://www.youtube.com/iframe_api") {
          await request.respond({
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            body: fakeYouTubeApi,
          });
          return;
        }
        if (url.startsWith("https://www.youtube-nocookie.com/embed/")) {
          interceptedEmbeds.push(url);
          await request.respond({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: `<!doctype html><html><body style="margin:0;background:#070707;color:#fff;font-family:sans-serif;display:grid;place-items:center;height:100vh;text-align:center"><div><div style="font-size:42px">▶</div><strong>Offline QA test double</strong><br><span style="color:#aaa">Not a real YouTube frame</span></div></body></html>`,
          });
          return;
        }
        if (url.startsWith("https://i.ytimg.com/")) {
          await request.respond({ status: 200, contentType: "image/png", body: thumbnailPng });
          return;
        }
        if (url.startsWith(base) || url.startsWith("data:") || url.startsWith("blob:")) {
          await request.continue();
          return;
        }
        await request.abort("blockedbyclient");
      } catch {
        // Puppeteer can race a navigation teardown; the page-level checks below remain authoritative.
      }
    })();
  });

  await page.evaluateOnNewDocument(
    (data: { snapshot: Record<string, unknown>; settings: Record<string, unknown> }) => {
      const mergeDeep = (baseValue: any, patch: any): any => {
        const result = Array.isArray(baseValue) ? [...baseValue] : { ...baseValue };
        for (const [key, value] of Object.entries(patch ?? {})) {
          result[key] =
            value && typeof value === "object" && !Array.isArray(value) && baseValue?.[key] && typeof baseValue[key] === "object"
              ? mergeDeep(baseValue[key], value)
              : value;
        }
        return result;
      };
      const section = (value: Record<string, unknown>) =>
        new Proxy(value, {
          get(target, property) {
            if (property in target) return target[property as string];
            if (property === "then") return undefined;
            return async () => (String(property).startsWith("on") ? () => undefined : undefined);
          },
        });

      let settings = structuredClone(data.settings);
      const snapshot = structuredClone(data.snapshot) as any;
      const richLyrics = [
        "[ti:Never Gonna Give You Up]",
        "[ar:Rick Astley]",
        "[00:00.00]<00:00.00>First <00:00.40>remote <00:00.80>line <00:01.20>arrives",
        "[00:05.00]<00:05.00>Second <00:05.40>remote <00:05.80>line <00:06.20>continues",
        "[00:10.00]こんにちは世界、リモート時計が動いています",
        "[00:20.00]A later line stays with the iframe",
        "[00:40.00]Forty seconds into the remote song",
        "[01:00.00]One minute line takes over",
        "[01:30.00]Ninety seconds and still synchronized",
      ].join("\n");
      const plainLyrics = "Plain remote lyric one\nPlain remote lyric two";

      const qaHistoryStorageKey = "cadence.qa.history.v1";
      let persistedHistory: unknown[] = [];
      try {
        const parsed = JSON.parse(localStorage.getItem(qaHistoryStorageKey) ?? "[]") as unknown;
        if (Array.isArray(parsed)) persistedHistory = parsed;
      } catch {
        persistedHistory = [];
      }
      (window as any).__historyAdds = persistedHistory;
      (window as any).__persistQaHistory = () => {
        try {
          localStorage.setItem(qaHistoryStorageKey, JSON.stringify((window as any).__historyAdds));
        } catch {
          /* the reload assertion below will fail loudly if storage is unavailable */
        }
      };
      (window as any).__lyricsSearches = [];
      (window as any).__translateCalls = [];
      (window as any).__romanizeCalls = [];
      (window as any).__openedExternal = [];
      (window as any).__catalogCalls = [] as string[];
      (window as any).__catalogMode = "success";
      const catalogNow = Date.now();
      const catalogChannel = {
        id: "UCqa000000000000000001",
        title: "Rick Astley",
        handle: "@RickAstley",
        description: "Offline QA channel fixture for the integrated YouTube catalog.",
        artworkUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        canonicalUrl: "https://www.youtube.com/channel/UCqa000000000000000001",
        uploadsPlaylistId: "UUqa000000000000000001",
        subscriberCount: 1234567,
        videoCount: 432,
        viewCount: 987654321,
        fetchedAt: catalogNow,
      };
      const catalogPlaylist = {
        id: "PLqa000000000001",
        title: "QA Public Playlist",
        description: "Offline QA playlist fixture.",
        channelId: catalogChannel.id,
        channelTitle: "Rick Astley",
        artistLabel: "Rick Astley",
        albumLabel: null,
        isAlbumCollection: false,
        artworkUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        itemCount: 4,
        canonicalUrl: "https://www.youtube.com/playlist?list=PLqa000000000001",
        publishedAt: "2026-01-01T00:00:00Z",
        fetchedAt: catalogNow,
      };
      const catalogSecondPlaylist = {
        ...catalogPlaylist,
        id: "PLqa000000000002",
        title: "QA Second Public Playlist",
        canonicalUrl: "https://www.youtube.com/playlist?list=PLqa000000000002",
      };
      const catalogAlbumPlaylist = {
        ...catalogPlaylist,
        id: "OLAK5uy_qaAlbum123",
        title: "Whenever You Need Somebody",
        description: "Verified YouTube Music album-playlist fixture (OLAK5uy namespace).",
        albumLabel: "Whenever You Need Somebody",
        isAlbumCollection: true,
        itemCount: 3,
        canonicalUrl: "https://music.youtube.com/playlist?list=OLAK5uy_qaAlbum123",
      };
      const catalogVideos = [
        {
          source: {
            kind: "youtube",
            remoteId: "dQw4w9WgXcQ",
            canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          },
          title: "Never Gonna Give You Up (Official Video)",
          artistLabel: "Rick Astley",
          channelId: catalogChannel.id,
          channelTitle: "Rick Astley - Topic",
          albumLabel: null,
          durationSeconds: 212,
          artworkUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
          publishedAt: "2009-10-25T00:00:00Z",
          availability: "ready",
          fetchedAt: catalogNow,
        },
        {
          source: {
            kind: "youtube",
            remoteId: "video000002",
            canonicalUrl: "https://www.youtube.com/watch?v=video000002",
          },
          title: "Catalog Second Video",
          artistLabel: "Rick Astley",
          channelId: catalogChannel.id,
          channelTitle: "Rick Astley - Topic",
          albumLabel: null,
          durationSeconds: 180,
          artworkUrl: "https://i.ytimg.com/vi/video000002/hqdefault.jpg",
          publishedAt: "2026-01-02T00:00:00Z",
          availability: "not-embeddable",
          fetchedAt: catalogNow,
        },
        {
          source: {
            kind: "youtube",
            remoteId: "video000003",
            canonicalUrl: "https://www.youtube.com/watch?v=video000003",
          },
          title: "Catalog Third Video",
          artistLabel: "Rick Astley",
          channelId: catalogChannel.id,
          channelTitle: "Rick Astley - Topic",
          albumLabel: null,
          durationSeconds: 180,
          artworkUrl: "https://i.ytimg.com/vi/video000003/hqdefault.jpg",
          publishedAt: "2026-01-03T00:00:00Z",
          availability: "ready",
          fetchedAt: catalogNow,
        },
        {
          source: {
            kind: "youtube",
            remoteId: "video000004",
            canonicalUrl: "https://www.youtube.com/watch?v=video000004",
          },
          title: "Catalog Fourth Video",
          artistLabel: "Rick Astley",
          channelId: catalogChannel.id,
          channelTitle: "Rick Astley - Topic",
          albumLabel: null,
          durationSeconds: 180,
          artworkUrl: "https://i.ytimg.com/vi/video000004/hqdefault.jpg",
          publishedAt: "2026-01-04T00:00:00Z",
          availability: "ready",
          fetchedAt: catalogNow,
        },
      ];
      const catalogSecondChannel = {
        ...catalogChannel,
        id: "UCqa000000000000000002",
        title: "Cadence QA Channel",
        handle: "@CadenceQA",
        canonicalUrl: "https://www.youtube.com/channel/UCqa000000000000000002",
        uploadsPlaylistId: "UUqa000000000000000002",
        subscriberCount: 1200,
        videoCount: 12,
        viewCount: 34567,
      };
      const catalogPage = (items: unknown[]) => ({
        ok: true,
        data: {
          items: structuredClone(items),
          nextPageToken: null,
          totalResults: items.length,
          cached: false,
          fetchedAt: catalogNow,
        },
      });
      const catalogPaged = (items: unknown[], pageToken?: string | null, pageSize = 2) => {
        const start = pageToken ? Number(pageToken.replace("qa-page-", "")) * pageSize : 0;
        const slice = items.slice(start, start + pageSize);
        return {
          ok: true,
          data: {
            items: structuredClone(slice),
            nextPageToken: start + pageSize < items.length ? `qa-page-${start / pageSize + 1}` : null,
            totalResults: items.length,
            cached: false,
            fetchedAt: catalogNow,
          },
        };
      };
      const catalogGate = (name: string) => {
        (window as any).__catalogCalls.push(name);
        if ((window as any).__catalogMode === "quota" && name.startsWith("search")) {
          return {
            ok: false,
            error: {
              kind: "quota-exceeded",
              message: "This API key has reached its YouTube Data API quota. Local music is unaffected.",
              status: 403,
            },
          };
        }
        const catalogSettings = (settings as any).youtubeCatalog ?? {};
        if (!catalogSettings.enabled) {
          return {
            ok: false,
            error: { kind: "disabled", message: "The YouTube catalog is off. Turn it on in Settings → Library." },
          };
        }
        if (!catalogSettings.apiKey) {
          return {
            ok: false,
            error: { kind: "missing-key", message: "Add your YouTube Data API v3 key in Settings → Library." },
          };
        }
        return null;
      };
      const chromeInfo = { undecorated: false, maximized: false, fullscreen: false, focused: true };

      (window as any).cadence = {
        info: async () => ({
          name: "Cadence",
          version: "youtube-phase-b-browser-qa",
          platform: "browser-harness",
          tauri: "not-running",
          electron: "",
          chrome: navigator.userAgent,
          node: "n/a",
          dbEngine: "snapshot",
          mediaProtocol: "http",
        }),
        library: section({
          snapshot: async () => structuredClone(snapshot),
          addFolder: async () => ({ canceled: true }),
          removeFolder: async () => structuredClone(snapshot),
          rescan: async () => ({ added: 0, updated: 0, removed: 0, errors: [], durationMs: 1 }),
          search: async (query: string) =>
            snapshot.tracks.filter((track: any) =>
              [track.title, track.artist, track.album].some((value: unknown) =>
                String(value).toLowerCase().includes(query.toLowerCase())
              )
            ),
          getTrack: async (id: number) => snapshot.tracks.find((track: any) => track.id === id) ?? null,
          setFavorite: async () => undefined,
          recordPlay: async () => undefined,
          onScanProgress: () => () => undefined,
          onChanged: () => () => undefined,
        }),
        history: section({
          list: async () =>
            ((window as any).__historyAdds as any[])
              .map((entry, index) => ({ id: index + 1, ...structuredClone(entry) }))
              .sort((a, b) => b.playedAt - a.playedAt || b.id - a.id),
          add: async (entry: unknown) => {
            (window as any).__historyAdds.push(structuredClone(entry));
            (window as any).__persistQaHistory();
            return { id: (window as any).__historyAdds.length };
          },
          clear: async () => {
            (window as any).__historyAdds = [];
            (window as any).__persistQaHistory();
          },
        }),
        playlists: section({
          list: async () => [],
          create: async () => ({}),
          createSmart: async () => ({}),
          updateSmart: async () => undefined,
          rename: async () => undefined,
          remove: async () => undefined,
          addTracks: async () => undefined,
          removeTrack: async () => undefined,
          reorder: async () => undefined,
          tracks: async () => [],
        }),
        settings: section({
          get: async () => structuredClone(settings),
          patch: async (patch: unknown) => {
            settings = mergeDeep(settings, patch);
            return structuredClone(settings);
          },
          reset: async () => structuredClone(data.settings),
        }),
        lyrics: section({
          resolve: async () => ({ candidates: [], providerStatus: [], definitive: false }),
          search: async (request: any) => {
            (window as any).__lyricsSearches.push(structuredClone(request));
            return {
              results: [
                {
                  source: "qa-rich",
                  provider: "QA rich LRC",
                  text: richLyrics,
                  syncHint: "richsync",
                  language: "en",
                  songwriters: ["Mike Stock", "Matt Aitken", "Pete Waterman"],
                  sourceHref: null,
                  cached: false,
                  matchTitle: "Never Gonna Give You Up",
                  matchArtist: "Rick Astley",
                  matchAlbum: "Whenever You Need Somebody",
                  matchDuration: 212,
                },
                {
                  source: "qa-plain",
                  provider: "QA plain text",
                  text: plainLyrics,
                  syncHint: "none",
                  language: "en",
                  songwriters: [],
                  sourceHref: null,
                  cached: false,
                  matchTitle: "Never Gonna Give You Up",
                  matchArtist: "Rick Astley",
                  matchAlbum: null,
                  matchDuration: 212,
                },
              ],
              providerStatus: [
                { provider: "qa-rich", status: "hit", detail: "QA rich LRC" },
                { provider: "qa-plain", status: "hit", detail: "QA plain text" },
              ],
              cached: false,
            };
          },
          youtubeMetadata: async () => ({ ok: false, reason: "error", detail: "not used by Phase B view" }),
          translate: async (request: any) => {
            (window as any).__translateCalls.push(structuredClone(request));
            return {
              translations: request.lines.map((line: string) => `[es] ${line}`),
              targetLanguage: request.targetLanguage,
              detectedLanguage: "en",
              provider: "qa",
            };
          },
          romanize: async (request: any) => {
            (window as any).__romanizeCalls.push(structuredClone(request));
            return {
              romanizations: request.lines.map((line: string) => `[romaji] ${line}`),
              detectedLanguage: "ja",
              provider: "qa",
            };
          },
          saveSidecar: async () => "/qa/lyrics.lrc",
          clearCache: async () => ({ removedEntries: 0 }),
          listCache: async () => ({ entries: [], stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 } }),
          getCacheEntry: async () => null,
          removeCacheEntry: async () => ({ removed: false, stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 } }),
          cacheChosenFile: async () => undefined,
          rememberSelection: async () => undefined,
          fetchAll: {
            getState: async () => ({
              jobId: null,
              state: "idle",
              total: 0,
              processed: 0,
              found: 0,
              notFound: 0,
              failed: 0,
              skipped: 0,
              currentTrack: null,
              startedAt: null,
              finishedAt: null,
            }),
            start: async () => ({
              jobId: null,
              state: "idle",
              total: 0,
              processed: 0,
              found: 0,
              notFound: 0,
              failed: 0,
              skipped: 0,
              currentTrack: null,
              startedAt: null,
              finishedAt: null,
            }),
            pause: async () => ({
              jobId: null,
              state: "idle",
              total: 0,
              processed: 0,
              found: 0,
              notFound: 0,
              failed: 0,
              skipped: 0,
              currentTrack: null,
              startedAt: null,
              finishedAt: null,
            }),
            resume: async () => ({
              jobId: null,
              state: "idle",
              total: 0,
              processed: 0,
              found: 0,
              notFound: 0,
              failed: 0,
              skipped: 0,
              currentTrack: null,
              startedAt: null,
              finishedAt: null,
            }),
            cancel: async () => ({
              jobId: null,
              state: "idle",
              total: 0,
              processed: 0,
              found: 0,
              notFound: 0,
              failed: 0,
              skipped: 0,
              currentTrack: null,
              startedAt: null,
              finishedAt: null,
            }),
            retryFailed: async () => ({
              jobId: null,
              state: "idle",
              total: 0,
              processed: 0,
              found: 0,
              notFound: 0,
              failed: 0,
              skipped: 0,
              currentTrack: null,
              startedAt: null,
              finishedAt: null,
            }),
            stats: async () => ({ totalTracks: 0, withLyrics: 0, needsSearch: 0, fullyProcessed: 0 }),
            promote: async () => undefined,
            onProgress: () => () => undefined,
          },
        }),
        youtubeCatalog: section({
          status: async () => {
            const catalogSettings = (settings as any).youtubeCatalog ?? {};
            return {
              enabled: Boolean(catalogSettings.enabled),
              configured: Boolean(catalogSettings.enabled && catalogSettings.apiKey),
              region: catalogSettings.region || "US",
              cacheEntries: (window as any).__catalogCalls.length,
            };
          },
          clearCache: async () => {
            const cleared = (window as any).__catalogCalls.length;
            (window as any).__catalogCalls = [];
            return { cleared };
          },
          searchMusicVideos: async (request: { pageToken?: string | null } = {}) =>
            catalogGate("searchMusicVideos") ?? catalogPaged(catalogVideos, request.pageToken, 2),
          searchChannels: async (request: { pageToken?: string | null } = {}) =>
            catalogGate("searchChannels") ??
            catalogPaged([catalogChannel, catalogSecondChannel], request.pageToken, 1),
          searchPlaylists: async (request: { pageToken?: string | null } = {}) =>
            catalogGate("searchPlaylists") ??
            catalogPaged([catalogPlaylist, catalogSecondPlaylist], request.pageToken, 1),
          searchAlbumCollections: async (request: { pageToken?: string | null } = {}) =>
            catalogGate("searchAlbumCollections") ??
            catalogPaged([catalogAlbumPlaylist], request.pageToken, 1),
          trending: async (request: { pageToken?: string | null } = {}) =>
            catalogGate("trending") ?? catalogPaged(catalogVideos, request.pageToken, 2),
          newReleases: async (request: { pageToken?: string | null } = {}) =>
            catalogGate("newReleases") ?? catalogPaged([...catalogVideos].reverse(), request.pageToken, 2),
          getChannel: async (request: { channelId: string }) => {
            const gate = catalogGate("getChannel");
            if (gate) return gate;
            if (request.channelId !== catalogChannel.id) {
              return { ok: false, error: { kind: "not-found", message: "QA channel not found.", status: 404 } };
            }
            return {
              ok: true,
              data: {
                channel: structuredClone(catalogChannel),
                playlists: [structuredClone(catalogPlaylist), structuredClone(catalogAlbumPlaylist)],
                playlistsNextPageToken: "qa-page-1",
                uploads: catalogPaged(catalogVideos, null, 2).data,
                cached: false,
                fetchedAt: catalogNow,
              },
            };
          },
          getChannelPlaylists: async (request: { channelId: string; pageToken?: string | null }) => {
            const gate = catalogGate("getChannelPlaylists");
            if (gate) return gate;
            if (request.channelId !== catalogChannel.id) {
              return { ok: false, error: { kind: "not-found", message: "QA channel playlists not found.", status: 404 } };
            }
            return catalogPaged(
              [catalogPlaylist, catalogAlbumPlaylist, catalogSecondPlaylist],
              request.pageToken,
              2
            );
          },
          getChannelVideos: async (request: { channelId: string; pageToken?: string | null }) => {
            const gate = catalogGate("getChannelVideos");
            if (gate) return gate;
            if (request.channelId !== catalogChannel.id) {
              return { ok: false, error: { kind: "not-found", message: "QA channel videos not found.", status: 404 } };
            }
            return catalogPaged([...catalogVideos].reverse(), request.pageToken, 2);
          },
          getPlaylist: async (request: { playlistId: string }) => {
            const gate = catalogGate("getPlaylist");
            if (gate) return gate;
            const playlist = [catalogPlaylist, catalogSecondPlaylist, catalogAlbumPlaylist].find(
              candidate => candidate.id === request.playlistId
            );
            if (!playlist) {
              return { ok: false, error: { kind: "not-found", message: "QA playlist not found.", status: 404 } };
            }
            return {
              ok: true,
              data: { playlist: structuredClone(playlist), cached: false, fetchedAt: catalogNow },
            };
          },
          getPlaylistItems: async (request: { playlistId: string; pageToken?: string | null }) => {
            const gate = catalogGate("getPlaylistItems");
            if (gate) return gate;
            if (
              ![
                catalogPlaylist.id,
                catalogSecondPlaylist.id,
                catalogAlbumPlaylist.id,
                catalogChannel.uploadsPlaylistId,
              ].includes(request.playlistId)
            ) {
              return { ok: false, error: { kind: "not-found", message: "QA playlist items not found.", status: 404 } };
            }
            if (request.playlistId === catalogAlbumPlaylist.id) {
              const albumItems = catalogVideos
                .filter(video => video.availability === "ready")
                .map(video => ({
                  ...structuredClone(video),
                  source: {
                    kind: "youtube-music",
                    remoteId: video.source.remoteId,
                    canonicalUrl: `https://music.youtube.com/watch?v=${video.source.remoteId}`,
                  },
                  albumLabel: catalogAlbumPlaylist.albumLabel,
                }));
              return catalogPaged(albumItems, request.pageToken, 2);
            }
            return catalogPaged(catalogVideos, request.pageToken, 2);
          },
        }),
        player: section({
          prepareAlacSource: async () => "/audio/fixture.wav",
          reportState: async () => undefined,
          onCommand: () => () => undefined,
        }),
        app: section({
          openExternal: async (url: string) => {
            (window as any).__openedExternal.push(url);
          },
          openPath: async () => undefined,
          chooseLyricsFile: async () => null,
          window: async () => undefined,
          isFullScreen: async () => false,
          setMiniPlayer: async () => undefined,
          initialWindowChrome: { ...chromeInfo },
          windowChrome: async () => ({ ...chromeInfo }),
          onWindowChromeChange: () => () => undefined,
        }),
        decodeTester: section({
          deleteFiles: async () => [],
          exportFileList: async () => ({ canceled: true }),
        }),
        onMenuAction: () => () => undefined,
      };
    },
    { snapshot, settings: initialSettings as unknown as Record<string, unknown> }
  );

  const shot = async (name: string) => page!.screenshot({ path: join(shotDir, `${name}.png`) as `${string}.png` });
  const clickText = async (selector: string, wanted: string) => {
    const clicked = await page!.evaluate(
      (sel: string, text: string) => {
        const node = [...document.querySelectorAll(sel)].find(
          candidate => candidate.textContent?.replace(/\s+/g, " ").trim() === text
        ) as HTMLElement | undefined;
        node?.click();
        return Boolean(node);
      },
      selector,
      wanted
    );
    if (!clicked) throw new Error(`Could not click ${selector} with text ${wanted}`);
  };
  const nav = (label: string) => clickText("aside.sidebar .nav-item", label);
  const audioState = () =>
    page!.evaluate(() => {
      const audios = [...document.querySelectorAll("audio")];
      const audio = audios.find(candidate => !candidate.paused) ?? audios[0];
      return {
        currentTime: Number.isFinite(audio?.currentTime) ? audio.currentTime : -1,
        duration: Number.isFinite(audio?.duration) ? audio.duration : -1,
        paused: audio?.paused ?? true,
        src: audio?.currentSrc ?? audio?.src ?? "",
      };
    });
  const fakeState = () =>
    page!.evaluate(() => {
      const players = (window as any).__fakeYouTubePlayers ?? [];
      const player = players.at(-1);
      if (!player) return null;
      return {
        count: players.length,
        state: player.getPlayerState(),
        currentTime: player.getCurrentTime(),
        duration: player.getDuration(),
        volume: player.getVolume(),
        muted: player.isMuted(),
        rate: player.getPlaybackRate(),
        destroyed: player.destroyed,
        videoId: player.videoId,
        calls: player.calls,
        options: {
          width: player.options.width,
          height: player.options.height,
          host: player.options.host,
          playerVars: player.options.playerVars,
        },
      };
    });
  const setRange = async (selector: string, value: number) => {
    await page!.$eval(selector, (node, next) => {
      const input = node as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, String(next));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  };
  const playerBox = () =>
    page!.evaluate(() => {
      const shell = document.querySelector('[data-testid="youtube-player-shell"]');
      const iframe = document.querySelector('[data-testid="youtube-iframe"]');
      const rect = (node: Element | null) => {
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { width: box.width, height: box.height, x: box.x, y: box.y };
      };
      const shellBox = rect(shell);
      const centerElement = shellBox
        ? document.elementFromPoint(shellBox.x + shellBox.width / 2, shellBox.y + shellBox.height / 2)
        : null;
      return {
        shell: shellBox,
        iframe: rect(iframe),
        centerTag: centerElement?.tagName ?? null,
        centerTestId: centerElement?.getAttribute("data-testid") ?? null,
      };
    });
  const activeLyric = () =>
    page!.evaluate(
      () => document.querySelector(".lyrics-body .blyrics--active")?.textContent?.replace(/\s+/g, " ").trim() ?? null
    );
  const waitForFakeState = async (state: number, timeout = 5_000) => {
    try {
      await page!.waitForFunction(
        wanted => {
          const player = (window as any).__fakeYouTubePlayers?.at(-1);
          return player?.getPlayerState() === wanted;
        },
        { timeout },
        state
      );
    } catch (error) {
      const diagnostics = await page!
        .evaluate(() => {
          const player = (window as any).__fakeYouTubePlayers?.at(-1);
          return {
            hash: location.hash,
            fake: player
              ? {
                  state: player.getPlayerState(),
                  videoId: player.videoId,
                  currentTime: player.getCurrentTime(),
                  duration: player.getDuration(),
                  calls: player.calls,
                  destroyed: player.destroyed,
                }
              : null,
            stage: document.querySelector('[data-testid="integrated-youtube-player"]')?.textContent ?? null,
            playerBar: document.querySelector('[data-testid="player-bar"]')?.textContent ?? null,
            body: document.body.innerText.slice(0, 1600),
          };
        })
        .catch(() => null);
      console.log(`FAKE PLAYER TIMEOUT waiting for state ${state}:`, JSON.stringify(diagnostics, null, 2));
      console.log("Browser logs (last 40):\n" + logs.slice(-40).join("\n"));
      await shot("debug-fake-player-timeout").catch(() => undefined);
      throw error;
    }
  };
  const historyAdds = () => page!.evaluate(() => structuredClone((window as any).__historyAdds ?? []));
  const remoteHistoryAdds = async () =>
    (await historyAdds()).filter((entry: any) => entry?.source?.kind && entry.source.kind !== "local");
  const clickMainPlayToggle = () =>
    page!.click('[data-testid="player-bar"] [data-testid="play-toggle"]');

  await page.goto(base, { waitUntil: "networkidle2" });
  await page.waitForSelector("aside.sidebar .nav-item", { timeout: 30_000 }).catch(async error => {
    console.log("BOOT FAILED. body:", await page!.evaluate(() => document.body.innerText.slice(0, 1200)));
    console.log("BOOT FAILED. logs:", logs.slice(-30).join("\n"));
    await shot("00-boot-failure").catch(() => undefined);
    throw error;
  });
  await page.waitForSelector('[data-testid="player-bar"]', { timeout: 30_000 });
  await wait(500);
  const navLabels = await page.$$eval("aside.sidebar .nav-item", nodes =>
    nodes.map(node => node.textContent?.replace(/\s+/g, " ").trim())
  );
  check(
    "app-boots-without-separate-youtube-page",
    !navLabels.includes("YouTube") && navLabels.includes("Now Playing"),
    navLabels.join(", ")
  );

  // The empty state of the one Now Playing view owns direct-link entry. A playlist-only link
  // opens the catalog detail route (and honestly reports that the catalog is still off).
  await nav("Now Playing");
  await page.waitForSelector('[data-testid="lyrics-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-url-form"]', { timeout: 15_000 });
  await shot("01-main-now-playing-empty");
  check(
    "empty-main-now-playing-has-direct-link-and-no-player",
    (await page.evaluate(
      () =>
        Boolean(document.querySelector('[data-testid="youtube-url-form"]')) &&
        !document.querySelector('[data-testid="integrated-youtube-player"]') &&
        !document.querySelector('[data-testid="youtube-now-playing"]')
    )) === true
  );
  await page.type(
    '[data-testid="youtube-url-input"]',
    "https://music.youtube.com/playlist?list=PL1234567890"
  );
  await page.click('[data-testid="youtube-url-submit"]');
  await page.waitForSelector('[data-testid="youtube-playlist-view"]', { timeout: 10_000 });
  await page.waitForSelector('[data-testid="youtube-detail-error"]', { timeout: 10_000 });
  check(
    "playlist-only-url-opens-integrated-playlist-page",
    (await page.evaluate(() => location.hash)).includes("youtube-playlist/PL1234567890") &&
      ((await page.$eval('[data-testid="youtube-detail-error"]', node => node.textContent)) ?? "").includes(
        "catalog is off"
      ),
    await page.evaluate(() => location.hash)
  );
  await shot("01b-playlist-link-catalog-off");
  await page.evaluate(() => {
    location.hash = "#/youtube";
  });
  await page.waitForSelector('[data-testid="lyrics-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-url-form"]', { timeout: 15_000 });
  check(
    "legacy-youtube-hash-opens-main-now-playing",
    (await page.evaluate(() => location.hash)) === "#/youtube" &&
      (await page.evaluate(() => document.querySelector('[data-testid="lyrics-view"]')?.getAttribute("data-current-source"))) === "none"
  );

  // Start a real local fixture first so the remote-play transition has something real to pause.
  await nav("Songs");
  await page.waitForSelector('[data-testid="track-row"]', { timeout: 20_000 });
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="track-row"]')].find(node =>
      node.textContent?.includes("Fixture FLAC")
    ) as HTMLElement | undefined;
    row?.click();
  });
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio");
    return Boolean(audio && !audio.paused && audio.currentTime > 0.25);
  }, { timeout: 15_000 });
  const localBeforeRemote = await audioState();
  const historyAfterLocal = await page.evaluate(() => (window as any).__historyAdds.length as number);
  check("local-fixture-plays-before-remote", !localBeforeRemote.paused && localBeforeRemote.currentTime > 0.25, JSON.stringify(localBeforeRemote));

  const remoteHistoryBeforeOpen = (await remoteHistoryAdds()).length;
  await page.evaluate(() => {
    location.hash =
      "#/search/" +
      encodeURIComponent("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ");
  });
  await page.waitForSelector('[data-testid="youtube-direct-link"]', { timeout: 15_000 });
  await clickText('[data-testid="youtube-direct-link"] button', "Open video");
  await page.waitForSelector('[data-testid="lyrics-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="integrated-youtube-player"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-iframe"]', { timeout: 15_000 });
  await waitForFakeState(1, 15_000);
  await page.waitForFunction(
    () => document.querySelector(".lyrics-heading h1")?.textContent?.includes("Never Gonna Give You Up"),
    { timeout: 10_000 }
  );
  await page.waitForSelector(".lyrics-body .blyrics--line", { timeout: 15_000 });
  await wait(700);

  const loaded = await fakeState();
  const box = await playerBox();
  const searches = await page.evaluate(() => (window as any).__lyricsSearches);
  check(
    "watch-url-with-playlist-loads-only-video-in-main-now-playing",
    loaded?.videoId === "dQw4w9WgXcQ" && loaded.state === 1,
    JSON.stringify(loaded)
  );
  // Assert the opening line while the fake IFrame clock is still in its first five seconds.
  // Later size/dock interactions legitimately advance playback into the second timed line.
  check(
    "lyrics-follow-iframe-clock-at-start",
    ((await activeLyric()) ?? "").includes("First"),
    (await activeLyric()) ?? "none"
  );
  const mainNowPlayingState = await page.evaluate(() => ({
    source: document.querySelector('[data-testid="lyrics-view"]')?.getAttribute("data-current-source"),
    sourceKey: document.querySelector('[data-testid="lyrics-view"]')?.getAttribute("data-current-source-key"),
    heading: document.querySelector(".lyrics-heading")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    playerTitle: document.querySelector('[data-testid="player-bar"] .player-title')?.textContent?.trim() ?? "",
    playerBadge:
      document
        .querySelector('[data-testid="player-bar"] [data-testid="source-badge"]')
        ?.getAttribute("data-source-kind") ?? null,
    stageBadge:
      document
        .querySelector('[data-testid="integrated-youtube-player"] [data-testid="source-badge"]')
        ?.getAttribute("data-source-kind") ?? null,
    separatePage: Boolean(document.querySelector('[data-testid="youtube-now-playing"]')),
  }));
  check(
    "main-now-playing-and-player-bar-recognize-youtube-music-item",
    mainNowPlayingState.source === "youtube-music" &&
      mainNowPlayingState.sourceKey === "youtube-music:dQw4w9WgXcQ" &&
      mainNowPlayingState.heading.includes("Never Gonna Give You Up") &&
      mainNowPlayingState.playerTitle.includes("Never Gonna Give You Up") &&
      mainNowPlayingState.playerBadge === "youtube-music" &&
      mainNowPlayingState.stageBadge === "youtube-music" &&
      !mainNowPlayingState.separatePage,
    JSON.stringify(mainNowPlayingState)
  );
  check(
    "official-player-options-are-visible-and-non-autoplay",
    loaded?.options.host === "https://www.youtube-nocookie.com" &&
      loaded.options.playerVars.autoplay === 0 &&
      loaded.options.playerVars.controls === 1 &&
      loaded.options.playerVars.enablejsapi === 1 &&
      loaded.options.playerVars.origin === base,
    JSON.stringify(loaded?.options)
  );
  check(
    "default-integrated-player-is-exactly-480x270",
    box.shell?.width === 480 && box.shell.height === 270 && box.iframe?.width === 480 && box.iframe.height === 270,
    JSON.stringify(box)
  );
  await page.click('[data-testid="integrated-youtube-size-toggle"]');
  await wait(250);
  const compactBox = await playerBox();
  check(
    "compact-integrated-player-is-exactly-200x200",
    compactBox.shell?.width === 200 &&
      compactBox.shell.height === 200 &&
      compactBox.iframe?.width === 200 &&
      compactBox.iframe.height === 200,
    JSON.stringify(compactBox)
  );
  check("player-center-is-not-covered", box.centerTag === "IFRAME" && box.centerTestId === "youtube-iframe", JSON.stringify(box));
  check("nocookie-frame-was-allowed-by-csp-and-intercepted", interceptedEmbeds.some(url => url.includes("/embed/dQw4w9WgXcQ")), interceptedEmbeds.join(" | "));
  check(
    "lyrics-search-uses-player-metadata-and-duration",
    searches.some((request: any) => request.title.includes("Never Gonna Give You Up") && request.artist === "Rick Astley" && request.duration === 212),
    JSON.stringify(searches)
  );
  check(
    "rich-lyrics-are-labelled-word-synced",
    ((await page.$eval('[data-testid="sync-label"]', node => node.textContent)) ?? "").includes("Word synced")
  );
  const decorations = await page.evaluate(() => ({
    translated: document.querySelector(".lyrics-body .blyrics--translated")?.textContent ?? "",
    romanized: document.querySelector(".lyrics-body .blyrics--romanized")?.textContent ?? "",
    translateCalls: (window as any).__translateCalls.length,
    romanizeCalls: (window as any).__romanizeCalls.length,
  }));
  check("translation-decoration-is-rendered", decorations.translated.includes("[es]") && decorations.translateCalls > 0, JSON.stringify(decorations));
  check("romanization-decoration-is-rendered", decorations.romanized.includes("[romaji]") && decorations.romanizeCalls > 0, JSON.stringify(decorations));
  await shot("02-integrated-now-playing-compact");

  // Provider selection through Cadence's existing lyrics dock: a plain candidate must stay
  // explicitly unsynchronized. Remote items must not gain local sidecar/file actions.
  const chooseLyricsCandidate = async (provider: string) => {
    await page!.evaluate(() => {
      const button = document.querySelector(
        '[data-testid="lyrics-dock"] button[title="Lyrics source"]'
      ) as HTMLButtonElement | null;
      button?.click();
    });
    await page!.waitForSelector('[data-testid="lyrics-dock"] .dock-sources .source-row', {
      timeout: 5_000,
    });
    await page!.evaluate(wanted => {
      const row = [...document.querySelectorAll('[data-testid="lyrics-dock"] .dock-sources .source-row')].find(
        node => node.textContent?.includes(wanted)
      ) as HTMLElement | undefined;
      row?.click();
    }, provider);
    await wait(300);
  };
  await chooseLyricsCandidate("QA plain text");
  check(
    "plain-candidate-is-labelled-unsynchronized",
    ((await page.$eval('[data-testid="sync-label"]', node => node.textContent)) ?? "").includes("Unsynced")
  );
  await chooseLyricsCandidate("QA rich LRC");
  check(
    "remote-lyrics-dock-hides-local-file-actions",
    (await page.evaluate(
      () =>
        !document.querySelector('[data-testid="lyrics-dock"] button[title="Open a lyrics file"]') &&
        !document.querySelector('[data-testid="lyrics-dock"] button[title="Save lyrics next to the track"]')
    )) === true
  );

  await wait(400);
  const localAfterRemotePlay = await audioState();
  const remoteHistoryAfterPlay = await remoteHistoryAdds();
  check("remote-selection-pauses-local-audio", localAfterRemotePlay.paused, JSON.stringify(localAfterRemotePlay));
  check(
    "observed-remote-playing-writes-one-source-aware-history-row",
    remoteHistoryAfterPlay.length === remoteHistoryBeforeOpen + 1 &&
      remoteHistoryAfterPlay.at(-1)?.source?.kind === "youtube-music" &&
      remoteHistoryAfterPlay.at(-1)?.source?.remoteId === "dQw4w9WgXcQ" &&
      remoteHistoryAfterPlay.at(-1)?.payload?.playbackMechanism === "youtube-iframe" &&
      !("trackId" in (remoteHistoryAfterPlay.at(-1)?.payload ?? {})) &&
      !("path" in (remoteHistoryAfterPlay.at(-1)?.payload ?? {})),
    JSON.stringify(remoteHistoryAfterPlay)
  );
  await clickMainPlayToggle();
  await waitForFakeState(2);
  const pausedAt = (await fakeState())?.currentTime ?? -1;
  await wait(650);
  const stillPausedAt = (await fakeState())?.currentTime ?? -1;
  check("pause-freezes-remote-clock", Math.abs(stillPausedAt - pausedAt) < 0.02, `${pausedAt} -> ${stillPausedAt}`);

  await clickMainPlayToggle();
  await waitForFakeState(1);
  await wait(350);
  check(
    "pause-resume-does-not-duplicate-remote-history",
    (await remoteHistoryAdds()).length === remoteHistoryAfterPlay.length,
    JSON.stringify(await remoteHistoryAdds())
  );
  await setRange('[data-testid="player-bar"] input.seek', 65);
  await page.waitForFunction(() => {
    const player = (window as any).__fakeYouTubePlayers?.at(-1);
    return player?.getCurrentTime() >= 64.8;
  }, { timeout: 5_000 });
  await wait(350);
  check("cadence-seek-retargets-lyrics-immediately", ((await activeLyric()) ?? "").includes("One minute"), (await activeLyric()) ?? "none");

  await page.evaluate(() => {
    const line = [...document.querySelectorAll(".lyrics-body .blyrics--line")].find(node =>
      node.textContent?.includes("Second")
    ) as HTMLElement | undefined;
    line?.click();
  });
  await page.waitForFunction(() => {
    const player = (window as any).__fakeYouTubePlayers?.at(-1);
    const time = player?.getCurrentTime() ?? 999;
    return time >= 4.5 && time < 10;
  }, { timeout: 5_000 });
  check("lyrics-line-click-seeks-iframe", true, `fake time ${(await fakeState())?.currentTime.toFixed(2)}s`);

  await setRange('[data-testid="player-bar"] input.volume', 0.25);
  await wait(250);
  check("main-player-volume-controls-iframe", (await fakeState())?.volume === 25, JSON.stringify(await fakeState()));
  await page.click('[data-testid="player-bar"] button[aria-label="Mute"]');
  await wait(200);
  check("main-player-mute-controls-iframe", (await fakeState())?.muted === true);
  await page.click('[data-testid="player-bar"] button[aria-label="Unmute"]');
  await wait(200);

  await page.evaluate(() => {
    (window as any).__fakeYouTubePlayers?.at(-1)?.setPlaybackRate(1.5);
  });
  await wait(350);
  const rateStart = (await fakeState())?.currentTime ?? 0;
  await wait(850);
  const rateEnd = (await fakeState())?.currentTime ?? 0;
  check(
    "iframe-rate-change-is-reflected-in-remote-clock",
    (await fakeState())?.rate === 1.5 && rateEnd - rateStart > 1.0,
    `${rateStart.toFixed(2)} -> ${rateEnd.toFixed(2)}`
  );
  await page.evaluate(() => {
    (window as any).__fakeYouTubePlayers?.at(-1)?.setPlaybackRate(1);
  });
  await wait(300);

  await page.click('[data-testid="integrated-youtube-size-toggle"]');
  await wait(300);
  const expanded = await playerBox();
  check("expanded-integrated-player-is-exactly-480x270", expanded.shell?.width === 480 && expanded.shell.height === 270 && expanded.iframe?.width === 480 && expanded.iframe.height === 270, JSON.stringify(expanded));
  await shot("03-integrated-now-playing-expanded");
  await page.click('[data-testid="integrated-youtube-size-toggle"]');
  await wait(250);

  await page.evaluate(() => {
    (window as any).__fakeYouTubePlayers?.at(-1)?.setPlaybackRate(2);
  });
  await setRange('[data-testid="player-bar"] input.seek', 211.55);
  await waitForFakeState(0, 5_000);
  await wait(300);
  const endedText =
    (await page.$eval('[data-testid="integrated-youtube-status"]', node => node.textContent ?? "")) ?? "";
  check("ended-state-is-surfaced-in-integrated-stage", endedText.includes("Ended"), endedText);
  await page.evaluate(() => {
    (window as any).__fakeYouTubePlayers?.at(-1)?.setPlaybackRate(1);
  });
  await clickMainPlayToggle();
  await waitForFakeState(1);

  // Pause through the one Cadence transport, then prove scripted Play is refused while less
  // than half of the official player is visible in a very short viewport.
  await clickMainPlayToggle();
  await waitForFakeState(2);
  await page.setViewport({ width: 1040, height: 180 });
  await page.waitForFunction(
    () =>
      document
        .querySelector(".integrated-youtube-note")
        ?.textContent?.includes("Keep more than half of the player visible"),
    { timeout: 8_000 }
  );
  await page.evaluate(() => {
    (document.querySelector('[data-testid="player-bar"] [data-testid="play-toggle"]') as HTMLButtonElement | null)?.click();
  });
  await wait(250);
  const guardState = await fakeState();
  const guardText = await page.evaluate(() =>
    document.body.innerText.includes("Keep more than half of the player visible")
  );
  check("scripted-play-requires-half-visibility", guardState?.state === 2 && guardText, JSON.stringify(guardState));
  await shot("04-integrated-small-viewport-guard");
  await page.setViewport({ width: 1440, height: 900 });
  await page.waitForFunction(
    () =>
      !document
        .querySelector(".integrated-youtube-note")
        ?.textContent?.includes("Keep more than half of the player visible"),
    { timeout: 8_000 }
  );
  await wait(250);
  if ((await fakeState())?.state !== 1) await clickMainPlayToggle();
  await waitForFakeState(1, 10_000);

  const playerCountBeforeNav = (await fakeState())?.count ?? 0;
  await nav("Home");
  await wait(400);
  const destroyedAfterNav = await page.evaluate(() => {
    const player = (window as any).__fakeYouTubePlayers?.at(-1);
    return { destroyed: player?.destroyed ?? false, iframePresent: Boolean(document.querySelector('[data-testid="youtube-iframe"]')) };
  });
  check("navigating-away-destroys-player", destroyedAfterNav.destroyed && !destroyedAfterNav.iframePresent, JSON.stringify(destroyedAfterNav));
  await nav("Now Playing");
  await page.waitForSelector('[data-testid="integrated-youtube-player"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-iframe"]', { timeout: 15_000 });
  await waitForFakeState(5);
  const afterReturn = await fakeState();
  check("returning-recreates-player-cued-not-autoplaying", (afterReturn?.count ?? 0) > playerCountBeforeNav && afterReturn?.state === 5, JSON.stringify(afterReturn));

  // Non-embeddable video error (official code 101 in the test double), opened through Search's
  // direct-link card because the Now Playing paste form is only for the empty queue state.
  const remoteHistoryBeforeError = (await remoteHistoryAdds()).length;
  await page.evaluate(() => {
    location.hash = "#/search/" + encodeURIComponent("https://youtu.be/error101XYZ");
  });
  await page.waitForSelector('[data-testid="youtube-direct-link"]', { timeout: 15_000 });
  await clickText('[data-testid="youtube-direct-link"] button', "Open video");
  await page.waitForSelector('[data-testid="integrated-youtube-player"]', { timeout: 15_000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="integrated-youtube-status"]')
        ?.textContent?.includes("does not allow"),
    { timeout: 10_000 }
  );
  const errorText =
    (await page.$eval('[data-testid="integrated-youtube-status"]', node => node.textContent ?? "")) ?? "";
  const hasSourceAction = await page.evaluate(
    () => Boolean(document.querySelector('[data-testid="integrated-youtube-open-source"]'))
  );
  check(
    "non-embeddable-error-is-actionable-and-writes-no-history",
    errorText.includes("does not allow") &&
      hasSourceAction &&
      (await remoteHistoryAdds()).length === remoteHistoryBeforeError,
    errorText
  );
  await shot("05-integrated-non-embeddable");

  // Local regression: after all remote work, a local fixture still plays through Cadence's engine.
  await nav("Songs");
  await page.waitForSelector('[data-testid="track-row"]');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="track-row"]')].find(node =>
      node.textContent?.includes("Fixture MP3")
    ) as HTMLElement | undefined;
    row?.click();
  });
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio");
    return Boolean(audio && !audio.paused && audio.currentTime > 0.25);
  }, { timeout: 15_000 });
  const localTitle = await page.$eval(".player-title", node => node.textContent?.trim() ?? "");
  check("local-playback-still-works-after-remote", localTitle === "Fixture MP3", localTitle);
  await page.evaluate(() => document.querySelector("audio")?.pause());

  // ---- Official Data API catalog, integrated into Cadence's existing Search/Home/details.
  // The bridge below returns deterministic Data API-shaped fixtures through Cadence's real
  // renderer components. This proves setup/search/detail/player wiring, not Google acceptance
  // of a real API key.
  const catalogCalls = () => page!.evaluate(() => [...(window as any).__catalogCalls] as string[]);
  const gotoHash = async (hash: string) => {
    await page!.evaluate(nextHash => {
      location.hash = nextHash;
    }, hash);
    await wait(250);
  };

  await gotoHash("#/search/Rick%20Astley");
  await page.waitForSelector('[data-testid="search-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-catalog-setup"]', { timeout: 15_000 });
  const callsBeforeSetup = await catalogCalls();
  check(
    "search-without-key-shows-catalog-setup-without-searching-online",
    !callsBeforeSetup.some(call => call.startsWith("search")),
    callsBeforeSetup.join(", ")
  );
  await shot("06-search-catalog-setup");

  await page.click('[data-testid="youtube-catalog-setup"] button.primary');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 15_000 });
  await clickText(".settings-tabs button", "Library");
  await page.waitForSelector('[data-testid="settings-youtube-catalog"]', { timeout: 15_000 });
  await page.type('[data-testid="youtube-catalog-api-key"]', "AIza-offline-qa-key");
  await page.type('[data-testid="youtube-catalog-region"]', "ID");
  await page.click('[data-testid="youtube-catalog-test"]');
  await page.waitForSelector('[data-testid="youtube-catalog-message"]', { timeout: 15_000 });
  const settingsCatalogState = await page.evaluate(() => ({
    inputType: document.querySelector('[data-testid="youtube-catalog-api-key"]')?.getAttribute("type"),
    enabled: (document.querySelector('[data-testid="youtube-catalog-enabled"]') as HTMLInputElement | null)?.checked,
    message: document.querySelector('[data-testid="youtube-catalog-message"]')?.textContent ?? "",
    bodyHasKey: document.body.innerText.includes("AIza-offline-qa-key"),
  }));
  check(
    "catalog-settings-save-test-and-mask-key",
    settingsCatalogState.inputType === "password" &&
      settingsCatalogState.enabled === true &&
      settingsCatalogState.message.includes("Catalog connected") &&
      !settingsCatalogState.bodyHasKey,
    JSON.stringify(settingsCatalogState)
  );
  await shot("07-settings-youtube-catalog");

  await nav("Home");
  await page.waitForSelector('[data-testid="home-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-trending-shelf"]', { timeout: 15_000 });
  await page.evaluate(() => {
    document.querySelector('[data-testid="youtube-trending-shelf"]')?.scrollIntoView({ block: "center" });
  });
  await page.waitForSelector('[data-testid="youtube-trending-shelf-list"] [data-testid="remote-track-row"]', {
    timeout: 15_000,
  });
  const trendingCountBeforeMore = await page.$$eval(
    '[data-testid="youtube-trending-shelf-list"] [data-testid="remote-track-row"]',
    nodes => nodes.length
  );
  await page.click('[data-testid="youtube-trending-shelf-load-more"]');
  await page.waitForFunction(
    previous =>
      document.querySelectorAll('[data-testid="youtube-trending-shelf-list"] [data-testid="remote-track-row"]')
        .length > previous,
    { timeout: 15_000 },
    trendingCountBeforeMore
  );
  const trendingBadgeKinds = await page.$$eval(
    '[data-testid="youtube-trending-shelf-list"] [data-testid="source-badge"]',
    nodes => nodes.map(node => node.getAttribute("data-source-kind"))
  );
  check(
    "home-trending-shelf-paginates-and-badges-every-row",
    trendingCountBeforeMore === 2 &&
      trendingBadgeKinds.length === 4 &&
      trendingBadgeKinds.every(kind => kind === "youtube"),
    trendingBadgeKinds.join(", ")
  );
  await page.evaluate(() => {
    document.querySelector('[data-testid="youtube-new-releases-shelf"]')?.scrollIntoView({ block: "center" });
  });
  await page.waitForSelector('[data-testid="youtube-new-releases-shelf-load"]', { timeout: 15_000 });
  const newReleaseCallsBefore = (await catalogCalls()).filter(call => call === "newReleases").length;
  await page.click('[data-testid="youtube-new-releases-shelf-load"]');
  await page.waitForSelector('[data-testid="youtube-new-releases-shelf-list"] [data-testid="remote-track-row"]', {
    timeout: 15_000,
  });
  check(
    "home-new-releases-load-only-on-explicit-request",
    newReleaseCallsBefore === 0 &&
      (await catalogCalls()).filter(call => call === "newReleases").length === 1,
    (await catalogCalls()).join(", ")
  );
  await shot("08-home-youtube-discovery");

  const searchCallsBeforeCatalogSearch = (await catalogCalls()).filter(call => call.startsWith("search")).length;
  await gotoHash("#/search/Rick%20Astley");
  await page.waitForSelector('[data-testid="youtube-search-videos"] [data-testid="remote-track-row"]', {
    timeout: 20_000,
  });
  const videoResultCountBeforeMore =
    (await page.$eval('[data-testid="youtube-catalog-result-count"]', node => node.textContent ?? "")) ?? "";
  await page.click('[data-testid="youtube-catalog-load-more"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="youtube-search-videos"] [data-testid="remote-track-row"]')
        .length === 4,
    { timeout: 15_000 }
  );
  const integratedSearch = await page.evaluate(() => ({
    heading: document.querySelector('[data-testid="search-view"] .view-heading')?.textContent ?? "",
    remoteIds: [...document.querySelectorAll('[data-testid="youtube-search-videos"] [data-testid="remote-track-row"]')].map(
      node => node.getAttribute("data-remote-id")
    ),
    badgeText: document.querySelector('[data-testid="youtube-search-videos"] [data-testid="source-badge"]')?.textContent ?? "",
  }));
  const searchCallsAfterCatalogSearch = (await catalogCalls()).filter(call => call.startsWith("search")).length;
  check(
    "integrated-search-videos-paginate-with-counts-and-badges",
    integratedSearch.heading.includes("local songs") &&
      videoResultCountBeforeMore.includes("2 music videos loaded") &&
      videoResultCountBeforeMore.includes("about 4 total results") &&
      integratedSearch.remoteIds.join(",") === "dQw4w9WgXcQ,video000002,video000003,video000004" &&
      integratedSearch.badgeText.includes("YouTube") &&
      searchCallsAfterCatalogSearch === searchCallsBeforeCatalogSearch + 2,
    JSON.stringify({
      integratedSearch,
      videoResultCountBeforeMore,
      searchCallsBeforeCatalogSearch,
      searchCallsAfterCatalogSearch,
    })
  );
  const searchCallsBeforeOrder = (await catalogCalls()).filter(call => call === "searchMusicVideos").length;
  await page.select('[data-testid="youtube-search-order"]', "date");
  await page.waitForFunction(
    previous => {
      const calls = (window as any).__catalogCalls as string[];
      return calls.filter(call => call === "searchMusicVideos").length > previous;
    },
    { timeout: 15_000 },
    searchCallsBeforeOrder
  );
  check(
    "integrated-search-order-control-requeries-active-category",
    (await catalogCalls()).filter(call => call === "searchMusicVideos").length === searchCallsBeforeOrder + 1
  );
  await shot("09-search-youtube-videos");

  await page.click('[data-testid="youtube-search-tab-channels"]');
  await page.waitForSelector('[data-testid="youtube-search-channels"] [data-testid="youtube-channel-card"]', {
    timeout: 15_000,
  });
  check(
    "integrated-search-channels-load-only-on-tab",
    (await catalogCalls()).filter(call => call === "searchChannels").length === 1
  );
  await page.click('[data-testid="youtube-catalog-load-more"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="youtube-search-channels"] [data-testid="youtube-channel-card"]')
        .length === 2,
    { timeout: 15_000 }
  );
  check(
    "integrated-search-channels-paginate-with-stats",
    (await page.evaluate(
      () =>
        document
          .querySelector('[data-testid="youtube-search-channels"]')
          ?.textContent?.includes("subscribers") ?? false
    )) === true
  );
  await page.click('[data-testid="youtube-search-tab-playlists"]');
  await page.waitForSelector('[data-testid="youtube-search-playlists"] [data-testid="youtube-playlist-card"]', {
    timeout: 15_000,
  });
  await page.click('[data-testid="youtube-catalog-load-more"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="youtube-search-playlists"] [data-testid="youtube-playlist-card"]')
        .length === 2,
    { timeout: 15_000 }
  );
  check(
    "integrated-search-playlists-paginate",
    (await catalogCalls()).filter(call => call === "searchPlaylists").length === 2
  );
  await page.click('[data-testid="youtube-search-tab-albums"]');
  await page.waitForSelector('[data-testid="youtube-search-albums"] [data-testid="youtube-playlist-card"]', {
    timeout: 15_000,
  });
  const albumSearchState = await page.evaluate(() => ({
    text: document.querySelector('[data-testid="youtube-search-albums"]')?.textContent ?? "",
    badge:
      document
        .querySelector('[data-testid="youtube-search-albums"] [data-testid="source-badge"]')
        ?.getAttribute("data-source-kind") ?? null,
  }));
  check(
    "integrated-search-album-tab-shows-only-verified-album-collections",
    albumSearchState.text.includes("Whenever You Need Somebody") && albumSearchState.badge === "youtube-music",
    JSON.stringify(albumSearchState)
  );
  await page.click('[data-testid="youtube-search-tab-playlists"]');
  await page.waitForSelector('[data-testid="youtube-search-playlists"] [data-testid="youtube-playlist-card"]', {
    timeout: 15_000,
  });
  await page.click('[data-testid="youtube-search-playlists"] [data-testid="youtube-playlist-card"]');
  await page.waitForSelector('[data-testid="youtube-playlist-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-playlist-items"] [data-testid="remote-track-row"]', {
    timeout: 15_000,
  });
  await clickText('[data-testid="youtube-playlist-view"] .catalog-load-more button', "Load more videos");
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="youtube-playlist-items"] [data-testid="remote-track-row"]')
        .length === 4,
    { timeout: 15_000 }
  );
  check(
    "public-playlist-detail-paginates-loaded-context",
    (await catalogCalls()).filter(call => call === "getPlaylistItems").length >= 2
  );
  check(
    "public-playlist-detail-uses-cadence-rows-and-badges",
    (await page.evaluate(() => location.hash)).includes("youtube-playlist/PLqa000000000001") &&
      (await page.$$eval('[data-testid="youtube-playlist-items"] [data-testid="source-badge"]', nodes => nodes.length)) > 0
  );
  await shot("10-youtube-playlist-detail");

  const remoteHistoryBeforeCatalogPlay = (await remoteHistoryAdds()).length;
  await page.click('[data-testid="youtube-context-play"]');
  await page.waitForSelector('[data-testid="lyrics-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="integrated-youtube-player"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-iframe"]', { timeout: 15_000 });
  await waitForFakeState(1, 15_000);
  await page.waitForFunction(
    () => document.querySelector(".lyrics-heading h1")?.textContent?.includes("Never Gonna Give You Up"),
    { timeout: 10_000 }
  );
  await wait(350);
  const catalogPlayerBadge = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid="player-bar"] [data-testid="source-badge"]')
        ?.getAttribute("data-source-kind") ?? null
  );
  check(
    "catalog-context-plays-in-main-now-playing-and-records-observed-play",
    (await fakeState())?.videoId === "dQw4w9WgXcQ" &&
      (await fakeState())?.state === 1 &&
      catalogPlayerBadge === "youtube" &&
      (await remoteHistoryAdds()).length === remoteHistoryBeforeCatalogPlay + 1,
    JSON.stringify({
      catalogPlayerBadge,
      remoteHistoryBeforeCatalogPlay,
      remoteHistoryAfterCatalogPlay: (await remoteHistoryAdds()).length,
      state: await fakeState(),
    })
  );

  await page.click('[data-testid="player-bar"] button[aria-label="Queue"]');
  await page.waitForSelector('[data-testid="queue-panel"]', { timeout: 10_000 });
  const queueState = await page.evaluate(() => ({
    entries: [...document.querySelectorAll('[data-testid="queue-entry"]')].map(node => ({
      source: node.getAttribute("data-source-kind"),
      occurrence: node.getAttribute("data-occurrence-id"),
      current: node.classList.contains("current"),
      text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
      badge:
        node.querySelector('[data-testid="source-badge"]')?.getAttribute("data-source-kind") ?? null,
    })),
  }));
  check(
    "queue-shows-loaded-playable-context-with-occurrences-and-badges",
    queueState.entries.length === 3 &&
      queueState.entries[0].current &&
      queueState.entries.every(entry => entry.source === "youtube" && entry.badge === "youtube" && entry.occurrence) &&
      new Set(queueState.entries.map(entry => entry.occurrence)).size === 3 &&
      !queueState.entries.some(entry => entry.text.includes("Catalog Second Video")),
    JSON.stringify(queueState)
  );
  await shot("10b-unified-queue-remote-context");
  await page.click('[data-testid="queue-panel"] button[aria-label="Close queue"]');
  await wait(250);

  const remoteHistoryBeforeNext = (await remoteHistoryAdds()).length;
  await page.click('[data-testid="player-bar"] button[aria-label="Next track"]');
  await page.waitForFunction(
    () => (window as any).__fakeYouTubePlayers?.at(-1)?.videoId === "video000003",
    { timeout: 15_000 }
  );
  await waitForFakeState(1, 15_000);
  await wait(350);
  check(
    "next-advances-within-remote-context-and-records-new-occurrence",
    (await fakeState())?.videoId === "video000003" &&
      (await fakeState())?.state === 1 &&
      (await page.evaluate(() => document.querySelector(".lyrics-heading h1")?.textContent ?? "")).includes(
        "Catalog Third Video"
      ) &&
      (await remoteHistoryAdds()).length === remoteHistoryBeforeNext + 1,
    JSON.stringify(await fakeState())
  );
  await page.click('[data-testid="player-bar"] button[aria-label="Previous track"]');
  await page.waitForFunction(
    () => (window as any).__fakeYouTubePlayers?.at(-1)?.videoId === "dQw4w9WgXcQ",
    { timeout: 15_000 }
  );
  await waitForFakeState(1, 15_000);
  await wait(350);
  check(
    "previous-returns-within-remote-context",
    (await fakeState())?.videoId === "dQw4w9WgXcQ" &&
      (await fakeState())?.state === 1 &&
      (await page.evaluate(() => document.querySelector(".lyrics-heading h1")?.textContent ?? "")).includes(
        "Never Gonna Give You Up"
      ),
    JSON.stringify(await fakeState())
  );
  await clickMainPlayToggle();
  await waitForFakeState(2);

  await gotoHash("#/youtube-playlist/PLqa000000000001");
  await page.waitForSelector('[data-testid="youtube-playlist-view"]', { timeout: 15_000 });
  await clickText('[data-testid="youtube-playlist-view"] .detail-hero button', "Channel");
  await page.waitForSelector('[data-testid="youtube-channel-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-channel-uploads"] [data-testid="remote-track-row"]', {
    timeout: 15_000,
  });
  const channelHeroText =
    (await page.$eval('[data-testid="youtube-channel-view"] .detail-hero', node => node.textContent ?? "")) ?? "";
  check(
    "channel-detail-shows-handle-and-public-stats",
    channelHeroText.includes("@RickAstley") &&
      channelHeroText.includes("subscribers") &&
      channelHeroText.includes("432 videos") &&
      channelHeroText.includes("views"),
    channelHeroText
  );
  await clickText('[data-testid="youtube-channel-view"] button', "Load more uploads");
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="youtube-channel-uploads"] [data-testid="remote-track-row"]')
        .length === 4,
    { timeout: 15_000 }
  );
  await page.click('[data-testid="youtube-channel-playlists-load-more"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="youtube-channel-playlists"] [data-testid="youtube-playlist-card"]')
        .length === 2,
    { timeout: 15_000 }
  );
  const popularCallsBefore = (await catalogCalls()).filter(call => call === "getChannelVideos").length;
  await page.click('[data-testid="youtube-channel-load-popular"]');
  await page.waitForSelector('[data-testid="youtube-channel-popular"] [data-testid="remote-track-row"]', {
    timeout: 15_000,
  });
  await page.click('[data-testid="youtube-channel-popular-load-more"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="youtube-channel-popular"] [data-testid="remote-track-row"]')
        .length === 4,
    { timeout: 15_000 }
  );
  check(
    "channel-detail-paginates-uploads-playlists-and-explicit-popular-videos",
    popularCallsBefore === 0 &&
      (await catalogCalls()).filter(call => call === "getChannelVideos").length === 2 &&
      (await page.$$eval('[data-testid="youtube-channel-album-collections"] [data-testid="youtube-playlist-card"]', nodes => nodes.length)) === 1,
    (await catalogCalls()).join(", ")
  );
  await shot("11-youtube-channel-detail");

  await page.click('[data-testid="youtube-channel-album-collections"] [data-testid="youtube-playlist-card"]');
  await page.waitForSelector('[data-testid="youtube-playlist-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-playlist-items"] [data-testid="remote-track-row"]', {
    timeout: 15_000,
  });
  await clickText('[data-testid="youtube-playlist-view"] .catalog-load-more button', "Load more videos");
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="youtube-playlist-items"] [data-testid="remote-track-row"]')
        .length === 3,
    { timeout: 15_000 }
  );
  const albumDetailState = await page.evaluate(() => ({
    hero: document.querySelector('[data-testid="youtube-playlist-view"] .detail-hero')?.textContent ?? "",
    heroBadge:
      document
        .querySelector('[data-testid="youtube-playlist-view"] .detail-hero [data-testid="source-badge"]')
        ?.getAttribute("data-source-kind") ?? null,
    rowKinds: [...document.querySelectorAll('[data-testid="youtube-playlist-items"] [data-testid="remote-track-row"]')].map(
      node => node.getAttribute("data-source-kind")
    ),
    rowsText: document.querySelector('[data-testid="youtube-playlist-items"]')?.textContent ?? "",
  }));
  check(
    "verified-album-collection-detail-uses-music-sources-and-actual-album-label",
    albumDetailState.hero.includes("YouTube Music album collection") &&
      albumDetailState.heroBadge === "youtube-music" &&
      albumDetailState.rowKinds.length === 3 &&
      albumDetailState.rowKinds.every(kind => kind === "youtube-music") &&
      albumDetailState.rowsText.includes("Whenever You Need Somebody"),
    JSON.stringify(albumDetailState)
  );
  await shot("11b-youtube-album-collection-detail");

  const searchCallsBeforeDirectLink = (await catalogCalls()).filter(call => call.startsWith("search")).length;
  await gotoHash("#/search/https%3A%2F%2Fmusic.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ");
  await page.waitForSelector('[data-testid="youtube-direct-link"]', { timeout: 15_000 });
  const searchCallsAfterDirectLink = (await catalogCalls()).filter(call => call.startsWith("search")).length;
  check(
    "direct-music-link-in-search-uses-no-search-quota",
    searchCallsAfterDirectLink === searchCallsBeforeDirectLink,
    `${searchCallsBeforeDirectLink} -> ${searchCallsAfterDirectLink}`
  );
  const remoteHistoryBeforeMusicLink = (await remoteHistoryAdds()).length;
  await clickText('[data-testid="youtube-direct-link"] button', "Open video");
  await page.waitForSelector('[data-testid="lyrics-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="integrated-youtube-player"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="youtube-iframe"]', { timeout: 15_000 });
  await waitForFakeState(1, 15_000);
  await wait(350);
  const musicBadge = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid="player-bar"] [data-testid="source-badge"]')
        ?.getAttribute("data-source-kind") ?? null
  );
  check(
    "actual-youtube-music-link-keeps-youtube-music-provenance-in-main-player",
    musicBadge === "youtube-music" &&
      (await remoteHistoryAdds()).length === remoteHistoryBeforeMusicLink + 1 &&
      (await remoteHistoryAdds()).at(-1)?.source?.kind === "youtube-music",
    String(musicBadge)
  );
  await clickMainPlayToggle();
  await waitForFakeState(2);
  await shot("12-direct-youtube-music-link");

  await page.evaluate(() => {
    (window as any).__catalogMode = "quota";
  });
  await gotoHash("#/search/Fixture");
  await page.waitForSelector('[data-testid="youtube-catalog-error-state"]', { timeout: 20_000 });
  const quotaState = await page.evaluate(() => ({
    error: document.querySelector('[data-testid="youtube-catalog-error-state"]')?.textContent ?? "",
    localSearchPresent: Boolean(document.querySelector('[data-testid="search-track-list"]')),
    searchHeading: document.querySelector('[data-testid="search-view"] .view-heading')?.textContent ?? "",
  }));
  check(
    "quota-error-is-isolated-to-remote-search-section",
    quotaState.error.includes("quota") && quotaState.localSearchPresent && quotaState.searchHeading.includes("local songs"),
    JSON.stringify(quotaState)
  );
  await shot("13-search-quota-error");
  await page.evaluate(() => {
    (window as any).__catalogMode = "success";
  });

  // Mixed queue: start the local Songs queue, insert a catalog video with Play Next, then cross
  // local -> remote -> local -> remote through the same transport and queue occurrences.
  await nav("Songs");
  await page.waitForSelector('[data-testid="track-row"]', { timeout: 15_000 });
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="track-row"]')].find(node =>
      node.textContent?.includes("Fixture FLAC")
    ) as HTMLElement | undefined;
    row?.click();
  });
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio");
    return Boolean(audio && !audio.paused && audio.currentTime > 0.25);
  }, { timeout: 15_000 });
  check("local-playback-still-works-after-catalog", !(await audioState()).paused, JSON.stringify(await audioState()));
  await clickMainPlayToggle();
  await page.waitForFunction(() => document.querySelector("audio")?.paused === true, { timeout: 10_000 });

  await gotoHash("#/search/Rick%20Astley");
  await page.waitForSelector('[data-testid="youtube-search-videos"] [data-testid="remote-track-row"]', {
    timeout: 20_000,
  });
  await page.click(
    '[data-testid="youtube-search-videos"] button[aria-label="Play Never Gonna Give You Up (Official Video) next"]'
  );
  await wait(250);
  await page.click('[data-testid="player-bar"] button[aria-label="Queue"]');
  await page.waitForSelector('[data-testid="queue-panel"]', { timeout: 10_000 });
  const mixedQueueState = await page.evaluate(() => ({
    entries: [...document.querySelectorAll('[data-testid="queue-entry"]')].map(node => ({
      source: node.getAttribute("data-source-kind"),
      current: node.classList.contains("current"),
      text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
      badge:
        node.querySelector('[data-testid="source-badge"]')?.getAttribute("data-source-kind") ?? null,
    })),
  }));
  const mixedCurrentIndex = mixedQueueState.entries.findIndex(entry => entry.current);
  const mixedRemoteIndex = mixedQueueState.entries.findIndex(entry => entry.source === "youtube");
  check(
    "play-next-inserts-remote-occurrence-after-current-local-track",
    mixedCurrentIndex >= 0 &&
      mixedRemoteIndex === mixedCurrentIndex + 1 &&
      mixedQueueState.entries[mixedCurrentIndex]?.source === "local" &&
      mixedQueueState.entries[mixedCurrentIndex]?.badge === null &&
      mixedQueueState.entries[mixedRemoteIndex]?.badge === "youtube",
    JSON.stringify(mixedQueueState)
  );
  await shot("14-mixed-local-remote-queue");
  await page.evaluate(() => {
    const entry = [...document.querySelectorAll('[data-testid="queue-entry"]')].find(
      node => node.getAttribute("data-source-kind") === "youtube"
    );
    (entry?.querySelector(".queue-track") as HTMLButtonElement | null)?.click();
  });
  await page.waitForSelector('[data-testid="lyrics-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="integrated-youtube-player"]', { timeout: 15_000 });
  await waitForFakeState(1, 15_000);
  check(
    "queue-jump-crosses-local-to-remote-and-pauses-local-engine",
    (await audioState()).paused &&
      (await page.evaluate(() => document.querySelector(".lyrics-heading h1")?.textContent ?? "")).includes(
        "Never Gonna Give You Up"
      ),
    JSON.stringify({ audio: await audioState(), fake: await fakeState() })
  );

  await page.click('[data-testid="player-bar"] button[aria-label="Previous track"]');
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio");
    return Boolean(audio && !audio.paused && audio.currentTime > 0.1);
  }, { timeout: 15_000 });
  const localAfterPrevious = await page.evaluate(() => ({
    source: document.querySelector('[data-testid="lyrics-view"]')?.getAttribute("data-current-source"),
    heading: document.querySelector(".lyrics-heading h1")?.textContent ?? "",
    badge: Boolean(document.querySelector('[data-testid="player-bar"] [data-testid="source-badge"]')),
    stage: Boolean(document.querySelector('[data-testid="integrated-youtube-player"]')),
  }));
  check(
    "previous-crosses-remote-back-to-local-without-fake-badge-or-stage",
    localAfterPrevious.source === "local" &&
      localAfterPrevious.heading.includes("Fixture FLAC") &&
      !localAfterPrevious.badge &&
      !localAfterPrevious.stage,
    JSON.stringify(localAfterPrevious)
  );

  await page.click('[data-testid="player-bar"] button[aria-label="Next track"]');
  await page.waitForSelector('[data-testid="integrated-youtube-player"]', { timeout: 15_000 });
  await waitForFakeState(1, 15_000);
  check(
    "next-crosses-local-back-to-same-remote-occurrence",
    (await audioState()).paused &&
      (await page.evaluate(() => document.querySelector(".lyrics-heading h1")?.textContent ?? "")).includes(
        "Never Gonna Give You Up"
      ),
    JSON.stringify({ audio: await audioState(), fake: await fakeState() })
  );
  await clickMainPlayToggle();
  await waitForFakeState(2);

  await nav("History");
  await page.waitForSelector('[data-testid="history-view"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="history-entry"]', { timeout: 15_000 });
  const historyViewState = await page.evaluate(() => ({
    entries: [...document.querySelectorAll('[data-testid="history-entry"]')].map(node => ({
      source: node.getAttribute("data-source-kind"),
      badge:
        node.querySelector('[data-testid="source-badge"]')?.getAttribute("data-source-kind") ?? null,
      text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
    })),
  }));
  check(
    "history-is-one-source-aware-list-with-remote-badges",
    historyViewState.entries.some(entry => entry.source === "local" && entry.badge === null) &&
      historyViewState.entries.some(
        entry => entry.source === "youtube" && entry.badge === "youtube" && entry.text.includes("Never Gonna")
      ) &&
      historyViewState.entries.some(entry => entry.source === "youtube-music" && entry.badge === "youtube-music"),
    JSON.stringify(historyViewState.entries.slice(0, 8))
  );
  await shot("15-history-source-aware");

  await nav("Home");
  await page.waitForSelector('[data-testid="home-recently-played"]', { timeout: 15_000 });
  const recentlyPlayedState = await page.evaluate(() => ({
    items: [...document.querySelectorAll('[data-testid="recently-played-item"]')].map(node => ({
      source: node.getAttribute("data-source-kind"),
      badge:
        node.querySelector('[data-testid="source-badge"]')?.getAttribute("data-source-kind") ?? null,
      text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
    })),
  }));
  const recentlyPlayedKeys = recentlyPlayedState.items.map(item => `${item.source}:${item.text}`);
  check(
    "recently-played-uses-same-history-deduped-by-source",
    recentlyPlayedState.items.some(item => item.source === "local" && item.badge === null) &&
      recentlyPlayedState.items.some(item => item.source === "youtube" && item.badge === "youtube") &&
      recentlyPlayedState.items.some(item => item.source === "youtube-music" && item.badge === "youtube-music") &&
      new Set(recentlyPlayedKeys).size === recentlyPlayedKeys.length,
    JSON.stringify(recentlyPlayedState)
  );
  await shot("16-home-recently-played-source-aware");

  const historyBeforeRestart = await historyAdds();
  const sessionBeforeRestart = await page.evaluate(() =>
    localStorage.getItem("cadence.session.v1")
  );
  await page.reload({ waitUntil: "networkidle0", timeout: 30_000 });
  await page.waitForSelector('[data-testid="player-bar"] [data-testid="source-badge"]', {
    timeout: 20_000,
  });
  await wait(750);
  const restartedPlayer = await page.evaluate(() => ({
    title:
      document
        .querySelector('[data-testid="player-bar"] .player-title')
        ?.textContent?.replace(/\s+/g, " ")
        .trim() ?? "",
    badge:
      document
        .querySelector('[data-testid="player-bar"] [data-testid="source-badge"]')
        ?.getAttribute("data-source-kind") ?? null,
    playLabel:
      document
        .querySelector('[data-testid="player-bar"] .play-button')
        ?.getAttribute("aria-label") ?? null,
    historyCount: ((window as any).__historyAdds ?? []).length,
  }));
  await nav("Now Playing");
  await page.waitForSelector('[data-testid="integrated-youtube-player"]', { timeout: 20_000 });
  await waitForFakeState(5, 20_000);
  const restartedFake = await fakeState();
  await nav("History");
  await page.waitForSelector('[data-testid="history-entry"][data-source-kind="youtube"]', {
    timeout: 20_000,
  });
  const historyAfterRestart = await historyAdds();
  check(
    "restart-restores-remote-session-cued-and-history-without-duplicates",
    Boolean(sessionBeforeRestart) &&
      restartedPlayer.title.includes("Never Gonna Give You Up") &&
      restartedPlayer.badge === "youtube" &&
      restartedPlayer.playLabel === "Play" &&
      restartedFake?.videoId === "dQw4w9WgXcQ" &&
      restartedFake.state === 5 &&
      historyAfterRestart.length === historyBeforeRestart.length &&
      historyAfterRestart.some((entry: any) => entry?.source?.kind === "youtube-music") &&
      historyAfterRestart.some((entry: any) => entry?.source?.kind === "local"),
    JSON.stringify({ restartedPlayer, restartedFake, historyAfterRestart: historyAfterRestart.length })
  );
  await shot("17-restart-restored-remote-session-and-history");

  const pageErrors = logs.filter(line => line.startsWith("[pageerror]"));
  const cspErrors = logs.filter(line => /content security policy/i.test(line));
  check("no-page-errors", pageErrors.length === 0, pageErrors.join(" | "));
  check("no-csp-violations-for-youtube-hosts", cspErrors.length === 0, cspErrors.join(" | "));
} finally {
  if (page) await page.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  server.close();
}

const failed = Object.entries(results).filter(([, result]) => !result.value);
console.log(`\nIntegrated YouTube browser QA: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} checks passed`);
if (logs.length) {
  console.log("\nBrowser logs (last 30):");
  for (const line of logs.slice(-30)) console.log(line);
}
if (failed.length) process.exitCode = 1;
