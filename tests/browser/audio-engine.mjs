/**
 * Stage 5 audio-engine browser harness.
 *
 * Runs the real built renderer in harness mode and drives the production AudioEngine through
 * dual-deck preloads, an overlapping crossfade, a fade-free gapless cut, EQ/ReplayGain graph
 * changes, and a Braccato source rebind. The two WAV fixtures are generated here so track
 * identity is based on distinct URLs while the audible content stays deterministic.
 *
 * Usage: npm run build:web && node tests/browser/audio-engine.mjs
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const fixtureDir = join(root, ".artifacts/fixtures");
const artifactDir = join(root, ".artifacts/audio-engine");
mkdirSync(fixtureDir, { recursive: true });
mkdirSync(artifactDir, { recursive: true });

if (!existsSync(join(outDir, "index.html"))) throw new Error("Run: npm run build:web");

function makeWav(seconds, freq, sampleRate = 44100) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 9000);
    data.writeInt16LE(value, i * 4);
    data.writeInt16LE(value, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const wavA = join(fixtureDir, "stage5-tone-a.wav");
const wavB = join(fixtureDir, "stage5-tone-b.wav");
writeFileSync(wavA, makeWav(8, 320));
writeFileSync(wavB, makeWav(8, 440));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const fixtures = {
    "/fixture/tone-a.wav": wavA,
    "/fixture/tone-b.wav": wavB,
    "/audio/tone.wav": wavA,
  };
  const fixture = fixtures[url.pathname];
  if (fixture) {
    const size = statSync(fixture).size;
    const headers = {
      "content-type": "audio/wav",
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
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
      createReadStream(fixture, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, "content-length": size });
      createReadStream(fixture).pipe(res);
    }
    return;
  }

  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(outDir, path);
  if (!file.startsWith(outDir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

await new Promise(done => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

await inflate(join(root, "node_modules/@sparticuz/chromium/bin/al2023.tar.br"));
setupLambdaEnvironment(join(tmpdir(), "al2023", "lib"));
chromium.setGraphicsMode = true;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  args: [
    ...chromium.args,
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    "--use-gl=angle",
    "--use-angle=swiftshader",
  ],
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 120_000,
});

const page = await browser.newPage();
const logs = [];
page.on("console", message => logs.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", error => logs.push(`[pageerror] ${error.message}`));

const results = {};
const check = (name, value, detail = "") => {
  results[name] = { value: Boolean(value), detail };
  console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = ms => new Promise(done => setTimeout(done, ms));
const near = (value, expected, tolerance) => Math.abs(value - expected) <= tolerance;

try {
  await page.goto(`${base}/index.html?harness=1`, { waitUntil: "networkidle0" });
  await page.waitForFunction("!!window.__cadenceHarness", { timeout: 20_000 });

  const initial = await page.evaluate(async () => {
    const engine = window.__cadenceHarness.audioEngine;
    const loaded = await engine.load(
      { streamUrl: "/fixture/tone-a.wav", title: "Tone A", path: "/fixture/tone-a.wav", codec: "WAV" },
      { gain: 0.501 }
    );
    await engine.play();
    await new Promise(resolve => setTimeout(resolve, 450));
    return { loaded, graph: engine.describeGraph(), position: engine.position };
  });
  check(
    "legacy-load-uses-first-deck-and-replaygain",
    initial.loaded && initial.graph.activeDeck === "a" && near(initial.graph.decks[0].replayGainLinear, 0.501, 0.04),
    JSON.stringify(initial.graph.decks)
  );
  check("web-audio-graph-built", initial.graph.graphBuilt && initial.position > 0.15, `position=${initial.position.toFixed(2)}`);

  const preload = await page.evaluate(async () => {
    const engine = window.__cadenceHarness.audioEngine;
    const ready = await engine.preloadNext({
      streamUrl: "/fixture/tone-b.wav",
      title: "Tone B",
      path: "/fixture/tone-b.wav",
      codec: "WAV",
    });
    return { ready, graph: engine.describeGraph() };
  });
  check(
    "standby-preload-ready-without-playing",
    preload.ready && preload.graph.decks[1].preloaded && preload.graph.decks[1].paused,
    JSON.stringify(preload.graph.decks[1])
  );

  const crossfadeStart = await page.evaluate(async () => {
    const engine = window.__cadenceHarness.audioEngine;
    engine.seek(5.5);
    await new Promise(resolve => setTimeout(resolve, 150));
    const started = await engine.transitionTo(
      { streamUrl: "/fixture/tone-b.wav", title: "Tone B", path: "/fixture/tone-b.wav", codec: "WAV" },
      { fadeSeconds: 2, gain: 1 }
    );
    await new Promise(resolve => setTimeout(resolve, 250));
    return { started, graph: engine.describeGraph(), activeElementId: engine.element.id };
  });
  const startDecks = Object.fromEntries(crossfadeStart.graph.decks.map(deck => [deck.deck, deck]));
  check(
    "crossfade-promotes-incoming-deck",
    crossfadeStart.started && crossfadeStart.graph.activeDeck === "b" && crossfadeStart.activeElementId === "cadence-audio-element-standby",
    JSON.stringify(crossfadeStart.graph)
  );
  check(
    "crossfade-overlaps-and-ramps-both-decks",
    !startDecks.a.paused &&
      !startDecks.b.paused &&
      startDecks.b.fadeLinear > 0.02 &&
      startDecks.b.fadeLinear < 0.95 &&
      startDecks.a.fadeLinear > 0.05 &&
      startDecks.a.fadeLinear < 1,
    `incoming=${startDecks.b.fadeLinear.toFixed(3)}, outgoing=${startDecks.a.fadeLinear.toFixed(3)}`
  );

  await wait(2300);
  const crossfadeDone = await page.evaluate(() => window.__cadenceHarness.audioEngine.describeGraph());
  const doneDecks = Object.fromEntries(crossfadeDone.decks.map(deck => [deck.deck, deck]));
  check(
    "crossfade-retires-outgoing-deck",
    doneDecks.a.paused && doneDecks.a.readyState === 0 && doneDecks.a.duration === 0 && near(doneDecks.b.fadeLinear, 1, 0.03),
    JSON.stringify(doneDecks)
  );

  const lyrics = await page.evaluate(async () => {
    const h = window.__cadenceHarness;
    const engine = h.audioEngine;
    h.mountLyrics(`[00:00.50]First incoming line\n[00:03.00]Second incoming line\n[00:05.50]Third incoming line`);
    await new Promise(resolve => setTimeout(resolve, 700));
    const hostBefore = document.querySelector("braccato-lyrics");
    const sourceBefore = hostBefore?.source === engine.element;
    await engine.preloadNext({
      streamUrl: "/fixture/tone-a.wav",
      title: "Tone A",
      path: "/fixture/tone-a.wav",
      codec: "WAV",
    });
    const started = await engine.transitionTo(
      { streamUrl: "/fixture/tone-a.wav", title: "Tone A", path: "/fixture/tone-a.wav", codec: "WAV" },
      { fadeSeconds: 0.6, gain: 1 }
    );
    await new Promise(resolve => setTimeout(resolve, 250));
    const hostAfter = document.querySelector("braccato-lyrics");
    const sourceAfter = hostAfter?.source === engine.element;
    engine.seek(3.2);
    await new Promise(resolve => setTimeout(resolve, 800));
    return {
      started,
      sourceBefore,
      sourceAfter,
      activeDeck: engine.describeGraph().activeDeck,
      activeText: hostAfter?.querySelector(".blyrics--active")?.textContent?.trim() ?? null,
      position: engine.position,
    };
  });
  check(
    "lyrics-source-rebinds-on-deck-swap",
    lyrics.started && lyrics.sourceBefore && lyrics.sourceAfter && lyrics.activeDeck === "a",
    JSON.stringify(lyrics)
  );
  check(
    "lyrics-follow-promoted-deck-clock",
    (lyrics.activeText ?? "").includes("Second incoming line") && lyrics.position > 3,
    `active=${JSON.stringify(lyrics.activeText)}, position=${lyrics.position.toFixed(2)}`
  );

  const gapless = await page.evaluate(async () => {
    const engine = window.__cadenceHarness.audioEngine;
    await engine.preloadNext({
      streamUrl: "/fixture/tone-b.wav",
      title: "Tone B",
      path: "/fixture/tone-b.wav",
      codec: "WAV",
    });
    const before = engine.describeGraph();
    const started = await engine.transitionTo(
      { streamUrl: "/fixture/tone-b.wav", title: "Tone B", path: "/fixture/tone-b.wav", codec: "WAV" },
      { fadeSeconds: 0, gain: 0.75 }
    );
    const immediatePosition = engine.position;
    await new Promise(resolve => setTimeout(resolve, 250));
    return { before, started, immediatePosition, graph: engine.describeGraph() };
  });
  const gaplessDecks = Object.fromEntries(gapless.graph.decks.map(deck => [deck.deck, deck]));
  check(
    "gapless-cut-uses-preload-and-starts-at-zero",
    gapless.before.decks.every(deck => deck.active || deck.preloaded) &&
      gapless.started &&
      gapless.immediatePosition < 0.5 &&
      gapless.graph.activeDeck === "b" &&
      gaplessDecks.a.paused &&
      gaplessDecks.a.readyState === 0 &&
      gaplessDecks.a.duration === 0,
    JSON.stringify(gapless.graph)
  );

  const eq = await page.evaluate(async () => {
    const engine = window.__cadenceHarness.audioEngine;
    engine.applyEqualizer({
      enabled: true,
      preampDb: 6,
      bandsDb: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
      presetId: "bass",
    });
    await new Promise(resolve => setTimeout(resolve, 450));
    const enabled = engine.describeGraph().equalizer;
    engine.applyEqualizer({
      enabled: false,
      preampDb: 6,
      bandsDb: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
      presetId: "bass",
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    const disabled = engine.describeGraph().equalizer;
    return { enabled, disabled };
  });
  check(
    "equalizer-applies-bands-and-preamp",
    eq.enabled && near(eq.enabled.bandGainsDb[0], 6, 0.6) && near(eq.enabled.bandGainsDb[3], 2, 0.4) && near(eq.enabled.preampLinear, 1.995, 0.2),
    JSON.stringify(eq.enabled)
  );
  check(
    "equalizer-disable-is-transparent",
    eq.disabled && eq.disabled.bandGainsDb.every(value => Math.abs(value) < 0.5) && near(eq.disabled.preampLinear, 1, 0.15),
    JSON.stringify(eq.disabled)
  );

  await page.screenshot({ path: join(artifactDir, "audio-engine-lyrics-rebind.png") });
} finally {
  await browser.close();
  server.close();
}

writeFileSync(join(artifactDir, "results.json"), JSON.stringify({ results, logs }, null, 2));
const failures = Object.entries(results).filter(([, result]) => !result.value);
console.log(`\n${Object.keys(results).length - failures.length}/${Object.keys(results).length} audio engine checks passed`);
if (failures.length) process.exit(1);
