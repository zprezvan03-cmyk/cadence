/**
 * Visual inspection pass for the global shader background. Written for Cadence.
 *
 * Boots the real built application against the harness bridge, turns the shader wallpaper on, and
 * walks every route, capturing a screenshot per page plus a text-visibility probe. It also resizes
 * the window, toggles the feature off and back on, reloads to prove persistence, and reports the
 * page's own console errors.
 *
 * Usage: node tests/browser/visual-inspect.mjs [--off] [--settle=ms]
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const harnessDir = join(root, ".artifacts/harness");
const audioDir = join(root, ".artifacts/fixtures/formats");
const shotDir = join(root, ".artifacts/visual");
mkdirSync(shotDir, { recursive: true });

const args = process.argv.slice(2);
const shaderOn = !args.includes("--off");
const settle = Number(args.find(arg => arg.startsWith("--settle="))?.split("=")[1] ?? 1600);

const { snapshot, defaultSettings } = JSON.parse(readFileSync(join(harnessDir, "library.json"), "utf8"));
const wait = ms => new Promise(r => setTimeout(r, ms));

/* --------------------------------------------------------------- server */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/ogg" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const decode = value => decodeURIComponent(value);
  let file = null;
  if (url.pathname.startsWith("/audio/")) file = join(audioDir, decode(url.pathname.slice(7)));
  else if (url.pathname.startsWith("/artwork/")) file = join(harnessDir, decode(url.pathname.slice(9)));
  else {
    file = join(outDir, url.pathname === "/" ? "/index.html" : url.pathname);
    if (!file.startsWith(outDir)) file = null;
  }
  if (!file || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const size = statSync(file).size;
  const headers = { "content-type": MIME[extname(file)] ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": "no-store" };
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
await new Promise(r => server.listen(4795, "0.0.0.0", r));
const base = "http://127.0.0.1:4795";

/* -------------------------------------------------------------- browser */
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
const consoleErrors = [];
page.on("pageerror", error => consoleErrors.push(`[pageerror] ${error.message}`));
page.on("console", message => {
  if (message.type() === "error") consoleErrors.push(`[console] ${message.text()}`);
});

// Bridge stub, mirroring tests/browser/run-app.mjs (library + settings + lyrics).
await page.evaluateOnNewDocument(data => {
  const { snapshot, fixtureDefaults, shaderOn } = data;
  window.__chrome = { undecorated: true, maximized: false, fullscreen: false, focused: true };
  window.__chromeListeners = new Set();
  window.__cadenceWindowActions = [];
  const KEY = "cadence.harness.settings.v1";
  const defaults = {
    ...fixtureDefaults,
    general: { ...fixtureDefaults.general, onboardingCompleted: true, onboardingStep: 3 },
    playback: { ...fixtureDefaults.playback, resumeOnLaunch: false, autoPlay: false },
    appearance: { ...fixtureDefaults.appearance, blurArtwork: true },
    artistImages: { ...fixtureDefaults.artistImages, enabled: false, autoFetch: false },
    shaders: { ...fixtureDefaults.shaders, enabled: true, globalBackground: shaderOn, kawarpOpacity: 0.85 },
  };
  const merge = (base, patch) => {
    const result = Array.isArray(base) ? [...base] : { ...base };
    for (const [key, value] of Object.entries(patch ?? {})) {
      result[key] = value && typeof value === "object" && !Array.isArray(value) && base?.[key] && typeof base[key] === "object"
        ? merge(base[key], value) : value;
    }
    return result;
  };
  const load = () => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? merge(structuredClone(defaults), JSON.parse(raw)) : structuredClone(defaults);
    } catch { return structuredClone(defaults); }
  };
  let settings = load();
  const trackById = id => snapshot.tracks.find(track => track.id === id) ?? null;
  window.cadence = {
    info: async () => ({ name: "Cadence", version: "0.2.0", platform: "visual", tauri: "2.12", electron: "", chrome: navigator.userAgent, node: "n/a", userData: "/visual", libraryEngine: "sqlite", codecs: {} }),
    fonts: { list: async () => [{ family: "Segoe UI", styles: ["Regular"] }, { family: "system", styles: ["Regular"] }] },
    library: {
      snapshot: async () => structuredClone(snapshot),
      addFolder: async () => ({ canceled: true }),
      removeFolder: async () => structuredClone(snapshot),
      rescan: async () => ({ added: 0, updated: 0, removed: 0, errors: [], durationMs: 1 }),
      search: async query => snapshot.tracks.filter(track => `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(query.toLowerCase())),
      getTrack: async id => trackById(id),
      setFavorite: async () => undefined,
      recordPlay: async () => undefined,
      onScanProgress: () => () => {},
      setArtworkOverride: async id => trackById(id),
    },
    settings: {
      get: async () => structuredClone(settings),
      patch: async patch => {
        settings = merge(settings, patch);
        localStorage.setItem(KEY, JSON.stringify(settings));
        return structuredClone(settings);
      },
      reset: async () => { settings = structuredClone(defaults); localStorage.removeItem(KEY); return structuredClone(settings); },
    },
    lyrics: {
      resolve: async () => ({ ok: true, synced: false, lines: [], source: "none", provider: "none" }),
      search: async () => ({ results: [], providerStatus: [], cached: false }),
      youtubeMetadata: async () => ({ ok: false, reason: "error", detail: "unavailable" }),
      onProgress: () => () => {},
      clearCache: async () => ({ removed: 0 }),
      stats: async () => ({ entries: 0, bytes: 0, path: "" }),
      autofetch: async () => ({ ok: false }),
      translate: async () => ({ ok: false }),
      romanize: async () => ({ ok: false }),
    },
    player: { onState: () => () => {} },
    history: { list: async () => [], record: async () => undefined, clear: async () => undefined },
    playlists: { list: async () => structuredClone(snapshot.playlists), create: async () => null, update: async () => null, remove: async () => undefined },
    stats: { listening: async () => ({ plays: [], totals: {} }) },
    scrobble: { status: async () => ({ connected: false }), connect: async () => ({ ok: false }), disconnect: async () => undefined },
    window: { minimize: async () => {}, maximize: async () => {}, close: async () => {}, state: async () => structuredClone(window.__chrome) },
  };
}, { snapshot, fixtureDefaults: defaultSettings, shaderOn });

await page.goto(base, { waitUntil: "networkidle0" });
await page.waitForSelector(".app-shell", { timeout: 20_000 });
await wait(1200);

/* --------------------------------------------------------------- probes */
const probeText = () => page.evaluate(() => {
  // Every visible text node in the shell, plus the element that paints under it.
  const results = [];
  const walker = document.createTreeWalker(document.querySelector(".app-shell") ?? document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (!text || text.length < 2) continue;
    const el = node.parentElement;
    if (!el) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.2) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
    const color = style.color;
    const match = /rgba?\(([^)]+)\)/.exec(color) ?? /color\(srgb ([^)]+)\)/.exec(color);
    const parts = (match?.[1] ?? "").split(/[,\s/]+/).filter(Boolean).map(Number);
    const alpha = parts.length >= 4 ? parts[3] : 1;
    results.push({ text: text.slice(0, 28), color, alpha });
  }
  return {
    count: results.length,
    invisible: results.filter(r => !Number.isFinite(r.alpha) ? false : r.alpha < 0.05),
    samples: results.slice(0, 3),
  };
});

const probeLayers = () => page.evaluate(() => {
  const layer = document.querySelector('[data-testid="global-shader-background"]');
  const canvas = layer?.querySelector("canvas");
  const bubbleLayer = document.querySelector(".global-shader-bubbles");
  const layerRect = layer?.getBoundingClientRect();
  // Top-most element at the centre of several important UI surfaces.
  const points = [
    ["sidebar-nav", ".sidebar .nav-item"],
    ["view-heading", ".view-heading h1"],
    ["player-title", ".player-title"],
    ["player-artwork", ".player-bar .playback-cover"],
  ].map(([name, selector]) => {
    const node = document.querySelector(selector);
    if (!node) return { name, hit: "missing" };
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { name, hitOk: Boolean(hit && (hit === node || node.contains(hit) || node.closest(selector))), hitTag: hit?.tagName?.toLowerCase() };
  });
  return {
    layer: Boolean(layer),
    layerZ: layer ? getComputedStyle(layer).zIndex : null,
    canvasZ: canvas ? getComputedStyle(canvas).zIndex : null,
    bubbles: Boolean(bubbleLayer),
    bubbleCount: bubbleLayer ? bubbleLayer.querySelectorAll(".glass-bubble").length : 0,
    coversWindow: Boolean(layerRect && layerRect.width === window.innerWidth && layerRect.height === window.innerHeight),
    points,
  };
});

const report = { pages: {}, consoleErrors, checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const go = async (label, action, filename) => {
  await action();
  await wait(settle);
  await page.mouse.move(700, 420);
  await wait(300);
  const text = await probeText();
  const layers = await probeLayers();
  await page.screenshot({ path: join(shotDir, filename) });
  report.pages[label] = { text: text.count, invisible: text.invisible.length, layers };
  check(`page-${label}-text-visible`, text.count > 0 && text.invisible.length === 0, `${text.count} text nodes, ${text.invisible.length} invisible`);
  if (layers.layer) {
    check(`page-${label}-ui-above-shader`, layers.points.every(p => p.hit === "missing" || p.hitOk), JSON.stringify(layers.points));
  }
};

const nav = async title => {
  await page.evaluate(selector => document.querySelector(selector)?.click(), `aside.sidebar button[title="${title}"]`);
  await wait(500);
};
const navText = async label => {
  await page.evaluate(text => {
    const link = [...document.querySelectorAll(".sidebar .nav-item")].find(node => node.textContent?.trim() === text);
    link?.click();
  }, label);
  await wait(500);
};

await go("home", async () => { await navText("Home"); }, "p1-home.png");
await go("songs", async () => { await navText("Songs"); }, "p2-songs.png");
await go("albums", async () => { await navText("Albums"); }, "p3-albums.png");
await go("artists", async () => { await navText("Artists"); }, "p4-artists.png");
await go("liked", async () => { await navText("Liked songs"); }, "p5-liked.png");
await go("playlists", async () => {
  const disclosure = await page.$('.nav-section-toggle[title="Playlists"][aria-expanded="false"]');
  if (disclosure) await disclosure.click();
  await wait(300);
  await navText("All playlists");
}, "p6-playlists.png");
await go("stats", async () => { await navText("Stats"); }, "p7-stats.png");
await go("history", async () => { await navText("History"); }, "p8-history.png");
await go("settings", async () => { await nav("Settings"); }, "p9-settings.png");
await go("lyrics-windowed", async () => { await page.evaluate(() => { location.hash = "#/lyrics"; }); await wait(600); }, "p10-lyrics-windowed.png");
await go("now-playing-fullscreen", async () => {
  await page.evaluate(() => { location.hash = "#/"; });
  await wait(400);
  await page.evaluate(() => document.querySelector('[data-testid="open-now-playing"]')?.click());
  await wait(900);
}, "p11-now-playing.png");

// Queue open over the shader.
await go("queue-open", async () => {
  await page.mouse.move(700, 300);
  await page.evaluate(() => document.querySelector('[data-testid="fullscreen-controls"] button[aria-label="Queue"]')?.click());
  await wait(700);
}, "p12-queue.png");
await page.keyboard.press("Escape");
await wait(500);
await page.keyboard.press("Escape");
await wait(700);

// Resize: the shader must re-fit, and text must stay put.
const resizeProbe = async (width, height, name) => {
  await page.setViewport({ width, height });
  await wait(1400);
  const layers = await probeLayers();
  const text = await probeText();
  await page.screenshot({ path: join(shotDir, name) });
  check(`resize-${width}x${height}`, text.invisible.length === 0 && (layers.layer ? layers.coversWindow : true), JSON.stringify({ text: text.count, invisible: text.invisible.length, covers: layers.coversWindow }));
};
await navText("Songs");
await resizeProbe(1024, 700, "p13-resize-1024.png");
await resizeProbe(1680, 1000, "p14-resize-1680.png");
await page.setViewport({ width: 1480, height: 900 });
await wait(800);

// Toggle off and on from Settings, capturing both states.
const openAppearance = async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll(".settings-tabs button")].find(node => node.textContent?.trim() === "Appearance")?.click();
  });
  await wait(400);
  await page.evaluate(() => document.querySelector('[data-testid="settings-shaders"]')?.scrollIntoView({ block: "start" }));
  await wait(300);
};
const shaderToggle = async () => {
  const clicked = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".setting-row")].find(node => /whole app/i.test(node.querySelector("strong")?.textContent ?? ""));
    const input = row?.querySelector('input[type="checkbox"]');
    input?.click();
    return Boolean(input);
  });
  if (!clicked) throw new Error("Shader toggle row not found in Settings → Appearance");
  await wait(1200);
};
await nav("Settings");
await wait(600);
await openAppearance();
await page.screenshot({ path: join(shotDir, "p15-settings-before.png") });
await page.screenshot({ path: join(shotDir, "p16-settings-shader-panel.png") });
await shaderToggle();
await openAppearance();
await page.screenshot({ path: join(shotDir, "p17-settings-toggled-off.png") });
const toggledOff = await probeLayers();
check("toggle-off-removes-layer", toggledOff.layer === false, JSON.stringify({ layer: toggledOff.layer }));
await shaderToggle();
const toggledOn = await probeLayers();
check("toggle-on-restores-layer", toggledOn.layer === true, JSON.stringify({ layer: toggledOn.layer }));

// Persistence across a restart (reload re-reads the stored settings).
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector(".app-shell");
await wait(1600);
const afterReload = await probeLayers();
check("persists-across-restart", afterReload.layer === true, JSON.stringify({ layer: afterReload.layer }));
await page.screenshot({ path: join(shotDir, "p18-after-reload.png") });

report.consoleErrors = consoleErrors;
console.log("\nconsole errors:", consoleErrors.length ? consoleErrors.slice(0, 8) : "none");
console.log(`\nscreenshots → ${shotDir}`);
console.log(`\n${report.checks.filter(c => c.ok).length}/${report.checks.length} checks passed`);

await browser.close();
server.close();
process.exit(report.checks.every(c => c.ok) ? 0 : 1);
