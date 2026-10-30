/**
 * Animation audit harness.
 *
 * Boots the production renderer in headless Chromium over a real library and drives the actual
 * interactions (nav clicks, track changes, queue, menus, modals, fullscreen, reduced motion) while
 * reading the animations the browser is really running. Nothing here asserts on source code: every
 * check asks the live DOM for the animation name, its duration, or the frames it produced.
 *
 * Mid-transition frames are captured by pausing the *real* running animation at 110 ms and taking a
 * screenshot, then comparing it to the settled frame — proof that the intermediate state exists and
 * is not just a start/end cut.
 *
 * Usage: npm run build:web && npx vite-node tests/browser/animation-audit.ts
 */

import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";
import { PNG } from "pngjs";
import { LibraryStore } from "../../src/main/library/store";
import { scanLibrary } from "../../src/main/library/scanner";
import { SettingsStore } from "../../src/main/settings";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const fixtures = join(root, ".artifacts/fixtures/formats");
const shotDir = join(root, ".artifacts/animation-audit");
mkdirSync(shotDir, { recursive: true });

if (!existsSync(join(outDir, "index.html"))) throw new Error("Run: npm run build:web");
if (!existsSync(join(fixtures, "fixture.flac"))) throw new Error("Run: python3 tests/fixtures/generate-audio.py");

/* --------------------------------------------------------------- fixtures */

const stateDir = mkdtempSync(join(tmpdir(), "cadence-anim-"));
const musicDir = join(stateDir, "music");
const artworkDir = join(stateDir, "artwork");
mkdirSync(musicDir, { recursive: true });
mkdirSync(artworkDir, { recursive: true });

// Real files with embedded covers, so the player's artwork path is exercised. The FLAC is copied
// out a few times so the song list is long enough to scroll.
copyFileSync(join(fixtures, "fixture.mp3"), join(musicDir, "Beta Song.mp3"));
copyFileSync(join(fixtures, "fixture.ogg"), join(musicDir, "Gamma Song.ogg"));
for (let index = 0; index < 22; index += 1) {
  copyFileSync(join(fixtures, "fixture.flac"), join(musicDir, `Alpha Song ${String(index + 1).padStart(2, "0")}.flac`));
}
writeFileSync(
  join(musicDir, "Alpha Song.lrc"),
  "[00:00.30]First line of the alpha song\n[00:01.60]Second line arrives later\n[00:03.20]Third line keeps the pace\n",
  "utf8"
);

const store = new LibraryStore(join(stateDir, "library.db"), artworkDir, path => `/artwork/${encodeURIComponent(basename(path))}`);
const scan = await scanLibrary(store, { folders: [musicDir] });
if (scan.errors.length) console.log("scan errors:", scan.errors);

