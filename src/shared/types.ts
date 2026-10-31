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
  /** True when this file has a supported audio extension; codec support is checked separately. */
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
  /**
   * Metadata of the catalogue record this candidate came from. Automatic resolution leaves these
   * unset (the local file's own tags apply); manual lyric searches populate them so the selector
   * can show the matched title/artist/album even when they differ from the playing track's tags.
   */
  matchTitle?: string | null;
  matchArtist?: string | null;
  matchAlbum?: string | null;
  matchDuration?: number | null;
}

export interface LyricsSearchRequest {
  /** Manually entered song title; may differ from the playing track's tags. */
  title: string;
  /** Manually entered artist; optional because some catalogues match on title alone. */
  artist: string;
  album?: string;
  /** Seconds, when known from the playing track. */
  duration?: number;
  /** Skip the network and answer from the local search cache only. */
  localOnly?: boolean;
}

export interface LyricsSearchResponse {
  /** Matching candidates, each carrying its `match*` catalogue metadata, best match first. */
  results: LyricsCandidate[];
  providerStatus: { provider: string; status: "hit" | "miss" | "error" | "skipped"; detail?: string }[];
  /** True when every row came from the local cache (e.g. offline manual search). */
  cached: boolean;
}

/** Outcome of Settings -> Cache -> "Clear cache", reported once the file has been written. */
export interface LyricsCacheClearResult {
  /** Cached songs (lyrics plus manual-search rows) that were removed. */
  removedEntries: number;
}

/** Exact size of the persisted cache plus its entry breakdown, for Settings -> Cache. */
export interface LyricsCacheStats {
  entryCount: number;
  /** Entries that hold a track's lyrics (local, chosen and remote variants). */
  tracks: number;
  /** Entries that hold manual-search rows. */
  searches: number;
  /** Serialized bytes as written to `lyrics-cache.json`; measured, never estimated. */
  bytes: number;
}

/** One row of the cache manager list. */
export interface LyricsCacheEntrySummary {
  /** Opaque cache key, used to inspect and delete this entry. */
  key: string;
  kind: "track" | "search";
  trackId: number | null;
  title: string;
  artist: string;
  album: string;
  duration: number;
  /** Display names of the providers/sources stored for this entry. */
  sources: string[];
  /** Distinct payload formats stored for this entry (`ttml`, `lrc`, …). */
  formats: string[];
  candidateCount: number;
  /** When the entry was last written (ms since epoch). */
  savedAt: number;
  /** A definitive "nothing found" answer is cached instead of lyrics. */
  negative: boolean;
}

export interface LyricsCacheListResult {
  entries: LyricsCacheEntrySummary[];
  stats: LyricsCacheStats;
}

/** A stored lyrics payload as shown in the cache inspector. */
export interface LyricsCacheCandidateView {
  source: string;
  provider: string;
  /** `ttml`, `qrc`, `lrc`, `srt`, `plain`, … as recorded when the payload was cached. */
  format: string;
  /** `local` file/tag, `manual` user choice, or `network` provider. */
  origin: "local" | "manual" | "network";
  syncHint: LyricsSyncType;
  language: string | null;
  songwriters: string[];
  sourceHref: string | null;
  /** When this payload first entered the cache (ms since epoch). */
  cachedAt: number;
  /** The original payload, byte-for-byte (timings, translations, romanization included). */
  text: string;
}

export interface LyricsCacheEntryDetail {
  key: string;
  kind: "track" | "search";
  trackId: number | null;
  title: string;
  artist: string;
  album: string;
  duration: number;
  savedAt: number;
  candidates: LyricsCacheCandidateView[];
}

export interface LyricsCacheRemoveResult {
  removed: boolean;
  stats: LyricsCacheStats;
}

export interface YouTubeMetadataRequest {
  /** Raw user input; the main process re-validates it even though the renderer pre-checks. */
  url: string;
}

export interface YouTubeMetadata {
  videoId: string;
  /** Video title, used only to fill a blank title field — it never overwrites a user value. */
  title: string;
  /** Channel name with YouTube Music's " - Topic" suffix removed; null when unparseable. */
  artist: string | null;
  /** Video length in seconds; null when the best-effort lookup could not determine it. */
  durationSeconds: number | null;
  thumbnailUrl: string | null;
}

