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
import { createHash } from "node:crypto";
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
  const sendTrack = (id: number) => {
    const track = store.getTrack(id);
    return sendJson(track ? store.toTrack(track) : null);
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
        case "/api/library/updateTrackMetadata": {
          const { id, edit } = (body ?? {}) as { id: number; edit: Parameters<typeof store.setTrackMetadata>[1] };
          store.setTrackMetadata(id, edit);
          return sendTrack(id);
        }
        case "/api/library/resetTrackMetadata": {
          const { id } = (body ?? {}) as { id: number };
          store.clearTrackMetadata(id);
          return sendTrack(id);
        }
        case "/api/library/setTrackArtwork": {
          const { id, dataBase64, mimeType } = (body ?? {}) as {
            id: number;
            dataBase64: string;
            mimeType: string;
          };
          if (!store.getTrack(id)) return sendJson(null);
          const bytes = Buffer.from(dataBase64, "base64");
          const ext =
            mimeType === "image/png"
              ? ".png"
              : mimeType === "image/webp"
                ? ".webp"
                : mimeType === "image/gif"
                  ? ".gif"
                  : mimeType === "image/bmp"
                    ? ".bmp"
                    : ".jpg";
          const fileName = `${createHash("sha1").update(bytes).digest("hex")}${ext}`;
          const target = join(artworkDir, fileName);
          if (!existsSync(target)) writeFileSync(target, bytes);
          store.setTrackArtwork(id, fileName);
          return sendTrack(id);
        }
        case "/api/library/removeTrackArtwork": {
          const { id } = (body ?? {}) as { id: number };
          store.removeTrackArtwork(id);
          return sendTrack(id);
        }
        case "/api/library/resetTrackArtwork": {
          const { id } = (body ?? {}) as { id: number };
          store.resetTrackArtwork(id);
          return sendTrack(id);
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
        case "/api/playlists/list":
          return sendJson(store.getPlaylists());
        case "/api/playlists/create": {
          const { name, trackIds } = (body ?? {}) as { name: string; trackIds?: number[] };
          return sendJson(store.createPlaylist(name, trackIds ?? []));
        }
        case "/api/playlists/createSmart": {
          const { name, rule } = (body ?? {}) as {
            name: string;
            rule: Parameters<typeof store.createSmartPlaylist>[1];
          };
          const created = store.createSmartPlaylist(name, rule);
          return created ? sendJson(created) : sendJson({ error: "Invalid smart playlist rule" }, 400);
        }
        case "/api/playlists/updateSmart": {
          const { id, rule } = (body ?? {}) as {
            id: number;
            rule: Parameters<typeof store.updateSmartPlaylist>[1];
          };
          return store.updateSmartPlaylist(id, rule)
            ? sendJson({ ok: true })
            : sendJson({ error: "Invalid smart playlist rule" }, 400);
        }
        case "/api/playlists/rename": {
          const { id, name } = (body ?? {}) as { id: number; name: string };
          store.renamePlaylist(id, name);
          return sendJson({ ok: true });
        }
        case "/api/playlists/remove": {
          const { id } = (body ?? {}) as { id: number };
          store.deletePlaylist(id);
          return sendJson({ ok: true });
        }
        case "/api/playlists/addTracks": {
          const { id, trackIds } = (body ?? {}) as { id: number; trackIds: number[] };
          store.addTracksToPlaylist(id, trackIds);
          return sendJson({ ok: true });
        }
        case "/api/playlists/removeTrack": {
          const { id, trackId } = (body ?? {}) as { id: number; trackId: number };
          store.removeTrackFromPlaylist(id, trackId);
          return sendJson({ ok: true });
        }
        case "/api/playlists/reorder": {
          const { id, trackIds } = (body ?? {}) as { id: number; trackIds: number[] };
          store.reorderPlaylist(id, trackIds);
          return sendJson({ ok: true });
        }
        case "/api/playlists/tracks": {
          const { id } = (body ?? {}) as { id: number };
          return sendJson(
            store
              .getPlaylistTrackIds(id)
              .map(trackId => store.getTrack(trackId))
              .filter(track => track !== null)
              .map(track => store.toTrack(track)),
          );
        }
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
        updateTrackMetadata: (id: number, edit: unknown) =>
          call("/api/library/updateTrackMetadata", { id, edit }),
        resetTrackMetadata: (id: number) => call("/api/library/resetTrackMetadata", { id }),
        setTrackArtwork: async (id: number, data: ArrayBuffer, mimeType: string) => {
          const bytes = new Uint8Array(data);
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          }
          return call("/api/library/setTrackArtwork", { id, dataBase64: btoa(binary), mimeType });
        },
        removeTrackArtwork: (id: number) => call("/api/library/removeTrackArtwork", { id }),
        resetTrackArtwork: (id: number) => call("/api/library/resetTrackArtwork", { id }),
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
        list: () => call("/api/playlists/list"),
        create: (name: string, trackIds: number[] = []) =>
          call("/api/playlists/create", { name, trackIds }),
        createSmart: (name: string, rule: unknown) => call("/api/playlists/createSmart", { name, rule }),
        updateSmart: async (id: number, rule: unknown) => {
          await call("/api/playlists/updateSmart", { id, rule });
        },
        rename: async (id: number, name: string) => {
          await call("/api/playlists/rename", { id, name });
        },
        remove: async (id: number) => {
          await call("/api/playlists/remove", { id });
        },
        addTracks: async (id: number, trackIds: number[]) => {
          await call("/api/playlists/addTracks", { id, trackIds });
        },
        removeTrack: async (id: number, trackId: number) => {
          await call("/api/playlists/removeTrack", { id, trackId });
        },
        reorder: async (id: number, trackIds: number[]) => {
          await call("/api/playlists/reorder", { id, trackIds });
        },
        tracks: (id: number) => call("/api/playlists/tracks", { id }),
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
  // Wait for the view to settle (entries, empty state, or error) instead of a fixed
  // delay: on a cold first launch the bootstrap restore can outlast a short wait.
  await page
    .waitForFunction(
      () =>
        document.querySelector(
          '[data-testid="history-entry"], [data-testid="history-empty"], [data-testid="history-error"]',
        ) !== null,
      { timeout: 10_000 },
    )
    .catch(() => null);
  await wait(200);
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="history-entry"] .history-info strong')).map(
      el => el.textContent?.trim() ?? "",
    ),
  );
};

