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
  status: { provider: string; status: "hit" | "miss" | "error" | "skipped"; detail?: string }[];
}

const normalize = (value: string): string =>
  value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Sørensen–Dice bigram similarity, used only to rank LRCLIB search results. */
function similarity(a: string, b: string): number {
  const left = normalize(a).replace(/\s+/g, "");
  const right = normalize(b).replace(/\s+/g, "");
  if (!left || !right) return 0;
  if (left === right) return 1;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < left.length - 1; i++) {
    const bigram = left.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  let matches = 0;
  for (let i = 0; i < right.length - 1; i++) {
    const bigram = right.slice(i, i + 2);
    const count = bigrams.get(bigram) ?? 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      matches += 1;
    }
  }
  return (2 * matches) / (left.length - 1 + right.length - 1);
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
  const status: LrclibResult["status"] = [];

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
    status.push({
      provider: "lrclib",
      status: lastError ? "error" : "miss",
      detail: lastError ?? "No matching lyrics on LRCLIB",
    });
    return { candidates, status };
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
  status.push({ provider: "lrclib", status: "hit", detail: record.syncedLyrics ? "Synced lyrics found" : "Plain lyrics found" });
  return { candidates, status };
}
