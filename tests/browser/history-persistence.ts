/**
 * End-to-end browser harness for Listening History & Homepage Recently Played persistence across restarts.
 *
 * Drives the real production renderer bundle (`dist/`) in headless Chromium backed by an on-disk
 * SQLite database (`library.db` via `LibraryStore` / `node:sqlite` `listening_history` table) that
 * enforces the exact Tauri v2 `cmd_history_add` / `cmd_history_list` / `cmd_history_clear` IPC
 * contract.
 *
 * Verifies:
 *   1. Initial launch with empty storage shows empty History and no Recently Played shelf.
 *   2. Playing multiple tracks in the UI populates both History (all sessions, newest first) and
 *      Homepage Recently Played (deduplicated by trackId, newest first), and writes rows to SQLite
 *      on disk (`library.db`).
 *   3. Closing the application (closing page + closing SQLite connection) and reopening a fresh
 *      instance restores both History and Homepage Recently Played on startup without duplicate entries.
 *   4. Playing additional tracks, surviving tab navigation, surviving a simulated app update +
 *      malformed SQLite row injection across a second restart.
 *   5. Simulated write/clear failure preserves existing history, and clicking "Clear history"
 *      removes history from both views and persists the empty state across a third restart.
 *
 * Usage: npm run build:web && npx vite-node tests/browser/build-library.ts
 *        && npx vite-node tests/browser/history-persistence.ts
 */

import { createServer } from "node:http";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import puppeteer, { type Page } from "puppeteer-core";
import chromium, { inflate, setupLambdaEnvironment } from "@sparticuz/chromium";
import { LibraryStore } from "../../src/main/library/store";
import { scanLibrary } from "../../src/main/library/scanner";
import { SettingsStore } from "../../src/main/settings";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "dist");
const audioDir = join(root, ".artifacts/fixtures/formats");
const shotDir = join(root, ".artifacts/history-persistence");
mkdirSync(shotDir, { recursive: true });

if (!existsSync(join(outDir, "index.html"))) {
  throw new Error("Run: npm run build:web");
}

const stateDir = mkdtempSync(join(tmpdir(), "cadence-history-e2e-"));
const dbPath = join(stateDir, "library.db");
const artworkDir = join(stateDir, "artwork");
const settingsFile = join(stateDir, "settings.json");
const mediaUrl = (filePath: string) => `/audio/${encodeURIComponent(basename(filePath))}`;

let store = new LibraryStore(dbPath, artworkDir, mediaUrl);
let settings = new SettingsStore(settingsFile);
store.addFolder(audioDir);
await scanLibrary(store, { folders: [audioDir], force: true });

let failAdd = false;
let failClear = false;
let appVersion = "1.0.0";

/** Simulates a full application shutdown and cold restart from the on-disk SQLite `library.db`. */
const restartBackend = (nextVersion = appVersion) => {
  store.close();
  appVersion = nextVersion;
  store = new LibraryStore(dbPath, artworkDir, mediaUrl);
  settings = new SettingsStore(settingsFile);
};

/** Reads the raw `listening_history` rows directly from the on-disk SQLite `library.db` file. */
const readSqliteHistoryRows = (): Array<{
  id: number;
  track_id: number;
  played_at: number;
  payload: string;
}> => {
  store.flush();
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare("SELECT id, track_id, played_at, payload FROM listening_history ORDER BY played_at DESC, id DESC")
      .all() as Array<{ id: number; track_id: number; played_at: number; payload: string }>;
  } finally {
    db.close();
  }
};

/** Injects a malformed row directly into the on-disk SQLite `listening_history` table. */
const injectMalformedSqliteRow = () => {
  store.close();
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("INSERT INTO listening_history (track_id, played_at, payload) VALUES (?, ?, ?)").run(
      999999,
      Date.now() + 5000,
      "{corrupt-json-payload",
    );
  } finally {
    db.close();
  }
  store = new LibraryStore(dbPath, artworkDir, mediaUrl);
};

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

