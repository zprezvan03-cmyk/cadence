/**
 * Bounded in-memory registry for remote catalog results.
 *
 * Phase A deliberately does not persist YouTube Data API metadata in SQLite or settings. The
 * registry only lets Search, Home, channel/playlist detail and the existing official-player
 * view hand the same source-aware item to one another during this app session.
 */

import { create } from "zustand";
import { mediaItemKey } from "../../shared/media";
import type { MediaItem, YouTubeChannelItem, YouTubePlaylistSummary } from "../../shared/types";

const MAX_VIDEOS = 500;
const MAX_CHANNELS = 200;
const MAX_PLAYLISTS = 200;

interface RemoteMediaState {
  videosByKey: Record<string, MediaItem>;
  channelsById: Record<string, YouTubeChannelItem>;
  playlistsById: Record<string, YouTubePlaylistSummary>;
  rememberVideos: (items: readonly MediaItem[]) => void;
  rememberChannels: (items: readonly YouTubeChannelItem[]) => void;
  rememberPlaylists: (items: readonly YouTubePlaylistSummary[]) => void;
  clear: () => void;
}

function prune<T extends { fetchedAt: number }>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= max) return record;
  entries.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
  return Object.fromEntries(entries.slice(0, max));
}

export const useRemoteMedia = create<RemoteMediaState>()(set => ({
  videosByKey: {},
  channelsById: {},
  playlistsById: {},

  rememberVideos: items => {
    if (items.length === 0) return;
    set(state => {
      const next = { ...state.videosByKey };
      for (const item of items) next[mediaItemKey(item)] = item;
      return { videosByKey: prune(next, MAX_VIDEOS) };
    });
  },

  rememberChannels: items => {
    if (items.length === 0) return;
    set(state => {
      const next = { ...state.channelsById };
      for (const item of items) next[item.id] = item;
      return { channelsById: prune(next, MAX_CHANNELS) };
    });
  },

  rememberPlaylists: items => {
    if (items.length === 0) return;
    set(state => {
      const next = { ...state.playlistsById };
      for (const item of items) next[item.id] = item;
      return { playlistsById: prune(next, MAX_PLAYLISTS) };
    });
  },

  clear: () => set({ videosByKey: {}, channelsById: {}, playlistsById: {} }),
}));
