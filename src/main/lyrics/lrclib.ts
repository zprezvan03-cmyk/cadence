/**
 * LRCLIB provider for Cadence.
 *
 * LRCLIB is one of the providers Better Lyrics uses upstream (as `lrclib-synced` / `lrclib-plain`
 * in src/core/constants.ts). The extension reaches it through the authenticated Cubey stream; a
 * standalone app has no YouTube page origin for that handshake, so this talks to the public LRCLIB
 * API directly, which is the same underlying data source. Implemented for Cadence.
 */

import { LRCLIB_BASE_URL } from "../../shared/upstream/better-lyrics/constants";
import type { LyricsCandidate } from "../../shared/types";
import { similarity } from "./matching";

const CLIENT_NAME = "Cadence Player v0.1.0 (https://github.com/zprezvan03-cmyk/betterlyrics-standalone)";
const REQUEST_TIMEOUT_MS = 12000;

export interface LrclibQuery {
  title: string;
  artist: string;
  album: string;
  duration: number;
}

interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export interface LrclibResult {
  candidates: LyricsCandidate[];
  statuses: { provider: string; status: "hit" | "miss" | "error" | "skipped"; detail?: string }[];
}

async function request<T>(path: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; data: T | null }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${LRCLIB_BASE_URL}${path}`, {
    headers: { "Lrclib-Client": CLIENT_NAME, Accept: "application/json" },
    signal: combined,
  });
  if (response.status === 404) return { ok: false, status: 404, data: null };
  if (!response.ok) return { ok: false, status: response.status, data: null };
  return { ok: true, status: response.status, data: (await response.json()) as T };
}

function pickBest(records: LrclibRecord[], query: LrclibQuery): LrclibRecord | null {
  let best: { record: LrclibRecord; score: number } | null = null;
  for (const record of records) {
    if (!record.syncedLyrics && !record.plainLyrics) continue;
    const durationPenalty =
      query.duration > 0 && record.duration > 0 ? Math.min(1, Math.abs(record.duration - query.duration) / 15) : 0;
    const score =
      similarity(record.trackName, query.title) * 0.55 +
      similarity(record.artistName, query.artist) * 0.35 +
      (1 - durationPenalty) * 0.1;
    if (!best || score > best.score) best = { record, score };
  }
  if (!best || best.score < 0.45) return null;
  return best.record;
}

export async function fetchLrclib(query: LrclibQuery, signal?: AbortSignal): Promise<LrclibResult> {
  const candidates: LyricsCandidate[] = [];
  const statuses: LrclibResult["statuses"] = [];

  const params = new URLSearchParams({
    track_name: query.title,
    artist_name: query.artist,
  });
  if (query.album) params.append("album_name", query.album);
  if (query.duration > 0) params.append("duration", String(Math.round(query.duration)));

  let record: LrclibRecord | null = null;
  let lastError: string | undefined;

  try {
    const exact = await request<LrclibRecord>(`/get?${params.toString()}`, signal);
    if (exact.data && (exact.data.syncedLyrics || exact.data.plainLyrics)) record = exact.data;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    lastError = (error as Error).message;
  }

  if (!record) {
    try {
      const searchParams = new URLSearchParams({ track_name: query.title, artist_name: query.artist });
      const search = await request<LrclibRecord[]>(`/search?${searchParams.toString()}`, signal);
      if (Array.isArray(search.data)) record = pickBest(search.data, query);
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      lastError = (error as Error).message;
    }
  }

  if (!record) {
    statuses.push({
      provider: "lrclib",
      status: lastError ? "error" : "miss",
      detail: lastError ?? "No matching lyrics on LRCLIB",
    });
    return { candidates, statuses };
  }

  const href = `https://lrclib.net/lyrics/${record.id}`;
  if (record.syncedLyrics) {
    candidates.push({
      source: "lrclib-synced",
      provider: "LRCLIB (synced)",
      text: record.syncedLyrics,
      syncHint: "synced",
      language: null,
      songwriters: [],
      sourceHref: href,
      cached: false,
    });
  }
  if (record.plainLyrics) {
    candidates.push({
      source: "lrclib-plain",
      provider: "LRCLIB",
      text: record.plainLyrics,
      syncHint: "none",
      language: null,
      songwriters: [],
      sourceHref: href,
      cached: false,
    });
  }
  statuses.push({ provider: "lrclib", status: "hit", detail: record.syncedLyrics ? "Synced lyrics found" : "Plain lyrics found" });
  return { candidates, statuses };
}

const SEARCH_RESULT_LIMIT = 8;

/**
 * Manual-search variant: returns every usable LRCLIB record (synced preferred per record) instead
 * of only the closest one, so the lyrics selector can offer alternatives. Each candidate carries
 * the catalogue record's own metadata for display.
 */
export async function searchLrclib(
  query: LrclibQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal
): Promise<LrclibResult> {
  const params = new URLSearchParams({ track_name: query.title });
  if (query.artist) params.set("artist_name", query.artist);
  try {
    const response = await request<LrclibRecord[]>(`/search?${params.toString()}`, signal);
    if (response.status === 404 || !Array.isArray(response.data)) {
      return { candidates: [], statuses: [{ provider: "lrclib", status: "miss", detail: "No matching lyrics on LRCLIB" }] };
    }
    if (!response.ok) {
      return { candidates: [], statuses: [{ provider: "lrclib", status: "error", detail: `Request failed (${response.status})` }] };
    }

    const candidates: LyricsCandidate[] = [];
    for (const record of response.data) {
      if (!record.syncedLyrics && !record.plainLyrics) continue;
      const href = `https://lrclib.net/lyrics/${record.id}`;
      const metadata = {
        matchTitle: record.trackName,
        matchArtist: record.artistName,
        matchAlbum: record.albumName,
        matchDuration: record.duration,
      };
      if (record.syncedLyrics && enabledKeys.has("lrclib-synced")) {
        candidates.push({
          source: "lrclib-synced",
          provider: "LRCLIB (synced)",
          text: record.syncedLyrics,
          syncHint: "synced",
          language: null,
          songwriters: [],
          sourceHref: href,
          cached: false,
          ...metadata,
        });
      }
      if (record.plainLyrics && enabledKeys.has("lrclib-plain")) {
        candidates.push({
          source: "lrclib-plain",
          provider: "LRCLIB",
          text: record.plainLyrics,
          syncHint: "none",
          language: null,
          songwriters: [],
          sourceHref: href,
          cached: false,
          ...metadata,
        });
      }
      if (candidates.length >= SEARCH_RESULT_LIMIT) break;
    }

    return candidates.length
      ? { candidates, statuses: [{ provider: "lrclib", status: "hit", detail: `${candidates.length} result${candidates.length === 1 ? "" : "s"}` }] }
      : { candidates: [], statuses: [{ provider: "lrclib", status: "miss", detail: "No matching lyrics on LRCLIB" }] };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    return { candidates: [], statuses: [{ provider: "lrclib", status: "error", detail: (error as Error).message }] };
  }
}
