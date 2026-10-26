/**
 * Tauri v2 desktop bridge (`window.cadence`).
 *
 * Implements the full `CadenceApi` contract for Windows (WebView2) and desktop targets by pairing
 * Cadence's runtime-agnostic TypeScript cores (`LibraryStoreCore`, `scanLibraryCore`,
 * `readTrackMetadataCore`, `LyricsServiceCore`, `LyricsCacheCore`, `SettingsCore`, translation,
 * romanization, and YouTube metadata) with scoped Rust commands (`@tauri-apps/api/core` + `event`).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  CadenceApi,
  LibraryScanResult,
  LibrarySnapshot,
  MediaCommand,
  PlayerSnapshot,
  ScanProgress,
  Track,
  WindowChromeState,
} from "../shared/types";
import { isPathInside, type PathPlatform } from "../main/media/allowlist";
import { toTauriMediaUrl } from "../main/media/protocolHandler";
import { SettingsCore } from "../main/settingsCore";
import { LyricsCacheCore } from "../main/lyrics/cacheCore";
import { createLocalLyricsReader } from "../main/lyrics/localLyricsCore";
import { LyricsServiceCore } from "../main/lyrics/serviceCore";
import { setRuntimeFetch, type RuntimeFetch } from "../main/lyrics/http";
import { fetchYouTubeMetadata } from "../main/lyrics/youtube";
import {
  clearCache as clearTranslationCache,
  createTranslationCache,
  romanizeBatch,
  translateBatch,
} from "../main/lyrics/translation";
import {
  artworkExtensionForMime,
  readTrackMetadataCore,
  sha1Hex,
} from "../main/library/metadataCore";
import {
  scanLibraryCore,
  type WalkedAudioFile,
  type WalkResult,
} from "../main/library/scannerCore";
import {
  LibraryStoreCore,
  type DatabaseShape,
  type LibraryPersistenceAdapter,
  type PlaylistRow,
  type StoredTrack,
} from "../main/library/storeCore";

export interface BootstrapPayload {
  appDataDir: string;
  artworkDir: string;
  platform: string;
  arch: string;
  appVersion: string;
  tauriVersion: string;
  settingsJson: string | null;
  lyricsCacheJson: string | null;
  dbSnapshot: DatabaseShape;
  startupFiles: string[];
  undecorated: boolean;
}

interface HttpFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type DbMutation =
  | { op: "upsertTrack"; id: number; path: string; payload: string }
  | { op: "deleteTrack"; id: number }
  | { op: "setLyrics"; trackId: number; payload: string }
  | { op: "deleteLyrics"; trackId: number }
  | { op: "upsertPlaylist"; id: number; payload: string; nextPlaylistId: number }
  | { op: "deletePlaylist"; id: number }
  | { op: "addFolder"; path: string }
  | { op: "removeFolder"; path: string };

const IDLE_SCAN: ScanProgress = {
  running: false,
  phase: "idle",
  foldersTotal: 0,
  filesSeen: 0,
  filesProcessed: 0,
  filesSkipped: 0,
  errors: [],
  message: "",
  startedAt: null,
  finishedAt: null,
};

let nextHttpRequestId = 1;

function createTauriRuntimeFetch(): RuntimeFetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const normalized = new Headers(init.headers);
      normalized.forEach((value, key) => {
        headers[key] = value;
      });
    }

    const requestId = `req-${nextHttpRequestId++}`;
    const onAbort = () => {
      void invoke("cmd_http_abort", { requestId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await invoke<HttpFetchResponse>("cmd_http_fetch", {
        args: {
          requestId,
          url,
          headers,
          timeoutMs: 15_000,
        },
      });
      return new Response(res.body, {
        status: res.status,
        headers: res.headers,
      });
    } catch (err) {
      const msg = String(err ?? "");
      if (signal?.aborted || msg.includes("ABORTED")) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (msg.includes("TIMEOUT")) {
        throw new DOMException("Request timed out", "TimeoutError");
      }
      throw new TypeError(msg.replace(/^NETWORK:\s*/, "") || "Network request failed");
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

