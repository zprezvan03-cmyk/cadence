import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

import { installTauriBridge } from "../../src/tauri/bridge";
import { setRuntimeFetch } from "../../src/main/lyrics/http";
import { emptyDatabase, type DatabaseShape, type StoredTrack } from "../../src/main/library/storeCore";
import { readTrackMetadataCore } from "../../src/main/library/metadataCore";
import { MediaAllowlist, handleMediaRequest, tauriArtworkUrl } from "../../src/main/protocol";
import { serveFile } from "../../src/main/media/staticFile";
import { inferArtworkMimeType } from "../../src/main/media/protocolHandler";

const rootDir = resolve(import.meta.dirname, "../..");
const fixturesDir = join(rootDir, ".artifacts/fixtures/formats");

describe("Tauri v2 migration — configuration, RangeTokenizer, and desktop bridge", () => {
  beforeEach(() => {
    if (typeof (globalThis as { window?: unknown }).window === "undefined") {
      (globalThis as unknown as { window: unknown }).window = globalThis;
    }
  });

  afterEach(() => {
    clearMocks();
    setRuntimeFetch((...args) => globalThis.fetch(...args));
    delete (globalThis as { cadence?: unknown }).cadence;
  });

  it("validates tauri.conf.json window/bundle configuration and least-privilege capabilities", () => {
    const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
    const conf = JSON.parse(readFileSync(join(rootDir, "src-tauri/tauri.conf.json"), "utf8"));
    const schema = JSON.parse(
      readFileSync(join(rootDir, "node_modules/@tauri-apps/cli/config.schema.json"), "utf8")
    );

    // Every top-level key in tauri.conf.json must exist in the official @tauri-apps/cli 2.12 schema
    const allowedTopKeys = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(conf)) {
      expect(allowedTopKeys.has(key)).toBe(true);
    }

    expect(conf.productName).toBe("Cadence");
    expect(conf.identifier).toBe("app.cadence.player");
    expect(conf.version).toBe("0.1.0");

    // WebView2 owns the existing SMTC session. Its host process must claim the same AUMID that
    // Tauri writes to the Cadence shortcut, before the window and media session are created.
    const windowsEntryPoint = readFileSync(join(rootDir, "src-tauri/src/main.rs"), "utf8");
    expect(windowsEntryPoint).toContain("SetCurrentProcessExplicitAppUserModelID");
    expect(windowsEntryPoint).toContain(`windows::core::w!("${conf.identifier}")`);
    expect(windowsEntryPoint.indexOf("configure_windows_app_identity();")).toBeLessThan(
      windowsEntryPoint.indexOf("cadence_lib::run();")
    );
    expect(conf.build.frontendDist).toBe("../dist");

    // beforeDevCommand and beforeBuildCommand must reference existing npm scripts in package.json
    for (const cmdKey of ["beforeDevCommand", "beforeBuildCommand"] as const) {
      const rawCmd = String(conf.build[cmdKey] ?? "");
      const scriptMatch = rawCmd.match(/^npm run ([\w:-]+)$/);
      expect(scriptMatch).not.toBeNull();
      expect(typeof pkg.scripts?.[scriptMatch![1]]).toBe("string");
    }

    const mainWindow = conf.app.windows[0];
    expect(mainWindow.width).toBe(1440);
    expect(mainWindow.height).toBe(920);
    expect(mainWindow.minWidth).toBe(1040);
    expect(mainWindow.minHeight).toBe(680);
    expect(mainWindow.backgroundColor).toBe("#08080b");
    expect(mainWindow.backgroundThrottling).toBe("disabled");

    // Windows icons must exist on disk
    for (const relIcon of conf.bundle.icon) {
      const full = join(rootDir, "src-tauri", relIcon);
      expect(existsSync(full)).toBe(true);
      expect(statSync(full).size).toBeGreaterThan(256);
    }

    // The integrated Windows title bar requires an undecorated window. Platform configs replace the
    // base `app.windows` array wholesale (JSON Merge Patch), so the Windows overlay must repeat every
    // base field or the window silently falls back to defaults.
    const winConf = JSON.parse(
      readFileSync(join(rootDir, "src-tauri/tauri.windows.conf.json"), "utf8")
    );
    const winWindow = winConf.app.windows[0];
    expect(mainWindow.decorations).toBeUndefined();
    expect(winWindow.decorations).toBe(false);
    expect(Object.keys(winWindow).sort()).toEqual([...Object.keys(mainWindow), "decorations"].sort());
    for (const key of Object.keys(mainWindow)) {
      expect(winWindow[key]).toEqual(mainWindow[key]);
    }

    // Capabilities must enforce least privilege (no arbitrary shell or unrestricted fs plugins)
    const cap = JSON.parse(
      readFileSync(join(rootDir, "src-tauri/capabilities/default.json"), "utf8")
    );
    expect(cap.local).toBe(true);
    expect(cap.windows).toEqual(["main"]);
    for (const perm of cap.permissions as string[]) {
      expect(perm.startsWith("shell:")).toBe(false);
      expect(perm.startsWith("fs:")).toBe(false);
    }
    // The custom title bar's drag region needs these two core window permissions.
    expect(cap.permissions).toContain("core:window:allow-start-dragging");
    expect(cap.permissions).toContain("core:window:allow-internal-toggle-maximize");
  });

  it("extracts FLAC and MP3 tags, cover artwork SHA-1, and embedded lyrics via RangeTokenizer", async () => {
    const flacPath = join(fixturesDir, "fixture.flac");
    const flacBytes = readFileSync(flacPath);
    let rangeReads = 0;
    const savedArtwork = new Map<string, Uint8Array>();

    const parsed = await readTrackMetadataCore("C:\\Users\\Alice\\Music\\fixture.flac", {
      fileSize: flacBytes.byteLength,
      mtimeMs: 1_700_000_000_000,
      readChunk: async (offset, length) => {
        rangeReads += 1;
        return new Uint8Array(flacBytes.subarray(offset, offset + length));
      },
      saveArtwork: async (data, format) => {
        expect(format).toContain("image/png");
        savedArtwork.set("cover", data);
        return "deadbeef".repeat(5) + ".png";
      },
      fileExists: candidate => candidate.endsWith("fixture.lrc"),
    });

    expect(parsed.title).toBe("Fixture FLAC");
    expect(parsed.artist).toBe("Harness Artist");
    expect(parsed.album).toBe("Test Bench");
    expect(parsed.duration).toBeGreaterThan(2);
    expect(parsed.hasSidecarLyrics).toBe(true);
    expect(parsed.artworkFile).toBe("deadbeef".repeat(5) + ".png");
    expect(savedArtwork.get("cover")?.subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    // 64 KiB read-ahead window parses FLAC headers + cover art + ID3v1 tail in a handful of reads
    expect(rangeReads).toBeLessThanOrEqual(6);
  });

  it("infers accurate artwork MIME types for Windows SMTC MediaMetadata", () => {
    const pngUrl = tauriArtworkUrl(
      "C:\\Users\\Alice\\AppData\\Roaming\\app.cadence.player\\artwork",
      "0123456789abcdef0123456789abcdef01234567.png",
      "win32"
    );
    const webpUrl = tauriArtworkUrl(
      "C:\\Users\\Alice\\AppData\\Roaming\\app.cadence.player\\artwork",
      "0123456789abcdef0123456789abcdef01234567.webp",
      "win32"
    );
    const jpgUrl = tauriArtworkUrl(
      "C:\\Users\\Alice\\AppData\\Roaming\\app.cadence.player\\artwork",
      "0123456789abcdef0123456789abcdef01234567.jpg",
      "win32"
    );
    expect(inferArtworkMimeType(pngUrl)).toBe("image/png");
    expect(inferArtworkMimeType(webpUrl)).toBe("image/webp");
    expect(inferArtworkMimeType(jpgUrl)).toBe("image/jpeg");
  });

  it("drives library scan, SQLite persistence, settings, offline lyrics cache, cancellation, and events over Tauri IPC", async () => {
    const flacBytes = readFileSync(join(fixturesDir, "fixture.flac"));
    const winMusicRoot = "C:\\Users\\Alice\\Music";
    const winFlacPath = "C:\\Users\\Alice\\Music\\fixture.flac";
    const winAppData = "C:\\Users\\Alice\\AppData\\Roaming\\app.cadence.player";
    const winArtworkDir = `${winAppData}\\artwork`;

    // Simulated persistent Rust state across app restarts
    const persistedDb: DatabaseShape = emptyDatabase();
    let persistedSettingsJson: string | null = null;
    let persistedLyricsCacheJson: string | null = null;
    let allowlistRoots: string[] = [];
    const savedArtFiles = new Map<string, Buffer>();
    const abortedHttpIds: string[] = [];
    const openedUrls: string[] = [];
    const revealedPaths: string[] = [];
    const windowActions: string[] = [];
    const lyricLoads: number[] = [];
    let httpCallCount = 0;

    const installBackendMock = () => {
      mockIPC(
        async (cmd, payload: any) => {
          switch (cmd) {
            case "cmd_bootstrap":
              return {
                appDataDir: winAppData,
                artworkDir: winArtworkDir,
                platform: "win32",
                arch: "x86_64",
                appVersion: "0.1.0",
                tauriVersion: "2.12.5",
                settingsJson: persistedSettingsJson,
                lyricsCacheJson: persistedLyricsCacheJson,
                // Rust bootstrap deliberately omits embedded text; it is read per track below.
                dbSnapshot: { ...structuredClone(persistedDb), lyrics: {} },
                startupFiles: [],
                undecorated: true,
              };

            case "cmd_allowlist_sync":
              allowlistRoots = [...(payload?.roots ?? [])];
              return null;

            case "cmd_pick_folder":
              return winMusicRoot;

            case "cmd_walk_folders":
              return {
                files: [
                  {
                    path: winFlacPath,
                    size: flacBytes.byteLength,
                    mtimeMs: 1_700_000_000_000,
                    hasSidecarLyrics: false,
                    animatedArtPath: null,
                  },
                ],
                errors: [],
              };

            case "cmd_read_file_chunk": {
              const { offset, length } = payload;
              const slice = flacBytes.subarray(offset, offset + length);
              return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
            }

            case "cmd_save_artwork": {
              // Raw `Uint8Array` request body; the real command reads the filename from headers.
              savedArtFiles.set("cover", Buffer.from(payload));
              return "cover";
            }

            case "cmd_load_lyrics":
              lyricLoads.push(payload.trackId);
              return persistedDb.lyrics[String(payload.trackId)] ?? null;

            case "cmd_db_mutate": {
              for (const op of payload.ops) {
                if (op.op === "upsertTrack") {
                  const parsed = JSON.parse(op.payload) as StoredTrack;
                  const idx = persistedDb.tracks.findIndex(t => t.id === op.id);
                  if (idx >= 0) persistedDb.tracks[idx] = parsed;
                  else persistedDb.tracks.push(parsed);
                } else if (op.op === "deleteTrack") {
                  persistedDb.tracks = persistedDb.tracks.filter(t => t.id !== op.id);
                } else if (op.op === "setLyrics") {
                  persistedDb.lyrics[String(op.trackId)] = JSON.parse(op.payload);
                } else if (op.op === "deleteLyrics") {
                  delete persistedDb.lyrics[String(op.trackId)];
                } else if (op.op === "upsertPlaylist") {
                  const row = JSON.parse(op.payload);
                  const idx = persistedDb.playlists.findIndex(p => p.id === op.id);
                  if (idx >= 0) persistedDb.playlists[idx] = row;
                  else persistedDb.playlists.push(row);
                  persistedDb.nextPlaylistId = op.nextPlaylistId;
                } else if (op.op === "deletePlaylist") {
                  persistedDb.playlists = persistedDb.playlists.filter(p => p.id !== op.id);
                } else if (op.op === "addFolder") {
                  if (!persistedDb.folders.includes(op.path)) persistedDb.folders.push(op.path);
                } else if (op.op === "removeFolder") {
                  persistedDb.folders = persistedDb.folders.filter(f => f !== op.path);
                }
              }
              return null;
            }

            case "cmd_write_user_json":
              if (payload.kind === "settings") persistedSettingsJson = payload.content;
              if (payload.kind === "lyricsCache") persistedLyricsCacheJson = payload.content;
              return null;

            case "cmd_read_sidecar_text":
              return null;

            case "cmd_http_abort":
              abortedHttpIds.push(payload.requestId);
              return null;

            case "cmd_http_fetch": {
              httpCallCount += 1;
              const url = String(payload.args.url);
              if (url.includes("slow-track")) {
                await new Promise(r => setTimeout(r, 150));
                if (abortedHttpIds.includes(payload.args.requestId)) {
                  throw "ABORTED";
                }
              }
              if (url.includes("youtube.com/oembed")) {
                return {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    title: "Midnight City",
                    author_name: "M83 - Topic",
                    thumbnail_url: "https://i.ytimg.com/vi/dX3k_QDnzHE/hqdefault.jpg",
                  }),
                };
              }
              if (url.includes("youtube.com/watch")) {
                return {
                  status: 200,
                  headers: { "content-type": "text/html" },
                  body: '<html>"lengthSeconds":"243"</html>',
                };
              }
              if (url.includes("lrclib.net/api/get")) {
                return {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    id: 42,
                    trackName: "Fixture FLAC",
                    artistName: "Harness Artist",
                    albumName: "Test Bench",
                    duration: 4,
                    instrumental: false,
                    syncedLyrics: "[00:00.50]Hello from Tauri LRCLIB",
                    plainLyrics: "Hello from Tauri LRCLIB",
                  }),
                };
              }
              return { status: 404, headers: {}, body: "" };
            }

            case "cmd_shell_open_external":
              openedUrls.push(payload.url);
              return null;

            case "cmd_shell_show_in_folder":
              revealedPaths.push(payload.path);
              return null;

            case "cmd_window_action":
              windowActions.push(payload.action);
              return null;

            case "cmd_window_is_fullscreen":
              return windowActions.at(-1) === "fullscreen";

            case "cmd_window_chrome_state":
              return {
                undecorated: true,
                maximized: windowActions.at(-1) === "maximize",
                fullscreen: windowActions.at(-1) === "fullscreen",
                focused: true,
              };

            default:
              return null;
          }
        },
        { shouldMockEvents: true }
      );
    };

    installBackendMock();
    const firstSession = await installTauriBridge();
    const { api } = firstSession;

    // 1. Runtime info
    const info = await api.info();
    expect(info.name).toBe("Cadence");
    expect(info.tauri).toBe("2.12.5");
    expect(info.dbEngine).toBe("sqlite");
    expect(info.mediaProtocol).toBe("cadence-media");

    // 2. Folder picker + library scan + WebView2 `cadence-media.localhost` streaming
    const addRes = await api.library.addFolder();
    expect(addRes.canceled).toBe(false);
    expect(addRes.result?.added).toBe(1);
    expect(savedArtFiles.get("cover")?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(allowlistRoots).toEqual([winMusicRoot]);

    const snap = await api.library.snapshot();
    expect(snap.tracks).toHaveLength(1);
    const track = snap.tracks[0];
    expect(track.title).toBe("Fixture FLAC");
    expect(track.streamUrl).toMatch(/^http:\/\/cadence-media\.localhost\/file\//);
    expect(track.artworkUrl).toMatch(/^http:\/\/cadence-media\.localhost\/art\//);

    // Verify WebView2 URL serves HTTP 206 Range via `handleMediaRequest`
    const allowlist = new MediaAllowlist("win32");
    allowlist.setRoots(allowlistRoots);
    const rangeRes = await handleMediaRequest(
      new Request(track.streamUrl, { headers: { Range: "bytes=0-3" } }),
      {
        allowlist,
        artworkDirectory: winArtworkDir,
        platform: "win32",
        serve: (_resolved, req) => serveFile(join(fixturesDir, "fixture.flac"), req),
      }
    );
    expect(rangeRes.status).toBe(206);
    expect(Buffer.from(await rangeRes.arrayBuffer()).toString("ascii")).toBe("fLaC");

    // 3. Settings + Playlists + Favorites persist across restart
    await api.settings.patch({ playback: { volume: 0.42 }, appearance: { accent: "#22d3ee" } });
    await api.library.setFavorite(track.id, true);
    const playlist = await api.playlists.create("Night Drive", [track.id]);
    expect(playlist.trackCount).toBe(1);

    // 4. Request cancellation:
    //    - superseded `resolve` rejects immediately with AbortError so stale tracks never win
    //    - superseded `search` aborts the underlying native Rust HTTP socket via `cmd_http_abort`
    const slowResolve = api.lyrics.resolve({
      trackId: 999,
      title: "slow-track",
      artist: "Slow Artist",
      album: "",
      duration: 180,
    });
    const fastResolve = await api.lyrics.resolve({
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
    });
    await expect(slowResolve).rejects.toMatchObject({ name: "AbortError" });
    expect(fastResolve.candidates.some(c => c.source === "lrclib-synced")).toBe(true);

    const slowSearch = api.lyrics.search({
      title: "slow-track",
      artist: "Slow Artist",
      album: "",
      duration: 180,
    });
    await new Promise(r => setTimeout(r, 15));
    const fastSearch = await api.lyrics.search({
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
    });
    await expect(slowSearch).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedHttpIds.length).toBeGreaterThan(0);
    expect(Array.isArray(fastSearch.results)).toBe(true);

    // 5. YouTube keyless oEmbed + watch duration lookup via Tauri native HTTP
    const yt = await api.lyrics.youtubeMetadata({
      url: "https://music.youtube.com/watch?v=dX3k_QDnzHE",
    });
    expect(yt.ok).toBe(true);
    if (yt.ok) {
      expect(yt.metadata.title).toBe("Midnight City");
      expect(yt.metadata.artist).toBe("M83");
      expect(yt.metadata.durationSeconds).toBe(243);
    }

    // 6. Native media key & menu event forwarding + window/shell commands
    const receivedCommands: string[] = [];
    const unsubCmd = api.player.onCommand(cmd => receivedCommands.push(cmd));
    await emit("cadence://player-command", "toggle");
    await emit("cadence://player-command", "next");
    expect(receivedCommands).toEqual(["play-pause", "next"]);
    unsubCmd();

    await api.app.openExternal("https://github.com/better-lyrics/better-lyrics");
    await api.app.openPath(track.path);
    await api.app.window("fullscreen");
    expect(await api.app.isFullScreen()).toBe(true);
    await api.app.window("exitFullscreen");
    expect(await api.app.isFullScreen()).toBe(false);

    // Integrated title bar: the startup snapshot is synchronous, the live state follows the window.
    expect(api.app.initialWindowChrome.undecorated).toBe(true);
    expect(await api.app.windowChrome()).toMatchObject({ undecorated: true, fullscreen: false });
    await api.app.window("maximize");
    expect(windowActions.at(-1)).toBe("maximize");
    expect((await api.app.windowChrome()).maximized).toBe(true);
    await api.app.window("restore");
    expect((await api.app.windowChrome()).maximized).toBe(false);
    expect(openedUrls).toEqual(["https://github.com/better-lyrics/better-lyrics"]);
    expect(revealedPaths).toEqual([winFlacPath]);

    const callsBeforeRestart = httpCallCount;
    firstSession.dispose();
    clearMocks();

    // 7. Restart Tauri bridge from persisted SQLite + JSON files and verify offline cache hit!
    installBackendMock();
    const secondSession = await installTauriBridge();
    const reloadedSettings = await secondSession.api.settings.get();
    expect(reloadedSettings.playback.volume).toBe(0.42);
    expect(reloadedSettings.appearance.accent).toBe("#22d3ee");

    const reloadedSnap = await secondSession.api.library.snapshot();
    expect(reloadedSnap.tracks).toHaveLength(1);
    expect(reloadedSnap.tracks[0].favorite).toBe(true);
    expect(reloadedSnap.playlists).toHaveLength(1);
    expect(reloadedSnap.playlists[0].name).toBe("Night Drive");

    // Cached lyrics resolve with zero network requests!
    const cachedLyrics = await secondSession.api.lyrics.resolve({
      trackId: reloadedSnap.tracks[0].id,
      title: reloadedSnap.tracks[0].title,
      artist: reloadedSnap.tracks[0].artist,
      album: reloadedSnap.tracks[0].album,
      duration: reloadedSnap.tracks[0].duration,
    });
    expect(httpCallCount).toBe(callsBeforeRestart);
    expect(cachedLyrics.candidates.some(c => c.cached && c.source === "lrclib-synced")).toBe(true);
    expect(cachedLyrics.candidates.some(c => c.source === "embedded-tag" && c.text.includes("Fixture first line"))).toBe(true);
    expect(lyricLoads.at(-1)).toBe(reloadedSnap.tracks[0].id);

    secondSession.dispose();
  });
});
