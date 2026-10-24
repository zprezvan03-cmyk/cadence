/**
 * Keyless YouTube metadata lookup for the manual lyrics search.
 *
 * This never downloads audio, extracts media streams, or invents a video ID for a provider:
 *   1. The renderer-supplied link is validated and its 11-character ID is extracted.
 *   2. YouTube's public, keyless oEmbed endpoint (`/oembed?url=...&format=json`) supplies the
 *      title and channel (author) name. oEmbed answers 401/404 for private or unavailable videos,
 *      which maps to an "unavailable" result instead of a generic failure.
 *   3. As a best-effort supplement, the public watch page is read once for its published
 *      `lengthSeconds` value so duration can improve matching when the local track has none. Any
 *      failure of this step is swallowed — oEmbed metadata alone still produces a usable result.
 *
 * The video ID itself is never forwarded to a lyrics provider; only the derived title/artist/
 * duration are merged into the manual-search query in the renderer, and only into blank fields.
 * Written for Cadence; no new dependency.
 */

import type { YouTubeMetadata, YouTubeMetadataResult } from "../../shared/types";
import { normalizeYouTubeArtist, parseYouTubeVideoId } from "../../shared/youtube";
import { getJson, getText, isAbort } from "./http";

const OEMBED_BASE_URL = "https://www.youtube.com/oembed";
const WATCH_BASE_URL = "https://www.youtube.com/watch";
const OEMBED_TIMEOUT_MS = 8_000;
const WATCH_TIMEOUT_MS = 8_000;

interface OEmbedResponse {
  title?: unknown;
  author_name?: unknown;
  thumbnail_url?: unknown;
}

function invalid(detail: string): YouTubeMetadataResult {
  return { ok: false, reason: "invalid", detail };
}

function unavailable(detail: string): YouTubeMetadataResult {
  return { ok: false, reason: "unavailable", detail };
}

function failed(detail: string): YouTubeMetadataResult {
  return { ok: false, reason: "error", detail };
}

function oEmbedUrl(videoId: string): string {
  const watch = `${WATCH_BASE_URL}?v=${encodeURIComponent(videoId)}`;
  return `${OEMBED_BASE_URL}?url=${encodeURIComponent(watch)}&format=json`;
}

/** Best-effort read of the watch page's published length; every failure degrades to null. */
async function watchDurationSeconds(videoId: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const page = await getText(`${WATCH_BASE_URL}?v=${encodeURIComponent(videoId)}&hl=en`, WATCH_TIMEOUT_MS, signal);
    if (!page.ok) return null;
    const match = page.text.match(/"lengthSeconds":"(\d+)"/);
    if (!match) return null;
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}

/**
 * Resolve public metadata for a YouTube link. Never throws for ordinary failures — a typed
 * {@link YouTubeMetadataResult} is returned so the renderer can show an inline message. An abort
 * (track change / newer request) still propagates.
 */
export async function fetchYouTubeMetadata(rawUrl: string, signal?: AbortSignal): Promise<YouTubeMetadataResult> {
  const videoId = parseYouTubeVideoId(rawUrl);
  if (!videoId) {
    return invalid("That doesn't look like a valid YouTube link.");
  }

  let response;
  try {
    response = await getJson(oEmbedUrl(videoId), OEMBED_TIMEOUT_MS, signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    return failed(`Couldn't reach YouTube: ${(error as Error).message || "network error"}`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return unavailable("This video is private or unavailable.");
    }
    if (response.status === 429) {
      return failed("YouTube is rate-limiting metadata requests. Try again shortly.");
    }
    return failed(`YouTube metadata request failed (${response.status}).`);
  }

  const body = response.json as OEmbedResponse | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return failed("YouTube returned no usable metadata for this video.");
  }
  const artist = normalizeYouTubeArtist(typeof body?.author_name === "string" ? body.author_name : null);
  const thumbnailUrl = typeof body?.thumbnail_url === "string" ? body.thumbnail_url : null;

  const durationSeconds = await watchDurationSeconds(videoId, signal);

  const metadata: YouTubeMetadata = {
    videoId,
    title,
    artist,
    durationSeconds,
    thumbnailUrl,
  };
  return { ok: true, metadata };
}