const snapshot = () => {
  const tracks = store.getTracks().map(track => ({
    ...store.toTrack(track),
    streamUrl: `/audio/${track.id}`,
    artworkUrl: track.artworkFile ? `/artwork/${encodeURIComponent(track.artworkFile)}` : null,
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
const tracks = snapshot().tracks;
const firstId = tracks.find(track => track.title === "Alpha Song 01")?.id ?? tracks[0].id;
const secondId = tracks[1]?.id ?? firstId;

/* ------------------------------------------------------------------ server */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
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
    if (url.pathname === "/api/lyrics/resolve") return sendJson({ candidates: [], providerStatus: [] });
    if (url.pathname === "/api/lyrics/search") return sendJson({ results: [], providerStatus: [], cached: false });
    if (url.pathname === "/api/lyrics/translate") return sendJson({ translations: [], detectedLanguage: "en" });
    if (url.pathname === "/api/lyrics/romanize") return sendJson({ romanizations: [], detectedLanguage: "en" });
    if (url.pathname.startsWith("/api/lyrics/")) return sendJson({ entries: [], stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 } });
    return sendJson({});
  }

  if (url.pathname.startsWith("/audio/")) {
    const id = Number(url.pathname.split("/")[2]);
    const track = store.getTrack(id);
    const file = track?.path ?? join(musicDir, "Alpha Song.flac");
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

  if (url.pathname.startsWith("/artwork/")) {
    const file = join(artworkDir, basename(decodeURIComponent(url.pathname)));
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
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

await new Promise<void>(done => server.listen(4798, "0.0.0.0", () => done()));
const base = "http://127.0.0.1:4798";

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

await page.evaluateOnNewDocument((ids: { first: number; second: number }) => {
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
  const chromeInfo = { undecorated: false, maximized: false, fullscreen: false, focused: true };
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
      resolve: async () => call("/api/lyrics/resolve", {}),
      search: async () => call("/api/lyrics/search", {}),
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
      initialWindowChrome: { ...chromeInfo },
      windowChrome: async () => ({ ...chromeInfo }),
      onWindowChromeChange: () => () => {},
    },
    player: {
      prepareAlacSource: async () => `/audio/${ids.first}`,
      reportState: async () => undefined,
      onCommand: () => () => {},
    },
    decodeTester: { deleteFiles: async () => [], exportFileList: async () => ({ canceled: true }) },
  };
}, { first: firstId, second: secondId });

/* ------------------------------------------------------------------ helpers */

const results: Record<string, { value: boolean; detail: string }> = {};
const check = (name: string, value: boolean, detail = "") => {
  results[name] = { value: Boolean(value), detail };
  console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const shot = async (name: string) => page.screenshot({ path: join(shotDir, `${name}.png`) as `${string}.png` });
const png = (name: string) => PNG.sync.read(readFileSync(join(shotDir, `${name}.png`)));

/** Mean share of pixels that differ between two screenshots. */
const frameDelta = (a: string, b: string) => {
  const left = png(a);
  const right = png(b);
  let changed = 0;
  const pixels = Math.min(left.data.length, right.data.length) / 4;
  for (let i = 0; i < pixels * 4; i += 4) {
    if (Math.abs(left.data[i] - right.data[i]) > 6 || Math.abs(left.data[i + 1] - right.data[i + 1]) > 6 || Math.abs(left.data[i + 2] - right.data[i + 2]) > 6) {
      changed += 1;
    }
  }
  return Number((changed / pixels).toFixed(4));
};

/** Every animation/transition the browser reports for the element, with its timing. */
const animationsFor = (selector: string) =>
  page.evaluate((sel: string) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    return node.getAnimations().map(animation => ({
      name: (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? "unknown",
      duration: (animation.effect?.getTiming().duration ?? null) as number | string | null,
      playState: animation.playState,
    }));
  }, selector);

/** Wait until a presence surface reports its exiting phase, then snapshot its animations. */
const waitForExit = async (selector: string) => {
  await page
    .waitForFunction(
      (sel: string) => document.querySelector(sel)?.getAttribute("data-presence") === "exiting",
      { timeout: 2000 },
      selector
    )
    .catch(() => null);
  return animationsFor(selector);
};

const waitForGone = (selector: string) =>
  page
    .waitForFunction((sel: string) => !document.querySelector(sel), { timeout: 2000 }, selector)
    .then(() => true)
    .catch(() => false);

/** Hold the running animations at `at` ms so a screenshot captures a true intermediate frame. */
const freezeAt = (at = 110) =>
  page.evaluate((time: number) => {
    const held = document.getAnimations().filter(animation => animation.playState === "running");
    for (const animation of held) {
      animation.pause();
      animation.currentTime = time;
    }
    return {
      count: held.length,
      names: held.map(animation => (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? "?"),
    };
  }, at);

const resumeAll = () =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter(animation => animation.playState === "paused")
      .forEach(animation => {
        animation.finish();
      })
  );

const clickSelector = async (selector: string) => {
  await page.click(selector);
};
const clickText = async (selector: string, wanted: string, exact = true) => {
  for (const handle of await page.$$(selector)) {
    const text = await handle.evaluate(node => node.textContent?.replace(/\s+/g, " ").trim() ?? "");
    if (exact ? text === wanted : text.includes(wanted)) {
      await handle.click();
      return;
    }
  }
  throw new Error(`No ${selector} with text ${JSON.stringify(wanted)}`);
};
const navItem = async (label: string) => clickText(".nav .nav-item", label);
const sidebarItem = async (label: string) => clickText("aside.sidebar .nav-item", label);

const waitForApp = async () => {
  await page.waitForSelector(".nav .nav-item", { timeout: 30_000 });
  await page.waitForSelector('[data-testid="player-bar"]', { timeout: 30_000 });
  await wait(400);
};

/* -------------------------------------------------------------------- boot */

await page.goto(base, { waitUntil: "networkidle2" });
await waitForApp();
await shot("00-boot");
check("app-boots", (await page.$$(".nav-item")).length >= 6, `${(await page.$$(".nav-item")).length} nav items`);
check("boot-no-console-errors", !logs.some(line => line.startsWith("[pageerror]")), logs.filter(line => line.startsWith("[pageerror]")).join(" | "));

// Motion foundation: the live stylesheet must expose the shared token scale, and the
// normalized consumers must compute to token durations rather than leftover literals.
const motionTokens = await page.evaluate(() => {
  const rootStyle = getComputedStyle(document.documentElement);
  const token = (name: string) => rootStyle.getPropertyValue(name).trim();
  const timeToMs = (value: string | undefined) => {
    if (!value) return null;
    const first = value.split(",")[0]?.trim() ?? "";
    if (first.endsWith("ms")) return Math.round(Number.parseFloat(first));
    if (first.endsWith("s")) return Math.round(Number.parseFloat(first) * 1000);
    return null;
  };
  const seekBuffer = document.querySelector(".seek-buffer");
  return {
    // Chromium serializes some custom-property times as fractional seconds (".12s"), so the
    // scale is compared as parsed milliseconds rather than raw stylesheet text.
    dur0: timeToMs(token("--dur-0")),
    dur1: timeToMs(token("--dur-1")),
    dur2: timeToMs(token("--dur-2")),
    dur3: timeToMs(token("--dur-3")),
    dur4: timeToMs(token("--dur-4")),
    stagger: timeToMs(token("--stagger-step")),
    easeOut: token("--ease-out"),
    easeIn: token("--ease-in"),
    easeInOut: token("--ease-in-out"),
    easeSpring: token("--ease-spring"),
    seekBufferMs: seekBuffer ? timeToMs(getComputedStyle(seekBuffer).transitionDuration) : null,
  };
});
check(
  "motion-token-scale",
  motionTokens.dur0 === 70 &&
    motionTokens.dur1 === 120 &&
    motionTokens.dur2 === 180 &&
    motionTokens.dur3 === 240 &&
    motionTokens.dur4 === 320 &&
    motionTokens.stagger === 24,
  JSON.stringify(motionTokens)
);
check(
  "motion-token-easings",
  [motionTokens.easeOut, motionTokens.easeIn, motionTokens.easeInOut, motionTokens.easeSpring].every(value => value.startsWith("cubic-bezier(")),
  JSON.stringify(motionTokens)
);
check("motion-token-consumers-normalized", motionTokens.seekBufferMs === 320, JSON.stringify(motionTokens));

// Home is the boot route, so the pill starts on it — measured, visible, not animating in.
const pillAtBoot = await page.evaluate(() => {
  const pill = document.querySelector(".nav-pill")!;
  const home = ([...document.querySelectorAll(".nav .nav-item")] as HTMLButtonElement[]).find(button => button.title === "Home")!.getBoundingClientRect();
  const rect = pill.getBoundingClientRect();
  return {
    visible: pill.classList.contains("is-visible"),
    aligned: Math.abs(rect.top - home.top) < 1 && Math.abs(rect.height - home.height) < 1,
    running: pill.getAnimations().length,
  };
});
check("nav-pill-starts-on-home", pillAtBoot.visible && pillAtBoot.aligned && pillAtBoot.running === 0, JSON.stringify(pillAtBoot));

/* ------------------------------------------------------- 1. sidebar motion */

const pillProbe = await page.evaluate(async () => {
  const pill = document.querySelector(".nav-pill")!;
  const buttons = [...document.querySelectorAll(".nav .nav-item")] as HTMLButtonElement[];
  const samples: { t: number; transform: string; opacity: string }[] = [];
  const before = {
    transition: getComputedStyle(pill).transitionProperty,
    duration: getComputedStyle(pill).transitionDuration,
    instant: (pill as HTMLElement).dataset.instant ?? null,
    pillState: pill.closest("nav")?.getAttribute("data-pill"),
  };
  const start = performance.now();
  buttons.find(button => button.title === "Albums")!.click();
  let immediate: { name: string; duration: number | string | null; target: string }[] = [];
  await new Promise<void>(done => {
    const tick = () => {
      if (!immediate.length) {
        immediate = document.getAnimations().map(animation => ({
          name: (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? "?",
          duration: (animation.effect?.getTiming().duration ?? null) as number | string | null,
          target: String((animation.effect as KeyframeEffect | null)?.target?.className ?? ""),
        }));
      }
      samples.push({
        t: Math.round(performance.now() - start),
        transform: getComputedStyle(pill).transform,
        opacity: getComputedStyle(pill).opacity,
      });
      if (performance.now() - start < 420) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  return { samples, before, immediate };
});
console.log("pill probe:", JSON.stringify(pillProbe.before), JSON.stringify(pillProbe.immediate));
const distinct = new Set(pillProbe.samples.map(sample => sample.transform)).size;
check(
  "nav-pill-slides",
  distinct >= 4,
  `${distinct} distinct transforms over ${pillProbe.samples.length} frames; first ${pillProbe.samples[0]?.transform} last ${pillProbe.samples.at(-1)?.transform}`
);
const viewAnimation = pillProbe.immediate.find(animation => animation.name === "view-in");
check("view-enters-with-fade", Number(viewAnimation?.duration) === 240, JSON.stringify(viewAnimation ?? pillProbe.immediate));

// Mid-transition frame: navigate again, hold the real animation at 110 ms, shoot, resume, then shoot
// the settled frame. The two images prove an intermediate state exists.
await navItem("Songs");
const held = await freezeAt(110);
await shot("01-nav-albums-mid");
await resumeAll();
await wait(340);
await shot("01-nav-albums-settled");
const navDelta = frameDelta("01-nav-albums-mid", "01-nav-albums-settled");
check("nav-mid-frame-differs", held.count > 0 && navDelta > 0.002, `${held.count} animations held, ${(navDelta * 100).toFixed(2)}% of pixels changed between mid and settled`);

const pillLanded = await page.evaluate(() => {
  const pill = document.querySelector(".nav-pill")!.getBoundingClientRect();
  const active = document.querySelector(".nav .nav-item.active")!.getBoundingClientRect();
  return {
    deltaTop: Math.abs(pill.top - active.top),
    deltaHeight: Math.abs(pill.height - active.height),
    activeBackground: getComputedStyle(document.querySelector(".nav .nav-item.active")!).backgroundColor,
    pillOpacity: getComputedStyle(document.querySelector(".nav-pill")!).opacity,
  };
});
check(
  "nav-pill-lands-on-active",
  pillLanded.deltaTop < 1 && pillLanded.deltaHeight < 1 && pillLanded.pillOpacity === "1",
  JSON.stringify(pillLanded)
);
check("nav-active-background-owned-by-pill", pillLanded.activeBackground === "rgba(0, 0, 0, 0)", pillLanded.activeBackground);

// The pill is measured, so a window resize must re-place it without a route change.
await page.setViewport({ width: 1120, height: 820 });
await wait(320);
const resizedPill = await page.evaluate(() => {
  const pill = document.querySelector(".nav-pill")!.getBoundingClientRect();
  const active = document.querySelector(".nav .nav-item.active")!.getBoundingClientRect();
  return { deltaTop: Math.abs(pill.top - active.top), deltaHeight: Math.abs(pill.height - active.height), left: Math.round(active.left) };
});
await page.setViewport({ width: 1440, height: 900 });
await wait(320);
check("nav-pill-follows-resize", resizedPill.deltaTop < 1 && resizedPill.deltaHeight < 1 && resizedPill.left === 14, JSON.stringify(resizedPill));

/* ------------------------------------------------ 2. page state preservation */

await navItem("Songs");
await wait(260);
await page.type(".inline-search input", "Fixture");
await page.select(".sort-select select", "artist");
const scrolled = await page.evaluate(async () => {
  const scroller = document.querySelector(".content-scroll") as HTMLElement;
  scroller.style.scrollBehavior = "auto";
  scroller.scrollTop = 90;
  await new Promise(done => requestAnimationFrame(() => done(null)));
  return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, rows: document.querySelectorAll(".track-row").length };
});
console.log("scroll probe:", JSON.stringify(scrolled));
await wait(160);
await navItem("Albums");
await wait(300);
await navItem("Songs");
await wait(320);
const restored = await page.evaluate(() => {
  const scroller = document.querySelector(".content-scroll") as HTMLElement;
  return {
    filter: (document.querySelector(".inline-search input") as HTMLInputElement | null)?.value ?? null,
    sort: (document.querySelector(".sort-select select") as HTMLSelectElement | null)?.value ?? null,
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
  };
});
check(
  "library-filter-sort-preserved",
  restored.filter === "Fixture" && restored.sort === "artist",
  JSON.stringify(restored)
);
check("library-scroll-preserved", restored.scrollTop > 40, `scrollTop ${restored.scrollTop}`);

// Clear the filter again so later checks see the whole list.
await page.evaluate(() => {
  const input = document.querySelector(".inline-search input") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await wait(200);

await sidebarItem("Settings");
await wait(280);
await clickText(".settings-tabs button", "Playback");
await wait(200);
await navItem("Home");
await wait(280);
await sidebarItem("Settings");
await wait(300);
const settingsState = await page.evaluate(() => ({
  playback: Boolean(document.querySelector('[data-testid="settings-playback"]')),
  appearance: Boolean(document.querySelector('[data-testid="settings-appearance"]')),
  activeTab: document.querySelector(".settings-tabs button.active")?.textContent?.trim() ?? null,
}));
check("settings-tab-preserved", settingsState.playback && !settingsState.appearance && settingsState.activeTab === "Playback", JSON.stringify(settingsState));
await shot("06-settings-playback");

/* ------------------------------------------------------- 3. now playing bar */

// Start playback from the Songs list.
await navItem("Songs");
await page.waitForSelector(".track-row", { timeout: 10_000 });
await wait(200);
await page.evaluate(() => (document.querySelector(".track-row") as HTMLElement).click());
await wait(600);
await page.evaluate(() => document.querySelector("audio")?.play());
await wait(400);

const iconToggle = await page.evaluate(async () => {
  const button = document.querySelector('[data-testid="play-toggle"]') as HTMLButtonElement;
  const read = () => ({
    label: button.getAttribute("aria-label"),
    animations: [...document.querySelectorAll(".play-icon")].flatMap(node =>
      node.getAnimations().map(animation => (animation as CSSAnimation).animationName ?? "")
    ),
  });
  button.click();
  await new Promise(done => requestAnimationFrame(() => done(null)));
  const paused = read();
  button.click();
  await new Promise(done => requestAnimationFrame(() => done(null)));
  const resumed = read();
  return { paused, resumed };
});
check(
  "play-icon-animates",
  iconToggle.paused.animations.includes("icon-in") && iconToggle.resumed.animations.includes("icon-in"),
  JSON.stringify(iconToggle)
);

const swap = await page.evaluate(async () => {
  const before = document.querySelector(".player-artwork-swap");
  (document.querySelector('button[aria-label="Next track"]') as HTMLButtonElement).click();
  await new Promise(done => requestAnimationFrame(() => done(null)));
  const artwork = document.querySelector(".player-artwork-swap");
  const meta = document.querySelector(".player-track-meta");
  const names = (node: Element | null) =>
    node?.getAnimations().map(animation => (animation as CSSAnimation).animationName ?? "") ?? [];
  return {
    artworkAnimations: names(artwork),
    metaAnimations: names(meta),
    // The same nodes are reused; the fade must not duplicate the cover in the bar.
    sameArtworkNode: artwork === before,
    artworkCount: document.querySelectorAll(".player-track .artwork").length,
    metaCount: document.querySelectorAll(".player-track-meta").length,
    artworkLoaded: Boolean(document.querySelector(".player-track .artwork img")),
  };
});
check(
  "artwork-fades-on-track-change",
  swap.artworkAnimations.includes("artwork-in") && swap.artworkCount === 1,
  JSON.stringify(swap)
);
check(
  "player-meta-fades-on-track-change",
  swap.metaAnimations.includes("meta-in") && swap.metaCount === 1,
  JSON.stringify(swap)
);
check("player-artwork-not-duplicated", swap.artworkCount === 1 && swap.metaCount === 1 && swap.sameArtworkNode, JSON.stringify(swap));
check("player-artwork-has-image", swap.artworkLoaded, "cover image rendered");

await wait(80);
const heldMeta = await freezeAt(90);
await shot("02-player-track-change-mid");
await resumeAll();
await wait(300);
await shot("02-player-track-change-settled");
check("player-mid-frame-differs", heldMeta.count > 0 && frameDelta("02-player-track-change-mid", "02-player-track-change-settled") > 0.0005, `${heldMeta.count} held`);

// Seek fill: painted from the audio clock, never transitioned, so the bar cannot lag the song.
const seekTiming = await page.evaluate(() => {
  const input = document.querySelector("input.seek") as HTMLInputElement;
  const buffer = document.querySelector(".seek-buffer") as HTMLElement;
  const track = getComputedStyle(input, "::-webkit-slider-runnable-track");
  return {
    inputDuration: getComputedStyle(input).transitionDuration,
    trackDuration: track.transitionDuration,
    bufferProperty: getComputedStyle(buffer).transitionProperty,
    bufferDuration: getComputedStyle(buffer).transitionDuration,
  };
});
check(
  "seek-fill-has-no-transition",
  seekTiming.inputDuration.split(",").every(value => value.trim() === "0s") &&
    seekTiming.trackDuration.split(",").every(value => value.trim() === "0s"),
  JSON.stringify(seekTiming)
);
check("buffer-width-transitions", seekTiming.bufferProperty.includes("width") && seekTiming.bufferDuration !== "0s", JSON.stringify(seekTiming));

const seekJump = await page.evaluate(async () => {
  const input = document.querySelector("input.seek") as HTMLInputElement;
  const before = Number(input.value);
  const rect = input.getBoundingClientRect();
  input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: rect.left + rect.width * 0.8, clientY: rect.top + rect.height / 2 }));
  input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  // A real click through the range input is what the app listens to.
  input.value = String(Number(input.max) * 0.8);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise(done => setTimeout(done, 120));
  const progress = input.style.getPropertyValue("--progress");
  return { before, after: Number(input.value), progress, max: Number(input.max) };
});
check(
  "seek-responds-immediately",
  seekJump.after > 0 && Number.parseFloat(seekJump.progress) > 50,
  JSON.stringify(seekJump)
);

/* ------------------------------------------------------- 4. queue and menus */

await page.keyboard.press("q");
await wait(60);
const queueAnimation = await animationsFor(".queue-panel");
check(
  "queue-panel-slides-in",
  Boolean(queueAnimation?.some(animation => animation.name === "slide-in" && Number(animation.duration) === 240)),
  JSON.stringify(queueAnimation)
);
const heldQueue = await freezeAt(120);
await shot("03-queue-mid");
await resumeAll();
await wait(260);
await shot("03-queue-settled");
check("queue-mid-frame-differs", heldQueue.count > 0 && frameDelta("03-queue-mid", "03-queue-settled") > 0.002, `${heldQueue.count} held`);
await page.keyboard.press("q");
const queueExit = await waitForExit('[data-testid="queue-panel"]');
check(
  "queue-slides-out",
  Boolean(queueExit?.some(animation => animation.name === "slide-out" && Number(animation.duration) === 120)),
  JSON.stringify(queueExit)
);
check("queue-dismisses-after-exit", await waitForGone('[data-testid="queue-panel"]'), "panel unmounted after its 120ms exit");

// A quick double toggle must not leave a panel behind or a transition stuck.
await page.keyboard.press("q");
await wait(30);
await page.keyboard.press("q");
await wait(400);
check("queue-rapid-toggle-settles", !(await page.$('[data-testid="queue-panel"]')), "rapid open/close");

await page.evaluate(() => {
  const row = document.querySelector(".track-row") as HTMLElement;
  (row.querySelector('button[aria-label="More actions"]') as HTMLElement | null)?.click();
});
await page.waitForSelector(".context-menu", { timeout: 5000 });
const menuAnimation = await animationsFor(".context-menu");
check("context-menu-pops-in", Boolean(menuAnimation?.some(animation => animation.name === "pop-in" && Number(animation.duration) === 180)), JSON.stringify(menuAnimation));
await page.keyboard.press("Escape");
const menuExit = await waitForExit(".context-menu");
check(
  "context-menu-pops-out",
  Boolean(menuExit?.some(animation => animation.name === "pop-out" && Number(animation.duration) === 120)),
  JSON.stringify(menuExit)
);
check("context-menu-dismisses-after-exit", await waitForGone(".context-menu"), "menu unmounted after its 120ms exit");

await page.evaluate(() => {
  const row = document.querySelector(".track-row") as HTMLElement;
  (row.querySelector('button[aria-label="More actions"]') as HTMLElement | null)?.click();
});
await page.waitForSelector(".context-menu", { timeout: 5000 });
await clickText(".context-menu button", "Add to playlist…", false);
await page.waitForSelector(".modal", { timeout: 5000 });
const modalAnimation = await animationsFor(".modal");
const backdropAnimation = await animationsFor(".modal-backdrop");
check("modal-scales-in", Boolean(modalAnimation?.some(animation => animation.name === "modal-in")), JSON.stringify(modalAnimation));
check("modal-backdrop-fades", Boolean(backdropAnimation?.some(animation => animation.name === "fade-in")), JSON.stringify(backdropAnimation));
const heldModal = await freezeAt(90);
await shot("04-modal-mid");
await resumeAll();
await wait(260);
await shot("04-modal-settled");
check("modal-mid-frame-differs", heldModal.count > 0 && frameDelta("04-modal-mid", "04-modal-settled") > 0.0005, `${heldModal.count} held`);
await page.keyboard.press("Escape");
const backdropExit = await waitForExit(".modal-backdrop");
const modalExit = await animationsFor(".modal");
check(
  "modal-backdrop-fades-out",
  Boolean(backdropExit?.some(animation => animation.name === "fade-out" && Number(animation.duration) === 120)),
  JSON.stringify(backdropExit)
);
check(
  "modal-scales-out",
  Boolean(modalExit?.some(animation => animation.name === "modal-out" && Number(animation.duration) === 120)),
  JSON.stringify(modalExit)
);
await freezeAt(60);
await shot("04-modal-exit-mid");
await resumeAll();
check("modal-dismisses-after-exit", await waitForGone(".modal-backdrop"), "backdrop unmounted after its 120ms exit");
await shot("04-modal-exit-settled");
check(
  "modal-exit-mid-frame-differs",
  frameDelta("04-modal-exit-mid", "04-modal-exit-settled") > 0.0005,
  `${(frameDelta("04-modal-exit-mid", "04-modal-exit-settled") * 100).toFixed(2)}% changed`
);

/* --------------------------------------------------------- 5. fullscreen */

await page.evaluate(() => {
  document.querySelector<HTMLButtonElement>('.player-bar button[aria-label="Fullscreen lyrics"]')!.click();
});
const fsHeld = await freezeAt(120);
await shot("05-fullscreen-mid");
await resumeAll();
await wait(400);
await shot("05-fullscreen-settled");
const fsState = await page.evaluate(() => {
  const view = document.querySelector(".lyrics-view.is-fullscreen");
  return {
    present: Boolean(view),
    rect: view ? view.getBoundingClientRect().toJSON() : null,
    controls: Boolean(document.querySelector('[data-testid="fullscreen-controls"]')),
  };
});
check("fullscreen-enters-with-fade", fsHeld.names.includes("fs-in"), JSON.stringify(fsHeld));
check("fullscreen-covers-window", fsState.rect?.width === 1440 && fsState.rect?.height === 900, JSON.stringify(fsState.rect));
check("fullscreen-mid-frame-differs", fsHeld.count > 0 && frameDelta("05-fullscreen-mid", "05-fullscreen-settled") > 0.001, `${fsHeld.count} held, ${(frameDelta("05-fullscreen-mid", "05-fullscreen-settled") * 100).toFixed(2)}% changed`);

// Controls: visible while the pointer moves, concealed after it leaves, animated both ways.
const controlArea = await page.evaluate(() => {
  const rect = document.querySelector(".fs-controls")!.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), top: rect.top };
});
await page.mouse.move(720, 300);
await wait(60);
await page.mouse.move(controlArea.x, controlArea.y);
await wait(60);
await page.mouse.move(controlArea.x + 4, controlArea.y);
await wait(350);
const controlsVisible = await page.evaluate(() => {
  const controls = document.querySelector(".fs-controls");
  return controls ? { concealed: controls.classList.contains("is-concealed"), opacity: getComputedStyle(controls).opacity } : null;
});
await page.mouse.move(720, 120);
await wait(120);
await page.mouse.move(722, 118);
await wait(700);
const controlsHidden = await page.evaluate(() => {
  const controls = document.querySelector(".fs-controls");
  if (!controls) return null;
  const style = getComputedStyle(controls);
  return { concealed: controls.classList.contains("is-concealed"), opacity: style.opacity, visibility: style.visibility, transform: style.transform, transition: style.transitionProperty };
});
check("fs-controls-show-on-hover", controlsVisible?.concealed === false, JSON.stringify(controlsVisible));
check(
  "fs-controls-hide-on-leave",
  controlsHidden?.concealed === true && controlsHidden.opacity === "0" && controlsHidden.visibility === "hidden",
  JSON.stringify(controlsHidden)
);
check("fs-controls-fade-not-cut", controlsHidden?.transition.includes("opacity") === true, controlsHidden?.transition ?? "");
await page.mouse.move(controlArea.x, controlArea.y);
await wait(60);
await page.mouse.move(controlArea.x + 6, controlArea.y);
const controlsBack = await page
  .waitForFunction(() => getComputedStyle(document.querySelector(".fs-controls")!).opacity === "1", { timeout: 3000 })
  .then(() => "1")
  .catch(() => page.evaluate(() => getComputedStyle(document.querySelector(".fs-controls")!).opacity));
check("fs-controls-return", controlsBack === "1", `opacity ${controlsBack}`);

// Dock popovers share the presence language: pop-in on open, fast pop-out on close.
await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[title="Lyrics source"]')?.click());
await page.waitForSelector(".dock-popover.dock-sources", { timeout: 5000 });
const dockIn = await animationsFor(".dock-popover.dock-sources");
check(
  "dock-popover-pops-in",
  Boolean(dockIn?.some(animation => animation.name === "pop-in" && Number(animation.duration) === 180)),
  JSON.stringify(dockIn)
);
await wait(240);
await shot("05-dock-popover");
await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[title="Lyrics source"]')?.click());
const dockOut = await waitForExit(".dock-popover.dock-sources");
check(
  "dock-popover-pops-out",
  Boolean(dockOut?.some(animation => animation.name === "pop-out" && Number(animation.duration) === 120)),
  JSON.stringify(dockOut)
);
check("dock-popover-dismisses-after-exit", await waitForGone(".dock-popover.dock-sources"), "popover unmounted after its 120ms exit");

await page.keyboard.press("Escape");
await wait(120);
const exitState = await page.evaluate(() => ({
  fullscreen: Boolean(document.querySelector(".lyrics-view.is-fullscreen")),
  shell: document.querySelector(".player-bar")?.getAnimations().map(animation => (animation as CSSAnimation).animationName ?? "") ?? [],
  sidebar: Boolean(document.querySelector(".sidebar")),
}));
check("fullscreen-exits", !exitState.fullscreen, "left fullscreen");
check("shell-fades-back", exitState.shell.includes("chrome-in") && exitState.sidebar, JSON.stringify(exitState));
await wait(300);
await shot("05-fullscreen-exit-settled");

/* ------------------------------------------------------------- 6. toasts */

await sidebarItem("Settings");
await wait(300);
await clickText(".settings-tabs button", "About");
await wait(250);
// Polling can miss a 120ms exit window (and a screenshot can outlast the toast's lifetime in
// this harness), so record the exit with an in-page observer installed before it appears.
await page.evaluate(() => {
  const host = window as unknown as { __toastExit: unknown; __toastLog: string[] };
  host.__toastExit = null;
  host.__toastLog = [];
  const observer = new MutationObserver(() => {
    const toast = document.querySelector(".toast");
    if (toast) host.__toastLog.push(`${toast.getAttribute("data-testid")}:${toast.getAttribute("data-presence")}`);
    if (toast?.getAttribute("data-presence") === "exiting") {
      host.__toastExit = toast.getAnimations().map(animation => ({
        name: (animation as CSSAnimation).animationName ?? "",
        duration: animation.effect?.getTiming().duration ?? null,
      }));
      observer.disconnect();
    }
  });
  observer.observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ["data-presence"] });
});
await clickText("button", "Reset all");
await page.waitForSelector(".toast", { timeout: 5000 });
const toastState = await animationsFor(".toast");
check("toast-slides-in", Boolean(toastState?.some(animation => animation.name === "toast-in")), JSON.stringify(toastState));
await shot("06-toast");
const toastExit = await page
  .waitForFunction(() => (window as unknown as { __toastExit: unknown }).__toastExit, { timeout: 6000 })
  .then(handle => handle?.jsonValue() as Promise<{ name: string; duration: number | string | null }[] | null>)
  .catch(() => null);
const toastLog = await page.evaluate(() => (window as unknown as { __toastLog: string[] }).__toastLog.slice(-12).join(" ; "));
check(
  "toast-fades-out",
  Boolean(toastExit?.some(animation => animation.name === "toast-out" && Number(animation.duration) === 120)),
  `${JSON.stringify(toastExit)} | ${toastLog}`
);
check("toast-dismisses-on-its-own", await waitForGone(".toast"), "toast removed after its lifetime + exit");

/* --------------------------------------------------- 7. rapid interaction */

const rapid = await page.evaluate(async () => {
  const buttons = [...document.querySelectorAll(".nav .nav-item")] as HTMLButtonElement[];
  const order = ["Songs", "Albums", "Artists", "Playlists", "Liked songs", "Home", "Songs", "Albums", "Home", "Songs", "Artists", "Home"];
  for (const label of order) {
    buttons.find(button => button.title === label)!.click();
    await new Promise(done => setTimeout(done, 45));
  }
  return order.at(-1)!;
});
await wait(500);
const rapidState = await page.evaluate(() => {
  const active = [...document.querySelectorAll(".nav .nav-item.active")];
  const pill = document.querySelector(".nav-pill")!.getBoundingClientRect();
  const home = ([...document.querySelectorAll(".nav .nav-item")] as HTMLButtonElement[]).find(button => button.title === "Home")!.getBoundingClientRect();
  return {
    views: document.querySelectorAll(".view").length,
    activeCount: active.length,
    activeTitle: active[0]?.getAttribute("title") ?? null,
    pillAligned: Math.abs(pill.top - home.top) < 1,
    overlays: document.querySelectorAll(".modal-backdrop, .context-menu").length,
  };
});
check("rapid-nav-single-view", rapidState.views === 1 && rapidState.activeCount === 1, JSON.stringify(rapidState));
check("rapid-nav-pill-not-stuck", rapidState.pillAligned && rapidState.activeTitle === rapid, JSON.stringify(rapidState));
check("rapid-nav-no-stuck-overlays", rapidState.overlays === 0, `${rapidState.overlays} overlays`);

/* ------------------------------------------------------- 8. layout stability */

const geometry = await page.evaluate(() => {
  const player = document.querySelector(".player-bar")!.getBoundingClientRect();
  const content = document.querySelector(".content-scroll")!.getBoundingClientRect();
  return { playerHeight: Math.round(player.height), contentHeight: Math.round(content.height), contentTop: Math.round(content.top) };
});
check("layout-stable", geometry.playerHeight === 92 && geometry.contentHeight === 740, JSON.stringify(geometry));
await shot("07-after-rapid-nav");

await navItem("Albums");
await wait(420);
await shot("08-albums-grid");
await navItem("Home");
await wait(280);

/* ------------------------------------------------------- 9. reduced motion */

await sidebarItem("Settings");
await wait(300);
await clickText(".settings-tabs button", "Appearance");
await wait(250);
const toggleReduceMotion = () =>
  page.evaluate(() => {
    const label = [...document.querySelectorAll(".setting-row")].find(row => row.textContent?.includes("Reduce motion"));
    (label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.click();
  });
await toggleReduceMotion();
await wait(300);
const reducedSetting = await page.evaluate(() => ({
  flag: document.documentElement.dataset.reduceMotion,
  navDuration: getComputedStyle(document.querySelector(".nav-item")!).transitionDuration,
  viewAnimation: getComputedStyle(document.querySelector(".view")!).animationDuration,
  collapsed: ["0.001ms", "1e-06s", "0.000001s"].includes(getComputedStyle(document.querySelector(".nav-item")!).transitionDuration),
}));
check("setting-collapses-motion", reducedSetting.flag === "true" && reducedSetting.collapsed, JSON.stringify(reducedSetting));

await toggleReduceMotion();
await wait(300);

// Compact sidebar: the explicit toggle must interpolate the column width (not swap it), labels
// fade/collapse instead of popping, hover/focus expansion overlays without moving the content,
// and the pill follows through all of it.
const toggleCompact = () =>
  page.evaluate(() => {
    const label = [...document.querySelectorAll(".setting-row")].find(row => row.textContent?.includes("Compact sidebar"));
    (label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.click();
  });
await page.mouse.move(900, 300);
const compactWidthSamples = await page.evaluate(async () => {
  const sidebar = document.querySelector(".sidebar")!;
  const label = [...document.querySelectorAll(".setting-row")].find(row => row.textContent?.includes("Compact sidebar"));
  (label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.click();
  const samples: number[] = [];
  const start = performance.now();
  await new Promise<void>(done => {
    const tick = () => {
      samples.push(Math.round(sidebar.getBoundingClientRect().width));
      if (performance.now() - start < 460) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  return samples;
});
const distinctCompactWidths = new Set(compactWidthSamples).size;
check(
  "compact-sidebar-width-animates",
  distinctCompactWidths >= 4 && compactWidthSamples[0] > 200 && compactWidthSamples.at(-1) === 76,
  `${distinctCompactWidths} distinct widths, ${compactWidthSamples[0]} -> ${compactWidthSamples.at(-1)}`
);
await navItem("Songs");
await wait(340);
const compactPill = await page.evaluate(() => {
  const pill = document.querySelector(".nav-pill")!.getBoundingClientRect();
  const active = document.querySelector(".nav .nav-item.active")!.getBoundingClientRect();
  return { deltaTop: Math.abs(pill.top - active.top), deltaHeight: Math.abs(pill.height - active.height), compact: document.documentElement.dataset.compactSidebar };
});
await page.mouse.move(900, 300);
await wait(460);
await shot("09-compact-sidebar");

const sidebarProbe = () =>
  page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar")!.getBoundingClientRect();
    const main = document.querySelector(".app-main")!.getBoundingClientRect();
    const label = document.querySelector(".nav .nav-item.active span")!;
    const labelStyle = getComputedStyle(label);
    const pill = document.querySelector(".nav-pill")!.getBoundingClientRect();
    const active = document.querySelector(".nav .nav-item.active")!.getBoundingClientRect();
    return {
      sidebarWidth: Math.round(sidebar.width),
      mainLeft: Math.round(main.left),
      labelOpacity: labelStyle.opacity,
      labelVisibility: labelStyle.visibility,
      pillAligned: Math.abs(pill.top - active.top) < 1 && Math.abs(pill.height - active.height) < 1,
    };
  });
await page.mouse.move(900, 300);
await wait(460);
const beforeHover = await sidebarProbe();
await page.mouse.move(38, 300);
await wait(560);
await shot("09-compact-hover-expanded");
const hoverState = await sidebarProbe();
check(
  "compact-hover-expands-overlay",
  beforeHover.sidebarWidth === 76 &&
    hoverState.sidebarWidth === 248 &&
    hoverState.mainLeft === beforeHover.mainLeft &&
    hoverState.labelOpacity === "1" &&
    hoverState.labelVisibility === "visible" &&
    hoverState.pillAligned,
  JSON.stringify({ beforeHover, hoverState })
);
await page.mouse.move(900, 300);
await wait(460);
const afterHover = await sidebarProbe();
check(
  "compact-hover-collapses",
  afterHover.sidebarWidth === 76 && afterHover.labelOpacity === "0" && afterHover.labelVisibility === "hidden",
  JSON.stringify(afterHover)
);
await page.keyboard.press("Tab");
await wait(560);
const focusState = await sidebarProbe();
check("compact-focus-expands-overlay", focusState.sidebarWidth === 248 && focusState.mainLeft === beforeHover.mainLeft, JSON.stringify(focusState));
await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
await wait(460);

await sidebarItem("Settings");
await wait(320);
await toggleCompact();
await wait(400);
check("compact-sidebar-pill-aligns", compactPill.compact === "true" && compactPill.deltaTop < 1 && compactPill.deltaHeight < 1, JSON.stringify(compactPill));

// The OS preference, with the in-app toggle off: the app must obey it anyway.
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await page.reload({ waitUntil: "networkidle2" });
await waitForApp();
const osReduced = await page.evaluate(() => ({
  flag: document.documentElement.dataset.reduceMotion,
  media: matchMedia("(prefers-reduced-motion: reduce)").matches,
  navDuration: getComputedStyle(document.querySelector(".nav-item")!).transitionDuration,
  viewAnimation: getComputedStyle(document.querySelector(".view")!).animationDuration,
  collapsed:
    ["0.001ms", "1e-06s", "0.000001s"].includes(getComputedStyle(document.querySelector(".nav-item")!).transitionDuration) &&
    ["0.001ms", "1e-06s", "0.000001s"].includes(getComputedStyle(document.querySelector(".view")!).animationDuration),
}));
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll(".nav .nav-item")] as HTMLButtonElement[];
  buttons.find(button => button.title === "Albums")!.click();
});
await wait(100);
const osReducedRunning = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running").length);
check(
  "os-reduced-motion-honoured",
  osReduced.media && osReduced.flag === "false" && osReduced.collapsed && osReducedRunning === 0,
  JSON.stringify({ ...osReduced, running: osReducedRunning })
);

await page.emulateMediaFeatures([]);
await page.reload({ waitUntil: "networkidle2" });
await waitForApp();
await wait(200);
const restoredMotion = await page.evaluate(() => getComputedStyle(document.querySelector(".nav-item")!).transitionDuration);
if (restoredMotion === "0.001ms") throw new Error("reduced motion did not clear");
check("motion-restored-after-preference", restoredMotion !== "0.001ms", restoredMotion);

/* ------------------------------------------------------------------ summary */

const failed = Object.entries(results).filter(([, result]) => !result.value);
writeFileSync(
  join(shotDir, "summary.json"),
  JSON.stringify({ checks: Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result])), failed: failed.map(([name]) => name), console: logs }, null, 2)
);
console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} checks passed`);
if (failed.length) console.log(`failed: ${failed.map(([name]) => name).join(", ")}`);

await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
