/**
 * End-to-end provider-identity harness: Better Lyrics vs Better Lyrics Line in the real UI.
 *
 * Unlike the stubbed `audit-ui.mjs` bridge, this harness wires the *real* main-process modules
 * behind the same `window.cadence` contract:
 *   - `LyricsService` + `LyricsCache` (real provider orchestration, classification and fallback),
 *   - `SettingsCore` persisted to a real file on disk (so a page reload is a genuine restart),
 *   - the production renderer bundle from `dist/` in headless Chromium.
 *
 * Only `fetch` inside this Node process is replaced, so the Better Lyrics API answers with fixed
 * payloads: syllable-timed TTML for one song, line-timed TTML for another, a whole-line-span TTML
 * (the shape that lies about word timing) for a third, and a /getLyrics failure that must fall
 * back to Kugou without inheriting the previous identity.
 *
 * Usage: npm run build:web && npx vite-node tests/browser/build-library.ts
 *        && npx vite-node tests/browser/provider-identity.ts
 */

import { createServer } from "node:http";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { SettingsStore } from "../../src/main/settings";
import type { LibraryStore } from "../../src/main/library/store";
import type { LyricsResolveRequest, LyricsSearchRequest } from "../../src/shared/types";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const harnessDir = join(root, ".artifacts/harness");
const audioDir = join(root, ".artifacts/fixtures/formats");
const shotDir = join(root, ".artifacts/provider-identity");
mkdirSync(shotDir, { recursive: true });

const snapshotFile = join(harnessDir, "library.json");
if (!existsSync(snapshotFile)) throw new Error("Run: npx vite-node tests/browser/build-library.ts");
if (!existsSync(join(outDir, "index.html"))) throw new Error("Run: npm run build:web");
const { snapshot } = JSON.parse(readFileSync(snapshotFile, "utf8"));

/* ------------------------------------------------------ Better Lyrics fixtures */

/** Real syllable timing: each line is split into independently timed spans. */
const TTML_SYLLABLE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:00.300" end="00:00:01.600"><span begin="00:00:00.300" end="00:00:00.700">Syl</span><span begin="00:00:00.700" end="00:00:01.100">la</span><span begin="00:00:01.100" end="00:00:01.600">ble</span></p>
<p begin="00:00:01.700" end="00:00:03.100"><span begin="00:00:01.700" end="00:00:02.300">tim</span><span begin="00:00:02.300" end="00:00:03.100">ing</span></p>
<p begin="00:00:03.200" end="00:00:04.600"><span begin="00:00:03.200" end="00:00:03.900">from</span><span begin="00:00:03.900" end="00:00:04.600">TTML</span></p>
</div></body></tt>`;

/** Line timing: `<p>` elements only. */
const TTML_LINE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:00.300" end="00:00:01.600">Line level timing only</p>
<p begin="00:00:01.700" end="00:00:03.100">No syllables in this file</p>
<p begin="00:00:03.200" end="00:00:04.600">Still a valid result</p>
</div></body></tt>`;

/** Line timing disguised as karaoke: one span per line, covering the whole line. */
const TTML_WHOLE_LINE_SPANS = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:00.300" end="00:00:01.600"><span begin="00:00:00.300" end="00:00:01.600">One span per line</span></p>
<p begin="00:00:01.700" end="00:00:03.100"><span begin="00:00:01.700" end="00:00:03.100">Still line level</span></p>
</div></body></tt>`;

/** A second line-timed TTML, used for the track that must offer two providers at once. */
const TTML_LINE_ALT = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:00.300" end="00:00:01.600">Better Lyrics line one</p>
<p begin="00:00:01.700" end="00:00:03.100">Better Lyrics line two</p>
</div></body></tt>`;

const KUGOU_LRC = "[00:00.30]Kugou line one\n[00:01.70]Kugou line two\n[00:03.20]Kugou line three";

