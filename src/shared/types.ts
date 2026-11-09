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
  /** ReplayGain track adjustment from file tags, in dB (null when untagged). */
  replayGainTrackDb: number | null;
  /** ReplayGain album adjustment from file tags, in dB (null when untagged). */
  replayGainAlbumDb: number | null;
  /** ReplayGain track peak amplitude (linear), used for clipping prevention. */
  replayGainTrackPeak: number | null;
  /** ReplayGain album peak amplitude (linear), used for clipping prevention. */
  replayGainAlbumPeak: number | null;
  /** True when a sidecar `.lrc`/`.ttml`/`.qrc`/`.srt` file sits next to the audio file. */
  hasSidecarLyrics: boolean;
  /** True when this file has a supported audio extension; codec support is checked separately. */
  playable: boolean;
  /** True when the user has edited this track's details in Cadence (see `metadataOverride`). */
  metadataEdited?: boolean;
  /**
   * The user's saved edits for this track, plus the scanned file-tag values they replaced.
   * Cadence re-applies `patch` after every rescan, so edits survive rescans without the
   * audio file itself ever being modified. Null/absent when the track is unedited.
   */
  metadataOverride?: TrackMetadataOverride | null;
}

/** Editable text/number fields of a track, as patched by the user in the track editor. */
export interface TrackMetadataEdit {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  genre?: string;
  year?: number | null;
  trackNo?: number | null;
  discNo?: number | null;
  /** Artwork file in Cadence's artwork cache; `null` means "explicitly no cover". */
  artworkFile?: string | null;
}

/** A complete snapshot of a track's editable fields, as read from the audio file's tags. */
export interface TrackMetadataSnapshot {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  genre: string;
  year: number | null;
  trackNo: number | null;
  discNo: number | null;
  artworkFile: string | null;
}

/**
 * Durable per-track edit state: `patch` holds only the fields the user changed, and
 * `original` holds the latest scanned tag values so "Reset to file tags" is always exact.
 */
export interface TrackMetadataOverride {
  patch: TrackMetadataEdit;
  original: TrackMetadataSnapshot;
  updatedAt: number;
}

/* ------------------------------------------------------------------ media sources */

/**
 * Content origin is deliberately separate from the mechanism that eventually plays it. The
 * remote source kinds are retained for source-aware queue/history compatibility and for a
 * future documented, appropriately licensed provider. This build registers no remote
 * playback provider, so non-local entries are representable but not playable.
 */
export type TrackSource =
  | { kind: "local"; trackId: number }
  | { kind: "youtube-music"; remoteId: string; canonicalUrl: string }
  | { kind: "youtube"; remoteId: string; canonicalUrl: string };

export type PlaybackMechanism = "local-file" | "remote-provider" | "unavailable";

export type MediaAvailability = "ready" | "restricted" | "unavailable" | "live" | "unknown";

/** Source-aware display/playback item shared by local and remote catalog surfaces. */
export interface MediaItem {
  source: TrackSource;
  title: string;
  artistLabel: string;
  channelId: string | null;
  channelTitle: string | null;
  albumLabel: string | null;
  durationSeconds: number | null;
  artworkUrl: string | null;
  publishedAt: string | null;
  availability: MediaAvailability;
  fetchedAt: number;
}

/**
 * One occurrence of a media item in Cadence's single playback queue. The occurrence ID is
 * deliberately distinct from the item's source identity: the same local or remote item may
 * appear more than once, and history/transition guards are keyed by the occurrence plus the
 * playback load, never by inventing a local numeric ID for remote media.
 */
