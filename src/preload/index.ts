/**
 * Cadence preload bridge. Written for Cadence.
 *
 * The renderer gets exactly the API described by `CadenceApi` and nothing else: no node globals, no
 * ipcRenderer, no filesystem. Event subscriptions return an unsubscribe function.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { CadenceApi, MediaCommand, ScanProgress } from "../shared/types";
import { IPC } from "../shared/types";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: CadenceApi & { onMenuAction(listener: (action: "add-folder" | "rescan") => void): () => void } = {
  info: () => ipcRenderer.invoke(IPC.info),
  library: {
    snapshot: () => ipcRenderer.invoke(IPC.librarySnapshot),
    addFolder: () => ipcRenderer.invoke(IPC.libraryAddFolder),
    removeFolder: (path: string) => ipcRenderer.invoke(IPC.libraryRemoveFolder, path),
    rescan: () => ipcRenderer.invoke(IPC.libraryRescan),
    search: (query: string) => ipcRenderer.invoke(IPC.librarySearch, query),
    getTrack: (id: number) => ipcRenderer.invoke(IPC.libraryGetTrack, id),
    setFavorite: (id: number, favorite: boolean) => ipcRenderer.invoke(IPC.librarySetFavorite, id, favorite),
    recordPlay: (id: number) => ipcRenderer.invoke(IPC.libraryRecordPlay, id),
    onScanProgress: (listener: (progress: ScanProgress) => void) => subscribe(IPC.libraryProgress, listener),
    onChanged: (listener: () => void) => subscribe(IPC.libraryChanged, listener),
  },
  playlists: {
    list: () => ipcRenderer.invoke(IPC.playlistList),
    create: (name: string, trackIds?: number[]) => ipcRenderer.invoke(IPC.playlistCreate, name, trackIds ?? []),
    rename: (id: number, name: string) => ipcRenderer.invoke(IPC.playlistRename, id, name),
    remove: (id: number) => ipcRenderer.invoke(IPC.playlistRemove, id),
    addTracks: (id: number, trackIds: number[]) => ipcRenderer.invoke(IPC.playlistAddTracks, id, trackIds),
    removeTrack: (id: number, trackId: number) => ipcRenderer.invoke(IPC.playlistRemoveTrack, id, trackId),
    reorder: (id: number, trackIds: number[]) => ipcRenderer.invoke(IPC.playlistReorder, id, trackIds),
    tracks: (id: number) => ipcRenderer.invoke(IPC.playlistTracks, id),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    patch: patch => ipcRenderer.invoke(IPC.settingsPatch, patch),
    reset: () => ipcRenderer.invoke(IPC.settingsReset),
  },
  lyrics: {
    resolve: request => ipcRenderer.invoke(IPC.lyricsResolve, request),
    search: request => ipcRenderer.invoke(IPC.lyricsSearch, request),
    youtubeMetadata: request => ipcRenderer.invoke(IPC.lyricsYouTube, request),
    translate: request => ipcRenderer.invoke(IPC.lyricsTranslate, request),
    romanize: request => ipcRenderer.invoke(IPC.lyricsRomanize, request),
    saveSidecar: (trackId: number, text: string) => ipcRenderer.invoke(IPC.lyricsSaveSidecar, trackId, text),
  },
  player: {
    reportState: state => ipcRenderer.invoke(IPC.playerReportState, state),
    onCommand: (listener: (command: MediaCommand) => void) => subscribe(IPC.playerCommand, listener),
  },
  app: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC.appOpenExternal, url),
    openPath: (path: string) => ipcRenderer.invoke(IPC.appOpenPath, path),
    chooseLyricsFile: (trackId: number) => ipcRenderer.invoke(IPC.appChooseLyricsFile, trackId),
    window: action => ipcRenderer.invoke(IPC.appWindow, action),
    isFullScreen: () => ipcRenderer.invoke(IPC.appIsFullScreen),
  },
  onMenuAction: listener => {
    const addFolder = () => listener("add-folder");
    const rescan = () => listener("rescan");
    ipcRenderer.on("menu:add-folder", addFolder);
    ipcRenderer.on("menu:rescan", rescan);
    return () => {
      ipcRenderer.removeListener("menu:add-folder", addFolder);
      ipcRenderer.removeListener("menu:rescan", rescan);
    };
  },
};

contextBridge.exposeInMainWorld("cadence", api);
