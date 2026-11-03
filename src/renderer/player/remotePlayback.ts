/**
 * Remote playback bridge for YouTube Music items inside Cadence's single audio engine.
 *
 * The provider resolves an InnerTube `player` response and picks the best audio format that has
 * a direct URL. Cadence never deciphers `signatureCipher` URLs and never attaches PO tokens, so
 * when every format is ciphered (or playback is otherwise blocked) the resolver reports a precise
 * reason and the player shows it instead of pretending playback works.
 *
 * Resolved googlevideo URLs expire, so they are cached per video id with a short TTL and
 * re-resolved transparently on expiry or on a stream error.
 */

import { getYouTubeMusicProvider, YtmProviderError } from "../../main/ytmusic/provider";
import type { MediaItem } from "../../shared/types";

export type RemoteStreamResult =
  | { ok: true; url: string; mimeType: string }
  | { ok: false; error: string };

interface CachedStream {
  url: string;
  mimeType: string;
  expiresAt: number;
}

/** Stream URLs are short-lived; refresh well before the usual ~6h expiry bites mid-track. */
const STREAM_TTL_MS = 4 * 60 * 1000;
const streamCache = new Map<string, CachedStream>();
const inFlight = new Map<string, Promise<RemoteStreamResult>>();

/** Extract the `list=` playlist context from a canonical watch URL, if present. */
export function playlistIdFromCanonicalUrl(canonicalUrl: string | null | undefined): string | null {
  if (!canonicalUrl) return null;
  try {
    return new URL(canonicalUrl).searchParams.get("list");
  } catch {
    return null;
  }
}

/** Map an InnerTube audio mimeType to a codec label for the engine (only ALAC is special). */
export function codecFromMime(mimeType: string | null | undefined): string | null {
  if (!mimeType) return null;
  if (mimeType.includes("mp4")) return "mp4a";
  if (mimeType.includes("webm")) return "opus";
  return null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof YtmProviderError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function resolveRemoteStream(item: MediaItem): Promise<RemoteStreamResult> {
  const source = item.source;
  if (source.kind === "local") {
    return Promise.resolve({ ok: false, error: "Item is not a remote source." });
  }
  const videoId = source.remoteId;
  const canonicalUrl = source.canonicalUrl;
  const cached = streamCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve({ ok: true, url: cached.url, mimeType: cached.mimeType });
  }
  const existing = inFlight.get(videoId);
  if (existing) return existing;
  const promise = (async (): Promise<RemoteStreamResult> => {
    try {
      const playlistId = playlistIdFromCanonicalUrl(canonicalUrl);
      const format = await getYouTubeMusicProvider().resolveStream(videoId, playlistId);
      if (!format.url) {
        return { ok: false, error: "No directly playable stream URL was returned." };
      }
      streamCache.set(videoId, {
        url: format.url,
        mimeType: format.mimeType,
        expiresAt: Date.now() + STREAM_TTL_MS,
      });
      return { ok: true, url: format.url, mimeType: format.mimeType };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  })().finally(() => {
    inFlight.delete(videoId);
  });
  inFlight.set(videoId, promise);
  return promise;
}

/** Drop a cached stream (e.g. after a 403 mid-playback) so the next attempt re-resolves. */
export function invalidateRemoteStream(videoId: string): void {
  streamCache.delete(videoId);
}

export function clearRemoteStreams(): void {
  streamCache.clear();
  inFlight.clear();
}
