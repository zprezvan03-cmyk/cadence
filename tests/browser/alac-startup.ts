/**
 * ALAC startup-latency harness.
 *
 * The desktop app cannot play ALAC through the WebView: Chromium has no ALAC decoder (this
 * harness proves it: `alac-native-support` fails with MEDIA_ERR_SRC_NOT_SUPPORTED), so every ALAC
 * track is decoded by the native Symphonia bridge into a PCM WAV before the <audio> element gets a
 * source. This harness measures the part of that wait the renderer controls — how many native
 * decodes a user action schedules and how long the first sample takes to arrive — with the native
 * bridge replaced by a stub whose cost is a fixed, serialized "decode" (the real decoder needs a
 * Rust toolchain, which this sandbox does not have).
 *
 * Usage: npm run build:web && npx vite-node tests/browser/alac-startup.ts
 */

import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";
import { LibraryStore } from "../../src/main/library/store";
import { scanLibrary } from "../../src/main/library/scanner";
import { SettingsStore } from "../../src/main/settings";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const fixtures = join(root, ".artifacts/fixtures/formats");
const shotDir = join(root, ".artifacts/alac-startup");
mkdirSync(shotDir, { recursive: true });

if (!existsSync(join(outDir, "index.html"))) throw new Error("Run: npm run build:web");
if (!existsSync(join(fixtures, "fixture-alac.m4a"))) throw new Error("Run: python3 tests/fixtures/generate-audio.py");

/** Cost of one native ALAC decode, as the stub models it (the real one is measured in Rust). */
const DECODE_MS = Number(process.env.ALAC_DECODE_MS ?? 900);

const stateDir = mkdtempSync(join(tmpdir(), "cadence-alac-startup-"));
const musicDir = join(stateDir, "music");
const artworkDir = join(stateDir, "artwork");
mkdirSync(musicDir, { recursive: true });
mkdirSync(artworkDir, { recursive: true });

const alacA = join(musicDir, "ALAC One.m4a");
copyFileSync(join(fixtures, "fixture-alac.m4a"), alacA);
const alacB = join(musicDir, "ALAC Two.m4a");
copyFileSync(join(fixtures, "fixture-alac.m4a"), alacB);
const flacPath = join(musicDir, "Lossless FLAC.flac");
copyFileSync(join(fixtures, "fixture.flac"), flacPath);
const mp3Path = join(musicDir, "Lossy MP3.mp3");
copyFileSync(join(fixtures, "fixture.mp3"), mp3Path);

const store = new LibraryStore(join(stateDir, "library.db"), artworkDir, path => `media://${path}`);
const scan = await scanLibrary(store, { folders: [musicDir] });
if (scan.errors.length) console.log("scan errors:", scan.errors);

