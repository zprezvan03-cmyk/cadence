/**
 * In-memory state for the isolated YouTube IFrame prototype.
 *
 * This deliberately does not touch Cadence's local library, queue, playlists, history, or SQLite.
 * Navigating away unmounts and destroys the iframe; only the pasted link and last player-reported
 * metadata survive for the current app session.
 */

import { create } from "zustand";
import { RemotePlaybackClockSource } from "../player/playbackClock";
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
  sizeMode: YouTubePlayerSizeMode;
  volume: number;
  muted: boolean;
  setDraftUrl: (url: string) => void;
  load: (videoId: string, sourceUrl: string) => void;
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
  sizeMode: "compact",
  volume: 0.85,
  muted: false,

  setDraftUrl: draftUrl => set({ draftUrl }),

  load: (videoId, sourceUrl) => {
    const current = get();
    const isNewVideo = current.videoId !== videoId;
    if (isNewVideo) youtubePlaybackClock.reset();
    set({
      videoId,
      sourceUrl,
      metadata: isNewVideo
        ? {
            videoId,
            sourceId: `youtube:${videoId}`,
            title: "Loading YouTube video…",
            artist: "",
            album: "",
            duration: 0,
            artworkUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            sourceUrl,
          }
        : current.metadata,
    });
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
    set({ metadata });
  },

  setSizeMode: sizeMode => set({ sizeMode }),

  setVolume: (volume, muted) =>
    set(state => ({
      volume: Math.min(1, Math.max(0, volume)),
      muted: muted ?? state.muted,
    })),

  clear: () => {
    youtubePlaybackClock.reset();
    set({ videoId: null, sourceUrl: null, metadata: null });
  },
}));