function detectChromiumVersion(): string {
  if (typeof navigator === "undefined") return "";
  const match = navigator.userAgent.match(/(?:Edg|Chrome)\/([\d.]+)/);
  return match ? match[1] : "";
}

export interface InstalledTauriBridge {
  api: CadenceApi;
  dispose: () => void;
}

export async function installTauriBridge(): Promise<InstalledTauriBridge> {
  const bootstrap = await invoke<BootstrapPayload>("cmd_bootstrap");
  // Captured before the first render so an undecorated (custom title bar) window does not flash a
  // gapless layout for a frame while the async chrome state is still in flight.
  const initialWindowChrome: WindowChromeState = {
    undecorated: bootstrap.undecorated,
    maximized: false,
    fullscreen: false,
    focused: true,
  };
  const pathPlatform: PathPlatform = bootstrap.platform === "win32" ? "win32" : "posix";

  setRuntimeFetch(createTauriRuntimeFetch());

  // Batched SQLite persistence queue for LibraryStoreCore
  let pendingOps: DbMutation[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlightFlush: Promise<void> = Promise.resolve();

  const flushDbQueue = (): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingOps.length === 0) return inFlightFlush;
    const batch = pendingOps;
    pendingOps = [];
    inFlightFlush = inFlightFlush
      .then(() => invoke<void>("cmd_db_mutate", { ops: batch }))
      .catch(error => {
        console.error("[Cadence] Failed to persist SQLite mutations:", error);
      });
    return inFlightFlush;
  };

  const enqueueDbOp = (op: DbMutation): void => {
    pendingOps.push(op);
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushDbQueue();
      }, 25);
    }
  };

  const dbAdapter: LibraryPersistenceAdapter = {
    engine: "sqlite",
    writeThrough: true,
    upsertTrack(track: StoredTrack) {
      enqueueDbOp({ op: "upsertTrack", id: track.id, path: track.path, payload: JSON.stringify(track) });
    },
    deleteTrack(id: number) {
      enqueueDbOp({ op: "deleteTrack", id });
    },
    setLyrics(trackId: number, payload: { text: string; kind: string }) {
      enqueueDbOp({ op: "setLyrics", trackId, payload: JSON.stringify(payload) });
    },
    deleteLyrics(trackId: number) {
      enqueueDbOp({ op: "deleteLyrics", trackId });
    },
    loadLyrics(trackId: number) {
      return invoke<{ text: string; kind: string } | null>("cmd_load_lyrics", { trackId });
    },
    upsertPlaylist(playlist: PlaylistRow, nextPlaylistId: number) {
      enqueueDbOp({
        op: "upsertPlaylist",
        id: playlist.id,
        payload: JSON.stringify(playlist),
        nextPlaylistId,
      });
    },
    deletePlaylist(id: number) {
      enqueueDbOp({ op: "deletePlaylist", id });
    },
    addFolder(path: string) {
      enqueueDbOp({ op: "addFolder", path });
    },
    removeFolder(path: string) {
      enqueueDbOp({ op: "removeFolder", path });
    },
  };

  const mediaUrl = (targetPath: string, isArtwork = false): string =>
    toTauriMediaUrl(targetPath, isArtwork ? "art" : "file", pathPlatform);

  const store = new LibraryStoreCore(
    bootstrap.artworkDir,
    mediaUrl,
    dbAdapter,
    bootstrap.dbSnapshot
  );

  const settings = new SettingsCore({
    initialJson: bootstrap.settingsJson,
    persist: json => invoke("cmd_write_user_json", { kind: "settings", content: json }),
  });

  const lyricsCache = new LyricsCacheCore({
    initialJson: bootstrap.lyricsCacheJson,
    persist: json => invoke("cmd_write_user_json", { kind: "lyricsCache", content: json }),
  });

  const localLyricsReader = createLocalLyricsReader({
    readTextFile: path => invoke<string | null>("cmd_read_sidecar_text", { path }),
    writeTextFile: async () => {
      throw new Error("Use cmd_write_sidecar_lrc");
    },
  });

  const lyricsService = new LyricsServiceCore(store, lyricsCache, localLyricsReader);
  const translationCache = createTranslationCache();

  // Scanner host I/O backed by binary `cmd_read_file_chunk` + `RangeTokenizer`
  const parseWalkedAudioFile = (file: WalkedAudioFile) =>
    readTrackMetadataCore(file.path, {
      fileSize: file.size,
      mtimeMs: file.mtimeMs,
      readChunk: async (offset, length) => {
        const res = await invoke<ArrayBuffer | Uint8Array | number[]>("cmd_read_file_chunk", {
          path: file.path,
          offset,
          length,
        });
        if (res instanceof Uint8Array) return res;
        if (res instanceof ArrayBuffer) return new Uint8Array(res);
        return Uint8Array.from(res);
      },
      saveArtwork: async (data, format) => {
        const hash = await sha1Hex(data);
        const ext = artworkExtensionForMime(format);
        const fileName = `${hash}${ext}`;
        // Raw IPC avoids a second JS number array and JSON string for every embedded cover.
        await invoke<string>("cmd_save_artwork", data, {
          headers: { "x-file-name": fileName },
        });
        return fileName;
      },
      fileExists: candidate => {
        if (file.animatedArtPath && candidate.toLowerCase() === file.animatedArtPath.toLowerCase()) {
          return true;
        }
        if (file.hasSidecarLyrics) {
          const lower = candidate.toLowerCase();
          if (
            lower.endsWith(".lrc") ||
            lower.endsWith(".ttml") ||
            lower.endsWith(".qrc") ||
            lower.endsWith(".srt") ||
            lower.endsWith(".txt")
          ) {
            return true;
          }
        }
        return false;
      },
    });

  let currentScan: ScanProgress = { ...IDLE_SCAN };
  let activeScanPromise: Promise<LibraryScanResult> | null = null;

  const progressListeners = new Set<(progress: ScanProgress) => void>();
  const changedListeners = new Set<() => void>();
  const commandListeners = new Set<(command: MediaCommand) => void>();
  const menuListeners = new Set<(action: string) => void>();

  const emitScanProgress = (progress: ScanProgress) => {
    currentScan = progress;
    for (const listener of progressListeners) listener(progress);
  };

  const emitLibraryChanged = () => {
    for (const listener of changedListeners) listener();
  };

  const buildSnapshot = (): LibrarySnapshot => ({
    tracks: store.getTracks().map(track => store.toTrack(track)),
    albums: store.getAlbums(),
    artists: store.getArtists(),
    playlists: store.getPlaylists(),
    folders: store.getFolders(),
    counts: store.counts(),
    scan: currentScan,
  });

  const runFolderScan = (folders: string[], force = false): Promise<LibraryScanResult> => {
    if (activeScanPromise) return activeScanPromise;
    activeScanPromise = scanLibraryCore(
      store,
      {
        folders,
        force,
        onProgress: emitScanProgress,
      },
      {
        walkFolders: async targetFolders =>
          invoke<WalkResult>("cmd_walk_folders", { folders: targetFolders }),
        parseTrack: file => parseWalkedAudioFile(file),
      }
    )
      .then(async result => {
        await flushDbQueue();
        store.releaseLyrics();
        emitLibraryChanged();
        return result;
      })
      .finally(() => {
        activeScanPromise = null;
      });
    return activeScanPromise;
  };

  const importDirectAudioFiles = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    try {
      const files = await invoke<WalkedAudioFile[]>("cmd_stat_audio_files", { paths });
      if (files.length === 0) return;
      for (const file of files) {
        const existing = store.getTrackByPath(file.path);
        const parsed = await parseWalkedAudioFile(file);
        store.upsertTrack({
          ...parsed,
          hasEmbeddedLyrics: parsed.embeddedLyrics !== null,
          artworkFile: parsed.artworkFile ?? existing?.artworkFile ?? null,
          animatedArtPath: parsed.animatedArtPath ?? existing?.animatedArtPath ?? null,
          accentColor: existing?.accentColor ?? null,
        });
      }
      await flushDbQueue();
      store.releaseLyrics();
      emitLibraryChanged();
    } catch (error) {
      console.warn("[Cadence] Could not import opened audio files:", error);
    }
  };

  // Request cancellation controllers for track-scoped network work
  let resolveController: AbortController | null = null;
  let searchController: AbortController | null = null;
  let youtubeController: AbortController | null = null;
  let translateController: AbortController | null = null;
  let romanizeController: AbortController | null = null;
  let lastPlayerState: PlayerSnapshot | null = null;

  const unlisteners: UnlistenFn[] = [];

  const mapPlayerCommand = (raw: string): MediaCommand | null => {
    switch (raw) {
      case "toggle":
      case "play-pause":
        return "play-pause";
      case "next":
        return "next";
      case "previous":
        return "previous";
      case "stop":
        return "stop";
      case "seek-forward":
        return "seek-forward";
      case "seek-back":
        return "seek-back";
      default:
        return null;
    }
  };

  unlisteners.push(
    await listen<string>("cadence://player-command", event => {
      const mapped = mapPlayerCommand(event.payload);
      if (!mapped) return;
      for (const listener of commandListeners) listener(mapped);
    }),
    await listen<string>("cadence://menu-action", event => {
      const raw = event.payload;
      const mapped =
        raw === "library:addFolder"
          ? "add-folder"
          : raw === "library:rescan"
            ? "rescan"
            : raw === "view:lyrics"
              ? "toggle-fullscreen-lyrics"
              : raw;
      for (const listener of menuListeners) listener(mapped);
    }),
    await listen<string[]>("cadence://open-files", event => {
      if (Array.isArray(event.payload) && event.payload.length > 0) {
        void importDirectAudioFiles(event.payload);
      }
    })
  );

  const onPageHide = () => {
    lyricsService.flush();
    void flushDbQueue();
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", onPageHide);
  }

  if (bootstrap.startupFiles.length > 0) {
    void importDirectAudioFiles(bootstrap.startupFiles);
  }

  const api: CadenceApi & {
    onMenuAction(listener: (action: string) => void): () => void;
    getLastReportedPlayerState(): PlayerSnapshot | null;
  } = {
    async info(): Promise<AppInfo> {
      return {
        name: "Cadence",
        version: bootstrap.appVersion,
        tauri: bootstrap.tauriVersion,
        electron: "",
        chrome: detectChromiumVersion(),
        node: "",
        platform: `${bootstrap.platform} (${bootstrap.arch})`,
        dbEngine: store.engine,
        mediaProtocol: "cadence-media",
      };
    },

    library: {
      async snapshot(): Promise<LibrarySnapshot> {
        return buildSnapshot();
      },

      async addFolder() {
        const picked = await invoke<string | null>("cmd_pick_folder");
        if (!picked) {
          return { canceled: true, folders: store.getFolders() };
        }
        store.addFolder(picked);
        await invoke("cmd_allowlist_sync", { roots: store.getFolders() });
        await flushDbQueue();
        const result = await runFolderScan([picked], false);
        return { canceled: false, folders: store.getFolders(), result };
      },

      async removeFolder(folderPath: string): Promise<LibrarySnapshot> {
        store.removeFolder(folderPath);
        const toRemove = new Set<string>();
        for (const track of store.getTracks()) {
          if (isPathInside(folderPath, track.path, pathPlatform)) {
            toRemove.add(track.path);
          }
        }
        store.removeTracks(toRemove);
        await invoke("cmd_allowlist_sync", { roots: store.getFolders() });
        await flushDbQueue();
        emitLibraryChanged();
        return buildSnapshot();
      },

      async rescan(): Promise<LibraryScanResult> {
        const folders = store.getFolders();
        await invoke("cmd_allowlist_sync", { roots: folders });
        return runFolderScan(folders, false);
      },

      async search(query: string): Promise<Track[]> {
        return store.search(query);
      },

      async getTrack(id: number): Promise<Track | null> {
        const stored = store.getTrack(id);
        return stored ? store.toTrack(stored) : null;
      },

      async setFavorite(id: number, favorite: boolean): Promise<void> {
        store.setFavorite(id, favorite);
        await flushDbQueue();
        emitLibraryChanged();
      },

      async recordPlay(id: number): Promise<void> {
        store.recordPlay(id);
        await flushDbQueue();
      },

      onScanProgress(listener: (progress: ScanProgress) => void): () => void {
        progressListeners.add(listener);
        return () => {
          progressListeners.delete(listener);
        };
      },

      onChanged(listener: () => void): () => void {
        changedListeners.add(listener);
        return () => {
          changedListeners.delete(listener);
        };
      },
    },

    playlists: {
      async list() {
        return store.getPlaylists();
      },
      async create(name: string, trackIds: number[] = []) {
        const created = store.createPlaylist(name, trackIds);
        await flushDbQueue();
        emitLibraryChanged();
        return created;
      },
      async rename(id: number, name: string) {
        store.renamePlaylist(id, name);
        await flushDbQueue();
        emitLibraryChanged();
      },
      async remove(id: number) {
        store.deletePlaylist(id);
        await flushDbQueue();
        emitLibraryChanged();
      },
      async addTracks(id: number, trackIds: number[]) {
        store.addTracksToPlaylist(id, trackIds);
        await flushDbQueue();
        emitLibraryChanged();
      },
      async removeTrack(id: number, trackId: number) {
        store.removeTrackFromPlaylist(id, trackId);
        await flushDbQueue();
        emitLibraryChanged();
      },
      async reorder(id: number, trackIds: number[]) {
        store.reorderPlaylist(id, trackIds);
        await flushDbQueue();
        emitLibraryChanged();
      },
      async tracks(id: number): Promise<Track[]> {
        return store
          .getPlaylistTrackIds(id)
          .map(trackId => store.getTrack(trackId))
          .filter((track): track is StoredTrack => track !== null)
          .map(track => store.toTrack(track));
      },
    },

    settings: {
      async get() {
        return settings.get();
      },
      async patch(patch) {
        return settings.patch(patch);
      },
      async reset() {
        return settings.reset();
      },
    },

    lyrics: {
      async resolve(request) {
        resolveController?.abort();
        const controller = new AbortController();
        resolveController = controller;
        try {
          await store.ensureLyrics(request.trackId);
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          return await lyricsService.resolve(
            request,
            settings.get().lyrics.providerOrder,
            controller.signal
          );
        } finally {
          if (resolveController === controller) resolveController = null;
          store.releaseLyrics(request.trackId);
          lyricsCache.flush();
        }
      },

      async search(request) {
        searchController?.abort();
        const controller = new AbortController();
        searchController = controller;
        try {
          return await lyricsService.searchLyrics(
            request,
            settings.get().lyrics.providerOrder,
            controller.signal
          );
        } finally {
          if (searchController === controller) searchController = null;
          lyricsCache.flush();
        }
      },

      async youtubeMetadata(request) {
        youtubeController?.abort();
        const controller = new AbortController();
        youtubeController = controller;
        try {
          return await fetchYouTubeMetadata(request.url, controller.signal);
        } finally {
          if (youtubeController === controller) youtubeController = null;
        }
      },

      async translate(request) {
        translateController?.abort();
        const controller = new AbortController();
        translateController = controller;
        try {
          const response = await translateBatch(
            {
              lines: request.lines,
              targetLanguage: request.targetLanguage,
              sourceLanguage: request.sourceLanguage,
              signal: controller.signal,
            },
            translationCache
          );
          return {
            translations: response.results.map(item => item?.translatedText ?? null),
            detectedLanguage: response.detectedLanguage,
          };
        } finally {
          if (translateController === controller) translateController = null;
        }
      },

      async romanize(request) {
        romanizeController?.abort();
        const controller = new AbortController();
        romanizeController = controller;
        try {
          const response = await romanizeBatch(
            {
              lines: request.lines,
              targetLanguage: request.targetLanguage,
              sourceLanguage: request.sourceLanguage,
              signal: controller.signal,
            },
            translationCache
          );
          return {
            romanizations: response.results,
            detectedLanguage: response.detectedLanguage,
          };
        } finally {
          if (romanizeController === controller) romanizeController = null;
        }
      },

      async saveSidecar(trackId: number, text: string) {
        const track = store.getTrack(trackId);
        if (!track) throw new Error("Track not found");
        const savedPath = await invoke<string>("cmd_write_sidecar_lrc", {
          audioPath: track.path,
          text,
        });
        store.setSidecarLyricsFlag(trackId, true);
        await flushDbQueue();
        emitLibraryChanged();
        return { path: savedPath };
      },
    },

    player: {
      async reportState(state: PlayerSnapshot): Promise<void> {
        lastPlayerState = state;
      },

      onCommand(listener: (command: MediaCommand) => void): () => void {
        commandListeners.add(listener);
        return () => {
          commandListeners.delete(listener);
        };
      },
    },

    app: {
      async openExternal(url: string): Promise<void> {
        await invoke("cmd_shell_open_external", { url });
      },

      async openPath(path: string): Promise<void> {
        await invoke("cmd_shell_show_in_folder", { path });
      },

      async chooseLyricsFile(_trackId: number) {
        const picked = await invoke<{ path: string; text: string } | null>("cmd_pick_lyrics_file");
        if (!picked) return { canceled: true };
        return { canceled: false, path: picked.path, text: picked.text };
      },

      async window(action) {
        await invoke("cmd_window_action", { action });
      },

      async isFullScreen(): Promise<boolean> {
        return invoke<boolean>("cmd_window_is_fullscreen");
      },

      initialWindowChrome,

      async windowChrome(): Promise<WindowChromeState> {
        return invoke<WindowChromeState>("cmd_window_chrome_state");
      },

      onWindowChromeChange(listener: (state: WindowChromeState) => void): () => void {
        let active = true;
        const handles: UnlistenFn[] = [];
        const refresh = () => {
          void invoke<WindowChromeState>("cmd_window_chrome_state")
            .then(state => {
              if (active) listener(state);
            })
            .catch(() => {
              /* the window went away while the state was being read */
            });
        };
        // tao re-emits resize for maximize, restore and fullscreen transitions; focus/blur carry the
        // active-window treatment of the controls.
        void Promise.all([
          listen(TauriEvent.WINDOW_RESIZED, refresh),
          listen(TauriEvent.WINDOW_FOCUS, refresh),
          listen(TauriEvent.WINDOW_BLUR, refresh),
        ]).then(registered => {
          if (!active) {
            for (const unlisten of registered) unlisten();
            return;
          }
          handles.push(...registered);
        });
        refresh();
        return () => {
          active = false;
          for (const unlisten of handles) unlisten();
        };
      },
    },

    onMenuAction(listener: (action: string) => void): () => void {
      menuListeners.add(listener);
      return () => {
        menuListeners.delete(listener);
      };
    },

    getLastReportedPlayerState(): PlayerSnapshot | null {
      return lastPlayerState;
    },
  };

  // Expose cache clearing for Settings -> About -> "Clear lyrics cache"
  (api.lyrics as unknown as { clearCache?: () => Promise<void> }).clearCache = async () => {
    lyricsCache.clear();
    lyricsCache.flush();
    clearTranslationCache(translationCache);
  };

  if (typeof window !== "undefined") {
    window.cadence = api;
  }

  return {
    api,
    dispose: () => {
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("pagehide", onPageHide);
      }
      for (const unlisten of unlisteners) unlisten();
      resolveController?.abort();
      searchController?.abort();
      youtubeController?.abort();
      translateController?.abort();
      romanizeController?.abort();
      lyricsCache.flush();
      store.close();
    },
  };
}