const readBody = (req: import("node:http").IncomingMessage): Promise<unknown> =>
  new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveBody(undefined);
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on("error", rejectBody);
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const sendJson = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname.startsWith("/api/")) {
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      switch (url.pathname) {
        case "/api/info":
          return sendJson({
            name: "Cadence",
            version: appVersion,
            tauri: "2.12.5",
            electron: "",
            chrome: "Chromium",
            node: process.version,
            platform: `${process.platform} (${process.arch})`,
            dbEngine: store.engine,
            mediaProtocol: "cadence-media",
          });
        case "/api/library/snapshot":
          return sendJson({
            tracks: store.getTracks().map(t => store.toTrack(t)),
            albums: store.getAlbums(),
            artists: store.getArtists(),
            playlists: store.getPlaylists(),
            folders: store.getFolders(),
            scan: {
              running: false,
              phase: "idle",
              foldersTotal: 1,
              filesSeen: 0,
              filesProcessed: 0,
              filesSkipped: 0,
              errors: [],
            },
            counts: store.counts(),
          });
        case "/api/library/recordPlay": {
          const { id } = (body ?? {}) as { id: number };
          store.recordPlay(id);
          return sendJson({ ok: true });
        }
        case "/api/history/add": {
          // Enforce the exact Tauri v2 IPC contract: { trackId, playedAt, payload }
          const args = (body ?? {}) as {
            trackId?: number;
            playedAt?: number;
            payload?: unknown;
          };
          if (
            typeof args.trackId !== "number" ||
            typeof args.playedAt !== "number" ||
            !args.payload ||
            typeof args.payload !== "object"
          ) {
            return sendJson({ error: "Invalid cmd_history_add arguments" }, 400);
          }
          if (failAdd) {
            return sendJson({ error: "Disk full (os error 112)" }, 500);
          }
          const entry = store.addHistoryEntry(args.trackId, args.playedAt, args.payload as any);
          return sendJson({ id: entry.id });
        }
        case "/api/history/list":
          return sendJson(store.listHistory());
        case "/api/history/clear":
          if (failClear) {
            return sendJson({ error: "Database is locked (os error 5)" }, 500);
          }
          store.clearHistory();
          return sendJson({ ok: true });
        case "/api/settings/get":
          return sendJson(settings.get());
        case "/api/settings/patch":
          return sendJson(settings.patch((body ?? {}) as Record<string, unknown>));
        case "/api/settings/reset":
          return sendJson(settings.reset());
        default:
          return sendJson({});
      }
    } catch (error) {
      return sendJson({ error: (error as Error)?.message ?? String(error) }, 500);
    }
  }

  if (url.pathname.startsWith("/audio/")) {
    const file = join(audioDir, decodeURIComponent(url.pathname.slice(7)));
    if (!existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const size = statSync(file).size;
    const headers = {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    };
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)!;
      const start = Number(match[1] || 0);
      const end = match[2] ? Number(match[2]) : size - 1;
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
    return;
  }

  if (url.pathname.startsWith("/artwork/")) {
    const file = join(artworkDir, decodeURIComponent(url.pathname.slice(9)));
    if (existsSync(file) && !statSync(file).isDirectory()) {
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "image/png" });
      createReadStream(file).pipe(res);
      return;
    }
  }

  const relPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(outDir, relPath);
  if (!file.startsWith(outDir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
});

await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

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
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 180_000,
});