/** Discriminated result so the renderer shows inline failures instead of a thrown IPC error. */
export type YouTubeMetadataResult =
  | { ok: true; metadata: YouTubeMetadata }
  | { ok: false; reason: "invalid" | "unavailable" | "error"; detail: string };

export interface LyricsResolveRequest {
  trackId: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  /** Skip the network and only look at local files / tags. */
  localOnly?: boolean;
  /**
   * Explicit user-initiated retry: bypass the cached network answer and the Not Found cooldown
   * so previously unsuccessful providers are queried again. Automatic paths never set this.
   */
  forceRefresh?: boolean;
}

export interface LyricsResolveResult {
  candidates: LyricsCandidate[];
  /** Providers that were attempted and their outcome, for the provider picker UI. */
  providerStatus: { provider: string; status: "hit" | "miss" | "error" | "skipped"; detail?: string }[];
  /**
   * True when every participating provider completed normally (hit or clean miss), so an empty
   * candidate list is a proven "not found". False when any provider errored or timed out.
   */
  definitive?: boolean;
}

/** Lifecycle of the persistent Fetch All Lyrics background job. */
export type LyricsFetchJobState = "idle" | "running" | "paused" | "completed" | "canceled";

/** Renderer-facing snapshot of the Fetch All job; the bridge owns the authoritative state. */
export interface LyricsFetchJobSnapshot {
  jobId: string | null;
  state: LyricsFetchJobState;
  total: number;
  /** Entries in a terminal state (found + notFound + failed + skipped). */
  processed: number;
  found: number;
  notFound: number;
  /** Temporary failures plus rate-limited tracks awaiting a manual retry. */
  failed: number;
  skipped: number;
  /** A track being processed right now, when any. */
  currentTrack: { trackId: number; title: string; artist: string } | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Library-wide lyrics coverage, for the onboarding Fetch All page and Settings. */
export interface LyricsFetchStats {
  totalTracks: number;
  /** Tracks that already have some usable lyrics (local, embedded, manual or cached remote). */
  withLyrics: number;
  /** Tracks a Fetch All run would still query providers for. */
  needsSearch: number;
  /** Tracks whose every eligible provider result is already cached and fresh. */
  fullyProcessed: number;
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

/** Bounded provider-request parallelism for Autofetch / Fetch All (see the central limiter). */
export type LyricsFetchConcurrency = "low" | "balanced" | "high";

export interface LyricsSettings {
  providerOrder: string[];
  autoFetch: boolean;
  /**
   * Days before a proven "not found" track is eligible for another automatic provider search
   * (1–30). Only the last attempt timestamp is stored, so changing this re-evaluates every track
   * immediately. Manual retries always bypass it.
   */
  notFoundCooldownDays: number;
  /** Global provider-request concurrency preset shared by Autofetch, Fetch All and manual search. */
  fetchConcurrency: LyricsFetchConcurrency;
  /** Offset in milliseconds applied to the playback clock before matching. */
  offsetMs: number;
  translationLanguage: string;
  romanization: boolean;
  themeId: string;
  customThemeCss: string;
  fontSizeRem: number;
  fontWeight: number;
  lineHeight: number;
  /** Font size in pixels of the translated line beneath each lyric. */
  translationFontSizePx: number;
  /** Font size in pixels of the romanized line beneath each lyric. */
  romanizationFontSizePx: number;
  activeOpacity: number;
  inactiveOpacity: number;
  targetScrollRatio: number;
  showCredits: boolean;
  hideInstrumentalOnly: boolean;
  passiveScroll: boolean;
  fullscreenOnOpen: boolean;
  /** Whether the lyrics text is shown in fullscreen Now Playing; playback is unaffected either way. */
  showLyricsInFullscreen: boolean;
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
  /** When the sidebar is compact, hovering (or keyboard-focusing) it temporarily expands it as an overlay. */
  compactSidebarHoverExpand: boolean;
  blurArtwork: boolean;
  /** Font id from the shared font list; applied to the whole UI and the lyrics view. */
  fontFamily: string;
}

export interface ShaderSettings extends GradientSettings {
  /**
   * Cadence-specific performance switch. It scales blur passes and the render buffer, never the
   * visual language of the effect.
   */
  performanceMode: "high" | "balanced" | "low" | "off";
}

/** The two Now Playing surfaces a profile can describe independently. */
export type NowPlayingProfileMode = "windowed" | "fullscreen";

/** Which side of the fullscreen stage the artwork column occupies. */
export type NowPlayingArtworkSlot = "left" | "right";
/** Where the title/artist block sits in fullscreen: under the artwork, or across the top. */
export type NowPlayingMetadataSlot = "artwork" | "top";
export type NowPlayingLyricsAlignment = "left" | "center";
/** Word-highlight treatments. They only ever affect lyrics that actually carry word timings. */
export type NowPlayingKaraokeStyle = "sweep" | "solid" | "gradient" | "glow" | "minimal";
export type NowPlayingBackgroundMode =
  | "fluid"
  | "blurred-artwork"
  | "gradient"
  | "solid"
  | "particles"
  | "visualizer";

/**
 * Visual proportions for one Now Playing surface. These values deliberately layer on the
 * existing global lyrics typography settings: a profile changes the balance of artwork,
 * lyrics, metadata and controls without silently replacing the sizes chosen in Settings.
 * Later customization stages add independently editable appearance fields to this shape.
 */
export interface NowPlayingProfileConfig {
  /** Whether the profile asks fullscreen layouts to show artwork. Narrow layouts may still hide it. */
  artworkVisible: boolean;
  /** Multiplier for the responsive artwork size (0.6–1.25 after normalization). */
  artworkScale: number;
  /** Multiplier for the main lyric size (0.7–1.35). */
  lyricsScale: number;
  /** Multiplier for translated lyric lines (0.7–1.35). */
  translationScale: number;
  /** Multiplier for romanized lyric lines (0.7–1.35). */
  romanizationScale: number;
  /** Multiplier for the track title (0.75–1.25). */
  titleScale: number;
  /** Multiplier for artist/album metadata (0.75–1.25). */
  metadataScale: number;
  /** Multiplier for playback-control and dock hit sizes (0.8–1.2). */
  controlsScale: number;
  /** Maximum readable lyric measure in CSS pixels (640–1280). */
  lyricsMaxWidth: number;
  /** Multiplier for Now Playing gutters and major gaps (0.8–1.25). */
  spacingScale: number;

