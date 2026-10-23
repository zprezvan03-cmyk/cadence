/**
 * Shared contract between the Electron main process, the preload bridge and the renderer.
 * Everything here is written for Cadence (the new application); nothing in this file comes
 * from the upstream projects.
 */

import type { GradientSettings } from "./upstream/shaders/gradientSettings";

export type RepeatMode = "off" | "all" | "one";
export type LyricsSyncType = "richsync" | "synced" | "none";

export interface Track {
  id: number;
  path: string;
  /** Stream URL served by the app's `cadence-media://` protocol. */
  streamUrl: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  genre: string;
  year: number | null;
  trackNo: number | null;
  discNo: number | null;
  /** Seconds. */
  duration: number;
  bitrate: number | null;
  sampleRate: number | null;
  channels: number | null;
  codec: string;
  container: string;
  fileSize: number;
  mtimeMs: number;
  artworkUrl: string | null;
  /** Local animated cover (`cover.mp4`/`cover.webm` beside the track), when one exists. */
  animatedArtUrl: string | null;
  /** Dominant colour of the artwork as `#rrggbb`, computed while scanning. */
  accentColor: string | null;
  hasEmbeddedLyrics: boolean;
  favorite: boolean;
  addedAt: number;
  lastPlayedAt: number | null;
  playCount: number;
  /** True when a sidecar `.lrc`/`.ttml`/`.qrc`/`.srt` file sits next to the audio file. */
  hasSidecarLyrics: boolean;
  /** True when the decoder family is expected to be supported by Chromium. */
  playable: boolean;
}

export interface Album {
  /** Stable slug: `${albumArtist}\u0000${name}`. */
  id: string;
  name: string;
  albumArtist: string;
  year: number | null;
  artworkUrl: string | null;
  accentColor: string | null;
  trackCount: number;
  duration: number;
}

export interface Artist {
  id: string;
  name: string;
  artworkUrl: string | null;
  trackCount: number;
  albumCount: number;
}

export interface Playlist {
  id: number;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  trackCount: number;
  duration: number;
  /** Artwork of the first track, used as the playlist cover. */
  artworkUrl: string | null;
}

