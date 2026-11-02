/**
 * Pure helpers for the official YouTube IFrame player prototype.
 *
 * These are kept out of the TSX component so Node-run unit tests can cover the state/error,
 * size, and origin rules without loading React or the DOM player wrapper.
 */

import type { RemotePlaybackClock } from "../../player/playbackClock";

export type YouTubePlayerSizeMode = "compact" | "expanded";

export const YOUTUBE_PLAYER_SIZES: Record<YouTubePlayerSizeMode, { width: number; height: number }> = {
  compact: { width: 200, height: 200 },
  expanded: { width: 480, height: 270 },
};

export type YouTubePlayerStateName =
  | "unstarted"
  | "ended"
  | "playing"
  | "paused"
  | "buffering"
  | "cued"
  | "unknown";

export interface YouTubePlayerMetadata {
  videoId: string;
  title: string;
  author: string;
}

export interface YouTubePlayerSnapshot extends RemotePlaybackClock {
  state: YouTubePlayerStateName;
  stateCode: number;
  volume: number;
  muted: boolean;
}

export interface YouTubePlayerErrorInfo {
  code: number | null;
  kind: "invalid-parameter" | "player" | "not-found" | "not-embeddable" | "api-load" | "unknown";
  message: string;
}

export function youtubePlayerStateName(stateCode: number): YouTubePlayerStateName {
  switch (stateCode) {
    case -1:
      return "unstarted";
    case 0:
      return "ended";
    case 1:
      return "playing";
    case 2:
      return "paused";
    case 3:
      return "buffering";
    case 5:
      return "cued";
    default:
      return "unknown";
  }
}

export function mapYouTubePlayerError(code: number | null): YouTubePlayerErrorInfo {
  switch (code) {
    case 2:
      return {
        code,
        kind: "invalid-parameter",
        message: "YouTube rejected the player request (error 2). Check the video link and try again.",
      };
    case 5:
      return {
        code,
        kind: "player",
        message: "The official YouTube player reported an HTML5 playback error (error 5).",
      };
    case 100:
      return {
        code,
        kind: "not-found",
        message: "This YouTube video was not found. It may have been deleted or made private (error 100).",
      };
    case 101:
    case 150:
      return {
        code,
        kind: "not-embeddable",
        message: "The video owner does not allow this video to be played in an embedded player.",
      };
    default:
      return {
        code,
        kind: "unknown",
        message: code
          ? `The official YouTube player reported error ${code}.`
          : "The official YouTube player could not be loaded.",
      };
  }
}

/**
 * The origin to tell YouTube about. In Tauri this is the app's real WebView origin (for example
 * `http://tauri.localhost` on Windows); in the Vite/browser harness it is the HTTP origin.
 * An opaque origin is not invented into a fake website domain — the player variable is omitted.
 */
export function resolveYouTubePlayerOrigin(locationLike: Location = window.location): string | undefined {
  const origin = locationLike.origin;
  if (origin && origin !== "null") return origin;
  if ((locationLike.protocol === "http:" || locationLike.protocol === "https:") && locationLike.host) {
    return `${locationLike.protocol}//${locationLike.host}`;
  }
  return undefined;
}
