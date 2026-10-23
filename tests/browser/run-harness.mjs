/**
 * Renderer browser harness.
 *
 * The Electron binary cannot be downloaded in this environment, so this script runs the *real*
 * built renderer bundle inside headless Chromium (WebGL via SwiftShader, real WebAudio, real
 * <audio> element) against a small static server that serves the `out/renderer` build plus a
 * generated WAV file. It exercises the audio engine, the player store, the Braccato lyrics
 * renderer and the Kawarp shader canvas, and prints hard evidence for each step.
 *
 * Usage: node tests/browser/run-harness.mjs
 */
import { createServer } from "node:http";
import zlib from "node:zlib";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "out/renderer");
const fixtureDir = join(root, ".artifacts/fixtures");
const artifactDir = join(root, ".artifacts/harness");
mkdirSync(fixtureDir, { recursive: true });
mkdirSync(artifactDir, { recursive: true });

/* ------------------------------------------------------------------ fixtures */

function makeWav(seconds, freq, sampleRate = 44100) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    // Amplitude envelope so the beat detector sees real transients, not a constant tone.
    const beat = i % (sampleRate / 2) < sampleRate * 0.06 ? 1 : 0.25;
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 9000 * beat);
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

const wavPath = join(fixtureDir, "harness-tone.wav");
if (!existsSync(wavPath)) writeFileSync(wavPath, makeWav(12, 320));

