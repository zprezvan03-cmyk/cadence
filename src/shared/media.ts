/**
 * Pure helpers for Cadence's source-aware media model.
 *
 * These helpers intentionally do not manufacture local identities for remote media: a YouTube
 * item keeps its string video ID and canonical URL, while a local item keeps the existing
 * numeric library ID. Playback mechanism selection lives with the playback coordinator/player;
 * this module only describes where an item came from.
 */

import type { MediaItem, Track, TrackSource } from "./types";

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

export function remoteVideoId(item: MediaItem): string | null {
  return isRemoteSource(item.source) ? item.source.remoteId : null;
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