const idOf = (path: string) => {
  const track = store.getTrackByPath(path);
  if (!track) throw new Error(`No track for ${path}`);
  return track.id;
};
const ids = { alacA: idOf(alacA), alacB: idOf(alacB), flac: idOf(flacPath), mp3: idOf(mp3Path) };
console.log("track ids:", JSON.stringify(ids));
console.log(
  "scanned codecs:",
  JSON.stringify(store.getTracks().map(track => `${track.title} = ${track.codec}`))
);

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
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".woff2": "font/woff2",
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
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    if (url.pathname === "/api/library") return sendJson(snapshot());
    if (url.pathname === "/api/settings") return sendJson(settings.get());
    if (url.pathname === "/api/settings/patch") return sendJson(settings.patch(body));
    if (url.pathname === "/api/settings/reset") return sendJson(settings.reset());
    if (url.pathname.startsWith("/api/lyrics/")) {
      if (url.pathname === "/api/lyrics/resolve") return sendJson({ candidates: [], providerStatus: [] });
      return sendJson({ entries: [], stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 } });
    }
    return sendJson({});
  }

  // Media: the ALAC bridge hands back this WAV; everything else streams its own file.
  const mediaMatch = /^\/(audio|alac-wav)\/(\d+)$/.exec(url.pathname);
  if (mediaMatch) {
    const [, kind, rawId] = mediaMatch;
    const track = store.getTrack(Number(rawId));
    const file = kind === "alac-wav" ? join(fixtures, "fixture.wav") : (track?.path ?? flacPath);
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

await new Promise<void>(done => server.listen(4797, "0.0.0.0", () => done()));
const base = "http://127.0.0.1:4797";

/* ----------------------------------------------------------------- browser */

await inflate(join(root, "node_modules/@sparticuz/chromium/bin/al2023.tar.br"));
setupLambdaEnvironment(join(tmpdir(), "al2023", "lib"));
chromium.setGraphicsMode = true;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  args: [...chromium.args, "--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 180_000,
});
const page = await browser.newPage();
const logs: string[] = [];
page.on("console", message => logs.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", (error: unknown) => logs.push(`[pageerror] ${String(error)}`));

await page.evaluateOnNewDocument((decodeMs: number) => {
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

  /**
   * Native ALAC decode model, matching the Rust bridge: a decoded file that already exists on disk
   * is reused, but two requests that arrive before the first decoder finishes both start their own
   * full decode (the cache file only wins at rename time). Decodes are CPU-bound, so they are
   * serialized here to model cores being shared.
   */
  const decodedByPath = new Map<string, string>();
  let decodeChain: Promise<unknown> = Promise.resolve();
  const decodeLog: { path: string; kind: "cold" | "cached"; startedAt: number; finishedAt: number }[] = [];

  const decodeAlac = (path: string): Promise<string> => {
    const startedAt = performance.now();
    const cached = decodedByPath.get(path);
    if (cached) {
      decodeLog.push({ path, kind: "cached", startedAt, finishedAt: performance.now() });
      return Promise.resolve(cached);
    }
    const entry = { path, kind: "cold" as const, startedAt, finishedAt: 0 };
    decodeLog.push(entry);
    const run = decodeChain.then(
      () =>
        new Promise<string>(resolve => {
          entry.startedAt = performance.now();
          setTimeout(() => {
            const id = path.match(/(\d+)$/)?.[1] ?? "0";
            const url = `/alac-wav/${id}`;
            decodedByPath.set(path, url);
            entry.finishedAt = performance.now();
            resolve(url);
          }, decodeMs);
        })
    );
    decodeChain = run.catch(() => undefined);
    return run;
  };

  // Pre-decoded WAVs live on the "disk" between scenarios; tests clear them when they want a cold run.
  (window as unknown as { __alac: unknown }).__alac = {
    decodeLog,
    reset: () => (decodeLog.length = 0),
    clear: () => decodedByPath.clear(),
    now: () => performance.now(),
  };

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
      resolve: async () => ({ candidates: [], providerStatus: [] }),
      search: async () => ({ results: [], providerStatus: [], cached: false }),
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
      prepareAlacSource: async (path: string) => decodeAlac(path),
      reportState: async () => undefined,
      onCommand: () => () => {},
    },
    decodeTester: { deleteFiles: async () => [], exportFileList: async () => ({ canceled: true }) },
  };
}, DECODE_MS);

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
  throw new Error(`No ${selector} with text ${JSON.stringify(wanted)}`);
};
const nav = async (label: string) => {
  await clickText(".sidebar .nav-item", label);
  await wait(250);
};

const audioState = () =>
  page.evaluate(() => {
    const element = document.querySelector("audio") as HTMLAudioElement | null;
    return {
      paused: element?.paused ?? true,
      currentTime: element?.currentTime ?? 0,
      duration: element?.duration ?? Number.NaN,
      src: element?.currentSrc ?? "",
      error: element?.error?.code ?? null,
      buffering: Boolean(document.querySelector('[data-testid="player-preparing"]')),
    };
  });

/** Waits until real audio is advancing: elapsed wall-clock ms plus the in-page moment it began. */
const waitForPlayback = async (limitMs = 15_000) => {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const state = await audioState();
    if (!state.paused && state.currentTime > 0.05) return { ms: Date.now() - started, at: await pageNow() };
    await wait(25);
  }
  return { ms: Number.POSITIVE_INFINITY, at: Number.POSITIVE_INFINITY };
};

const decodeStats = () =>
  page.evaluate(() =>
    (
      window as unknown as {
        __alac: { decodeLog: { path: string; kind: string; startedAt: number; finishedAt: number }[] };
      }
    ).__alac.decodeLog.map(entry => ({
      path: entry.path,
      kind: entry.kind,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
    }))
  );
const pageNow = () => page.evaluate(() => (window as unknown as { __alac: { now: () => number } }).__alac.now());
const resetDecodes = () => page.evaluate(() => (window as unknown as { __alac: { reset: () => void } }).__alac.reset());
const clearDecoded = () => page.evaluate(() => (window as unknown as { __alac: { clear: () => void } }).__alac.clear());

const rowSelector = (id: number) => `[data-testid="track-row"][data-track-id="${id}"]`;
const stopPlayback = async () => {
  await page.evaluate(() => document.querySelector("audio")?.pause());
  await wait(120);
};