export interface ScanProgress {
  running: boolean;
  phase: "idle" | "walking" | "reading" | "saving" | "done" | "error";
  foldersTotal: number;
  filesSeen: number;
  filesProcessed: number;
  filesSkipped: number;
  errors: { path: string; reason: string }[];
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface LibraryCounts {
  tracks: number;
  albums: number;
  artists: number;
  playlists: number;
  duration: number;
}

export interface LibrarySnapshot {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  folders: string[];
  scan: ScanProgress;
  counts: LibraryCounts;
}

export interface LyricsCandidate {
  /** Where the text came from, e.g. `local:sidecar`, `tag:synced`, `lrclib`. */
  source: string;
  /** Human readable provider name. */
  provider: string;
  /** Raw lyrics text (LRC, TTML, QRC, SRT or plain). */
  text: string;
  /** Hint from the provider about the timing available. */
  syncHint: LyricsSyncType;
  language: string | null;
  songwriters: string[];
  /** Direct link to the provider page, when the provider exposes one. */
  sourceHref: string | null;
  cached: boolean;
}

export interface LyricsResolveRequest {
  trackId: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  /** Skip the network and only look at local files / tags. */
  localOnly?: boolean;
}

export interface LyricsResolveResult {
  candidates: LyricsCandidate[];
  /** Providers that were attempted and their outcome, for the provider picker UI. */
  providerStatus: { provider: string; status: "hit" | "miss" | "error" | "skipped"; detail?: string }[];
}

export interface TranslationRequest {
  lines: string[];
  targetLanguage: string;
  /** Optional song language hint used for romanization. */
  sourceLanguage?: string | null;
}

export interface TranslationResult {
  /** Aligned with the input lines; `null` when the line could not be translated. */
  translations: (string | null)[];
  detectedLanguage: string;
}

export interface RomanizationResult {
  romanizations: (string | null)[];
  detectedLanguage: string;
}

export interface LyricsSettings {
  providerOrder: string[];
  autoFetch: boolean;
  /** Offset in milliseconds applied to the playback clock before matching. */
  offsetMs: number;
  translationLanguage: string;
  romanization: boolean;
  themeId: string;
  customThemeCss: string;
  fontSizeRem: number;
  fontWeight: number;
  lineHeight: number;
  activeOpacity: number;
  inactiveOpacity: number;
  targetScrollRatio: number;
  showCredits: boolean;
  hideInstrumentalOnly: boolean;
  passiveScroll: boolean;
  fullscreenOnOpen: boolean;
}

export interface PlaybackSettings {
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  playbackRate: number;
  resumeOnLaunch: boolean;
}

export interface AppearanceSettings {
  accent: string;
  reduceMotion: boolean;
  compactSidebar: boolean;
  blurArtwork: boolean;
}

export interface ShaderSettings extends GradientSettings {
  /**
   * Cadence-specific performance switch. It scales blur passes and the render buffer, never the
   * visual language of the effect.
   */
  performanceMode: "high" | "balanced" | "low" | "off";
}

export interface AppSettings {
  version: number;
  playback: PlaybackSettings;
  appearance: AppearanceSettings;
  lyrics: LyricsSettings;
  shaders: ShaderSettings;
  advanced: { showLogs: boolean };
}

export interface PlayerSnapshot {
  trackId: number | null;
  position: number;
  duration: number;
  playing: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  shuffle: boolean;
  repeat: RepeatMode;
  queue: number[];
  queueIndex: number;
}

export interface LibraryScanResult {
  added: number;
  updated: number;
  removed: number;
  errors: { path: string; reason: string }[];
  durationMs: number;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  dbEngine: string;
  mediaProtocol: string;
}

/** The API exposed on `window.cadence` by the preload script. */
export interface CadenceApi {
  info(): Promise<AppInfo>;
  library: {
    snapshot(): Promise<LibrarySnapshot>;
    addFolder(): Promise<{ canceled: boolean; folders: string[]; result?: LibraryScanResult }>;
    removeFolder(path: string): Promise<LibrarySnapshot>;
    rescan(): Promise<LibraryScanResult>;
    search(query: string): Promise<Track[]>;
    getTrack(id: number): Promise<Track | null>;
    setFavorite(id: number, favorite: boolean): Promise<void>;
    recordPlay(id: number): Promise<void>;
    onScanProgress(listener: (progress: ScanProgress) => void): () => void;
    onChanged(listener: () => void): () => void;
  };
  playlists: {
    list(): Promise<Playlist[]>;
    create(name: string, trackIds?: number[]): Promise<Playlist>;
    rename(id: number, name: string): Promise<void>;
    remove(id: number): Promise<void>;
    addTracks(id: number, trackIds: number[]): Promise<void>;
    removeTrack(id: number, trackId: number): Promise<void>;
    reorder(id: number, trackIds: number[]): Promise<void>;
    tracks(id: number): Promise<Track[]>;
  };
  settings: {
    get(): Promise<AppSettings>;
    patch(patch: DeepPartial<AppSettings>): Promise<AppSettings>;
    reset(): Promise<AppSettings>;
  };
  lyrics: {
    resolve(request: LyricsResolveRequest): Promise<LyricsResolveResult>;
    translate(request: TranslationRequest): Promise<TranslationResult>;
    romanize(request: TranslationRequest): Promise<RomanizationResult>;
    saveSidecar(trackId: number, text: string): Promise<{ path: string }>;
  };
  player: {
    reportState(state: PlayerSnapshot): Promise<void>;
    onCommand(listener: (command: MediaCommand) => void): () => void;
  };
  app: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<void>;
    chooseLyricsFile(trackId: number): Promise<{ canceled: boolean; path?: string; text?: string }>;
    window(action: "minimize" | "maximize" | "close" | "fullscreen" | "exitFullscreen"): Promise<void>;
    isFullScreen(): Promise<boolean>;
  };
}

export type MediaCommand = "play-pause" | "next" | "previous" | "stop" | "seek-forward" | "seek-back";

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** IPC channel names, kept in one place so main and preload cannot drift. */
export const IPC = {
  info: "app:info",
  librarySnapshot: "library:snapshot",
  libraryAddFolder: "library:add-folder",
  libraryRemoveFolder: "library:remove-folder",
  libraryRescan: "library:rescan",
  librarySearch: "library:search",
  libraryGetTrack: "library:get-track",
  librarySetFavorite: "library:set-favorite",
  libraryRecordPlay: "library:record-play",
  libraryProgress: "library:progress",
  libraryChanged: "library:changed",
  playlistList: "playlists:list",
  playlistCreate: "playlists:create",
  playlistRename: "playlists:rename",
  playlistRemove: "playlists:remove",
  playlistAddTracks: "playlists:add-tracks",
  playlistRemoveTrack: "playlists:remove-track",
  playlistReorder: "playlists:reorder",
  playlistTracks: "playlists:tracks",
  settingsGet: "settings:get",
  settingsPatch: "settings:patch",
  settingsReset: "settings:reset",
  lyricsResolve: "lyrics:resolve",
  lyricsTranslate: "lyrics:translate",
  lyricsRomanize: "lyrics:romanize",
  lyricsSaveSidecar: "lyrics:save-sidecar",
  playerReportState: "player:report-state",
  playerCommand: "player:command",
  appOpenExternal: "app:open-external",
  appOpenPath: "app:open-path",
  appChooseLyricsFile: "app:choose-lyrics-file",
  appWindow: "app:window",
  appIsFullScreen: "app:is-full-screen",
} as const;
