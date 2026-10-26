/**
 * Lyrics decoration harness.
 *
 * Boots the *built* renderer in headless Chromium and mounts the production Now Playing lyrics
 * page (`LyricsView` -> `useLyrics` -> lyrics store -> Braccato renderer) over a stub bridge. All
 * interaction is through the real dock controls; the stub only supplies provider payloads.
 *
 * Usage: npm run build:web && node tests/browser/lyrics-decorations.mjs
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const artifactDir = join(root, ".artifacts/lyrics-harness");
mkdirSync(artifactDir, { recursive: true });

/* ------------------------------------------------------------------ fixtures */

const TTML_FULL = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="ja">
  <head>
    <metadata>
      <ttm:agent type="person" xml:id="v1"/>
      <translations xml:lang="en">
        <translation for="L1"><text>Cherry blossoms fall</text></translation>
        <translation for="L2"><text>The sky is blue</text></translation>
        <translation for="L3"><text>The wind blows</text></translation>
      </translations>
      <transliterations>
        <transliteration xml:lang="ja-Latn">
          <text for="L1"><span begin="00:00.500" end="00:01.200">sakura </span><span begin="00:01.200" end="00:02.500">no hana</span></text>
          <text for="L2">sora wa aoi</text>
          <text for="L3">kaze ga fuku</text>
        </transliteration>
      </transliterations>
    </metadata>
  </head>
  <body dur="00:09.000">
    <div>
      <p begin="00:00.500" end="00:02.500" key="L1" ttm:agent="v1"><span begin="00:00.500" end="00:01.200">桜</span><span begin="00:01.200" end="00:02.500">の花</span></p>
      <p begin="00:03.000" end="00:05.000" key="L2" ttm:agent="v1">空は青い</p>
      <p begin="00:05.500" end="00:07.500" key="L3" ttm:agent="v1">風が吹く</p>
    </div>
  </body>
</tt>`;

const TTML_PARTIAL = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="ja">
  <head>
    <metadata>
      <translations xml:lang="en">
        <translation for="L1"><text>File translation one</text></translation>
      </translations>
      <transliterations>
        <transliteration xml:lang="ja-Latn">
          <text for="L1">sakura no hana</text>
        </transliteration>
      </transliterations>
    </metadata>
  </head>
  <body dur="00:09.000">
    <div>
      <p begin="00:00.500" end="00:02.500" key="L1"><span begin="00:00.500" end="00:01.200">桜</span><span begin="00:01.200" end="00:02.500">の花</span></p>
      <p begin="00:03.000" end="00:05.000" key="L2">空は青い</p>
      <p begin="00:05.500" end="00:07.500" key="L3">風が吹く</p>
    </div>
  </body>
</tt>`;

const TTML_INSTRUMENTAL = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ja">
  <head><metadata>
    <translations xml:lang="en">
      <translation for="L1"><text>Opening line translation</text></translation>
      <translation for="L2"><text>Closing line translation</text></translation>
    </translations>
    <transliterations>
      <transliteration xml:lang="ja-Latn">
        <text for="L1">opening line</text>
        <text for="L2">closing line</text>
      </transliteration>
    </translations>
  </metadata></head>
  <body dur="00:20.000"><div>
    <p begin="00:00.500" end="00:02.500" key="L1">最初の行</p>
    <p begin="00:12.000" end="00:14.000" key="L2">最後の行</p>
  </div></body>
</tt>`;

const PLAIN_LRC = `[ti:Remote fixture]
[ar:Harness Artist]
[al:Lyrics Bench]
[length:00:09]
[00:00.50]First sung line
[00:02.00]Second sung line
[00:04.00]Third sung line
`;

const TTML_SECOND_FILE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ja">
  <head><metadata>
    <translations xml:lang="en"><translation for="L1"><text>Second file line</text></translation><translation for="L2"><text>Second file tail</text></translation></translations>
  </metadata></head>
  <body dur="00:06.000"><div>
    <p begin="00:00.500" end="00:02.000" key="L1">二番目</p>
    <p begin="00:02.500" end="00:04.000" key="L2">終わり</p>
  </div></body>
</tt>`;