const readHomeRecentlyPlayedTitles = async (page: Page): Promise<string[]> => {
  await clickNav(page, "Home");
  // Home renders from the history store; wait until its shelves have mounted.
  await page.waitForSelector(".shelf", { timeout: 10_000 }).catch(() => null);
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
  await page.waitForSelector('[data-testid="history-empty"]', { timeout: 10_000 }).catch(() => null);
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
  await page.waitForSelector('[data-testid="history-empty"]', { timeout: 10_000 }).catch(() => null);
  const launch4EmptyVisible = Boolean(await page.$('[data-testid="history-empty"]'));
  await page.screenshot({ path: join(shotDir, "04-launch4-cleared-after-restart.png") });
  check(
    "launch4-cleared-history-persists-across-restart",
    launch4Recent.length === 0 && launch4EmptyVisible && readSqliteHistoryRows().length === 0,
    `recent=${launch4Recent.length}, emptyVisible=${launch4EmptyVisible}`,
  );

  /* =================================================================================
   * Launch 5: Listening stats & Home discovery read the same persisted history.
   * Seed controlled play starts (recent repeats + long-quiet tracks) straight into
   * SQLite, restart, and verify the rendered Stats view and Home shelves.
   * ================================================================================= */
  await page.close();
  const dayMs = 24 * 60 * 60 * 1000;
  const seedNow = Date.now();
  const libraryTracks = store.getTracks().map(t => store.toTrack(t));
  const seedPlay = (title: string, playedAt: number) => {
    const t = libraryTracks.find(candidate => candidate.title === title);
    if (!t) throw new Error(`Fixture track not found: ${title}`);
    store.addHistoryEntry(t.id, playedAt, {
      trackId: t.id,
      path: t.path,
      title: t.title,
      artist: t.artist,
      albumArtist: t.albumArtist,
      album: t.album,
      artworkUrl: t.artworkUrl,
      duration: t.duration,
    });
  };
  // Fixture Opus / Fixture ALAC were never played in the UI above, so their library
  // counters stay untouched and only these old history rows describe them.
  seedPlay("Fixture FLAC", seedNow - 2 * dayMs);
  seedPlay("Fixture FLAC", seedNow - dayMs);
  seedPlay("Fixture FLAC", seedNow - 60_000);
  seedPlay("Fixture MP3", seedNow - 30 * 60_000);
  seedPlay("Fixture Opus", seedNow - 45 * dayMs);
  seedPlay("Fixture ALAC", seedNow - 60 * dayMs);

  restartBackend("1.0.1");
  page = await launchAppPage();

  await clickNav(page, "Stats");
  await page.waitForSelector('[data-testid="stats-view"]', { timeout: 10_000 });
  await page.waitForSelector('[data-testid="stats-summary"]', { timeout: 10_000 }).catch(() => null);
  const recordedPlays = await page
    .$eval('[data-testid="stats-summary"] .stat-card strong', el => el.textContent?.trim() ?? "")
    .catch(() => "");
  const statsTopTracks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="stats-top-tracks"] .stats-rank-row')).map(
      el => el.textContent?.replace(/\s+/g, " ").trim() ?? "",
    ),
  );
  const statsBarCounts = await page.evaluate(() => ({
    days: document.querySelectorAll('[data-testid="stats-day-chart"] .stats-bar-column').length,
    hours: document.querySelectorAll('[data-testid="stats-hour-chart"] .stats-bar-column').length,
  }));
  await page.screenshot({ path: join(shotDir, "05-launch5-stats.png") });
  check(
    "launch5-stats-summary-and-top-tracks-render",
    recordedPlays === "6" &&
      (statsTopTracks[0]?.includes("Fixture FLAC") ?? false) &&
      (statsTopTracks[0]?.includes("3 plays") ?? false),
    `recorded=${recordedPlays}, top=${JSON.stringify(statsTopTracks[0] ?? "")}`,
  );
  check(
    "launch5-stats-charts-render-30-days-and-24-hours",
    statsBarCounts.days === 30 && statsBarCounts.hours === 24,
    JSON.stringify(statsBarCounts),
  );

  await clickNav(page, "Home");
  await page.waitForSelector('[data-testid="home-top-tracks"]', { timeout: 10_000 }).catch(() => null);
  const homeShelves = await page.evaluate(() => ({
    top: Array.from(document.querySelectorAll('[data-testid="home-top-tracks"] .title-text')).map(
      el => el.textContent?.trim() ?? "",
    ),
    onRepeat: Array.from(
      document.querySelectorAll('[data-testid="home-on-repeat"] [data-testid="on-repeat-item"] strong'),
    ).map(el => el.textContent?.trim() ?? ""),
    rediscover: Array.from(
      document.querySelectorAll('[data-testid="home-rediscover"] [data-testid="rediscover-item"] strong'),
    ).map(el => el.textContent?.trim() ?? ""),
  }));
  await page.screenshot({ path: join(shotDir, "06-launch5-home-shelves.png") });
  check(
    "launch5-home-discovery-shelves-render",
    homeShelves.top[0] === "Fixture FLAC" &&
      homeShelves.onRepeat.includes("Fixture FLAC") &&
      homeShelves.rediscover.includes("Fixture Opus") &&
      homeShelves.rediscover.includes("Fixture ALAC"),
    JSON.stringify(homeShelves),
  );

  /* =================================================================================
   * Launch 6: Library tools. Edit a track's title + cover in the UI, force a real
   * rescan and restart, then verify smart playlists and duplicate detection render.
   * ================================================================================= */
  const editedTitle = "Edited Fixture FLAC";
  const flacBeforeEdit = store.getTracks().find(track => track.title === "Fixture FLAC")!;
  const artworkBeforeEdit = flacBeforeEdit.artworkFile;
  const coverPath = join(stateDir, "custom-cover.png");
  writeFileSync(
    coverPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );

  const openTrackEditorByTitle = async (title: string) => {
    await clickNav(page, "Songs");
    await page.waitForSelector('[data-testid="track-row"]', { timeout: 10_000 });
    for (const row of await page.$$('[data-testid="track-row"]')) {
      const text = await row.$eval(".title-text", node => node.textContent?.trim() ?? "").catch(() => "");
      if (text !== title) continue;
      const button = await row.$('button[aria-label="More actions"]');
      if (!button) break;
      await button.click();
      await page.waitForSelector('[data-testid="track-edit-details"]', { timeout: 10_000 });
      await page.click('[data-testid="track-edit-details"]');
      await page.waitForSelector('[data-testid="track-editor"]', { timeout: 10_000 });
      return;
    }
    throw new Error(`Could not open track editor for: ${title}`);
  };

  const replaceInputValue = async (selector: string, value: string) => {
    await page.focus(selector);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await page.type(selector, value);
  };

  const saveTrackTitle = async (title: string) => {
    await replaceInputValue('[data-testid="track-editor-title"]', title);
    await page.click('[data-testid="track-editor-save"]');
    await page
      .waitForFunction(
        (expected: string) =>
          Array.from(document.querySelectorAll('[data-testid="track-row"] .title-text')).some(
            el => el.textContent?.trim() === expected,
          ),
        { timeout: 10_000 },
        title,
      )
      .catch(() => null);
    await wait(250);
  };

  await openTrackEditorByTitle("Fixture FLAC");
  const artworkInput = await page.$('[data-testid="track-editor-artwork-input"]');
  await (
    artworkInput as unknown as { uploadFile: (path: string) => Promise<void> } | null
  )?.uploadFile(coverPath);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (store.getTrack(flacBeforeEdit.id)?.artworkFile !== flacBeforeEdit.artworkFile) break;
    await wait(100);
  }
  const artworkAfterUpload = store.getTrack(flacBeforeEdit.id)?.artworkFile ?? null;
  await replaceInputValue('[data-testid="track-editor-title"]', editedTitle);
  await page.screenshot({ path: join(shotDir, "07-launch6-track-editor.png") });
  await page.click('[data-testid="track-editor-save"]');
  await page
    .waitForFunction(
      (expected: string) =>
        Array.from(document.querySelectorAll('[data-testid="track-row"] .title-text')).some(
          el => el.textContent?.trim() === expected,
        ),
      { timeout: 10_000 },
      editedTitle,
    )
    .catch(() => null);
  await wait(250);
  check(
    "launch6-track-editor-saves-metadata-and-artwork",
    store.getTrack(flacBeforeEdit.id)?.title === editedTitle &&
      artworkAfterUpload !== null &&
      artworkAfterUpload.endsWith(".png") &&
      artworkAfterUpload !== artworkBeforeEdit,
    `title=${store.getTrack(flacBeforeEdit.id)?.title}, artwork=${artworkAfterUpload}`,
  );

  // Close completely, force a genuine rescan of the files on disk, and relaunch: the
  // Cadence edit must still win over the file tags the scanner reads again.
  await page.close();
  await scanLibrary(store, { folders: [audioDir], force: true });
  restartBackend("1.0.1");
  page = await launchAppPage();
  await clickNav(page, "Songs");
  await page.waitForSelector('[data-testid="track-row"]', { timeout: 10_000 });
  const titlesAfterRescan = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="track-row"] .title-text')).map(
      el => el.textContent?.trim() ?? "",
    ),
  );
  check(
    "launch6-metadata-edit-survives-force-rescan-and-restart",
    titlesAfterRescan.includes(editedTitle) && !titlesAfterRescan.includes("Fixture FLAC"),
    JSON.stringify(titlesAfterRescan),
  );

  await clickNav(page, "Playlists");
  await page.click('[data-testid="new-smart-playlist"]');
  await page.waitForSelector('[data-testid="smart-playlist-form"]', { timeout: 10_000 });
  const smartPreviewText = await page.$eval(
    '[data-testid="smart-playlist-preview"]',
    el => el.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
  await page.type('[data-testid="smart-playlist-name"]', "Most played check");
  await page.click('[data-testid="smart-playlist-form"] button[type="submit"]');
  await page.waitForSelector('[data-testid="smart-rule-banner"]', { timeout: 10_000 });
  const smartBannerText = await page.$eval(
    '[data-testid="smart-rule-banner"]',
    el => el.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
  const smartTrackTitles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="playlist-track-list"] .title-text')).map(
      el => el.textContent?.trim() ?? "",
    ),
  );
  await page.screenshot({ path: join(shotDir, "08-launch6-smart-playlist.png") });
  check(
    "launch6-smart-playlist-renders-live-membership",
    smartPreviewText.includes("match right now") &&
      smartBannerText.includes("Most played") &&
      smartTrackTitles[0] === editedTitle,
    `preview=${smartPreviewText}; tracks=${JSON.stringify(smartTrackTitles)}`,
  );

  // Give a second fixture the same title/artist so the duplicate finder has a real pair
  // (the fixture files share artist and near-identical lengths by construction).
  await openTrackEditorByTitle("Fixture MP3");
  await saveTrackTitle(editedTitle);
  await clickNav(page, "Songs");
  await page.click('[data-testid="find-duplicates"]');
  await page.waitForSelector('[data-testid="duplicate-group"]', { timeout: 10_000 });
  const duplicatePanel = await page.evaluate(() => ({
    text: document.querySelector('[data-testid="duplicates-panel"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    paths: Array.from(document.querySelectorAll('[data-testid="duplicate-track"] .duplicate-track-copy em')).map(
      el => el.textContent?.trim() ?? "",
    ),
  }));
  await page.screenshot({ path: join(shotDir, "09-launch6-duplicates.png") });
  check(
    "launch6-duplicates-panel-groups-the-pair-with-a-keeper",
    duplicatePanel.text.includes("Recommended keeper") &&
      duplicatePanel.paths.some(path => path.endsWith("fixture.flac")) &&
      duplicatePanel.paths.some(path => path.endsWith("fixture.mp3")),
    JSON.stringify(duplicatePanel.paths),
  );

  await page.click('[data-testid="duplicate-review-all"]');
  await page.waitForSelector('[data-testid="playlist-track-list"]', { timeout: 10_000 }).catch(() => null);
  await wait(400);
  const reviewTitles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="playlist-track-list"] .title-text')).map(
      el => el.textContent?.trim() ?? "",
    ),
  );
  check(
    "launch6-duplicate-review-playlist-opens-with-both-copies",
    reviewTitles.length >= 2 && reviewTitles.every(title => title === editedTitle),
    JSON.stringify(reviewTitles),
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
