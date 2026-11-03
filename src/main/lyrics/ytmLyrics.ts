/**
 * YouTube Music lyrics provider for the Cadence lyrics engine.
 *
 * Uses the InnerTube-based YouTube Music provider (src/main/ytmusic) to fetch the official
 * lyrics for a track by its video id: `next` exposes the lyrics tab's browse endpoint, and
 * browsing it returns the lyrics text in a musicDescriptionShelfRenderer. YTM lyrics are plain
 * (unsynced) text, so the candidate is reported with syncHint "none" — word-level sync still
 * comes from the existing rich providers (TTML/QRC) when they have the song.
 *
 * The provider only runs for tracks that actually carry a YouTube Music source (query.videoId);
 * for local tracks it reports a clean skip so local resolution is untouched.
 */

import type { LyricsCandidate } from "../../shared/types";
import { isAbort, type ProviderOutcome, type ProviderQuery, type ProviderStatus } from "./http";
import { inspectLyricsPayload } from "./syncInspection";
import { getYouTubeMusicProvider, YtmProviderError } from "../ytmusic/provider";

export const YTM_LYRICS_PROVIDER_KEY = "youtube-music";
export const YTM_LYRICS_DISPLAY_NAME = "YouTube Music";

export async function fetchYtmLyrics(
  query: ProviderQuery,
  signal?: AbortSignal,
  enabledKeys?: ReadonlySet<string>
): Promise<ProviderOutcome> {
  const statuses: ProviderStatus[] = [];
  const keys = enabledKeys ?? new Set([YTM_LYRICS_PROVIDER_KEY]);
  if (!keys.has(YTM_LYRICS_PROVIDER_KEY)) {
    return { candidates: [], statuses: [{ provider: YTM_LYRICS_PROVIDER_KEY, status: "skipped", detail: "Provider disabled" }] };
  }
  const videoId = query.videoId?.trim();
  if (!videoId) {
    return {
      candidates: [],
      statuses: [{ provider: YTM_LYRICS_PROVIDER_KEY, status: "skipped", detail: "Needs a YouTube Music source" }],
    };
  }
  try {
    const text = await getYouTubeMusicProvider().lyrics(videoId);
    if (signal?.aborted || !text) {
      return {
        candidates: [],
        statuses: [{ provider: YTM_LYRICS_PROVIDER_KEY, status: "miss", detail: text ? "Cancelled" : "No lyrics" }],
      };
    }
    const inspected = inspectLyricsPayload(text, {
      durationSeconds: query.duration,
      title: query.title,
      artist: query.artist,
    });
    if (!inspected.usable) {
      return {
        candidates: [],
        statuses: [{ provider: YTM_LYRICS_PROVIDER_KEY, status: "miss", detail: "Unusable lyrics payload" }],
      };
    }
    const candidate: LyricsCandidate = {
      source: YTM_LYRICS_PROVIDER_KEY,
      provider: YTM_LYRICS_DISPLAY_NAME,
      text,
      syncHint: inspected.syncType,
      language: inspected.language,
      songwriters: inspected.songwriters,
      sourceHref: `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      cached: false,
    };
    return { candidates: [candidate], statuses: [{ provider: YTM_LYRICS_PROVIDER_KEY, status: "hit" }] };
  } catch (error) {
    if (isAbort(error)) {
      return {
        candidates: [],
        statuses: [{ provider: YTM_LYRICS_PROVIDER_KEY, status: "skipped", detail: "Cancelled" }],
      };
    }
    const detail =
      error instanceof YtmProviderError ? error.message : error instanceof Error ? error.message : String(error);
    return {
      candidates: [],
      statuses: [{ provider: YTM_LYRICS_PROVIDER_KEY, status: "error", detail }],
    };
  }
}