const candidate = (source, provider, text) => ({
  source,
  provider,
  text,
  syncHint: text.trimStart().startsWith("<") || text.includes("<tt") ? "richsync" : "synced",
  language: text.includes("<tt") ? "ja" : null,
  songwriters: [],
  sourceHref: null,
  cached: true,
});

const TTML_CANDIDATE = candidate("local-ttml", "Local TTML", TTML_FULL);
const LRC_CANDIDATE = candidate("local-lrc", "Local LRC", PLAIN_LRC);
const TTML_PARTIAL_CANDIDATE = candidate("local-partial", "Local TTML (partial)", TTML_PARTIAL);
const TTML_INSTRUMENTAL_CANDIDATE = candidate("local-instrumental", "Local TTML (instrumental)", TTML_INSTRUMENTAL);

/* ------------------------------------------------------------------- server */

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".wav": "audio/wav" };
const wavPath = join(artifactDir, "tone.wav");
if (!existsSync(wavPath)) {
  const sampleRate = 8000;
  const frames = sampleRate * 10;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 6000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(wavPath, Buffer.concat([header, data]));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let file = null;
  if (url.pathname === "/audio/tone.wav") file = wavPath;
  else {
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
  };
  // The audio element needs byte ranges to seek; without them a paused element stays at 0 and the
  // renderer never highlights a line.
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
await new Promise(r => server.listen(4794, "0.0.0.0", r));
const base = "http://127.0.0.1:4794";

/* ------------------------------------------------------------------ browser */

await inflate(join(root, "node_modules/@sparticuz/chromium/bin/al2023.tar.br"));
setupLambdaEnvironment(join(tmpdir(), "al2023", "lib"));
chromium.setGraphicsMode = true;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: true,
  args: [...chromium.args, "--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 1280, height: 900 },
  protocolTimeout: 120_000,
});
const page = await browser.newPage();
const logs = [];
page.on("console", message => logs.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", error => logs.push(`[pageerror] ${error.message}`));

const results = {};
const check = (name, value, detail = "") => {
  results[name] = { value: Boolean(value), detail: String(detail) };
  console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, timeout = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(fn)) return true;
    await wait(100);
  }
  return false;
};
const state = () => page.evaluate(() => window.__cadenceHarness.lyricsState());
const dom = () =>
  page.evaluate(() => {
    const lineNodes = [...document.querySelectorAll("braccato-lyrics .blyrics--line")];
    // Timed romanization is built from word runs, whose highlight copy repeats the text; read the
    // visible run instead of the whole node's textContent.
    const textOf = node =>
      node?.querySelector(".blyrics-bidi-run:not(.blyrics-highlight-run)")?.textContent?.trim() ??
      node?.textContent?.trim() ??
      null;
    return {
      lines: lineNodes.length,
      romanized: lineNodes.map(line => textOf(line.querySelector(":scope > .blyrics--romanized"))),
      translated: lineNodes.map(line => textOf(line.querySelector(":scope > .blyrics--translated"))),
      translatedLanguageAttrs: [...document.querySelectorAll("braccato-lyrics .blyrics--translated")].map(node => node.lang),
      romanizeActive: Boolean(document.querySelector('button[title="Romanize lyrics"].active')),
      translateLabel: document.querySelector('button[title="Translate lyrics"]')?.textContent?.trim() ?? null,
      busy: Boolean(document.querySelector('button[title="Reload lyrics"]')?.disabled),
    };
  });
const clickTitle = async title => {
  await page.click(`button[title="${title}"]`);
  await wait(250);
};
const clickPopoverRow = async (popover, text, index = 0) => {
  const clicked = await page.evaluate(
    ({ popover, text, index }) => {
      const rows = [...document.querySelectorAll(`${popover} .source-row`)].filter(row => row.textContent?.includes(text));
      const row = rows[index];
      if (!row) return false;
      row.click();
      return true;
    },
    { popover, text, index }
  );
  await wait(400);
  return clicked;
};
const mount = async (options, waitForLines = true) => {
  await page.evaluate(opts => window.__cadenceHarness.mountLyricsView(opts), options);
  if (waitForLines) await waitFor(() => document.querySelectorAll("braccato-lyrics .blyrics--line").length > 0);
  await wait(350);
};