  /* Layout (grid-constrained component placement) */
  artworkSlot: NowPlayingArtworkSlot;
  metadataSlot: NowPlayingMetadataSlot;
  metadataVisible: boolean;
  dockVisible: boolean;
  controlsVisible: boolean;
  lyricsAlignment: NowPlayingLyricsAlignment;

  /* Typography. Font ids reference the shared font list; "" inherits the app font. */
  fontId: string;
  translationFontId: string;
  romanizationFontId: string;
  /** Main lyric weight 300–900; 0 inherits the Settings weight. */
  lyricsWeight: number;
  /** Line-height multiplier on the Settings line height (0.85–1.4). */
  lineSpacingScale: number;
  /** Extra letter spacing in em (-0.02–0.08). */
  letterSpacingEm: number;

  /* Lyrics appearance. Colors are #rrggbb; "" inherits the active theme. */
  activeColor: string;
  inactiveColor: string;
  /** Multiplier on the Settings inactive opacity (0.4–1.6). */
  inactiveOpacityScale: number;
  /** Renderer active-line scale (0.9–1.2). */
  activeLineScale: number;
  /** Blur applied to inactive lines, px (0–6). Opt-in; 0 disables the filter entirely. */
  inactiveBlurPx: number;

  /* Karaoke / word highlight (word-timed sources only; never faked for line-level lyrics). */
  karaokeStyle: NowPlayingKaraokeStyle;
  /** Highlight/glow strength (0–1). */
  karaokeIntensity: number;
  /** Active-word emphasis scale (1–1.2). */
  activeWordScale: number;