/** Two real sidecar files for the WAV fixture, used by the multi-sidecar UI checks below. */
const SIDECAR_LRC = "[00:00.30]Sidecar LRC line one\n[00:01.70]Sidecar LRC line two\n[00:03.20]Sidecar LRC line three";
const SIDECAR_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:00.300" end="00:00:01.600"><span begin="00:00:00.300" end="00:00:00.900">Side</span><span begin="00:00:00.900" end="00:00:01.600">car</span></p>
<p begin="00:00:01.700" end="00:00:03.100"><span begin="00:00:01.700" end="00:00:02.300">TTML</span><span begin="00:00:02.300" end="00:00:03.100">line</span></p>
</div></body></tt>`;

const byTitle = (title: string) => snapshot.tracks.find((track: { title: string }) => track.title === title);
/** Which Better Lyrics payload each fixture song gets, keyed by the title sent as `?s=`. */
const PAYLOADS: Record<string, { getLyrics?: string; getLyricsStatus?: number; kugou?: string }> = {
  "Fixture FLAC": { getLyrics: TTML_SYLLABLE },
  "Fixture MP3": { getLyrics: TTML_LINE },
  "Fixture Ogg Vorbis": { getLyrics: TTML_WHOLE_LINE_SPANS },
  // /getLyrics is down for this one: the Kugou endpoint answers instead.
  "Fixture Opus": { getLyricsStatus: 503, kugou: KUGOU_LRC },
  // Two providers answer for this one, so the dock offers a real manual choice.
  "Fixture ALAC": { getLyrics: TTML_LINE_ALT, kugou: KUGOU_LRC },
};

/* --------------------------------------------- real main-process modules */

const stateDir = mkdtempSync(join(tmpdir(), "cadence-provider-identity-"));
const settingsFile = join(stateDir, "settings.json");
const cacheFile = join(stateDir, "lyrics.json");
// Actual files on disk for the WAV track: the real LyricsService discovers both sidecars through
// its Node filesystem adapter. Every other track in this harness stays network-only.
const sidecarDir = mkdtempSync(join(tmpdir(), "cadence-provider-identity-sidecars-"));
const sidecarAudioPath = join(sidecarDir, "Song.wav");
copyFileSync(join(audioDir, "fixture.wav"), sidecarAudioPath);
writeFileSync(join(sidecarDir, "Song.lrc"), SIDECAR_LRC, "utf8");
writeFileSync(join(sidecarDir, "Song.ttml"), SIDECAR_TTML, "utf8");
const sidecarTrackId = byTitle("fixture")?.id;
const fakeStore = {
  getTrack: (id: number) =>
    id === sidecarTrackId ? { path: sidecarAudioPath, title: "fixture", trackNo: 1 } : undefined,
  getLyrics: () => null,
} as unknown as LibraryStore;

let settings = new SettingsStore(settingsFile);
let lyricsCache = new LyricsCache(cacheFile);
let lyricsService = new LyricsService(fakeStore, lyricsCache);

/**
 * Throws away every in-memory main-process module and rebuilds it from the files on disk — the
 * state an actual app relaunch starts from. Pair it with `page.reload()` for a full restart.
 */
const coldStart = () => {
  lyricsCache.flush();
  settings = new SettingsStore(settingsFile);
  lyricsCache = new LyricsCache(cacheFile);
  lyricsService = new LyricsService(fakeStore, lyricsCache);
};

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
  const song = parsed.searchParams.get("s") ?? "";
  const payload = PAYLOADS[song];
  if (parsed.hostname === "api.betterlyrics.org") {
    if (parsed.pathname === "/getLyrics") {
      if (payload?.getLyricsStatus) return json({ error: "temporarily unavailable" }, payload.getLyricsStatus);
      if (payload?.getLyrics) return json({ ttml: payload.getLyrics });
      return json({ error: "not found" }, 404);
    }
    if (parsed.pathname === "/kugou/getLyrics" && payload?.kugou) {
      return json({ lyrics: payload.kugou, provider: "kugou" });
    }
    return json({ error: "not found" }, 404);
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
        // Exactly what src/tauri/bridge.ts does: the service reads the persisted provider order.
        const result = await lyricsService.resolve(
          body as LyricsResolveRequest,
          settings.get().lyrics.providerOrder
        );
        lyricsCache.flush();
        return sendJson(result);
      }
      if (url.pathname === "/api/lyrics/search") {
        const result = await lyricsService.searchLyrics(
          body as LyricsSearchRequest,
          settings.get().lyrics.providerOrder
        );
        return sendJson(result);
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

await new Promise<void>(done => server.listen(4793, "0.0.0.0", () => done()));
const base = "http://127.0.0.1:4793";

/* ------------------------------------------------------------------ browser */

// `@sparticuz/chromium` only unpacks its bundled NSS/NSPR libraries on Amazon Linux; on other
// distributions the browser fails to start with `libnspr4.so: cannot open shared object file`.
// Unpack them explicitly and point the loader at them before launching.
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

/** The same `window.cadence` contract the preload/Tauri bridge installs, backed by /api. */
await page.evaluateOnNewDocument(() => {
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(
      path,
      body === undefined
        ? { cache: "no-store" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    );
    return response.json();
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
    },
    player: {
      // Native ALAC is covered by Rust tests; this browser harness uses its matching PCM fixture.
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
      await wait(100);
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
  await wait(200);
};
const playTrack = async (title: string) => {
  await nav("Songs");
  for (const row of await page.$$('[data-testid="track-row"]')) {
    const text = await row.$eval(".title-text", node => node.textContent?.trim());
    if (text === title) {
      await row.click();
      await wait(500);
      return;
    }
  }
  throw new Error(`No track row ${title}`);
};

/** Opens the Now Playing dock's "Lyrics source" popover and reads what the user sees. */
const openSources = async () => {
  await nav("Now Playing");
  await wait(400);
  if (!(await page.$(".dock-sources"))) {
    await page.click('.lyrics-dock button[title="Lyrics source"]');
    await wait(250);
  }
  return page.evaluate(() => ({
    sources: [...document.querySelectorAll(".dock-sources .source-row")]
      .filter(row => row.querySelector("strong"))
      .map(row => ({
        name: row.querySelector("strong")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        sync: row.querySelector("em")?.textContent?.trim() ?? "",
        active: row.classList.contains("active"),
      })),
    providers: [...document.querySelectorAll(".dock-sources .provider-row")].map(row =>
      row.textContent?.replace(/\s+/g, " ").trim()
    ),
    syncLabel: document.querySelector('[data-testid="sync-label"]')?.textContent?.trim() ?? "",
  }));
};
/** Same read, but tolerates a dock with no lyrics (the popover button may be the only control). */
const readSourcesIfAny = async () => {
  await nav("Now Playing");
  await wait(400);
  const trigger = await page.$('.lyrics-dock button[title="Lyrics source"]');
  if (!trigger) return { sources: [], providers: [], syncLabel: "", dock: false, empty: true };
  if (!(await page.$(".dock-sources"))) {
    await trigger.click();
    await wait(250);
  }
  const read = await page.evaluate(() => ({
    sources: [...document.querySelectorAll(".dock-sources .source-row")]
      .filter(row => row.querySelector("strong"))
      .map(row => row.querySelector("strong")?.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    providers: [...document.querySelectorAll(".dock-sources .provider-row")].map(row =>
      row.textContent?.replace(/\s+/g, " ").trim() ?? ""
    ),
    syncLabel: document.querySelector('[data-testid="sync-label"]')?.textContent?.trim() ?? "",
    empty: Boolean(document.querySelector(".lyrics-empty-panel")),
  }));
  return { ...read, dock: true };
};
const closeSources = async () => {
  if (await page.$(".dock-sources")) {
    await page.click('.lyrics-dock button[title="Lyrics source"]');
    await wait(150);
  }
};

/** Clicks a candidate row in the dock's source popover (a real manual selection). */
const selectSourceRow = async (name: string) => {
  await nav("Now Playing");
  await wait(300);
  if (!(await page.$(".dock-sources"))) {
    await page.click('.lyrics-dock button[title="Lyrics source"]');
    await wait(250);
  }
  for (const row of await page.$$(".dock-sources .source-row")) {
    const text = await row.evaluate(node => node.querySelector("strong")?.textContent?.trim() ?? "");
    if (text === name) {
      await row.click();
      await wait(350);
      return;
    }
  }
  throw new Error(`No source row ${name}`);
};

/** Clicks a row in the already-open source popover, without navigating (which would close it). */
const clickOpenSourceRow = async (name: string) => {
  const rows = await page.$$(".dock-sources .source-row");
  for (const row of rows) {
    const text = await row.evaluate(node => node.querySelector("strong")?.textContent?.trim() ?? "");
    if (text === name) {
      await row.click();
      await wait(350);
      return;
    }
  }
  throw new Error(
    `No open source row ${name}; saw ${JSON.stringify(
      await page.$$eval(".dock-sources .source-row strong", nodes => nodes.map(node => node.textContent?.trim()))
    )}; state ${JSON.stringify(
      await page.evaluate(() => ({
        providers: [...document.querySelectorAll(".dock-sources .provider-row")].map(row =>
          row.textContent?.replace(/\s+/g, " ").trim()
        ),
        empty: Boolean(document.querySelector(".lyrics-empty-panel")),
        body: document.querySelector(".lyrics-body")?.textContent?.slice(0, 120) ?? null,
        panel: document.querySelector(".dock-sources") ? "open" : "closed",
      }))
    )}`
  );
};

/** The Settings → Appearance → Lyrics Provider Order list, as rendered. */
const providerOrderUi = async () => {
  await nav("Settings");
  await clickText(".settings-tabs button", "Appearance");
  await wait(150);
  return page.$$eval('[data-testid="provider-order"] li', nodes =>
    nodes.map(node => ({
      name: node.querySelector(".provider-name")?.childNodes[0]?.textContent?.trim() ?? "",
      badges: [...node.querySelectorAll(".provider-badge")].map(badge => badge.textContent?.trim()),
      index: node.querySelector(".provider-index")?.textContent?.trim(),
    }))
  );
};
const moveProviderUp = async (name: string) => {
  const items = await page.$$('[data-testid="provider-order"] li');
  for (const item of items) {
    const text = await item.$eval(".provider-name", node => node.childNodes[0]?.textContent?.trim() ?? "");
    if (text === name) {
      await (await item.$('button[aria-label="Move up"]'))!.click();
      await wait(180);
      return;
    }
  }
  throw new Error(`No provider row ${name}`);
};

await page.goto(base, { waitUntil: "networkidle0" });
await page.waitForSelector(".sidebar", { timeout: 30_000 }).catch(async () => {
  console.log("BOOT FAILED:", logs.slice(0, 20).join("\n"));
  await browser.close();
  server.close();
  process.exit(1);
});
await wait(700);
check("app-boots", (await page.$$(".nav-item")).length >= 5, `${(await page.$$(".nav-item")).length} nav items`);

/* ------------------------------------------- 1. syllable TTML → Better Lyrics */

await playTrack("Fixture FLAC");
const syllable = await openSources();
await shot("01-syllable-better-lyrics");
check(
  "syllable-ttml-is-better-lyrics",
  syllable.sources[0]?.name === "Better Lyrics" && syllable.sources[0]?.sync === "Word synced",
  JSON.stringify(syllable.sources)
);
check("syllable-sync-label", syllable.syncLabel === "Word synced", syllable.syncLabel);
await closeSources();

/* ------------------------------------- 2. line-level TTML → Better Lyrics Line */

await playTrack("Fixture MP3");
const lineLevel = await openSources();
await shot("02-line-better-lyrics-line");
check(
  "line-ttml-is-better-lyrics-line",
  lineLevel.sources[0]?.name === "Better Lyrics Line" && lineLevel.sources[0]?.sync === "Line synced",
  JSON.stringify(lineLevel.sources)
);
check(
  "line-ttml-not-relabelled-as-syllable",
  lineLevel.sources.every(source => source.name !== "Better Lyrics"),
  JSON.stringify(lineLevel.sources.map(source => source.name))
);
check(
  "line-ttml-kept-not-discarded",
  await page.evaluate(() => document.querySelectorAll(".blyrics--line").length > 0),
  `${await page.evaluate(() => document.querySelectorAll(".blyrics--line").length)} rendered lines`
);
await closeSources();

/* ------------- 2b. whole-line spans are line level, not fake syllable timing */

await playTrack("Fixture Ogg Vorbis");
const wholeLineSpans = await openSources();
await shot("03-whole-line-spans");
check(
  "whole-line-span-ttml-is-line-level",
  wholeLineSpans.sources[0]?.name === "Better Lyrics Line" && wholeLineSpans.sources[0]?.sync === "Line synced",
  JSON.stringify(wholeLineSpans.sources)
);
await closeSources();

/* --------------------------- 7. fallback keeps the right identity afterwards */

await playTrack("Fixture Opus");
const fallback = await openSources();
await shot("04-kugou-fallback");
check(
  "fallback-identity-is-kugou",
  fallback.sources[0]?.name === "Kugou Line" && fallback.sources[0]?.sync === "Line synced",
  JSON.stringify(fallback.sources)
);
check(
  "fallback-drops-previous-identity",
  fallback.sources.every(source => source.name !== "Better Lyrics" && source.name !== "Better Lyrics Line"),
  JSON.stringify(fallback.sources.map(source => source.name))
);
await closeSources();

/* ------------------------------------ 3. both identities coexist across songs */

await playTrack("Fixture FLAC");
const backToSyllable = await openSources();
check(
  "syllable-identity-stable-after-other-tracks",
  backToSyllable.sources[0]?.name === "Better Lyrics",
  JSON.stringify(backToSyllable.sources.map(source => source.name))
);
await closeSources();

/* ------------------------------ 4. independent configuration in the Settings UI */

const initialOrder = await providerOrderUi();
await shot("05-settings-provider-order");
const named = initialOrder.map(entry => entry.name);
check(
  "settings-lists-both-providers",
  named.filter(name => name === "Better Lyrics").length === 1 &&
    named.filter(name => name === "Better Lyrics Line").length === 1,
  named.join(" | ")
);
const syllableRow = initialOrder.find(entry => entry.name === "Better Lyrics");
const lineRow = initialOrder.find(entry => entry.name === "Better Lyrics Line");
check(
  "settings-badges-differ",
  syllableRow?.badges.includes("Syllable") === true && lineRow?.badges.includes("Line") === true,
  `${JSON.stringify(syllableRow?.badges)} vs ${JSON.stringify(lineRow?.badges)}`
);
check(
  "better-lyrics-line-is-not-unavailable",
  !lineRow?.badges.includes("unavailable"),
  JSON.stringify(lineRow?.badges)
);

// Move only Better Lyrics Line up; Better Lyrics must not follow it.
const beforeMove = named.indexOf("Better Lyrics Line");
await moveProviderUp("Better Lyrics Line");
await moveProviderUp("Better Lyrics Line");
const afterMoveOrder = (await page.$$eval('[data-testid="provider-order"] li', nodes =>
  nodes.map(node => node.querySelector(".provider-name")?.childNodes[0]?.textContent?.trim() ?? "")
)) as string[];
check(
  "line-slot-moves-independently",
  afterMoveOrder.indexOf("Better Lyrics Line") === beforeMove - 2 &&
    afterMoveOrder.indexOf("Better Lyrics") === named.indexOf("Better Lyrics"),
  `${named.join(",")} → ${afterMoveOrder.join(",")}`
);

/* -------------------- 5 & 6. persistence across navigation and a real restart */

const persistedAfterMove = settings.get().lyrics.providerOrder;
check(
  "settings-change-reaches-the-main-process",
  persistedAfterMove.indexOf("blyrics-line") === afterMoveOrder.indexOf("Better Lyrics Line"),
  persistedAfterMove.join(",")
);

await nav("Songs");
await nav("Now Playing");
const afterNavigation = await providerOrderUi();
check(
  "order-survives-navigation",
  afterNavigation.map(entry => entry.name).join(",") === afterMoveOrder.join(","),
  afterNavigation.map(entry => entry.name).join(",")
);

const onDisk = JSON.parse(readFileSync(settingsFile, "utf8"));
check(
  "order-written-to-disk",
  onDisk.lyrics.providerOrder.indexOf("blyrics-line") === afterMoveOrder.indexOf("Better Lyrics Line") &&
    onDisk.lyrics.providerOrder.includes("blyrics-richsynced"),
  onDisk.lyrics.providerOrder.join(","),
);

// A reload plus fresh main-process modules re-read every persisted file: a genuine restart.
coldStart();
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector(".sidebar", { timeout: 30_000 });
await wait(700);
const afterRestart = await providerOrderUi();
await shot("06-after-restart");
check(
  "order-survives-restart",
  afterRestart.map(entry => entry.name).join(",") === afterMoveOrder.join(","),
  afterRestart.map(entry => entry.name).join(",")
);

// …and the selector still reports the right identity after the restart.
await playTrack("Fixture MP3");
const restartedSources = await openSources();
check(
  "selector-identity-survives-restart",
  restartedSources.sources[0]?.name === "Better Lyrics Line",
  JSON.stringify(restartedSources.sources.map(source => source.name))
);
await closeSources();

/* ------------- 4b. disabling one slot in Settings does not disable the other */

await nav("Settings");
await clickText(".settings-tabs button", "Appearance");
await wait(150);
for (const item of await page.$$('[data-testid="provider-order"] li')) {
  const text = await item.$eval(".provider-name", node => node.childNodes[0]?.textContent?.trim() ?? "");
  if (text === "Better Lyrics Line") {
    await (await item.$('button[aria-label="Remove from order"]'))!.click();
    await wait(250);
    break;
  }
}
const afterRemoval = (await page.$$eval('[data-testid="provider-order"] li', nodes =>
  nodes.map(node => node.querySelector(".provider-name")?.childNodes[0]?.textContent?.trim() ?? "")
)) as string[];
check(
  "removing-line-slot-keeps-syllable-slot",
  !afterRemoval.includes("Better Lyrics Line") && afterRemoval.includes("Better Lyrics"),
  afterRemoval.join(","),
);
const poolNames = await page.$$eval('[data-testid="provider-pool"] .provider-pool-chip', nodes =>
  nodes.map(node => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
);
check(
  "removed-line-slot-is-re-addable",
  poolNames.some(name => name.startsWith("Better Lyrics Line")),
  poolNames.join(" | ")
);

// The removal is persisted as the upstream "known but off" entry rather than being dropped from
// the array; a dropped key is re-inserted (enabled) by migrateProviderOrder on the next load.
const diskAfterRemoval: string[] = JSON.parse(readFileSync(settingsFile, "utf8")).lyrics.providerOrder;
check(
  "removal-persisted-as-disabled",
  diskAfterRemoval.includes("d_blyrics-line") &&
    !diskAfterRemoval.includes("blyrics-line") &&
    diskAfterRemoval.includes("blyrics-richsynced"),
  diskAfterRemoval.join(",")
);

// With only the syllable slot enabled, a line-level song yields no Better Lyrics candidate at all
// instead of being relabelled.
await playTrack("Fixture MP3");
const withLineDisabled = await readSourcesIfAny();
await shot("07-line-slot-disabled");
check(
  "disabled-line-slot-never-relabels",
  !withLineDisabled.sources.includes("Better Lyrics") &&
    !withLineDisabled.sources.includes("Better Lyrics Line"),
  JSON.stringify(withLineDisabled.sources)
);
check(
  "disabled-line-slot-reports-itself-disabled",
  withLineDisabled.empty &&
    withLineDisabled.providers.some(row => /Better Lyrics Line disabled/.test(row)),
  `empty=${withLineDisabled.empty} | ${withLineDisabled.providers.join(" / ")}`
);
await closeSources();

// A restart must not resurrect the removed slot (the migration merges missing defaults back in).
coldStart();
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector(".sidebar", { timeout: 30_000 });
await wait(700);
const afterRemovalRestart = (await providerOrderUi()).map(entry => entry.name);
await shot("08-removal-after-restart");
check(
  "removal-survives-restart",
  !afterRemovalRestart.includes("Better Lyrics Line") && afterRemovalRestart.includes("Better Lyrics"),
  afterRemovalRestart.join(",")
);
const restartedPool = await page.$$eval('[data-testid="provider-pool"] .provider-pool-chip', nodes =>
  nodes.map(node => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
);
check(
  "removed-slot-still-offered-after-restart",
  restartedPool.some(name => name.startsWith("Better Lyrics Line")),
  restartedPool.join(" | ")
);

// Put it back and confirm the result returns under its own identity, at its old priority.
await clickText('[data-testid="provider-pool"] .provider-pool-chip', "Better Lyrics Line", false);
await wait(250);
const afterReAdd = (await providerOrderUi()).map(entry => entry.name);
check(
  "re-added-slot-returns-to-its-position",
  afterReAdd.join(",") === afterRestart.map(entry => entry.name).join(","),
  afterReAdd.join(",")
);
await playTrack("Fixture MP3");
const restored = await openSources();
check(
  "re-adding-line-slot-restores-attribution",
  restored.sources.some(source => source.name === "Better Lyrics Line"),
  JSON.stringify(restored.sources.map(source => source.name))
);
await closeSources();

/* ------- 7. manual selection in the Lyrics dock: persistence and separation */

// Fixture ALAC gets a line-level TTML *and* a Kugou LRC, so both identities are offered at once.
await playTrack("Fixture ALAC");
// Native ALAC now really advances the shared playback clock; pause it so a six-second fixture
// cannot auto-advance to the next track during this provider-persistence UI check.
await page.evaluate(() => document.querySelector("audio")?.pause());
const bothOffered = await openSources();
check(
  "same-track-offers-both-identities",
  bothOffered.sources[0]?.name === "Better Lyrics Line" &&
    bothOffered.sources.some(source => source.name === "Kugou Line") &&
    bothOffered.sources[0]?.active === true,
  JSON.stringify(bothOffered.sources)
);

await selectSourceRow("Kugou Line");
const afterManual = await openSources();
const manualText = await page.$$eval(".blyrics--line", nodes =>
  nodes.map(node => node.textContent?.replace(/\s+/g, " ").trim() ?? "").join(" | ")
);
await shot("09-manual-selection");
check(
  "manual-selection-switches-provider",
  afterManual.sources.find(source => source.active)?.name === "Kugou Line" &&
    manualText.includes("Kugou line one"),
  `${JSON.stringify(afterManual.sources)} | ${manualText}`
);
await closeSources();

await nav("Songs");
await nav("Albums");
const afterManualNav = await openSources();
check(
  "manual-selection-survives-navigation",
  afterManualNav.sources.find(source => source.active)?.name === "Kugou Line",
  JSON.stringify(afterManualNav.sources)
);
await closeSources();

// The manual choice is the *active provider*, not the priority order: Settings is untouched.
const orderAfterManual = (await providerOrderUi()).map(entry => entry.name);
check(
  "manual-selection-leaves-priority-order-alone",
  orderAfterManual.join(",") === afterReAdd.join(","),
  orderAfterManual.join(",")
);

coldStart();
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector(".sidebar", { timeout: 30_000 });
await wait(700);
await playTrack("Fixture ALAC");
await page.evaluate(() => document.querySelector("audio")?.pause());
const afterManualRestart = await openSources();
await shot("10-manual-selection-after-restart");
check(
  "manual-selection-survives-restart",
  afterManualRestart.sources.find(source => source.active)?.name === "Kugou Line" &&
    afterManualRestart.sources.some(source => source.name === "Better Lyrics Line"),
  JSON.stringify(afterManualRestart.sources)
);
await closeSources();

// Switching back is just as sticky, and the line-level identity is still its own entry.
await selectSourceRow("Better Lyrics Line");
await nav("Songs");
const afterSwitchBack = await openSources();
check(
  "manual-selection-can-switch-back",
  afterSwitchBack.sources.find(source => source.active)?.name === "Better Lyrics Line",
  JSON.stringify(afterSwitchBack.sources)
);
await closeSources();

/* ------------------------- multi-sidecar discovery in the real Now Playing UI */

await playTrack("fixture");
// Keep the six-second fixture from auto-advancing while the checks below run.
await page.evaluate(() => document.querySelector("audio")?.pause());
const bothSidecars = await openSources();
await shot("11-both-sidecars");
const localNames = bothSidecars.sources.map(source => source.name);
check(
  "both-sidecars-offered-exactly-once",
  localNames.filter(name => name === "Local TTML/QRC").length === 1 &&
    localNames.filter(name => name === "Local LRC").length === 1,
  JSON.stringify(bothSidecars.sources)
);
check(
  "both-sidecar-files-reported",
  bothSidecars.providers.some(row => row.includes("Song.ttml")) &&
    bothSidecars.providers.some(row => row.includes("Song.lrc")),
  JSON.stringify(bothSidecars.providers)
);
check(
  "local-rich-active-by-configured-priority",
  bothSidecars.sources[0]?.name === "Local TTML/QRC" &&
    bothSidecars.sources[0]?.active === true &&
    bothSidecars.syncLabel === "Word synced",
  `${JSON.stringify(bothSidecars.sources)} | ${bothSidecars.syncLabel}`
);
check(
  "local-ttml-not-labeled-as-better-lyrics",
  localNames.every(name => name !== "Better Lyrics" && name !== "Better Lyrics Line"),
  localNames.join(" | ")
);

// The source popover is still open from openSources(); select from it directly.
await clickOpenSourceRow("Local LRC");
const selectedLrc = await openSources();
const lrcRendered = await page.evaluate(() =>
  document.querySelector(".lyrics-body")?.textContent?.includes("Sidecar LRC line one") ?? false
);
check(
  "local-lrc-selectable-and-rendered",
  selectedLrc.sources.find(source => source.active)?.name === "Local LRC" && lrcRendered,
  `${JSON.stringify(selectedLrc.sources)} | rendered=${lrcRendered}`
);
await closeSources();

// Leaving Now Playing unmounts the view; returning must restore both candidates and the choice.
await nav("Songs");
const afterRemount = await openSources();
const remountNames = afterRemount.sources.map(source => source.name);
check(
  "both-sidecars-survive-now-playing-remount",
  remountNames.filter(name => name === "Local TTML/QRC").length === 1 &&
    remountNames.filter(name => name === "Local LRC").length === 1 &&
    afterRemount.sources.find(source => source.active)?.name === "Local LRC",
  JSON.stringify(afterRemount.sources)
);
await closeSources();

// A different track must not leak its provider identity back into the sidecar track.
await playTrack("Fixture MP3");
await playTrack("fixture");
await page.evaluate(() => document.querySelector("audio")?.pause());
const afterTrackSwitch = await openSources();
const switchedNames = afterTrackSwitch.sources.map(source => source.name);
check(
  "both-sidecars-survive-track-switch",
  switchedNames.filter(name => name === "Local TTML/QRC").length === 1 &&
    switchedNames.filter(name => name === "Local LRC").length === 1 &&
    switchedNames.every(name => name !== "Better Lyrics Line") &&
    afterTrackSwitch.sources.find(source => source.active)?.name === "Local LRC",
  JSON.stringify(afterTrackSwitch.sources)
);
await closeSources();

/* -------------------------------------------------------------------- report */

const failures = Object.entries(results).filter(([, entry]) => !entry.value);
console.log(`\n${Object.keys(results).length - failures.length}/${Object.keys(results).length} checks passed`);
if (failures.length) {
  console.log("Failures:");
  for (const [name, entry] of failures) console.log(`  ${name}: ${entry.detail}`);
  console.log("Console log tail:", logs.slice(-12).join("\n"));
}
console.log(`Better Lyrics API calls: ${apiCalls.length}`);
console.log(`Screenshots: ${shotDir}`);

await browser.close();
server.close();
lyricsCache.flush();
process.exit(failures.length ? 1 : 0);
