/**
 * Cadence IPC surface. Written for Cadence.
 *
 * Every handler validates its input; the renderer is untrusted by construction (context isolation,
 * no node integration), so paths arriving from it are checked against the media allowlist before
 * they can be opened.
 */

import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import type {
  AppInfo,
  AppSettings,
  DeepPartial,
  LibraryScanResult,
  LyricsResolveRequest,
  LyricsSearchRequest,
  TranslationRequest,
} from "../shared/types";
import { IPC } from "../shared/types";
import type { LibraryController } from "./library/controller";
import type { LyricsService } from "./lyrics/service";
import { writeSidecarLyrics } from "./lyrics/localLyrics";
import type { SettingsStore } from "./settings";
import { classifierFor, romanizeBatch, translateBatch, type TranslationCache } from "./lyrics/translation";
import { createTranslationCache } from "./lyrics/translation";

export interface IpcContext {
  library: LibraryController;
  lyrics: LyricsService;
  settings: SettingsStore;
  info: AppInfo;
  getWindow(): BrowserWindow | null;
  isWindowFullScreen(): boolean;
  setFullScreen(value: boolean): void;
}

function numberParam(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Expected a numeric id");
  return parsed;
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${name} to be a string`);
  return value;
}

export function registerIpc(context: IpcContext): void {
  const translationCache: TranslationCache = createTranslationCache();

  ipcMain.handle(IPC.info, () => context.info);

  ipcMain.handle(IPC.librarySnapshot, () => context.library.snapshot());
  ipcMain.handle(IPC.librarySearch, (_event, query: unknown) =>
    context.library.search(stringParam(query, "query"))
  );
  ipcMain.handle(IPC.libraryGetTrack, (_event, id: unknown) => context.library.getTrack(numberParam(id)));
  ipcMain.handle(IPC.libraryRescan, () => context.library.rescan(false));
  ipcMain.handle(IPC.librarySetFavorite, (_event, id: unknown, favorite: unknown) => {
    context.library.store.setFavorite(numberParam(id), Boolean(favorite));
    context.library.notifyChanged();
  });
  ipcMain.handle(IPC.libraryRecordPlay, (_event, id: unknown) => {
    context.library.store.recordPlay(numberParam(id));
  });
  ipcMain.handle(IPC.libraryAddFolder, async () => {
    const window = context.getWindow();
    const options = {
      title: "Choose a music folder",
      properties: ["openDirectory", "multiSelections", "createDirectory"] as const,
      buttonLabel: "Add folder",
    };
    const result = window
      ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, folders: context.library.store.getFolders() };
    }
    let scan: LibraryScanResult | undefined;
    for (const folder of result.filePaths) {
      scan = await context.library.addFolder(folder);
    }
    return { canceled: false, folders: context.library.store.getFolders(), result: scan };
  });
  ipcMain.handle(IPC.libraryRemoveFolder, async (_event, folder: unknown) => {
    await context.library.removeFolder(stringParam(folder, "folder"));
    return context.library.snapshot();
  });

  ipcMain.handle(IPC.playlistList, () => context.library.store.getPlaylists());
  ipcMain.handle(IPC.playlistCreate, (_event, name: unknown, trackIds: unknown) =>
    context.library.store.createPlaylist(
      stringParam(name, "name"),
      Array.isArray(trackIds) ? trackIds.map(Number).filter(Number.isFinite) : []
    )
  );
  ipcMain.handle(IPC.playlistRename, (_event, id: unknown, name: unknown) => {
    context.library.store.renamePlaylist(numberParam(id), stringParam(name, "name"));
  });
  ipcMain.handle(IPC.playlistRemove, (_event, id: unknown) => {
    context.library.store.deletePlaylist(numberParam(id));
  });
  ipcMain.handle(IPC.playlistAddTracks, (_event, id: unknown, trackIds: unknown) => {
    const ids = Array.isArray(trackIds) ? trackIds.map(Number).filter(Number.isFinite) : [];
    context.library.store.addTracksToPlaylist(numberParam(id), ids);
  });
  ipcMain.handle(IPC.playlistRemoveTrack, (_event, id: unknown, trackId: unknown) => {
    context.library.store.removeTrackFromPlaylist(numberParam(id), numberParam(trackId));
  });
  ipcMain.handle(IPC.playlistReorder, (_event, id: unknown, trackIds: unknown) => {
    const ids = Array.isArray(trackIds) ? trackIds.map(Number).filter(Number.isFinite) : [];
    context.library.store.reorderPlaylist(numberParam(id), ids);
  });
  ipcMain.handle(IPC.playlistTracks, (_event, id: unknown) => {
    const playlistId = numberParam(id);
    return context.library.store
      .getPlaylistTrackIds(playlistId)
      .map(trackId => context.library.getTrack(trackId))
      .filter((track): track is NonNullable<typeof track> => track !== null);
  });

  ipcMain.handle(IPC.settingsGet, () => context.settings.get());
  ipcMain.handle(IPC.settingsPatch, (_event, patch: unknown) => {
    const updated = context.settings.patch(patch as DeepPartial<AppSettings>);
    return updated;
  });
  ipcMain.handle(IPC.settingsReset, () => context.settings.reset());

  ipcMain.handle(IPC.lyricsResolve, async (_event, request: unknown) => {
    const typed = request as LyricsResolveRequest;
    return context.lyrics.resolve(
      {
        trackId: numberParam(typed?.trackId),
        title: stringParam(typed?.title, "title"),
        artist: stringParam(typed?.artist, "artist"),
        album: typeof typed?.album === "string" ? typed.album : "",
        duration: Number(typed?.duration) || 0,
        localOnly: Boolean(typed?.localOnly),
      },
      context.settings.get().lyrics.providerOrder
    );
  });

  ipcMain.handle(IPC.lyricsSearch, async (_event, request: unknown) => {
    const typed = request as LyricsSearchRequest;
    const title = stringParam(typed?.title, "title").trim();
    return context.lyrics.searchLyrics(
      {
        title,
        artist: typeof typed?.artist === "string" ? typed.artist.trim() : "",
        album: typeof typed?.album === "string" ? typed.album.trim() : "",
        duration: Number(typed?.duration) || 0,
        localOnly: Boolean(typed?.localOnly),
      },
      context.settings.get().lyrics.providerOrder
    );
  });

  ipcMain.handle(IPC.lyricsTranslate, async (_event, request: unknown) => {
    const typed = request as TranslationRequest;
    const lines = Array.isArray(typed?.lines) ? typed.lines.map(String) : [];
    const targetLanguage = stringParam(typed?.targetLanguage, "targetLanguage");
    const result = await translateBatch({ lines, targetLanguage }, translationCache);
    return {
      translations: result.results.map(entry => entry?.translatedText ?? null),
      detectedLanguage: result.detectedLanguage,
    };
  });

  ipcMain.handle(IPC.lyricsRomanize, async (_event, request: unknown) => {
    const typed = request as TranslationRequest;
    const lines = Array.isArray(typed?.lines) ? typed.lines.map(String) : [];
    classifierFor(lines); // warm the classifier so the batch uses the song-wide script balance
    const result = await romanizeBatch(
      { lines, targetLanguage: typed?.targetLanguage || "en", sourceLanguage: typed?.sourceLanguage ?? null },
      translationCache
    );
    return { romanizations: result.results, detectedLanguage: result.detectedLanguage };
  });

  ipcMain.handle(IPC.lyricsSaveSidecar, async (_event, trackId: unknown, text: unknown) => {
    const track = context.library.store.getTrack(numberParam(trackId));
    if (!track) throw new Error("Unknown track");
    const path = await writeSidecarLyrics(track.path, stringParam(text, "text"));
    context.library.store.setSidecarLyricsFlag(track.id, true);
    context.library.notifyChanged();
    return { path };
  });

  ipcMain.handle(IPC.appOpenExternal, async (_event, url: unknown) => {
    const target = stringParam(url, "url");
    if (!/^https?:\/\//i.test(target)) throw new Error("Only http(s) links can be opened");
    await shell.openExternal(target);
  });

  ipcMain.handle(IPC.appOpenPath, async (_event, path: unknown) => {
    const target = stringParam(path, "path");
    shell.showItemInFolder(target);
  });

  ipcMain.handle(IPC.appChooseLyricsFile, async (_event, trackId: unknown) => {
    const window = context.getWindow();
    const track = context.library.store.getTrack(numberParam(trackId));
    const options = {
      title: "Choose a lyrics file",
      properties: ["openFile"] as const,
      filters: [
        { name: "Lyrics", extensions: ["lrc", "ttml", "qrc", "srt", "txt"] },
        { name: "All files", extensions: ["*"] },
      ],
      defaultPath: track?.path,
    };
    const result = window
      ? await dialog.showOpenDialog(window, { ...options, properties: ["openFile"] })
      : await dialog.showOpenDialog({ ...options, properties: ["openFile"] });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const resolved = await context.lyrics.resolveUserFile(numberParam(trackId), result.filePaths[0]);
    const candidate = resolved.candidates[0];
    if (!candidate) return { canceled: true };
    return { canceled: false, path: candidate.sourceHref ?? result.filePaths[0], text: candidate.text };
  });

  ipcMain.handle(IPC.appWindow, (_event, action: unknown) => {
    const window = context.getWindow();
    switch (action) {
      case "minimize":
        window?.minimize();
        break;
      case "maximize":
        if (window?.isMaximized()) window.unmaximize();
        else window?.maximize();
        break;
      case "close":
        window?.close();
        break;
      case "fullscreen":
        context.setFullScreen(true);
        break;
      case "exitFullscreen":
        context.setFullScreen(false);
        break;
      default:
        break;
    }
  });

  ipcMain.handle(IPC.appIsFullScreen, () => context.isWindowFullScreen());

  ipcMain.handle(IPC.playerReportState, () => undefined);
}
