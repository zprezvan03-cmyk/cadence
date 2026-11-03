/**
 * YouTube Music domain model for Cadence.
 *
 * These types describe the music-oriented catalog that Cadence's InnerTube-based provider
 * (src/main/ytmusic) returns. They are deliberately separate from the local library `Track`
 * model: a remote song keeps its string video ID, and `mediaItemFromYtm*` converts it to the
 * unified `MediaItem` with a `youtube-music` TrackSource — never a fake local numeric ID and
 * never a filesystem path.
 *
 * Architectural reference: ArchiveTune (rukamori/ArchiveTune @ c7f0e243, GPL-3.0) and its pinned
 * core (rukamori/core @ fefeefa, GPL-3.0). The endpoint names, client profile fields and response
 * renderer shapes below are interface facts of YouTube's InnerTube API; all parsing and client
 * code in Cadence is original TypeScript, no upstream code is copied.
 */

import type { MediaItem, TrackSource } from "./types";
import { youtubeCanonicalUrl } from "./media";

export type YtmSearchFilter = "all" | "songs" | "videos" | "albums" | "artists" | "playlists";

export const YTM_SEARCH_FILTERS: readonly YtmSearchFilter[] = [
  "all",
  "songs",
  "videos",
  "albums",
  "artists",
  "playlists",
];

export const YTM_SEARCH_FILTER_LABELS: Record<YtmSearchFilter, string> = {
  all: "All",
  songs: "Songs",
  videos: "Videos",
  albums: "Albums",
  artists: "Artists",
  playlists: "Playlists",
};

export interface YtmArtistRef {
  name: string;
  browseId: string | null;
}

export interface YtmAlbumRef {
  title: string;
  browseId: string;
}

/** A song or video row. `kind` distinguishes the music-video (ATV) from plain video results. */
export interface YtmTrack {
  kind: "song" | "video";
  videoId: string;
  title: string;
  artists: YtmArtistRef[];
  album: YtmAlbumRef | null;
  durationSeconds: number | null;
  durationText: string | null;
  artworkUrl: string | null;
  explicit: boolean;
  viewCountText: string | null;
  /** Playlist the result was reached through (radio/automix context), when present. */
  playlistId: string | null;
  setVideoId: string | null;
}

export interface YtmAlbum {
  browseId: string;
  /** Watch-playlist id for the whole album (OLAK5uy_…), when known. */
  playlistId: string | null;
  title: string;
  artists: YtmArtistRef[];
  year: number | null;
  artworkUrl: string | null;
  explicit: boolean;
  trackCountText: string | null;
  albumType: string | null;
}

export interface YtmArtist {
  browseId: string;
  name: string;
  artworkUrl: string | null;
  subscriberCountText: string | null;
  /** Shuffle watch-playlist id, when the source offered one. */
  shufflePlaylistId: string | null;
  /** Radio (mix) playlist id, when the source offered one. */
  radioPlaylistId: string | null;
}

export interface YtmPlaylist {
  id: string;
  title: string;
  author: YtmArtistRef | null;
  trackCountText: string | null;
  viewCountText: string | null;
  artworkUrl: string | null;
  shufflePlaylistId: string | null;
  radioPlaylistId: string | null;
}

export type YtmItem =
  | { type: "song"; track: YtmTrack }
  | { type: "video"; track: YtmTrack }
  | { type: "album"; album: YtmAlbum }
  | { type: "artist"; artist: YtmArtist }
  | { type: "playlist"; playlist: YtmPlaylist };

export interface YtmSearchResults {
  filter: YtmSearchFilter;
  /** Top result card (all-filter searches), kept separate from the list sections. */
  topResult: YtmItem | null;
  items: YtmItem[];
  continuation: string | null;
}

export interface YtmHomeChip {
  title: string;
  params: string | null;
  selected: boolean;
}

export interface YtmShelf {
  title: string | null;
  subtitle: string | null;
  items: YtmItem[];
  /** Continuation token for paging this shelf (artist "Songs" etc.). */
  continuation: string | null;
  /** "More" browse target for the whole shelf (Explore → New releases etc.). */
  moreBrowseId: string | null;
  moreParams: string | null;
}

export interface YtmHomePage {
  chips: YtmHomeChip[];
  sections: YtmShelf[];
  continuation: string | null;
}

export interface YtmArtistPage {
  browseId: string;
  name: string;
  artworkUrl: string | null;
  description: string | null;
  subscriberCountText: string | null;
  shufflePlaylistId: string | null;
  radioPlaylistId: string | null;
  shelves: YtmShelf[];
  continuation: string | null;
}