/* ------------------------------------------------------------------- script */

await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sidebar", { timeout: 60_000 });
await wait(900);

/* 0. The reason the native bridge exists: Chromium cannot decode this ALAC file itself. */
const nativeAlac = await page.evaluate(async (url: string) => {
  const audio = new Audio(url);
  audio.muted = true;
  const settled = new Promise<string>(done => {
    audio.addEventListener("canplay", () => done("canplay"), { once: true });
    audio.addEventListener("error", () => done("error"), { once: true });
    setTimeout(() => done("timeout"), 6000);
  });
  audio.load();
  const outcome = await settled;
  return { outcome, code: audio.error?.code ?? null };
}, `/audio/${ids.alacA}`);
check(
  "alac-native-support",
  nativeAlac.outcome === "error" && nativeAlac.code === 4,
  `WebView outcome=${nativeAlac.outcome} code=${nativeAlac.code} (no ALAC decoder, so the native bridge is required)`
);

/**
 * A fresh document with no restored session: the stub's decoded-WAV cache, the player queue and
 * the lyrics/settings state all start from zero, which is what a cold user action looks like.
 */
const freshPage = async () => {
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sidebar", { timeout: 60_000 });
  await wait(800);
  await nav("Songs");
};
const clickRow = async (id: number) => page.click(rowSelector(id));
/** Clicks a row and measures until audio advances, timed from the click itself. */
const clickAndTime = async (id: number) => {
  const started = Date.now();
  await page.click(rowSelector(id));
  const playback = await waitForPlayback();
  return { ms: Date.now() - started, at: playback.at };
};
const doubleClickRow = async (id: number) => {
  const box = await (await page.$(rowSelector(id)))!.boundingBox();
  if (!box) throw new Error(`No box for track ${id}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
    // This build's types omit `clickCount`, but the CDP mouse event honours it and produces a real
    // double click (down/up ×2 plus dblclick).
    clickCount: 2,
  } as unknown as Parameters<typeof page.mouse.click>[2]);
};

const cold = (entries: { kind: string }[]) => entries.filter(entry => entry.kind === "cold").length;
/** Decodes that had to finish before playback began. */
const finishedBefore = (log: { kind: string; finishedAt: number }[], at: number) =>
  log.filter(entry => entry.kind === "cold" && entry.finishedAt > 0 && entry.finishedAt <= at).length;
/** Decodes the action scheduled at all — including background prewarms of other files. */
const scheduledBefore = (log: { kind: string; startedAt: number }[], at: number) =>
  log.filter(entry => entry.kind === "cold" && entry.startedAt <= at).length;

/* 1. Baseline: formats Chromium decodes itself start almost immediately. */
await freshPage();
const flac = await clickAndTime(ids.flac);
check("flac-starts-fast", flac.ms < 1500, `${flac.ms} ms from click to audio (baseline)`);
check(
  "fast-formats-show-no-preparing-indicator",
  (await page.$$('[data-testid="player-preparing"]')).length === 0,
  "no decode notice for formats Chromium decodes itself"
);
await shot("01-flac-playing");
await stopPlayback();

const mp3 = await clickAndTime(ids.mp3);
check("mp3-starts-fast", mp3.ms < 1500, `${mp3.ms} ms from click to audio`);
await stopPlayback();

/* 2. ALAC, cold, single click on a fresh page: the irreducible native decode. */
await freshPage();
await resetDecodes();
const singleStarted = Date.now();
await page.click(rowSelector(ids.alacA));
// The wait is visible: the player bar says what is happening instead of looking frozen.
const preparingShown = await page
  .waitForSelector('[data-testid="player-preparing"]', { timeout: 3_000 })
  .then(() => true)
  .catch(() => false);
check("alac-shows-preparing-indicator", preparingShown, preparingShown ? "" : "the player bar never showed it");
if (preparingShown) await shot("02a-alac-preparing");
const singlePlayback = await waitForPlayback();
const single = { ms: Date.now() - singleStarted, at: singlePlayback.at };
const singleLog = await decodeStats();
const singleFinished = finishedBefore(singleLog, single.at);
check(
  "alac-single-click-decodes-once",
  singleFinished === 1,
  `${singleFinished} decode(s) finished before playback: ${JSON.stringify(singleLog.map(entry => [entry.kind, entry.path.split("/").pop()]))}`
);
console.log(
  `MEASURE alac-single-click ${single.ms} ms (decode cost ${DECODE_MS} ms, ${scheduledBefore(singleLog, single.at)} decode(s) scheduled)`
);
await shot("02-alac-playing");
const alacState = await audioState();
check(
  "alac-duration-and-playback",
  Number.isFinite(alacState.duration) && alacState.duration > 5 && alacState.error === null,
  `duration=${alacState.duration} error=${alacState.error}`
);
await wait(600);
const advanced = await audioState();
check("alac-time-advances", advanced.currentTime > alacState.currentTime, `${alacState.currentTime} -> ${advanced.currentTime}`);

/* 3. Seeking inside the prepared WAV. */
await page.evaluate(() => {
  const element = document.querySelector("audio") as HTMLAudioElement | null;
  if (element) element.currentTime = 4;
});
await wait(500);
const seeked = await audioState();
check("alac-seek-works", Math.abs(seeked.currentTime - 4) < 1.2, `currentTime=${seeked.currentTime}`);
await stopPlayback();

/* 4. A real (OS-level) double click on a cold ALAC track must schedule one decode, not two. */
await freshPage();
await resetDecodes();
const doubleStarted = Date.now();
await doubleClickRow(ids.alacB);
const doublePlayback = await waitForPlayback();
const double = { ms: Date.now() - doubleStarted, at: doublePlayback.at };
const doubleLog = await decodeStats();
const doubleForFile = doubleLog.filter(entry => entry.kind === "cold" && entry.path.endsWith("ALAC Two.m4a")).length;
check(
  "alac-double-click-decodes-once",
  doubleForFile === 1,
  `${doubleForFile} decode(s) for the clicked file: ${JSON.stringify(doubleLog.map(entry => [entry.kind, entry.path.split("/").pop()]))}`
);
console.log(`MEASURE alac-double-click ${double.ms} ms (decode cost ${DECODE_MS} ms)`);
await stopPlayback();

/* 5. Queue transition: ALAC One playing, then "next" reaches ALAC Two, decoded in the background
 *    while the first track was audible. */
await freshPage();
await resetDecodes();
await page.click(rowSelector(ids.alacA));
await waitForPlayback();
await wait(Math.round(DECODE_MS * 1.4));
await resetDecodes();
const nextStarted = Date.now();
await page.click('button[aria-label="Next track"]');
const nextPlayback = await waitForPlayback();
const next = { ms: Date.now() - nextStarted, at: nextPlayback.at };
const nextLog = await decodeStats();
check("alac-queue-next-plays-second-track", Number.isFinite(nextPlayback.ms), `${next.ms} ms`);
check(
  "alac-queue-next-blocking-decodes",
  finishedBefore(nextLog, next.at) === 0,
  `${finishedBefore(nextLog, next.at)} decode(s) waited for after the skip (${nextLog.length} scheduled)`
);
console.log(`MEASURE alac-queue-next ${next.ms} ms (${nextLog.length} decode call(s) by the transition)`);

/* 6. Rapid switching between two cold ALAC files: the abandoned decode cannot be cancelled. */
await freshPage();
await resetDecodes();
await page.click(rowSelector(ids.alacA));
await wait(80);
const rapidStarted = Date.now();
await page.click(rowSelector(ids.alacB));
const rapidPlayback = await waitForPlayback();
const rapid = { ms: Date.now() - rapidStarted, at: rapidPlayback.at };
const rapidLog = await decodeStats();
console.log(`MEASURE alac-rapid-switch ${rapid.ms} ms ${JSON.stringify(rapidLog.map(entry => entry.kind))}`);
const rapidState = await audioState();
check(
  "alac-rapid-switch-plays-last-track",
  Number.isFinite(rapidPlayback.ms) && rapidState.error === null,
  `${rapid.ms} ms, error=${rapidState.error}`
);
await shot("03-alac-after-rapid-switch");

console.log(
  `SUMMARY ${JSON.stringify({
    flacMs: flac.ms,
    mp3Ms: mp3.ms,
    singleMs: single.ms,
    doubleMs: double.ms,
    nextMs: next.ms,
    rapidMs: rapid.ms,
    singleFinished,
    doubleForFile,
  })}`
);

const failures = Object.entries(results).filter(([, entry]) => !entry.value);
console.log(`\n${Object.keys(results).length - failures.length}/${Object.keys(results).length} checks passed`);
if (failures.length) {
  console.log("Failures:");
  for (const [name, entry] of failures) console.log(`  ${name}: ${entry.detail}`);
}
console.log("Console log tail:", logs.slice(-4).join("\n"));
console.log(`Screenshots: ${shotDir}`);

await browser.close();
server.close();
rmSync(stateDir, { recursive: true, force: true });
process.exit(0);