/** 4x4 procedurally generated JPEG-ish PNG cover so artwork loading is exercised. */
function makeCover() {
  const { deflateSync } = zlib;
  const size = 64;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p++] = 0;
    for (let x = 0; x < size; x += 1) {
      raw[p++] = 40 + x * 3;
      raw[p++] = 30 + y * 2;
      raw[p++] = 120 + ((x + y) % 40) * 3;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([header, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  const coverPath = join(fixtureDir, "harness-cover.png");
  writeFileSync(coverPath, png);
  return coverPath;
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return crc ^ -1;
}


const coverPath = makeCover();

/** A real LRC file: line timestamps only, so word-level sync must NOT be invented. */
const lrc = `[ti:Harness Signal]
[ar:Cadence Tests]
[al:Bench]
[length:00:12]
[00:00.50]First line of the harness
[00:03.00]Second line arrives here
[00:06.25]Third line holds steady
[00:08.75]Fourth and final line
`;

/* ------------------------------------------------------------------- server */

const RANGE_TYPES = new Set([".wav", ".mp3", ".flac", ".m4a", ".ogg", ".opus"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
  ".lrc": "text/plain; charset=utf-8",
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/fixture/tone.wav" || url.pathname === "/fixture/cover.png" || url.pathname === "/fixture/track.lrc") {
    const file = { "/fixture/tone.wav": wavPath, "/fixture/cover.png": coverPath, "/fixture/track.lrc": null }[url.pathname];
    if (!file) {
      res.writeHead(200, { "content-type": MIME[".lrc"], "access-control-allow-origin": "*" });
      res.end(lrc);
      return;
    }
    const size = statSync(file).size;
    const type = MIME[extname(file)] ?? "application/octet-stream";
    const headers = {
      "content-type": type,
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "content-range, accept-ranges, content-length",
      "cache-control": "no-store",
    };
    const range = req.headers.range;
    if (range && RANGE_TYPES.has(extname(file))) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = Number(match[1] || 0);
      const end = match[2] ? Number(match[2]) : size - 1;
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, "content-length": size });
      createReadStream(file).pipe(res);
    }
    return;
  }

  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(outDir, path);
  if (!file.startsWith(outDir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

await new Promise(r => server.listen(4789, "0.0.0.0", r));
const base = "http://127.0.0.1:4789";
console.log("harness server listening on", base);

/* ------------------------------------------------------------------ browser */

chromium.setGraphicsMode = true;
const executablePath = await chromium.executablePath();
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [...chromium.args, "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader"],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 120_000,
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

await page.goto(`${base}/index.html?harness=1`, { waitUntil: "networkidle0" });
await page.waitForFunction("!!window.__cadenceHarness", { timeout: 20_000 }).catch(() => {});
check("renderer-boot", await page.evaluate(() => typeof window.__cadenceHarness === "object"), "renderer bundle executed (harness mode)");

/* Capability probe before any playback claim. */
const capabilities = await page.evaluate(() => {
  const audio = document.createElement("audio");
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  let renderer = null;
  if (gl) {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }
  return {
    renderer,
    webgl2: Boolean(canvas.getContext("webgl2")),
    flac: audio.canPlayType("audio/flac"),
    mp3: audio.canPlayType("audio/mpeg"),
    aac: audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
    alac: audio.canPlayType('audio/mp4; codecs="alac"'),
    wav: audio.canPlayType("audio/wav"),
    vorbis: audio.canPlayType('audio/ogg; codecs="vorbis"'),
    opus: audio.canPlayType('audio/ogg; codecs="opus"'),
    mediaSession: "mediaSession" in navigator,
    sampleRate: new AudioContext().sampleRate,
  };
});
console.log("capabilities:", JSON.stringify(capabilities, null, 1));

const api = await page.evaluate(() => ({
  hasHarness: typeof window.__cadenceHarness === "object",
  keys: window.__cadenceHarness ? Object.keys(window.__cadenceHarness) : [],
}));
check("harness-api", api.hasHarness, api.keys.join(","));

if (api.hasHarness) {
  /* 1 — real playback through the app's own audio engine. */
  const playback = await page.evaluate(async () => {
    const h = window.__cadenceHarness;
    const { audioEngine, player } = h;
    await audioEngine.load({ streamUrl: "/fixture/tone.wav", title: "Harness Tone" });
    await audioEngine.play();
    await new Promise(r => setTimeout(r, 1200));
    const t1 = audioEngine.position;
    const state = player.getState();
    const analyserPeak = (() => {
      const analyser = audioEngine.getAnalyser();
      if (!analyser) return null;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      return peak;
    })();
    audioEngine.pause();
    await new Promise(r => setTimeout(r, 250));
    const pausedAt = audioEngine.position;
    await audioEngine.play();
    await new Promise(r => setTimeout(r, 500));
    const resumedAt = audioEngine.position;
    audioEngine.seek(8);
    await new Promise(r => setTimeout(r, 400));
    const afterSeek = audioEngine.position;
    audioEngine.setVolume(0.4);
    await new Promise(r => setTimeout(r, 150));
    const volume = audioEngine.volume;
    return {
      position: t1,
      storePosition: state.position,
      storePlaying: player.getState().isPlaying,
      duration: audioEngine.duration,
      analyserPeak,
      pausedAt,
      resumedAt,
      afterSeek,
      volume: audioEngine.element.volume,
      contextState: audioEngine.getAnalyserContext()?.state ?? "closed",
      error: audioEngine.element.error ? `${audioEngine.element.error.code}` : null,
    };
  });
  check("audio-plays", playback.position > 0.4, `position after 1.2s = ${playback.position.toFixed(2)}s`);
  check("audio-paused-stops-clock", Math.abs(playback.pausedAt - playback.position) < 0.35, `${playback.position.toFixed(2)} → ${playback.pausedAt.toFixed(2)}`);
  check("audio-resumes", playback.resumedAt > playback.pausedAt + 0.2, `${playback.pausedAt.toFixed(2)} → ${playback.resumedAt.toFixed(2)}`);
  check("audio-seek", Math.abs(playback.afterSeek - 8) < 1.2, `sought to 8s, now ${playback.afterSeek.toFixed(2)}s`);
  check("audio-volume", Math.abs(playback.volume - 0.4) < 0.01, String(playback.volume));
  check("audio-analyser-real-samples", (playback.analyserPeak ?? 0) > 5, `time-domain peak deviation ${playback.analyserPeak}`);
  check("audio-duration", Math.abs(playback.duration - 12) < 0.4, `${playback.duration}s`);
  console.log("store:", JSON.stringify({ position: playback.storePosition, playing: playback.storePlaying, error: playback.error }));

  /* 2 — Braccato lyrics renderer with line-level LRC. */
  await page.evaluate(async () => {
    const h = window.__cadenceHarness;
    const response = await fetch("/fixture/track.lrc");
    const text = await response.text();
    h.mountLyrics(text);
  });
  await new Promise(r => setTimeout(r, 1500));
  const lyrics = await page.evaluate(() => {
    const host = document.querySelector("braccato-lyrics");
    const lines = host?.querySelectorAll(".blyrics--line") ?? [];
    const active = host?.querySelectorAll(".blyrics--active") ?? [];
    return {
      mounted: Boolean(host),
      lineCount: lines.length,
      activeCount: active.length,
      activeText: active[0]?.textContent?.trim() ?? null,
      wordElements: host?.querySelectorAll("[class*='blyrics-word']").length ?? 0,
      // The upstream renderer tags word spans that only exist for line-level animation.
      lineSyncedWords: host?.querySelectorAll(".blyrics-line-synced-word").length ?? 0,
      wordTimedSpans: host?.querySelectorAll("[data-word-state]").length ?? 0,
      syncedParts: (host?.lyrics?.[0]?.parts?.length ?? 0),
      syncType: host?.renderer?.syncType ?? host?.lyricsOptions?.syncType ?? null,
      wordDurations: [...(host?.querySelectorAll(".blyrics--word") ?? [])].map(n => Number(n.dataset.duration ?? -1)),
      lineHtml: host?.querySelector(".blyrics--line")?.outerHTML?.replace(/\s+/g, " ")?.slice(0, 700) ?? null,
      htmlLength: host?.innerHTML.length ?? 0,
    };
  });
  check("lyrics-mounted", lyrics.mounted, `${lyrics.lineCount} lines, ${lyrics.htmlLength} bytes of DOM`);
  check("lyrics-line-highlight", lyrics.activeCount >= 1, `active line: ${JSON.stringify(lyrics.activeText)}`);
  const maxWordDuration = Math.max(0, ...lyrics.wordDurations);
  check(
    "lyrics-line-synced-has-no-word-timings",
    lyrics.syncedParts === 0 && maxWordDuration === 0,
    `${lyrics.lineSyncedWords}/${lyrics.wordElements} word spans tagged line-synced, max word duration ${maxWordDuration}ms (0 = no fabricated karaoke progress)`
  );
  console.log("lyrics:", JSON.stringify(lyrics, null, 1));

  /* 2b — highlight follows the real audio clock, including a seek. */
  const follow = await page.evaluate(async () => {
    const h = window.__cadenceHarness;
    const activeText = () => document.querySelector("braccato-lyrics .blyrics--active")?.textContent?.trim() ?? null;
    h.audioEngine.seek(3.2);
    await new Promise(r => setTimeout(r, 700));
    const atThree = activeText();
    h.audioEngine.seek(8.9);
    await new Promise(r => setTimeout(r, 700));
    const atNine = activeText();
    h.audioEngine.pause();
    await new Promise(r => setTimeout(r, 400));
    const pausedLine = activeText();
    return { atThree, atNine, pausedLine, elementTime: h.audioEngine.position };
  });
  check(
    "lyrics-follow-seek",
    (follow.atThree ?? "").includes("Second line") && (follow.atNine ?? "").includes("Fourth"),
    `3.2s → ${JSON.stringify(follow.atThree)}, 8.9s → ${JSON.stringify(follow.atNine)}`
  );
  check("lyrics-survive-pause", follow.pausedLine !== null, `line held while paused at ${follow.elementTime.toFixed(2)}s`);

  /* 2c — enhanced LRC (real word timings) must produce genuine word-level progress. */
  const richsync = await page.evaluate(async () => {
    const h = window.__cadenceHarness;
    const text = `[ti:Rich]
[00:00.50]<00:00.50>Word <00:00.90>level <00:01.35>timings <00:01.90>arrive
[00:03.00]<00:03.00>Second <00:03.40>karaoke <00:03.90>line <00:04.30>here`;
    h.mountLyrics(text);
    await new Promise(r => setTimeout(r, 1200));
    const host = document.querySelector("braccato-lyrics");
    const words = [...(host?.querySelectorAll(".blyrics--word") ?? [])];
    h.audioEngine.seek(1.0);
    await new Promise(r => setTimeout(r, 700));
    const states = words.map(n => `${n.dataset.content}:${n.dataset.time}/${n.dataset.duration}:${n.dataset.wordState}`).slice(0, 8);
    return {
      count: words.length,
      durations: words.map(n => Number(n.dataset.duration ?? -1)),
      hasParts: Boolean(host?.lyrics?.[0]?.parts?.length),
      states,
    };
  });
  const wordDurations = richsync.durations.filter(d => d > 0);
  check(
    "lyrics-word-level-sync",
    richsync.hasParts && wordDurations.length >= 4 && new Set(wordDurations).size > 1,
    `${richsync.count} words, parts=${richsync.hasParts}, durations=${JSON.stringify(richsync.durations.slice(0, 8))}`
  );
  console.log("rich word states:", richsync.states.join(" | "));

  /* 2d — translation and romanization render as secondary lines inside their own lyric line
     (Better Lyrics style), never as standalone entries after the lyrics. Lines without a
     decoration get none, and word timings survive decoration. */
  const decorated = await page.evaluate(async () => {
    const h = window.__cadenceHarness;
    const text = `[ti:Decorated]
[00:00.50]<00:00.50>桜の <00:00.90>花が <00:01.35>咲く
[00:03.00]空は青い
[00:05.00]風が吹く`;
    h.mountDecoratedLyrics(text, {
      translations: ["The cherry blossoms bloom", null, "The wind blows"],
      romanizations: ["sakura no hana ga saku", "sora wa aoi", null],
    });
    await new Promise(r => setTimeout(r, 1200));
    const host = document.querySelector("braccato-lyrics");
    const lines = [...(host?.querySelectorAll(".blyrics--line") ?? [])];
    const describe = line => {
      const main = line?.querySelector(":scope > .blyrics-line-main");
      const romanized = line?.querySelector(":scope > .blyrics--romanized");
      const translated = line?.querySelector(":scope > .blyrics--translated");
      return {
        childClasses: [...(line?.children ?? [])].map(node =>
          node.classList.contains("blyrics--romanized")
            ? "romanized"
            : node.classList.contains("blyrics--translated")
              ? "translated"
              : node.classList.contains("blyrics-line-main")
                ? "main"
                : node.className
        ),
        romanized: romanized?.textContent?.trim() ?? null,
        translated: translated?.textContent?.trim() ?? null,
        romanizedFontPx: romanized ? parseFloat(getComputedStyle(romanized).fontSize) : null,
        translatedFontPx: translated ? parseFloat(getComputedStyle(translated).fontSize) : null,
        mainFontPx: main ? parseFloat(getComputedStyle(main).fontSize) : null,
        wordSpans: line?.querySelectorAll(".blyrics--word").length ?? 0,
      };
    };
    h.audioEngine.seek(0.8);
    await new Promise(r => setTimeout(r, 600));
    return {
      lineCount: lines.length,
      perLine: lines.map(describe),
      strayTranslated: [...(host?.querySelectorAll(".blyrics--translated") ?? [])].filter(
        node => !node.closest(".blyrics--line")
      ).length,
      strayRomanized: [...(host?.querySelectorAll(".blyrics--romanized") ?? [])].filter(
        node => !node.closest(".blyrics--line")
      ).length,
      activeText: host?.querySelector(".blyrics--active")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    };
  });
  const [decoFirst, decoSecond, decoThird] = decorated.perLine;
  check(
    "decorations-grouped-per-line",
    decorated.lineCount === 3 &&
      decoFirst?.translated === "The cherry blossoms bloom" &&
      decoFirst?.romanized === "sakura no hana ga saku" &&
      decoSecond?.translated === null &&
      decoSecond?.romanized === "sora wa aoi" &&
      decoThird?.translated === "The wind blows" &&
      decoThird?.romanized === null,
    JSON.stringify(decorated.perLine)
  );
  check(
    "decorations-order-romanization-above-translation",
    (decoFirst?.childClasses.indexOf("romanized") ?? -1) >= 0 &&
      decoFirst.childClasses.indexOf("romanized") < decoFirst.childClasses.indexOf("translated") &&
      decoFirst.childClasses[0] === "main",
    JSON.stringify(decoFirst?.childClasses)
  );
  check(
    "decorations-not-standalone",
    decorated.strayTranslated === 0 && decorated.strayRomanized === 0,
    `stray translated=${decorated.strayTranslated} romanized=${decorated.strayRomanized}`
  );
  check(
    "decorations-secondary-typography",
    (decoFirst?.translatedFontPx ?? 99) < (decoFirst?.mainFontPx ?? 0) &&
      (decoFirst?.romanizedFontPx ?? 99) < (decoFirst?.translatedFontPx ?? 0),
    `main=${decoFirst?.mainFontPx}px translated=${decoFirst?.translatedFontPx}px romanized=${decoFirst?.romanizedFontPx}px`
  );
  check(
    "decorations-keep-word-sync-and-active-line",
    (decoFirst?.wordSpans ?? 0) >= 3 && (decorated.activeText ?? "").includes("桜の"),
    `word spans=${decoFirst?.wordSpans}, active=${JSON.stringify(decorated.activeText)}`
  );

  /* 3 — Kawarp shader canvas produces non-black pixels behind the lyrics. */
  const shader = await page.evaluate(async () => {
    const h = window.__cadenceHarness;
    await h.mountShaders();
    await new Promise(r => setTimeout(r, 2500));
    const canvas = document.querySelector(".kawarp-canvas");
    if (!canvas) return { mounted: false };
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    if (gl) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let sum = 0;
    let nonBlack = 0;
    let max = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const value = pixels[i] + pixels[i + 1] + pixels[i + 2];
      sum += value;
      if (value > 12) nonBlack += 1;
      max = Math.max(max, value);
    }
    return {
      mounted: true,
      width,
      height,
      mean: sum / (pixels.length / 4),
      nonBlackRatio: nonBlack / (pixels.length / 4),
      max,
      errors: h.shaderErrors,
    };
  });
  check("shader-canvas-mounted", shader.mounted, `${shader.width}x${shader.height}`);
  check("shader-non-black-output", (shader.nonBlackRatio ?? 0) > 0.5, `non-black ${(100 * (shader.nonBlackRatio ?? 0)).toFixed(1)}%, mean ${(shader.mean ?? 0).toFixed(1)}, max ${shader.max}`);
  if (shader.errors?.length) console.log("shader errors:", shader.errors);

  /* 4 — shader pixels change over time (animation actually runs). */
  const animation = await page.evaluate(async () => {
    const canvas = document.querySelector(".kawarp-canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const grab = () => {
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const a = grab();
    await new Promise(r => setTimeout(r, 700));
    const b = grab();
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 4) diff += 1;
    return { changedRatio: diff / (a.length / 4) };
  });
  check("shader-animates", animation.changedRatio > 0.02, `${(100 * animation.changedRatio).toFixed(1)}% of pixels changed in 700ms`);

  await page.screenshot({ path: join(artifactDir, "lyrics-shader.png") });
}

writeFileSync(join(artifactDir, "console.log"), logs.join("\n"));
console.log("\n--- renderer console ---");
console.log(logs.slice(0, 60).join("\n"));

const summary = { capabilities, results, logs: logs.length };
writeFileSync(join(artifactDir, "results.json"), JSON.stringify(summary, null, 2));
const failures = Object.entries(results).filter(([, r]) => !r.value);
console.log(`\n${Object.keys(results).length - failures.length}/${Object.keys(results).length} checks passed`);
await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