/** Parks the shared audio clock mid-song so the renderer highlights a line (and paints its text). */
const seekPreview = async seconds => {
  const result = await page.evaluate(value => window.__cadenceHarness.seekLyricsPreview(value), seconds);
  await wait(500);
  return result;
};
const activeLine = () =>
  page.evaluate(() => {
    const node = document.querySelector("braccato-lyrics .blyrics--active");
    if (!node) return null;
    return {
      main:
        node.querySelector(".blyrics-line-main .blyrics-bidi-run:not(.blyrics-highlight-run)")?.textContent?.trim() ??
        null,
      romanized:
        node.querySelector(".blyrics--romanized .blyrics-bidi-run:not(.blyrics-highlight-run)")?.textContent?.trim() ??
        node.querySelector(".blyrics--romanized")?.textContent?.trim() ??
        null,
      translated: node.querySelector(".blyrics--translated")?.textContent?.trim() ?? null,
    };
  });

await page.goto(`${base}/index.html?harness=1`, { waitUntil: "networkidle0" });
check("harness-boot", await page.evaluate(() => typeof window.__cadenceHarness === "object"));

const track = { id: 701, title: "Lyrics Fixture", duration: 9 };

try {
  /* ---------------------------------------------------------------- Issue 1 */
  // Full embedded romanization + translation, both toggles initially off.
  await mount({ track, candidates: [TTML_CANDIDATE, LRC_CANDIDATE], settings: { romanization: false, translationLanguage: "" } });
  let current = await dom();
  check("romanization-off-hides-embedded", current.romanized.every(text => text === null), JSON.stringify(current.romanized));
  check("translation-off-hides-embedded", current.translated.every(text => text === null), JSON.stringify(current.translated));

  await clickTitle("Romanize lyrics");
  current = await dom();
  let pipeline = await state();
  check(
    "romanization-on-shows-embedded-without-provider",
    current.romanizeActive &&
      current.romanized[0] === "sakura no hana" &&
      current.romanized[1] === "sora wa aoi" &&
      current.romanized[2] === "kaze ga fuku" &&
      pipeline.calls.romanize.length === 0 &&
      JSON.stringify(pipeline.lines[0]?.timedRomanization) === JSON.stringify(["sakura ", "no hana"]),
    `dom=${JSON.stringify(current.romanized)} calls=${pipeline.calls.romanize.length} timed=${JSON.stringify(pipeline.lines[0]?.timedRomanization)}`
  );

  await clickTitle("Romanize lyrics");
  current = await dom();
  pipeline = await state();
  check(
    "romanization-off-removes-embedded",
    !current.romanizeActive &&
      current.romanized.every(text => text === null) &&
      pipeline.lines.every(line => line.timedRomanization === null),
    `dom=${JSON.stringify(current.romanized)} timed=${JSON.stringify(pipeline.lines.map(line => line.timedRomanization))}`
  );

  await clickTitle("Romanize lyrics");
  current = await dom();
  pipeline = await state();
  check(
    "romanization-on-restores-embedded",
    current.romanized[0] === "sakura no hana" &&
      current.romanized[2] === "kaze ga fuku" &&
      pipeline.calls.romanize.length === 0 &&
      JSON.stringify(pipeline.lines[0]?.timedRomanization) === JSON.stringify(["sakura ", "no hana"]),
    `dom=${JSON.stringify(current.romanized)} calls=${pipeline.calls.romanize.length} timed=${JSON.stringify(pipeline.lines[0]?.timedRomanization)}`
  );

  // Translation independent of romanization.
  await clickTitle("Translate lyrics");
  await clickPopoverRow(".dock-languages", "English");
  current = await dom();
  pipeline = await state();
  check(
    "translation-on-shows-embedded-with-romanization-on",
    current.translated[0] === "Cherry blossoms fall" &&
      current.translated[1] === "The sky is blue" &&
      current.romanized[0] === "sakura no hana" &&
      pipeline.calls.translate.length === 0,
    `translated=${JSON.stringify(current.translated)} romanized=${JSON.stringify(current.romanized)} calls=${pipeline.calls.translate.length}`
  );
  // The track's clock drives the highlight; decorations must travel with the line they belong to.
  const seekResult = await seekPreview(3.2);
  const active = await activeLine();
  check(
    "decorations-follow-the-active-line",
    active?.main === "空は青い" && active?.romanized === "sora wa aoi" && active?.translated === "The sky is blue",
    JSON.stringify({ active, seekResult })
  );
  await page.screenshot({ path: join(artifactDir, "decorations-active-line.png") });

  await clickTitle("Romanize lyrics");
  current = await dom();
  await seekPreview(3.2);
  await page.screenshot({ path: join(artifactDir, "romanization-off-translation-on.png") });
  const activeNoRomanization = await activeLine();
  check(
    "romanization-off-keeps-translation",
    current.romanized.every(text => text === null) &&
      current.translated[0] === "Cherry blossoms fall" &&
      activeNoRomanization?.romanized === null &&
      activeNoRomanization?.translated === "The sky is blue",
    `translated=${JSON.stringify(current.translated)} romanized=${JSON.stringify(current.romanized)} active=${JSON.stringify(activeNoRomanization)}`
  );
  await clickTitle("Translate lyrics");
  await clickPopoverRow(".dock-languages", "Off");
  current = await dom();
  check(
    "translation-off-keeps-nothing-but-original",
    current.translated.every(text => text === null) && current.lines === 3,
    `translated=${JSON.stringify(current.translated)} lines=${current.lines}`
  );

  // Partial file: embedded wins, only gaps are generated.
  await mount({ track: { id: 702, title: "Partial Fixture", duration: 9 }, candidates: [TTML_PARTIAL_CANDIDATE], settings: { romanization: true, translationLanguage: "en" } });
  await wait(600);
  current = await dom();
  pipeline = await state();
  check(
    "partial-romanization-embedded-wins-and-gaps-only",
    current.romanized[0] === "sakura no hana" &&
      current.romanized[1] === "[rom] 空は青い" &&
      current.romanized[2] === "[rom] 風が吹く" &&
      pipeline.calls.romanize.length === 1 &&
      pipeline.calls.romanize[0].lines.length === 2 &&
      !pipeline.calls.romanize[0].lines.some(line => line.includes("桜")),
    `dom=${JSON.stringify(current.romanized)} calls=${JSON.stringify(pipeline.calls.romanize)}`
  );
  check(
    "partial-translation-embedded-wins-and-gaps-only",
    current.translated[0] === "File translation one" &&
      current.translated[1] === "[en] 空は青い" &&
      current.translated[2] === "[en] 風が吹く" &&
      pipeline.calls.translate.length === 1 &&
      pipeline.calls.translate[0].lines.length === 2 &&
      !pipeline.calls.translate[0].lines.some(line => line.includes("桜")),
    `dom=${JSON.stringify(current.translated)} calls=${JSON.stringify(pipeline.calls.translate)}`
  );

  // Romanization failure with embedded lines present: embedded still visible, UI not stuck.
  await page.evaluate(() => window.__cadenceHarness.configureLyrics({ romanizationFailure: true, translationFailure: false }));
  await mount({ track: { id: 703, title: "Failure Fixture", duration: 9 }, candidates: [TTML_PARTIAL_CANDIDATE], settings: { romanization: true, translationLanguage: "" } });
  await wait(800);
  current = await dom();
  pipeline = await state();
  check(
    "romanization-failure-keeps-embedded-and-clears-busy",
    current.romanized[0] === "sakura no hana" && !pipeline.romanizing && !current.busy,
    `dom=${JSON.stringify(current.romanized)} romanizing=${pipeline.romanizing}`
  );
  await page.evaluate(() => window.__cadenceHarness.configureLyrics({ romanizationFailure: false }));

  /* ---------------------------------------------------------------- Issue 2 */
  // Remote translation on a plain LRC, then reset paths that used to lose it.
  await mount({ track: { id: 704, title: "Remote Fixture", duration: 9 }, candidates: [LRC_CANDIDATE, TTML_CANDIDATE], settings: { romanization: false, translationLanguage: "en" } });
  await wait(600);
  current = await dom();
  pipeline = await state();
  check(
    "remote-translation-renders",
    current.translated[0] === "[en] First sung line" &&
      current.translated[2] === "[en] Third sung line" &&
      pipeline.calls.translate.at(-1)?.lines.length === 3,
    `translated=${JSON.stringify(current.translated)} calls=${pipeline.calls.translate.length}`
  );

  // Clicking the already-active source must not drop the decoration.
  await clickTitle("Lyrics source");
  const activeClicked = await clickPopoverRow(".dock-sources", "", 0);
  await wait(500);
  current = await dom();
  check(
    "active-source-reclick-keeps-translation",
    activeClicked && current.translated[0] === "[en] First sung line",
    `clicked=${activeClicked} translated=${JSON.stringify(current.translated)} state=${JSON.stringify((await state()).lines)}`
  );

  // Switching provider and back must re-decorate each time.
  await clickTitle("Lyrics source");
  await clickPopoverRow(".dock-sources", "Local TTML");
  await wait(500);
  current = await dom();
  check(
    "provider-switch-keeps-translation",
    current.translated[0] === "Cherry blossoms fall" && current.romanized.every(text => text === null),
    `translated=${JSON.stringify(current.translated)} romanized=${JSON.stringify(current.romanized)}`
  );
  await clickTitle("Lyrics source");
  await clickPopoverRow(".dock-sources", "Local LRC");
  await wait(500);
  current = await dom();
  check(
    "provider-switch-back-restores-translation",
    current.translated[0] === "[en] First sung line",
    `translated=${JSON.stringify(current.translated)}`
  );

  // Reload button re-resolves and re-decorates.
  await clickTitle("Reload lyrics");
  await wait(900);
  current = await dom();
  check("reload-keeps-translation", current.translated[0] === "[en] First sung line", JSON.stringify(current.translated));

  // Leaving Now Playing and coming back (unmount/remount) keeps the decoration.
  await page.evaluate(() => window.__cadenceHarness.unmountLyricsView());
  await wait(200);
  await mount({ track });
  current = await dom();
  check("navigation-back-keeps-translation", current.translated[0] === "[en] First sung line", JSON.stringify(current.translated));

  // Setting changes while away from Now Playing are reflected on return.
  await page.evaluate(() => window.__cadenceHarness.unmountLyricsView());
  await page.evaluate(() => window.__cadenceHarness.configureLyrics({ translationDelayMs: 0 }));
  // Use the store's own settings API through a synthetic dock interaction is impossible while away;
  // re-mount first, then toggle language through the dock.
  await mount({ track });
  await clickTitle("Translate lyrics");
  await clickPopoverRow(".dock-languages", "Spanish");
  await wait(700);
  current = await dom();
  check(
    "language-change-replaces-translation",
    current.translated[0] === "[es] First sung line" && current.translatedLanguageAttrs.every(lang => lang.startsWith("es")),
    `translated=${JSON.stringify(current.translated)} lang=${JSON.stringify(current.translatedLanguageAttrs)}`
  );
  await clickTitle("Translate lyrics");
  await clickPopoverRow(".dock-languages", "English");
  await wait(700);
  current = await dom();
  check("language-change-back-uses-english", current.translated[0] === "[en] First sung line", JSON.stringify(current.translated));

  // A slow translation must not overwrite a newer provider choice.
  await page.evaluate(() => window.__cadenceHarness.configureLyrics({ translationDelayMs: 900 }));
  await clickTitle("Lyrics source");
  await clickPopoverRow(".dock-sources", "Local TTML");
  await wait(120);
  await clickTitle("Lyrics source");
  await clickPopoverRow(".dock-sources", "Local LRC");
  await wait(1500);
  current = await dom();
  check(
    "slow-translation-does-not-cross-providers",
    current.translated[0] === "[en] First sung line",
    `translated=${JSON.stringify(current.translated)}`
  );
  await page.evaluate(() => window.__cadenceHarness.configureLyrics({ translationDelayMs: 0 }));

  // Choosing a second file must decorate it too (fresh parse, not a skipped cached id).
  await page.evaluate(ttml => window.__cadenceHarness.configureLyrics({ chosenFile: ttml }), TTML_SECOND_FILE);
  await clickTitle("Open a lyrics file");
  await wait(700);
  current = await dom();
  check(
    "chosen-file-translation-renders",
    current.translated[0] === "Second file line" && current.translated[1] === "Second file tail",
    `translated=${JSON.stringify(current.translated)}`
  );
  await page.evaluate(ttml => window.__cadenceHarness.configureLyrics({ chosenFile: ttml }), TTML_FULL);
  await clickTitle("Open a lyrics file");
  await wait(700);
  current = await dom();
  check(
    "second-chosen-file-translation-renders",
    current.translated[0] === "Cherry blossoms fall",
    `translated=${JSON.stringify(current.translated)}`
  );

  // Track switch with the same candidates still decorates the new track.
  await mount({ track: { id: 705, title: "Another Fixture", duration: 9 }, candidates: [LRC_CANDIDATE, TTML_CANDIDATE] });
  await wait(600);
  current = await dom();
  check("track-switch-translates", current.translated[0] === "[en] First sung line", JSON.stringify(current.translated));

  // Switching to another track and back re-resolves the cached parse; the decorations must be
  // rebuilt instead of being skipped by the "already decorated this parse" guards.
  await mount({
    track: { id: 709, title: "Round Trip A", duration: 9 },
    candidates: [LRC_CANDIDATE],
    settings: { translationLanguage: "en", romanization: true },
  });
  await wait(700);
  await mount({ track: { id: 710, title: "Round Trip B", duration: 9 }, candidates: [LRC_CANDIDATE] });
  await wait(700);
  await mount({ track: { id: 709, title: "Round Trip A", duration: 9 } });
  await wait(700);
  current = await dom();
  check(
    "track-round-trip-restores-decorations",
    current.translated[0] === "[en] First sung line" && current.romanized[0] === "[rom] First sung line",
    `translated=${JSON.stringify(current.translated)} romanized=${JSON.stringify(current.romanized)}`
  );

  // Instrumental gaps in the file are extra rendered lines; decorations must stay on the sung
  // lines they belong to instead of shifting with the array positions.
  await wait(600); // let any re-generation started by the previous fixture settle
  const callsBeforeInstrumental = (await state()).calls;
  await mount({
    track: { id: 708, title: "Instrumental Fixture", duration: 20 },
    candidates: [TTML_INSTRUMENTAL_CANDIDATE],
    settings: { romanization: true, translationLanguage: "en" },
  });
  await wait(600);
  current = await dom();
  pipeline = await state();
  check(
    "instrumental-gaps-keep-decoration-alignment",
    current.lines === 4 &&
      current.translated[0] === "Opening line translation" &&
      current.translated[1] === null &&
      current.translated[2] === "Closing line translation" &&
      current.translated[3] === null &&
      current.romanized[0] === "opening line" &&
      current.romanized[1] === null &&
      current.romanized[2] === "closing line" &&
      current.romanized[3] === null &&
      // Nothing was requested for this file: its sung lines are fully decorated and the
      // instrumental lines are never sent to a provider.
      [
        ...pipeline.calls.translate.slice(callsBeforeInstrumental.translate.length),
        ...pipeline.calls.romanize.slice(callsBeforeInstrumental.romanize.length),
      ].every(call => call.lines.every(line => line.trim().length > 0) && !call.lines.some(line => line.includes("行"))),
    `lines=${current.lines} translated=${JSON.stringify(current.translated)} romanized=${JSON.stringify(current.romanized)} extra=${JSON.stringify([
      ...pipeline.calls.translate.slice(callsBeforeInstrumental.translate.length),
      ...pipeline.calls.romanize.slice(callsBeforeInstrumental.romanize.length),
    ])}`
  );

  // A file that needs generated text must be decorated even when the previous chosen file was
  // fully embedded: the "already decorated" guard is keyed on the parse, not shared by every file.
  await page.evaluate(ttml => window.__cadenceHarness.configureLyrics({ chosenFile: ttml }), TTML_SECOND_FILE);
  await clickTitle("Open a lyrics file");
  await wait(600);
  await page.evaluate(ttml => window.__cadenceHarness.configureLyrics({ chosenFile: ttml }), TTML_PARTIAL);
  await clickTitle("Open a lyrics file");
  await wait(800);
  current = await dom();
  pipeline = await state();
  check(
    "chosen-file-after-embedded-file-generates",
    current.translated[0] === "File translation one" &&
      current.translated[1] === "[en] 空は青い" &&
      pipeline.calls.translate.at(-1)?.lines.length === 2,
    `translated=${JSON.stringify(current.translated)} calls=${JSON.stringify(pipeline.calls.translate.slice(-1))}`
  );

  // Generated romanization: toggle round trip, active-source re-click and remount.
  await mount({
    track: { id: 707, title: "Generated Romanization Fixture", duration: 9 },
    candidates: [TTML_PARTIAL_CANDIDATE],
    settings: { romanization: true, translationLanguage: "" },
  });
  await wait(800);
  current = await dom();
  pipeline = await state();
  let romanizeCalls = pipeline.calls.romanize.length;
  check(
    "generated-romanization-renders-gaps",
    current.romanized[0] === "sakura no hana" && current.romanized[1] === "[rom] 空は青い",
    JSON.stringify(current.romanized)
  );
  await clickTitle("Romanize lyrics");
  current = await dom();
  check("generated-romanization-toggle-off", current.romanized.every(text => text === null), JSON.stringify(current.romanized));
  await clickTitle("Romanize lyrics");
  await wait(800);
  current = await dom();
  pipeline = await state();
  check(
    "generated-romanization-toggle-on-restores-both",
    current.romanized[0] === "sakura no hana" && current.romanized[1] === "[rom] 空は青い" && pipeline.calls.romanize.length === romanizeCalls + 1,
    `dom=${JSON.stringify(current.romanized)} calls=${pipeline.calls.romanize.length - romanizeCalls}`
  );
  await clickTitle("Lyrics source");
  await clickPopoverRow(".dock-sources", "", 0);
  await wait(300);
  current = await dom();
  check(
    "active-source-reclick-keeps-generated-romanization",
    current.romanized[0] === "sakura no hana" && current.romanized[1] === "[rom] 空は青い",
    JSON.stringify(current.romanized)
  );
  romanizeCalls = (await state()).calls.romanize.length;
  await page.evaluate(() => window.__cadenceHarness.unmountLyricsView());
  await wait(200);
  await mount({ track: { id: 707, title: "Generated Romanization Fixture", duration: 9 } });
  await wait(500);
  current = await dom();
  pipeline = await state();
  check(
    "remount-reuses-generated-romanization",
    current.romanized[1] === "[rom] 空は青い" && pipeline.calls.romanize.length === romanizeCalls,
    `dom=${JSON.stringify(current.romanized)} extraCalls=${pipeline.calls.romanize.length - romanizeCalls}`
  );

  // Settings changed on another page (while Now Playing is unmounted) apply on return.
  await mount({
    track: { id: 711, title: "Settings Away Fixture", duration: 9 },
    candidates: [LRC_CANDIDATE],
    settings: { translationLanguage: "", romanization: false },
  });
  await page.evaluate(() => window.__cadenceHarness.unmountLyricsView());
  await page.evaluate(() => window.__cadenceHarness.patchLyricsSettings({ translationLanguage: "en" }));
  await mount({ track: { id: 711, title: "Settings Away Fixture", duration: 9 } });
  await wait(700);
  current = await dom();
  check("translation-enabled-while-away-applies-on-return", current.translated[0] === "[en] First sung line", JSON.stringify(current.translated));
  await page.evaluate(() => window.__cadenceHarness.unmountLyricsView());
  await page.evaluate(() => window.__cadenceHarness.patchLyricsSettings({ translationLanguage: "" }));
  await mount({ track: { id: 711, title: "Settings Away Fixture", duration: 9 } });
  await wait(400);
  current = await dom();
  check("translation-disabled-while-away-hides-on-return", current.translated.every(text => text === null), JSON.stringify(current.translated));
  await page.evaluate(() => window.__cadenceHarness.patchLyricsSettings({ translationLanguage: "en" }));

  // Re-resolving the same track after a provider-order change (cached parse) must re-decorate
  // instead of being skipped by the "already decorated this parse" guards.
  await page.evaluate(() => window.__cadenceHarness.configureLyrics({ translationDelayMs: 0, romanizationDelayMs: 0 }));
  await mount({
    track: { id: 712, title: "Re-resolve Fixture", duration: 9 },
    candidates: [LRC_CANDIDATE, TTML_CANDIDATE],
    settings: { translationLanguage: "en", romanization: true },
  });
  await wait(800);
  current = await dom();
  check(
    "reresolve-before-state",
    current.translated[0] === "[en] First sung line" && current.romanized[0] === "[rom] First sung line",
    `translated=${JSON.stringify(current.translated)} romanized=${JSON.stringify(current.romanized)}`
  );
  const order = (await state()).settings.providerOrder;
  const resolveCallsBefore = (await state()).calls.resolve;
  await page.evaluate(nextOrder => window.__cadenceHarness.patchLyricsSettings({ providerOrder: nextOrder }), [...order].reverse());
  await wait(1000);
  current = await dom();
  pipeline = await state();
  check(
    "reresolve-cached-parse-keeps-decorations",
    current.translated[0] === "[en] First sung line" &&
      current.romanized[0] === "[rom] First sung line" &&
      pipeline.calls.resolve > resolveCallsBefore &&
      pipeline.status === "ready",
    `translated=${JSON.stringify(current.translated)} romanized=${JSON.stringify(current.romanized)} resolveCalls=${pipeline.calls.resolve}`
  );

  // A failed romanization request must not suppress a translation running alongside it.
  await page.evaluate(() => window.__cadenceHarness.configureLyrics({ romanizationFailure: true }));
  await mount({
    track: { id: 713, title: "Mixed Failure Fixture", duration: 9 },
    candidates: [TTML_PARTIAL_CANDIDATE],
    settings: { translationLanguage: "en", romanization: true },
  });
  await wait(800);
  current = await dom();
  pipeline = await state();
  check(
    "romanization-failure-keeps-translation",
    current.translated[0] === "File translation one" &&
      current.translated[1] === "[en] 空は青い" &&
      current.romanized[0] === "sakura no hana" &&
      !pipeline.translating &&
      !pipeline.romanizing,
    `translated=${JSON.stringify(current.translated)} romanized=${JSON.stringify(current.romanized)}`
  );
  await page.evaluate(() => window.__cadenceHarness.configureLyrics({ romanizationFailure: false }));

  // A failed translation reports an error without leaving a stuck busy state; re-enabling retries.
  await page.evaluate(() => window.__cadenceHarness.configureLyrics({ translationFailure: true, chosenFile: null }));
  await mount({ track: { id: 706, title: "Remote Failure Fixture", duration: 9 }, candidates: [LRC_CANDIDATE], settings: { translationLanguage: "en" } });
  await wait(700);
  current = await dom();
  pipeline = await state();
  check(
    "translation-failure-clears-busy-and-reports",
    !pipeline.translating && !current.busy && /Translation failed/.test(pipeline.error ?? "") && current.translated.every(text => text === null),
    `translating=${pipeline.translating} error=${pipeline.error} translated=${JSON.stringify(current.translated)}`
  );
  await page.evaluate(() => window.__cadenceHarness.configureLyrics({ translationFailure: false }));
  await clickTitle("Translate lyrics");
  await clickPopoverRow(".dock-languages", "Off");
  await clickTitle("Translate lyrics");
  await clickPopoverRow(".dock-languages", "English");
  await wait(700);
  current = await dom();
  check("translation-retry-after-failure", current.translated[0] === "[en] First sung line", JSON.stringify(current.translated));
} catch (error) {
  check("harness-completed", false, error?.stack ?? String(error));
}

writeFileSync(join(artifactDir, "results.json"), JSON.stringify({ results, logs }, null, 2));
writeFileSync(join(artifactDir, "console.log"), logs.join("\n"));
console.log("\n--- renderer console ---");
console.log(logs.slice(0, 40).join("\n"));
const failures = Object.values(results).filter(entry => !entry.value);
console.log(`\n${Object.keys(results).length - failures.length}/${Object.keys(results).length} checks passed`);
await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