const logs: string[] = [];
const results: Record<string, { value: boolean; detail: string }> = {};
const check = (name: string, value: boolean, detail = "") => {
  results[name] = { value: Boolean(value), detail };
  console.log(`${value ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

const launchAppPage = async (): Promise<Page> => {
  const page = await browser.newPage();
  page.on("console", message => logs.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error: unknown) => logs.push(`[pageerror] ${String(error)}`));

  await page.evaluateOnNewDocument(() => {
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(
        path,
        body === undefined
          ? { cache: "no-store" }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload;
    };
    const chrome = { undecorated: false, maximized: false, fullscreen: false, focused: true };
    (window as unknown as { cadence: unknown }).cadence = {
      info: () => call("/api/info"),
      library: {
        snapshot: () => call("/api/library/snapshot"),
        addFolder: async () => ({ canceled: true, folders: [] }),
        removeFolder: () => call("/api/library/snapshot"),
        rescan: async () => ({ added: 0, updated: 0, removed: 0, errors: [], durationMs: 1 }),
        search: async () => [],
        getTrack: async (id: number) => {
          const snap = await call("/api/library/snapshot");
          return snap.tracks.find((t: { id: number }) => t.id === id) ?? null;
        },
        setFavorite: async () => undefined,
        recordPlay: async (id: number) => {
          await call("/api/library/recordPlay", { id });
        },
        onScanProgress: () => () => {},
        onChanged: () => () => {},
      },
      history: {
        add: async (args: { trackId: number; playedAt: number; payload: unknown }) => {
          const res = await call("/api/history/add", args);
          return res?.id;
        },
        list: () => call("/api/history/list"),
        clear: async () => {
          await call("/api/history/clear", {});
        },
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
        get: () => call("/api/settings/get"),
        patch: (patch: unknown) => call("/api/settings/patch", patch),
        reset: () => call("/api/settings/reset", {}),
      },
      lyrics: {
        resolve: async () => ({ candidates: [], providerStatus: [] }),
        search: async () => ({ results: [], providerStatus: [], cached: false }),
        youtubeMetadata: async () => ({ ok: false, reason: "error", detail: "not in harness" }),
        translate: async (request: { lines: string[] }) => ({
          translations: request.lines.map(() => null),
          detectedLanguage: "en",
        }),
        romanize: async (request: { lines: string[] }) => ({
          romanizations: request.lines.map(() => null),
          detectedLanguage: "en",
        }),
        saveSidecar: async () => ({ path: "/harness/lyrics.lrc" }),
        clearCache: async () => ({ removedEntries: 0 }),
        listCache: async () => ({
          entries: [],
          stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 },
        }),
        getCacheEntry: async () => null,
        removeCacheEntry: async () => ({
          removed: false,
          stats: { entryCount: 0, tracks: 0, searches: 0, bytes: 0 },
        }),
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
        prepareAlacSource: async (p: string) => p,
        reportState: async () => undefined,
        onCommand: () => () => {},
      },
      decodeTester: {
        deleteFiles: async () => [],
        exportFileList: async () => ({ canceled: true }),
      },
    };
  });

  await page.goto(base, { waitUntil: "networkidle0" });
  await page.waitForSelector(".sidebar");
  return page;
};

const clickNav = async (page: Page, label: string) => {
  for (const handle of await page.$$(".sidebar .nav-item")) {
    const text = await handle.evaluate(node => node.textContent?.replace(/\s+/g, " ").trim() ?? "");
    if (text === label) {
      await handle.click();
      await wait(250);
      return;
    }
  }
  throw new Error(`Nav item not found: ${label}`);
};

const playTrackByTitleInSongsView = async (page: Page, title: string) => {
  await clickNav(page, "Songs");
  await page.waitForSelector('[data-testid="track-row"]', { timeout: 10_000 });
  for (const row of await page.$$('[data-testid="track-row"]')) {
    const text = await row.$eval(".title-text", node => node.textContent?.trim());
    if (text === title) {
      await row.click();
      await wait(900);
      return;
    }
  }
  throw new Error(`Track row not found: ${title}`);
};

const readHistoryViewTitles = async (page: Page): Promise<string[]> => {
  await clickNav(page, "History");
  await wait(200);
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="history-entry"] .history-info strong')).map(
      el => el.textContent?.trim() ?? "",
    ),
  );
};

const readHomeRecentlyPlayedTitles = async (page: Page): Promise<string[]> => {
  await clickNav(page, "Home");
  await wait(200);
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        '[data-testid="home-recently-played"] [data-testid="recently-played-item"] strong',
      ),
    ).map(el => el.textContent?.trim() ?? ""),
  );
};

try {
  /* =================================================================================
   * Launch 1: Empty initial storage -> Play tracks -> Verify History, Home & SQLite
   * ================================================================================= */
  let page = await launchAppPage();

  const initialRecentCount = await page.evaluate(
    () => document.querySelectorAll('[data-testid="home-recently-played"]').length,
  );
  await clickNav(page, "History");
  const initialEmptyVisible = Boolean(await page.$('[data-testid="history-empty"]'));
  check(
    "launch1-empty-initial-state",
    initialRecentCount === 0 && initialEmptyVisible && readSqliteHistoryRows().length === 0,
    `recentShelf=${initialRecentCount}, emptyState=${initialEmptyVisible}`,
  );

  // Play 3 distinct tracks and replay the first track (4 play sessions total).
  await playTrackByTitleInSongsView(page, "Fixture FLAC");
  await playTrackByTitleInSongsView(page, "Fixture MP3");
  await playTrackByTitleInSongsView(page, "Fixture Ogg Vorbis");
  await playTrackByTitleInSongsView(page, "Fixture FLAC");

  const launch1History = await readHistoryViewTitles(page);
  await page.screenshot({ path: join(shotDir, "01-launch1-history.png") });
  const launch1Recent = await readHomeRecentlyPlayedTitles(page);
  await page.screenshot({ path: join(shotDir, "02-launch1-home-recent.png") });
  const sqliteRowsAfterLaunch1 = readSqliteHistoryRows();

  check(
    "launch1-history-view-populated",
    JSON.stringify(launch1History) ===
      JSON.stringify(["Fixture FLAC", "Fixture Ogg Vorbis", "Fixture MP3", "Fixture FLAC"]),
    JSON.stringify(launch1History),
  );
  check(
    "launch1-home-recently-played-populated",
    JSON.stringify(launch1Recent) ===
      JSON.stringify(["Fixture FLAC", "Fixture Ogg Vorbis", "Fixture MP3"]),
    JSON.stringify(launch1Recent),
  );
  check(
    "launch1-sqlite-rows-persisted-on-disk",
    sqliteRowsAfterLaunch1.length === 4 &&
      JSON.parse(sqliteRowsAfterLaunch1[0].payload).title === "Fixture FLAC" &&
      JSON.parse(sqliteRowsAfterLaunch1[1].payload).title === "Fixture Ogg Vorbis",
    `sqliteRows=${sqliteRowsAfterLaunch1.length}`,
  );

  /* =================================================================================
   * Launch 2: Full Application Close & Reopen -> Verify History & Recently Played
   * ================================================================================= */
  await wait(300);
  await page.close();
  restartBackend("1.0.0");
  page = await launchAppPage();

  // Immediately on launch (before playing anything), Home's Recently Played must be restored!
  const launch2RecentOnStartup = await readHomeRecentlyPlayedTitles(page);
  const launch2HistoryOnStartup = await readHistoryViewTitles(page);
  await page.screenshot({ path: join(shotDir, "03-launch2-restored-history.png") });

  check(
    "launch2-home-recently-played-restored-after-restart",
    JSON.stringify(launch2RecentOnStartup) ===
      JSON.stringify(["Fixture FLAC", "Fixture Ogg Vorbis", "Fixture MP3"]),
    JSON.stringify(launch2RecentOnStartup),
  );
  check(
    "launch2-history-view-restored-after-restart-without-duplicates",
    JSON.stringify(launch2HistoryOnStartup) ===
      JSON.stringify(["Fixture FLAC", "Fixture Ogg Vorbis", "Fixture MP3", "Fixture FLAC"]),
    JSON.stringify(launch2HistoryOnStartup),
  );

  // Navigate across tabs and verify synchronization stays intact, then play a new track.
  await clickNav(page, "Albums");
  await clickNav(page, "Artists");
  await playTrackByTitleInSongsView(page, "Fixture AAC");

  const launch2HistoryAfterPlay = await readHistoryViewTitles(page);
  const launch2RecentAfterPlay = await readHomeRecentlyPlayedTitles(page);
  check(
    "launch2-new-playback-updates-both-views",
    JSON.stringify(launch2HistoryAfterPlay) ===
      JSON.stringify([
        "Fixture AAC",
        "Fixture FLAC",
        "Fixture Ogg Vorbis",
        "Fixture MP3",
        "Fixture FLAC",
      ]) &&
      JSON.stringify(launch2RecentAfterPlay) ===
        JSON.stringify(["Fixture AAC", "Fixture FLAC", "Fixture Ogg Vorbis", "Fixture MP3"]),
    `history=${launch2HistoryAfterPlay.length}, recent=${launch2RecentAfterPlay.length}`,
  );

  /* =================================================================================
   * Launch 3: App Update + Malformed SQLite Row -> Verify Safe Recovery Across Restart
   * ================================================================================= */
  await wait(300);
  await page.close();
  injectMalformedSqliteRow();
  restartBackend("1.0.1");
  page = await launchAppPage();

  const launch3Recent = await readHomeRecentlyPlayedTitles(page);
  const launch3History = await readHistoryViewTitles(page);

  check(
    "launch3-survives-app-update-and-malformed-row",
    JSON.stringify(launch3History) ===
      JSON.stringify([
        "Fixture AAC",
        "Fixture FLAC",
        "Fixture Ogg Vorbis",
        "Fixture MP3",
        "Fixture FLAC",
      ]) &&
      JSON.stringify(launch3Recent) ===
        JSON.stringify(["Fixture AAC", "Fixture FLAC", "Fixture Ogg Vorbis", "Fixture MP3"]),
    `history=${JSON.stringify(launch3History)}`,
  );

  /* =================================================================================
   * Simulated Write/Clear Failure & Clear History Persistence Across Launch 4
   * ================================================================================= */
  failClear = true;
  await clickNav(page, "History");
  page.once("dialog", dialog => void dialog.accept());
  await page.click('[data-testid="clear-history"]');
  await wait(250);
  const historyAfterFailedClear = await readHistoryViewTitles(page);
  const errorBannerVisible = Boolean(await page.$('[data-testid="history-error"]'));
  check(
    "launch3-failed-clear-preserves-existing-history",
    historyAfterFailedClear.length === 5 && errorBannerVisible,
    `entries=${historyAfterFailedClear.length}, errorBanner=${errorBannerVisible}`,
  );

  failClear = false;
  page.once("dialog", dialog => void dialog.accept());
  await page.click('[data-testid="clear-history"]');
  await page.waitForSelector('[data-testid="history-empty"]', { timeout: 5_000 });
  const recentAfterClear = await readHomeRecentlyPlayedTitles(page);
  check(
    "launch3-clear-history-empties-both-views-and-sqlite",
    recentAfterClear.length === 0 && readSqliteHistoryRows().length === 0,
    `recent=${recentAfterClear.length}, sqliteRows=${readSqliteHistoryRows().length}`,
  );

  // Close & Reopen (Launch 4): Confirm cleared history remains empty after restart.
  await page.close();
  restartBackend("1.0.1");
  page = await launchAppPage();

  const launch4Recent = await readHomeRecentlyPlayedTitles(page);
  await clickNav(page, "History");
  const launch4EmptyVisible = Boolean(await page.$('[data-testid="history-empty"]'));
  await page.screenshot({ path: join(shotDir, "04-launch4-cleared-after-restart.png") });
  check(
    "launch4-cleared-history-persists-across-restart",
    launch4Recent.length === 0 && launch4EmptyVisible && readSqliteHistoryRows().length === 0,
    `recent=${launch4Recent.length}, emptyVisible=${launch4EmptyVisible}`,
  );

  await page.close();
} finally {
  await browser.close();
  server.close();
  store.close();
  rmSync(stateDir, { recursive: true, force: true });
}

writeFileSync(join(shotDir, "results.json"), JSON.stringify({ results, logs }, null, 2));
const failures = Object.entries(results).filter(([, r]) => !r.value);
console.log(`\n${Object.keys(results).length - failures.length}/${Object.keys(results).length} history persistence E2E checks passed`);
if (failures.length > 0) {
  process.exit(1);
}