export interface QueueEntry {
  occurrenceId: string;
  item: MediaItem;
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

/** Built-in smart playlist rule kinds, evaluated live against the current library. */
export type SmartPlaylistPreset =
  | "favorites"
  | "recently-added"
  | "recently-played"
  | "most-played"
  | "never-played"
  | "genre"
  | "artist";

/**
 * A smart playlist rule. Smart playlists store no track list: membership is recomputed
 * from the library every time the playlist is read, so it stays current on its own.
 */
export interface SmartPlaylistRule {
  preset: SmartPlaylistPreset;
  /** Genre or artist text for the `genre` / `artist` presets. */
  value?: string;
  /** Maximum number of tracks (after the preset's ordering); absent means no practical cap. */
  limit?: number;
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
  /** `smart` playlists are rule-driven and cannot be edited track by track. */
  kind?: "manual" | "smart";
  /** The rule driving a smart playlist; null/absent for manual playlists. */
  smart?: SmartPlaylistRule | null;
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
  /** Bypass only this transformation's derived result cache on explicit user regeneration. */
  forceRegenerate?: boolean;
  /** Plain neighboring lyric lines for context; never markup or timestamps. */
  contextLines?: string[];
  /** Stable identities from the parsed source lyric positions. */
  segmentIds?: string[];
  /** Optional per-segment source spans for word/syllable-aligned romanization. */
  segmentSpans?: Array<string[] | undefined>;
  targetLanguage: string;
  /** Optional song language hint used for romanization. */
  sourceLanguage?: string | null;
}

export interface TranslationResult {
  /** Aligned with the input lines; `null` when the line could not be translated. */
  translations: (string | null)[];
  detectedLanguage: string;
}

export type RomanizationMode = "line" | "word";

export interface RomanizationResult {
  romanizations: (string | null)[];
  detectedLanguage: string;
  /** Optional per-line word arrays aligned to the source words; used by word romanization mode. */
  words?: (string[] | null)[];
}

/** Bounded provider-request parallelism for Autofetch / Fetch All (see the central limiter). */
export type LyricsFetchConcurrency = "low" | "balanced" | "high";

export type LyricsAiProtocol = "ollama-native" | "openai-compatible";
export interface LyricsAiConfig {
  enabled: boolean;
  protocol: LyricsAiProtocol;
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  targetLanguage?: string;
  romanizationStandard?: string;
  /** JSON object of optional custom headers. Never included in logs or status text. */
  customHeaders: string;
}

export interface LyricsSettings {
  aiTranslation: LyricsAiConfig;
  aiRomanization: LyricsAiConfig;
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
  /** Whether generated romanization is shown as a full line or aligned word-by-word. */
  romanizationMode: RomanizationMode;
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

export type ReplayGainMode = "off" | "track" | "album";

export interface EqualizerSettings {
  enabled: boolean;
  preampDb: number;
  /** 10 band gains in dB (-12..+12); centre frequencies live in the renderer's equalizer module. */
  bandsDb: number[];
  presetId: string;
}

export interface PlaybackSettings {
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  playbackRate: number;
  resumeOnLaunch: boolean;
  /** Seconds of overlap between consecutive tracks; 0 disables crossfade. */
  crossfadeSeconds: number;
  /** Preload the next track so queue transitions cut without a silent gap. */
  gaplessPlayback: boolean;
  replayGainMode: ReplayGainMode;
  replayGainPreampDb: number;
  replayGainPreventClipping: boolean;
  equalizer: EqualizerSettings;
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
  scrobbling: LastFmSettings;
}

/** last.fm scrobbling credentials and session, stored locally in settings. */
export interface LastFmSettings {
  enabled: boolean;
  /** User-supplied last.fm API key (Cadence ships no shared key). */
  apiKey: string;
  /** User-supplied last.fm shared secret used only to sign requests locally. */
  apiSecret: string;
  /** Long-lived session key returned by auth.getSession; empty until connected. */
  sessionKey: string;
  /** Connected last.fm username, shown in Settings once authorized. */
  username: string;
}

/** One completed listening session, newest first when listed. */
export interface HistoryEntry {
  id: number;
  /** Discriminated content origin; remote plays never borrow a local numeric track ID. */
  source: TrackSource;
  /** When playback started, ms since epoch. */
  playedAt: number;
  /** Track metadata snapshot as it was when playback started; survives file removal. */
  payload: HistoryPayload;
}

interface HistoryPayloadBase {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  artworkUrl: string | null;
  duration: number;
  /** When remote catalog metadata was fetched; local snapshots use their play time if absent. */
  fetchedAt?: number;
}

/** Stored snapshot of a local play, kept small so history rows stay cheap. */
export interface LocalHistoryPayload extends HistoryPayloadBase {
  source: Extract<TrackSource, { kind: "local" }>;
  trackId: number;
  path: string;
}

/** Stored snapshot of an observed remote-provider play start. */
export interface RemoteHistoryPayload extends HistoryPayloadBase {
  source: Extract<TrackSource, { kind: "youtube" | "youtube-music" }>;
  channelId: string | null;
  channelTitle: string | null;
  canonicalUrl: string;
  playbackMechanism: Extract<PlaybackMechanism, "remote-provider">;
  fetchedAt: number;
}

/** Stored snapshot of a played item, discriminated by the same source model as the queue. */
export type HistoryPayload = LocalHistoryPayload | RemoteHistoryPayload;

export interface PlayerSnapshot {
  /** Local library ID for local playback; null for remote playback (never a fake ID). */
  trackId: number | null;
  source: TrackSource | null;
  playbackMechanism: PlaybackMechanism;
  position: number;
  duration: number;
  playing: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  shuffle: boolean;
  repeat: RepeatMode;
  queue: TrackSource[];
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
      source: TrackSource;
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
    /**
     * Saves user edits to a track's details as a durable override that is re-applied after
     * every rescan (the audio file itself is never modified). Resolves with the updated track.
     */
    updateTrackMetadata(id: number, edit: TrackMetadataEdit): Promise<Track | null>;
    /** Discards all saved edits for a track, restoring the values scanned from its file tags. */
    resetTrackMetadata(id: number): Promise<Track | null>;
    /**
     * Stores a user-chosen cover image for a track (saved into Cadence's artwork cache and
     * kept across rescans). Resolves with the updated track.
     */
    setTrackArtwork(id: number, data: ArrayBuffer, mimeType: string): Promise<Track | null>;
    /** Removes the track's cover in Cadence (kept across rescans until reset). */
    removeTrackArtwork(id: number): Promise<Track | null>;
    /** Drops only the artwork edit, so the cover scanned from the file shows again. */
    resetTrackArtwork(id: number): Promise<Track | null>;
    onScanProgress(listener: (progress: ScanProgress) => void): () => void;
    onChanged(listener: () => void): () => void;
  };
  playlists: {
    list(): Promise<Playlist[]>;
    create(name: string, trackIds?: number[]): Promise<Playlist>;
    /** Creates a rule-driven playlist whose membership is recomputed from the library. */
    createSmart(name: string, rule: SmartPlaylistRule): Promise<Playlist>;
    /** Replaces the rule of an existing smart playlist. */
    updateSmart(id: number, rule: SmartPlaylistRule): Promise<void>;
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
    aiModels(kind: "translation" | "romanization"): Promise<{id: string; name: string}[]>;
    aiTestConnection(kind: "translation" | "romanization"): Promise<string>;
    saveSidecar(trackId: number, text: string, format?: "ttml" | "lrc"): Promise<{ path: string }>;
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
    /** Resize the OS window into (or out of) the compact always-on-top mini-player. */
    setMiniPlayer(enabled: boolean): Promise<void>;
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