export interface YtmAlbumPage {
  browseId: string;
  title: string;
  artists: YtmArtistRef[];
  year: number | null;
  artworkUrl: string | null;
  description: string | null;
  trackCountText: string | null;
  durationText: string | null;
  tracks: YtmTrack[];
  continuation: string | null;
}

export interface YtmPlaylistPage {
  id: string;
  title: string;
  author: YtmArtistRef | null;
  description: string | null;
  trackCountText: string | null;
  viewCountText: string | null;
  artworkUrl: string | null;
  tracks: YtmTrack[];
  continuation: string | null;
}

export interface YtmMoodOrGenre {
  title: string;
  browseId: string | null;
  params: string | null;
}

export interface YtmExplorePage {
  newReleaseAlbums: YtmAlbum[];
  moodAndGenres: YtmMoodOrGenre[];
  /** Raw shelves for anything else the explore page returns. */
  shelves: YtmShelf[];
}

export interface YtmChartsPage {
  shelves: YtmShelf[];
  continuation: string | null;
}

export interface YtmSuggestions {
  queries: string[];
  items: YtmItem[];
}

/** One playable stream candidate resolved from the InnerTube `player` endpoint. */
export interface YtmStreamFormat {
  itag: number;
  url: string | null;
  /** Present when the URL is split into a ciphered signature; Cadence never deciphers it. */
  signatureCipher: string | null;
  mimeType: string;
  bitrate: number;
  contentLength: number | null;
  audioQuality: string | null;
  approxDurationMs: number | null;
}

export type YtmPlayabilityStatus =
  | "OK"
  | "LOGIN_REQUIRED"
  | "ERROR"
  | "UNPLAYABLE"
  | "LIVE_STREAM_OFFLINE"
  | "UNKNOWN";

export interface YtmPlayerResult {
  videoId: string;
  status: YtmPlayabilityStatus;
  /** Human-readable reason when status is not OK. */
  reason: string | null;
  title: string | null;
  author: string | null;
  channelId: string | null;
  durationSeconds: number | null;
  /** Audio-only formats, best first. Formats with a null url need deciphering and are flagged. */
  audioFormats: YtmStreamFormat[];
  /** True when at least one audio format has a directly usable URL (no deciphering). */
  hasDirectStream: boolean;
  /** True when every audio format is ciphered; native playback is then blocked by policy. */
  requiresDeciphering: boolean;
}

export interface YtmQueueResult {
  title: string | null;
  tracks: YtmTrack[];
  currentIndex: number | null;
  continuation: string | null;
  lyricsBrowseId: string | null;
  lyricsParams: string | null;
}

/* ------------------------------------------------------------------ conversions */

export function ytmWatchUrl(videoId: string, playlistId?: string | null): string {
  const base = youtubeCanonicalUrl(videoId, true);
  return playlistId ? `${base}&list=${encodeURIComponent(playlistId)}` : base;
}

export function ytmTrackSource(videoId: string, playlistId?: string | null): TrackSource {
  return { kind: "youtube-music", remoteId: videoId, canonicalUrl: ytmWatchUrl(videoId, playlistId) };
}

function artistLabel(artists: readonly YtmArtistRef[]): string {
  return artists.map(artist => artist.name).filter(Boolean).join(", ");
}

/** Convert a remote YTM track into the unified source-aware MediaItem (queue/history/NP). */
export function mediaItemFromYtmTrack(track: YtmTrack, fetchedAt = Date.now()): MediaItem {
  return {
    source: ytmTrackSource(track.videoId, track.playlistId),
    title: track.title,
    artistLabel: artistLabel(track.artists),
    channelId: track.artists.find(artist => artist.browseId)?.browseId ?? null,
    channelTitle: artistLabel(track.artists) || null,
    albumLabel: track.album?.title ?? null,
    durationSeconds: track.durationSeconds,
    artworkUrl: track.artworkUrl,
    publishedAt: null,
    availability: "ready",
    fetchedAt,
  };
}

export function ytmItemKey(item: YtmItem): string {
  switch (item.type) {
    case "song":
    case "video":
      return `video:${item.track.videoId}`;
    case "album":
      return `album:${item.album.browseId}`;
    case "artist":
      return `artist:${item.artist.browseId}`;
    case "playlist":
      return `playlist:${item.playlist.id}`;
  }
}
