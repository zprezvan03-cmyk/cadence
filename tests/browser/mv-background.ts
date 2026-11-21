/**
 * Music-video background browser harness.
 *
 * Boots the production renderer with `?harness=1`, generates a real WebM clip in the page with
 * MediaRecorder, and drives the fullscreen Now Playing background through the real settings store
 * and audio engine. Usage: npm run build:web && npx vite-node tests/browser/mv-background.ts
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";

declare global {
  interface Window {
    __cadenceHarness?: {
      patchMvSettings: (patch: Record<string, unknown>) => Promise<unknown>;
      mountLyricsView: (options: Record<string, unknown>) => void;
      setMvFile: (url: string | null) => void;
      seekLyricsPreview: (seconds: number) => Promise<{ position: number }>;
      audioEngine: { element: HTMLAudioElement };
    };
  }
}

const root = resolve(import.meta.dirname, "../..");
const dist = join(root, "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("Run: npm run build:web");

const fixtureDir = join(root, ".artifacts/fixtures");
mkdirSync(fixtureDir, { recursive: true });
const wavPath = join(fixtureDir, "harness-tone.wav");
if (!existsSync(wavPath)) {
  const rate = 44_100;
  const frames = rate * 12;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 320 * i) / rate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(wavPath, Buffer.concat([header, data]));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (/^\/audio\/.+\.wav$/.test(url.pathname)) {
    res.writeHead(200, { "content-type": "audio/wav", "accept-ranges": "bytes" });
    createReadStream(wavPath).pipe(res);
    return;
  }
  if (/^\/audio\/.+\.mp4$/.test(url.pathname)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = join(dist, name);
  if (!file.startsWith(dist) || !existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No test server address");
const baseUrl = `http://127.0.0.1:${address.port}`;

await inflate(join(root, "node_modules/@sparticuz/chromium/bin/al2023.tar.br"));
setupLambdaEnvironment(join(tmpdir(), "al2023", "lib"));
chromium.setGraphicsMode = true;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  args: [...chromium.args, "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader"],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 120_000,
});

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

try {
  const page = await browser.newPage();
  page.on("pageerror", error => console.log(`[pageerror] ${(error as Error).message}`));
  await page.goto(`${baseUrl}/?harness=1`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => Boolean(window.__cadenceHarness), { timeout: 30_000 });

  const mount = (playing: boolean, mvUrl?: string | null, scrimOpacity = 0.45) =>
    page.evaluate(
      async (options) => {
        const h = window.__cadenceHarness!;
        await h.patchMvSettings({ enabled: Boolean(options.mvUrl), scrimOpacity: options.scrimOpacity });
        h.mountLyricsView({
          track: { id: 1, title: "MV fixture", duration: 12, mvUrl: options.mvUrl ?? null },
          playing: options.playing,
          fullscreen: true,
        });
        await new Promise(resolve => setTimeout(resolve, 250));
      },
      { playing, mvUrl, scrimOpacity }
    );

  await mount(false, null);
  const defaultState = await page.evaluate(() => ({
    layers: document.querySelectorAll(".np-mv-bg").length,
    videos: document.querySelectorAll("video").length,
  }));
  check("mv-default-off-has-no-extra-video", defaultState.layers === 0 && defaultState.videos === 0, JSON.stringify(defaultState));

  const videoUrl = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(5);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise<void>(resolve => {
      recorder.onstop = () => resolve();
    });
    recorder.start();
    context.fillStyle = "#ff0044";
    context.fillRect(0, 0, 64, 64);
    await new Promise(resolve => setTimeout(resolve, 900));
    recorder.stop();
    await stopped;
    const url = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
    // MediaRecorder WebM often has no duration in its header. Seeking past the end makes Chromium
    // resolve a finite duration, which the loop-sync assertion needs.
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.src = url;
    await new Promise<void>(resolve => {
      probe.onloadedmetadata = () => resolve();
      setTimeout(() => resolve(), 1500);
    });
    if (!Number.isFinite(probe.duration)) {
      probe.currentTime = 1e10;
      await new Promise<void>(resolve => {
        probe.ontimeupdate = () => {
          if (Number.isFinite(probe.duration)) resolve();
        };
        setTimeout(() => resolve(), 1500);
      });
    }
    return url;
  });
  check("mv-recorder-produced-clip", videoUrl.startsWith("blob:"));

  const directLyricsButton = await page.evaluate(() =>
    Boolean(document.querySelector('button[title="Open a lyrics file"]'))
  );
  check("mv-dock-file-menu-keeps-direct-lyrics-button", directLyricsButton);

  await page.evaluate(url => window.__cadenceHarness!.setMvFile(url), videoUrl);
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="dock-file-menu-button"]')?.click());
  await page.waitForSelector('[data-testid="dock-file-menu"]', { timeout: 5000 });
  const menu = await page.evaluate(() => ({
    lyrics: Boolean(document.querySelector('[data-testid="dock-choose-lyrics"]')),
    mv: Boolean(document.querySelector('[data-testid="dock-choose-mv"]')),
  }));
  check("mv-dock-file-menu-offers-lyrics-and-mv", menu.lyrics && menu.mv, JSON.stringify(menu));
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="dock-choose-mv"]')?.click());
  await wait(300);
  const dockPick = await page.evaluate(async () => {
    const settings = await window.cadence!.settings.get();
    return {
      enabled: settings.mvBackground.enabled,
      binding: settings.mvBackground.bindings["local:1"],
      layer: Boolean(document.querySelector(".np-mv-bg")),
    };
  });
  check(
    "mv-dock-file-menu-binds-video",
    dockPick.enabled && dockPick.binding === videoUrl && dockPick.layer,
    JSON.stringify({ ...dockPick, binding: dockPick.binding === videoUrl ? videoUrl : dockPick.binding })
  );

  await page.evaluate(url => window.__cadenceHarness!.setMvFile(url), videoUrl);
  await page.evaluate(
    url => window.__cadenceHarness!.patchMvSettings({ bindings: { "local:1": url }, enabled: true }),
    videoUrl
  );
  await mount(true, videoUrl, 0.3);
  const layer = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>(".np-mv-video");
    const scrim = document.querySelector<HTMLElement>(".np-mv-scrim");
    return {
      container: Boolean(document.querySelector(".lyrics-view.is-fullscreen .np-bg.np-mv-bg")),
      muted: video?.muted ?? false,
      volume: video?.volume ?? -1,
      controls: video?.controls ?? true,
      pointerEvents: video ? getComputedStyle(video).pointerEvents : "",
      filter: video ? getComputedStyle(video).filter : "",
      scrimOpacity: scrim ? Number(getComputedStyle(scrim).opacity) : -1,
      videos: document.querySelectorAll("video").length,
    };
  });
  check("mv-layer-renders-behind-ui", layer.container && layer.videos === 1, JSON.stringify(layer));
  check("mv-video-is-muted-and-inert", layer.muted && layer.volume === 0 && !layer.controls && layer.pointerEvents === "none", JSON.stringify(layer));
  check("mv-video-is-unblurred", layer.filter === "none", layer.filter);
  check("mv-scrim-uses-setting", Math.abs(layer.scrimOpacity - 0.3) < 0.02, String(layer.scrimOpacity));

  await wait(500);
  const seeked = await page.evaluate(async () => {
    const h = window.__cadenceHarness!;
    const probe = await h.seekLyricsPreview(4);
    const audio = h.audioEngine.element;
    audio.dispatchEvent(new Event("seeked"));
    await new Promise(resolve => setTimeout(resolve, 300));
    const video = document.querySelector<HTMLVideoElement>(".np-mv-video")!;
    return { audio: probe.position, duration: video.duration, video: video.currentTime };
  });
  const shortVideoLoop = seeked.duration > 0 && seeked.duration < 12;
  const expectedShort = seeked.audio % seeked.duration;
  check(
    "mv-short-video-loops-with-audio",
    shortVideoLoop && Math.abs(seeked.video - expectedShort) < 0.4,
    JSON.stringify(seeked)
  );

  const paused = await page.evaluate(async url => {
    const h = window.__cadenceHarness!;
    h.mountLyricsView({
      track: { id: 1, title: "MV fixture", duration: 12, mvUrl: url },
      playing: false,
      fullscreen: true,
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    return document.querySelector<HTMLVideoElement>(".np-mv-video")?.paused ?? null;
  }, videoUrl);
  check("mv-pauses-with-audio", paused === true, String(paused));

  await page.evaluate(url => {
    window.__cadenceHarness!.mountLyricsView({
      track: { id: 1, title: "MV fixture", duration: 12, mvUrl: url },
      playing: true,
      fullscreen: true,
    });
  }, videoUrl);
  await wait(400);
  const resumed = await page.evaluate(() => document.querySelector<HTMLVideoElement>(".np-mv-video")?.paused ?? null);
  check("mv-resumes-with-audio", resumed === false, String(resumed));

  const toggle = await page.evaluate(async () => {
    const before = await window.cadence!.app.chooseMvFile(1);
    const button = document.querySelector<HTMLButtonElement>('[data-testid="now-playing-mv-button"]');
    const pressedBefore = button?.getAttribute("aria-pressed");
    button?.click();
    await new Promise(resolve => setTimeout(resolve, 250));
    const after = document.querySelector<HTMLButtonElement>('[data-testid="now-playing-mv-button"]');
    const settings = await window.cadence!.settings.get();
    return { before: before.canceled, pressedBefore, pressedAfter: after?.getAttribute("aria-pressed"), enabled: settings.mvBackground.enabled };
  });
  check("mv-dock-toggle-syncs-settings", toggle.pressedAfter !== toggle.pressedBefore && toggle.enabled === false, JSON.stringify(toggle));

  await page.evaluate(async () => {
    await window.__cadenceHarness!.patchMvSettings({ enabled: true, bindings: { "local:1": "/audio/broken.mp4" } });
    window.__cadenceHarness!.mountLyricsView({
      track: { id: 1, title: "MV fixture", duration: 12, mvUrl: "/audio/broken.mp4" },
      playing: true,
      fullscreen: true,
    });
  });
  await wait(700);
  const fallback = await page.evaluate(() => ({
    mvLayer: document.querySelectorAll(".np-mv-bg").length,
    regularBackground: document.querySelectorAll(".lyrics-view.is-fullscreen .np-bg").length,
    toast: document.querySelector('[data-testid="toast"]')?.textContent ?? "",
  }));
  check("mv-broken-url-falls-back-with-toast", fallback.mvLayer === 0 && fallback.regularBackground > 0 && fallback.toast.includes("Music video unavailable"), JSON.stringify(fallback));

  await page.evaluate(url => {
    window.__cadenceHarness!.patchMvSettings({ enabled: true, bindings: { "local:1": url } });
    window.__cadenceHarness!.mountLyricsView({
      track: { id: 1, title: "MV fixture", duration: 12, mvUrl: url },
      playing: true,
      fullscreen: true,
    });
  }, videoUrl);
  await wait(300);
  const handoff = await page.evaluate(() => {
    const node = document.querySelector(".lyrics-view.is-fullscreen :is(.kawarp-bg, .np-bg)");
    return { hasSelector: Boolean(node), classes: node?.className ?? "" };
  });
  check("mv-keeps-background-handoff-selector", handoff.hasSelector && handoff.classes.includes("np-bg"), JSON.stringify(handoff));
} finally {
  await browser.close();
  server.close();
}

if (failures.length > 0) {
  console.error(`\nFailed MV background checks: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\nAll MV background checks passed.");
}
