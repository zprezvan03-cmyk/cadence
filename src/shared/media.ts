/**
 * Pure helpers for Cadence's source-aware media model.
 *
 * These helpers intentionally do not manufacture local identities for remote media: a YouTube
 * item keeps its string video ID and canonical URL, while a local item keeps the existing
 * numeric library ID. Playback mechanism selection lives with the playback coordinator/player;
 * this module only describes where an item came from.
 */

import type {
  HistoryPayload,
  LocalHistoryPayload,
  MediaItem,
  RemoteHistoryPayload,
  Track,
  TrackSource,
} from "./types";

export function trackSourceKey(source: TrackSource): string {
  return source.kind === "local" ? `local:${source.trackId}` : `${source.kind}:${source.remoteId}`;
}

export function mediaItemKey(item: MediaItem): string {
  return trackSourceKey(item.source);
}

export function isRemoteSource(
  source: TrackSource
): source is Extract<TrackSource, { kind: "youtube" | "youtube-music" }> {
  return source.kind !== "local";
}

export function remoteVideoId(itemOrSource: MediaItem | TrackSource): string | null {
  const source = "source" in itemOrSource ? itemOrSource.source : itemOrSource;
  return isRemoteSource(source) ? source.remoteId : null;
}

export function sourceDisplayName(source: TrackSource): string | null {
  switch (source.kind) {
    case "youtube-music":
      return "YouTube Music";
    case "youtube":
      return "YouTube";
    case "local":
      return null;
  }
}

export function localTrackSource(track: Pick<Track, "id">): TrackSource {
  return { kind: "local", trackId: track.id };
}

export function mediaItemFromLocalTrack(track: Track, fetchedAt = Date.now()): MediaItem {
  return {
    source: localTrackSource(track),
    title: track.title,
    artistLabel: track.artist,
    channelId: null,
    channelTitle: null,
    albumLabel: track.album || null,
    durationSeconds: track.duration > 0 ? track.duration : null,
    artworkUrl: track.artworkUrl,
    publishedAt: null,
    availability: track.playable ? "ready" : "unavailable",
    fetchedAt,
  };
}

export function youtubeCanonicalUrl(videoId: string, music = false): string {
  return music
    ? `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export function youtubeMediaItem(input: {
  videoId: string;
  sourceKind?: "youtube" | "youtube-music";
  title: string;
  artistLabel: string;
  channelId?: string | null;
  channelTitle?: string | null;
  albumLabel?: string | null;
  durationSeconds?: number | null;
  artworkUrl?: string | null;
  publishedAt?: string | null;
  availability?: MediaItem["availability"];
  fetchedAt?: number;
}): MediaItem {
  const sourceKind = input.sourceKind ?? "youtube";
  return {
    source: {
      kind: sourceKind,
      remoteId: input.videoId,
      canonicalUrl: youtubeCanonicalUrl(input.videoId, sourceKind === "youtube-music"),
    },
    title: input.title,
    artistLabel: input.artistLabel,
    channelId: input.channelId ?? null,
    channelTitle: input.channelTitle ?? null,
    albumLabel: input.albumLabel ?? null,
    durationSeconds: input.durationSeconds ?? null,
    artworkUrl: input.artworkUrl ?? null,
    publishedAt: input.publishedAt ?? null,
    availability: input.availability ?? "unknown",
    fetchedAt: input.fetchedAt ?? Date.now(),
  };
}

/** Data API embed flags are useful, but the official player remains the final authority. */
export function canOpenInYouTubePlayer(item: MediaItem): boolean {
  return isRemoteSource(item.source) && item.availability !== "not-embeddable" && item.availability !== "unavailable";
}

/**
 * YouTube Music album playlists live in the public `OLAK5uy…` playlist-ID namespace. Cadence
 * uses that explicit identity only to label a playlist as a verified album collection; it is
 * not treated as a Data API album object and no album metadata is invented from titles.
 */
export function isYouTubeMusicAlbumPlaylistId(playlistId: string | null | undefined): boolean {
  return typeof playlistId === "string" && /^OLAK5uy[A-Za-z0-9_-]+$/.test(playlistId);
}

export function historyPayloadFromLocalTrack(track: Track): LocalHistoryPayload {
  return {
    source: localTrackSource(track) as Extract<TrackSource, { kind: "local" }>,
    trackId: track.id,
    path: track.path,
    title: track.title,
    artist: track.artist,
    albumArtist: track.albumArtist,
    album: track.album,
    artworkUrl: track.artworkUrl,
    duration: track.duration,
  };
}

export function historyPayloadFromMediaItem(item: MediaItem): HistoryPayload | null {
  if (!isRemoteSource(item.source)) return null;
  return {
    source: item.source,
    title: item.title,
    artist: item.artistLabel,
    albumArtist: item.artistLabel,
    album: item.albumLabel ?? "",
    artworkUrl: item.artworkUrl,
    duration: item.durationSeconds ?? 0,
    channelId: item.channelId,
    channelTitle: item.channelTitle,
    canonicalUrl: item.source.canonicalUrl,
    playbackMechanism: "youtube-iframe",
    fetchedAt: item.fetchedAt,
  };
}

export function mediaItemFromHistoryPayload(payload: HistoryPayload): MediaItem | null {
  if (payload.source.kind === "local") return null;
  const remote = payload as RemoteHistoryPayload;
  return {
    source: remote.source,
    title: remote.title,
    artistLabel: remote.artist,
    channelId: remote.channelId,
    channelTitle: remote.channelTitle,
    albumLabel: remote.album || null,
    durationSeconds: remote.duration > 0 ? remote.duration : null,
    artworkUrl: remote.artworkUrl,
    publishedAt: null,
    availability: "unknown",
    fetchedAt: remote.fetchedAt,
  };
}