  /* Background. Canvas modes are opt-in and run only while playing and visible. */
  backgroundMode: NowPlayingBackgroundMode;
  /** Background opacity (0.2–1). */
  backgroundIntensity: number;
  /** Blur radius for the blurred-artwork background, px (0–60). */
  backgroundBlurPx: number;
  /** Particle/visualizer speed multiplier (0.25–2). */
  effectSpeed: number;
  /** Particle density / visualizer responsiveness multiplier (0.25–1.5). */
  effectDensity: number;

}

/** One named Now Playing profile, with distinct windowed and fullscreen proportions. */
export interface NowPlayingProfile {
  id: string;
  name: string;
  description: string;
  /** Built-in profiles are shipped by Cadence and cannot be edited or deleted in place. */
  builtIn: boolean;
  windowed: NowPlayingProfileConfig;
  fullscreen: NowPlayingProfileConfig;
}

/** Persisted profile selection plus user-authored profiles. Built-ins live in code, not settings. */
export interface NowPlayingProfilesSettings {
  version: 1;
  activeProfileId: string;
  customProfiles: NowPlayingProfile[];
  /**
   * Optional per-context profile activation (disabled by default): when enabled, the
   * windowed and fullscreen surfaces use these profiles instead of `activeProfileId`.
   * Each chosen profile still contributes only its matching mode config.
   */
  contextSwitching: {
    enabled: boolean;
    windowedProfileId: string;
    fullscreenProfileId: string;
  };
}

export interface AppSettings {
  version: number;
  playback: PlaybackSettings;
  appearance: AppearanceSettings;
  lyrics: LyricsSettings;
  nowPlayingProfiles: NowPlayingProfilesSettings;
  shaders: ShaderSettings;
  advanced: { showLogs: boolean };
  general: {
    /** True once the first-launch onboarding has been finished or skipped. */
    onboardingCompleted: boolean;
    /** Step to resume at when onboarding was interrupted (0 = Welcome). */
    onboardingStep: number;
  };
}

/** One completed listening session, newest first when listed. */
export interface HistoryEntry {
  id: number;
  trackId: number;
  /** When playback started, ms since epoch. */
  playedAt: number;
  /** Track metadata snapshot as it was when playback started; survives file removal. */
  payload: HistoryPayload;
}

/** Stored snapshot of a played track, kept small so history rows stay cheap. */
export interface HistoryPayload {
  trackId: number;
  path: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  artworkUrl: string | null;
  duration: number;
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

/**
 * How a file failed the Decode Tester. File-access problems stay distinct from decoder problems,
 * and a codec Chromium simply has no decoder for is never reported as corruption.
 */
export type DecodeProblemKind =
  | "decode-error"
  | "unsupported-codec"
  | "truncated"
  | "inaccessible"
  | "timeout";

/** One file the Decode Tester could not decode through the same Chromium pipeline used for playback. */
export interface DecodeProblem {
  trackId: number | null;
  path: string;
  fileName: string;
  kind: DecodeProblemKind;
  /** Human-readable decoding error, phrased like the playback error banners. */
  message: string;
  /** Codec reported by the library scanner, when known (may be a bare extension for unreadable tags). */
  codec: string;
}

/** Per-file outcome of a confirmed Decode Tester deletion; failures never abort the batch. */
export interface DecodeDeleteOutcome {
  path: string;
  deleted: boolean;
  error: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  tauri?: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  dbEngine: string;
  mediaProtocol: string;
}

/** The API exposed on `window.cadence` by the desktop runtime bridge. */
export interface CadenceApi {
  info(): Promise<AppInfo>;
  history: {
    add(args: {
      trackId: number;
      playedAt: number;
      payload: HistoryPayload;
    }): Promise<void>;
    list(): Promise<HistoryEntry[]>;
    clear(): Promise<void>;
  };
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
    search(request: LyricsSearchRequest): Promise<LyricsSearchResponse>;
    youtubeMetadata(request: YouTubeMetadataRequest): Promise<YouTubeMetadataResult>;
    translate(request: TranslationRequest): Promise<TranslationResult>;
    romanize(request: TranslationRequest): Promise<RomanizationResult>;
    saveSidecar(trackId: number, text: string): Promise<{ path: string }>;
    /**
     * Empties the persistent remote-lyrics cache. Resolves only after the emptied cache file has
     * been written to disk and rejects with the filesystem error when it could not be, so the UI
     * never claims a deletion that did not happen. User data (library, settings, sidecar lyrics,
     * artwork) is untouched.
     */
    clearCache(): Promise<LyricsCacheClearResult>;
    /** Rows for Settings -> Cache: every cached track and manual search, newest first. */
    listCache(): Promise<LyricsCacheListResult>;
    /** The stored payloads of one entry, including the original lyrics text. */
    getCacheEntry(key: string): Promise<LyricsCacheEntryDetail | null>;
    /**
     * Deletes one entry and waits for the file write, so the UI only reports a deletion that
     * really happened. Original lyrics files, audio files and embedded tags are never touched.
     */
    removeCacheEntry(key: string): Promise<LyricsCacheRemoveResult>;
    /** Stores the lyrics file the user picked by hand so it survives restarts. */
    cacheChosenFile(request: { trackId: number; path: string; text: string }): Promise<void>;
    /** Stores a manual-search result the user chose, replacing any earlier choice for the track. */
    rememberSelection(request: { trackId: number; candidate: LyricsCandidate }): Promise<void>;
    /**
     * The persistent Fetch All Lyrics background job. It runs beside the lyrics service (never
     * through the track-scoped `resolve` above), shares the same provider/cache/request
     * coordination, and survives navigation and app restarts.
     */
    fetchAll: {
      getState(): Promise<LyricsFetchJobSnapshot>;
      /** Builds the queue and starts; a compatible running job is returned instead of duplicated. */
      start(): Promise<LyricsFetchJobSnapshot>;
      pause(): Promise<LyricsFetchJobSnapshot>;
      resume(): Promise<LyricsFetchJobSnapshot>;
      /** Stops active requests and drops pending work; already-cached lyrics are kept. */
      cancel(): Promise<LyricsFetchJobSnapshot>;
      /** Re-queues temporary failures / rate-limited tracks. Nothing retries automatically. */
      retryFailed(): Promise<LyricsFetchJobSnapshot>;
      stats(): Promise<LyricsFetchStats>;
      /** Moves a pending track to the front of the queue (e.g. it just started playing). */
      promote(trackId: number): Promise<void>;
      onProgress(listener: (snapshot: LyricsFetchJobSnapshot) => void): () => void;
    };
  };
  player: {
    /** Decode an ALAC source to a seekable lossless PCM WAV cache and return its media URL. */
    prepareAlacSource(path: string): Promise<string>;
    reportState(state: PlayerSnapshot): Promise<void>;
    onCommand(listener: (command: MediaCommand) => void): () => void;
  };
  decodeTester: {
    /**
     * Deletes only the listed library audio files (after the UI's explicit confirmation) and drops
     * the successfully deleted ones from the library. Each file reports its own outcome.
     */
    deleteFiles(paths: string[]): Promise<DecodeDeleteOutcome[]>;
    /**
     * Opens a native save dialog and writes the listed paths as UTF-8 text, one path per line.
     * Resolves with `canceled: true` when the user dismisses the dialog.
     */
    exportFileList(paths: string[]): Promise<{ canceled: boolean; path?: string }>;
  };
  app: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<void>;
    chooseLyricsFile(trackId: number): Promise<{ canceled: boolean; path?: string; text?: string }>;
    window(action: WindowAction): Promise<void>;
    isFullScreen(): Promise<boolean>;
    /** Frame state captured while the bridge boots, so the title bar renders on the first frame. */
    initialWindowChrome: WindowChromeState;
    windowChrome(): Promise<WindowChromeState>;
    onWindowChromeChange(listener: (state: WindowChromeState) => void): () => void;
  };
}

/** Window-frame state used to draw Cadence's integrated title bar. */
export interface WindowChromeState {
  /** The OS draws no frame, so the renderer draws the title bar and its window controls. */
  undecorated: boolean;
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
}

/** Native window commands reachable from the integrated title bar. */
export type WindowAction =
  | "minimize"
  | "maximize"
  | "restore"
  | "close"
  | "fullscreen"
  | "exitFullscreen";

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
  historyAdd: "history:add",
  historyList: "history:list",
  historyClear: "history:clear",
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
  lyricsSearch: "lyrics:search",
  lyricsYouTube: "lyrics:youtube-metadata",
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
