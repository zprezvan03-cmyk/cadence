/**
 * Registration point for the one official YouTube IFrame mounted by Cadence's main Now Playing
 * view.
 *
 * This module is deliberately not a playback store: it holds no current item, queue, play state,
 * history or UI state. `playerStore` remains the single source of truth; this adapter only lets
 * that store call the currently mounted player's documented handle and share its sampled clock
 * with the lyrics renderer.
 */

import { RemotePlaybackClockSource } from "./playbackClock";
import type { YouTubePlayerHandle } from "../features/youtube/YouTubeIframePlayer";

export const youtubePlaybackClock = new RemotePlaybackClockSource();

let activePlayer: YouTubePlayerHandle | null = null;

export function registerYouTubePlayer(handle: YouTubePlayerHandle | null): void {
  activePlayer = handle;
  if (!handle) {
    youtubePlaybackClock.setSnapshot({
      ...youtubePlaybackClock.getSnapshot(),
      isPlaying: false,
      sampledAt: Date.now(),
    });
  }
}

export function getYouTubePlayer(): YouTubePlayerHandle | null {
  return activePlayer;
}

export function resetYouTubePlaybackClock(): void {
  youtubePlaybackClock.reset();
}
