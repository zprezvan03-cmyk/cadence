/**
 * In-memory state for the isolated YouTube IFrame prototype.
 *
 * This deliberately does not touch Cadence's local library, queue, playlists, history, or SQLite.
 * Navigating away unmounts and destroys the iframe; only the pasted link and last player-reported
 * metadata survive for the current app session.
 */

import { create } from "zustand";
import { RemotePlaybackClockSource } from "../player/playbackClock";
import { remoteVideoId, trackSourceKey, youtubeMediaItem } from "../../shared/media";
import { parseYouTubeVideoLink } from "../../shared/youtube";
import type { MediaItem } from "../../shared/types";
import type { YouTubePlayerSizeMode } from "../features/youtube/YouTubeIframePlayer";

export interface YouTubeRemoteMetadata {
  videoId: string;
  /** Remote identity in the form `youtube:<videoId>`; never a local track ID. */
  sourceId: string;
  title: string;
  artist: string;
  /** The IFrame API does not provide an album; this stays blank unless a later source supplies it. */
  album: string;
  duration: number;
  artworkUrl: string;
  sourceUrl: string;
}

interface YouTubeRemoteState {
  draftUrl: string;
  videoId: string | null;
  sourceUrl: string | null;
  metadata: YouTubeRemoteMetadata | null;
  /** Source-aware catalog/link item currently cued in the official player, when known. */
  currentItem: MediaItem | null;
  sizeMode: YouTubePlayerSizeMode;
  volume: number;
  muted: boolean;
  setDraftUrl: (url: string) => void;
  load: (videoId: string, sourceUrl: string, item?: MediaItem | null) => void;
  loadMediaItem: (item: MediaItem) => boolean;
  setMetadata: (metadata: YouTubeRemoteMetadata) => void;
  setSizeMode: (mode: YouTubePlayerSizeMode) => void;
  setVolume: (volume: number, muted?: boolean) => void;
  clear: () => void;
}

/** One clock for the prototype. Player polls publish here; lyrics subscribe without React renders. */
export const youtubePlaybackClock = new RemotePlaybackClockSource();

export const useYouTubeRemote = create<YouTubeRemoteState>()((set, get) => ({
  draftUrl: "",
  videoId: null,
  sourceUrl: null,
  metadata: null,
  currentItem: null,
  sizeMode: "compact",
  volume: 0.85,
  muted: false,

  setDraftUrl: draftUrl => set({ draftUrl }),

  load: (videoId, sourceUrl, suppliedItem) => {
    const current = get();
    const isNewVideo = current.videoId !== videoId;
    if (isNewVideo) youtubePlaybackClock.reset();

    const suppliedMatches = suppliedItem && remoteVideoId(suppliedItem) === videoId ? suppliedItem : null;
    const parsedSourceKind = parseYouTubeVideoLink(sourceUrl)?.sourceKind ?? "youtube";
    const currentItem =
      suppliedMatches ??
      (isNewVideo
        ? youtubeMediaItem({
            videoId,
            sourceKind: parsedSourceKind,
            title: "Loading YouTube video…",
            artistLabel: "",
            artworkUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            availability: "unknown",
          })
        : current.currentItem);

    set({
      videoId,
      sourceUrl,
      currentItem,
      metadata:
        isNewVideo || suppliedMatches
          ? {
              videoId,
              sourceId: currentItem ? trackSourceKey(currentItem.source) : `youtube:${videoId}`,
              title: currentItem?.title ?? "Loading YouTube video…",
              artist: currentItem?.artistLabel ?? "",
              album: currentItem?.albumLabel ?? "",
              duration: currentItem?.durationSeconds ?? 0,
              artworkUrl:
                currentItem?.artworkUrl ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
              sourceUrl,
            }
          : current.metadata,
    });
  },

  loadMediaItem: item => {
    const videoId = remoteVideoId(item);
    if (!videoId || item.source.kind === "local") return false;
    set({ draftUrl: item.source.canonicalUrl });
    get().load(videoId, item.source.canonicalUrl, item);
    return true;
  },

  setMetadata: metadata => {
    const current = get();
    if (current.videoId !== metadata.videoId) return;
    const previous = current.metadata;
    if (
      previous?.title === metadata.title &&
      previous.artist === metadata.artist &&
      previous.album === metadata.album &&
      previous.duration === metadata.duration &&
      previous.artworkUrl === metadata.artworkUrl &&
      previous.sourceUrl === metadata.sourceUrl
    ) {
      return;
    }
    set(state => ({
      metadata,
      currentItem: state.currentItem
        ? {
            ...state.currentItem,
            title: metadata.title || state.currentItem.title,
            artistLabel: metadata.artist || state.currentItem.artistLabel,
            albumLabel: metadata.album || state.currentItem.albumLabel,
            durationSeconds: metadata.duration > 0 ? metadata.duration : state.currentItem.durationSeconds,
            artworkUrl: metadata.artworkUrl || state.currentItem.artworkUrl,
            fetchedAt: Date.now(),
          }
        : state.currentItem,
    }));
  },

  setSizeMode: sizeMode => set({ sizeMode }),

  setVolume: (volume, muted) =>
    set(state => ({
      volume: Math.min(1, Math.max(0, volume)),
      muted: muted ?? state.muted,
    })),

  clear: () => {
    youtubePlaybackClock.reset();
    set({ videoId: null, sourceUrl: null, metadata: null, currentItem: null });
  },
}));
