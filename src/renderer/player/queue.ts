/**
 * Cadence queue math, kept pure so it can be tested without a browser.
 */

import { mediaItemFromLocalTrack, trackSourceKey, youtubeCanonicalUrl } from "../../shared/media";
import type { MediaItem, QueueEntry, RepeatMode, Track, TrackSource } from "../../shared/types";

export type Rng = () => number;

/** Fisher–Yates over a copy of the array; `rng` defaults to Math.random so a single draw stays
 *  stable for the lifetime of one component instance. */
export function shuffle<T>(array: readonly T[], rng: Rng = Math.random): T[] {
  const copy = Array.from(array);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Fisher–Yates over positions, with the current position first so playback continues seamlessly. */
export function buildOrder(length: number, shuffle: boolean, current: number, rng: Rng = Math.random): number[] {
  const order = Array.from({ length }, (_, index) => index);
  if (!shuffle || length <= 1) return order;

  const currentIndex = Math.max(0, Math.min(current, length - 1));
  const rest = order.filter(index => index !== currentIndex);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [currentIndex, ...rest];
}

export interface AdvanceResult {
  position: number;
  /** True when playback ran off the end of the queue. */
  exhausted: boolean;
  /** True when the same track should restart (repeat one). */
  restart: boolean;
}

export function advancePosition(
  position: number,
  orderLength: number,
  repeat: RepeatMode,
  direction: 1 | -1 = 1,
  allowWrap = true
): AdvanceResult {
  if (orderLength === 0) return { position: 0, exhausted: true, restart: false };
  if (repeat === "one") return { position, exhausted: false, restart: true };

  const target = position + direction;
  if (target < 0) {
    if (repeat === "all" && allowWrap) return { position: orderLength - 1, exhausted: false, restart: false };
    return { position: 0, exhausted: false, restart: false };
  }
  if (target >= orderLength) {
    if (repeat === "all" && allowWrap) return { position: 0, exhausted: false, restart: false };
    return { position: orderLength - 1, exhausted: true, restart: false };
  }
  return { position: target, exhausted: false, restart: false };
}

/** Shuffle should not replay a track that is already in the queue history. */
export function nextShuffledPosition(
  order: number[],
  position: number,
  repeat: RepeatMode,
  rng: Rng = Math.random
): AdvanceResult {
  if (order.length === 0) return { position: 0, exhausted: true, restart: false };
  if (repeat === "one") return { position, exhausted: false, restart: true };
  if (position + 1 < order.length) return { position: position + 1, exhausted: false, restart: false };
  if (repeat === "all") {
    // Reshuffle from the start, keeping the current track from repeating immediately.
    const reshuffled = buildOrder(order.length, true, 0, rng);
    order.splice(0, order.length, ...reshuffled);
    return { position: 0, exhausted: false, restart: false };
  }
  return { position: order.length - 1, exhausted: true, restart: false };
}

function localStubItem(trackId: number): MediaItem {
  return {
    source: { kind: "local", trackId },
    title: "Loading local track…",
    artistLabel: "",
    channelId: null,
    channelTitle: null,
    albumLabel: null,
    durationSeconds: null,
    artworkUrl: null,
    publishedAt: null,
    availability: "unknown",
    fetchedAt: 0,
  };
}

export function localQueueEntry(trackId: number, occurrenceId: string, track?: Track | null): QueueEntry {
  return {
    occurrenceId,
    item: track ? mediaItemFromLocalTrack(track) : localStubItem(trackId),
  };
}

export function mediaQueueEntry(item: MediaItem, occurrenceId: string): QueueEntry {
  return { occurrenceId, item: { ...item, source: { ...item.source } } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function cleanNullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function cleanDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeSource(value: unknown): TrackSource | null {
  const source = asRecord(value);
  if (!source) return null;
  if (source.kind === "local") {
    return typeof source.trackId === "number" && Number.isInteger(source.trackId) && source.trackId >= 0
      ? { kind: "local", trackId: source.trackId }
      : null;
  }
  if (source.kind === "youtube" || source.kind === "youtube-music") {
    const remoteId = cleanString(source.remoteId);
    if (!/^[A-Za-z0-9_-]{11}$/.test(remoteId)) return null;
    return {
      kind: source.kind,
      remoteId,
      canonicalUrl:
        cleanNullableString(source.canonicalUrl) ??
        youtubeCanonicalUrl(remoteId, source.kind === "youtube-music"),
    };
  }
  return null;
}

function normalizeMediaItem(value: unknown): MediaItem | null {
  const item = asRecord(value);
  const source = normalizeSource(item?.source);
  if (!item || !source) return null;
  const availability = item.availability;
  return {
    source,
    title: cleanString(item.title, source.kind === "local" ? "Loading local track…" : "Loading YouTube video…"),
    artistLabel: cleanString(item.artistLabel),
    channelId: cleanNullableString(item.channelId),
    channelTitle: cleanNullableString(item.channelTitle),
    albumLabel: cleanNullableString(item.albumLabel),
    durationSeconds: cleanDuration(item.durationSeconds),
    artworkUrl: cleanNullableString(item.artworkUrl),
    publishedAt: cleanNullableString(item.publishedAt),
    availability:
      availability === "ready" ||
      availability === "not-embeddable" ||
      availability === "unavailable" ||
      availability === "live"
        ? availability
        : "unknown",
    fetchedAt: typeof item.fetchedAt === "number" && Number.isFinite(item.fetchedAt) ? item.fetchedAt : 0,
  };
}

/**
 * Accepts the pre-Stage-7 numeric session queue as well as the source-aware occurrence queue.
 * Invalid remote entries are dropped instead of being converted into fake local IDs.
 */
export function normalizeQueueEntry(value: unknown, fallbackOccurrenceId: string): QueueEntry | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0
      ? localQueueEntry(value, fallbackOccurrenceId)
      : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const item = normalizeMediaItem(record.item ?? record);
  if (!item) return null;
  const occurrenceId = cleanNullableString(record.occurrenceId) ?? fallbackOccurrenceId;
  return { occurrenceId, item };
}

export function normalizeQueueEntries(values: readonly unknown[]): QueueEntry[] {
  const seenOccurrences = new Set<string>();
  const entries: QueueEntry[] = [];
  values.forEach((value, index) => {
    const entry = normalizeQueueEntry(value, `restored-${index}`);
    if (!entry) return;
    let occurrenceId = entry.occurrenceId;
    if (seenOccurrences.has(occurrenceId)) occurrenceId = `${occurrenceId}-${index}`;
    seenOccurrences.add(occurrenceId);
    entries.push({ ...entry, occurrenceId });
  });
  return entries;
}

export function pruneQueueOrder(
  queue: readonly QueueEntry[],
  order: readonly number[],
  orderPosition: number,
  keep: (entry: QueueEntry) => boolean
): { queue: QueueEntry[]; order: number[]; orderPosition: number } {
  const oldCurrentIndex = order[orderPosition];
  const oldCurrent = oldCurrentIndex === undefined ? null : queue[oldCurrentIndex] ?? null;
  const oldToNew = new Map<number, number>();
  const nextQueue: QueueEntry[] = [];
  queue.forEach((entry, oldIndex) => {
    if (!keep(entry)) return;
    oldToNew.set(oldIndex, nextQueue.length);
    nextQueue.push(entry);
  });

  const nextOrder: number[] = [];
  const included = new Set<number>();
  for (const oldIndex of order) {
    const nextIndex = oldToNew.get(oldIndex);
    if (nextIndex === undefined || included.has(nextIndex)) continue;
    included.add(nextIndex);
    nextOrder.push(nextIndex);
  }
  nextQueue.forEach((_, nextIndex) => {
    if (!included.has(nextIndex)) nextOrder.push(nextIndex);
  });

  if (nextOrder.length === 0) return { queue: [], order: [], orderPosition: 0 };
  if (oldCurrent) {
    const currentNewIndex = nextQueue.findIndex(entry => entry.occurrenceId === oldCurrent.occurrenceId);
    const currentPosition = nextOrder.indexOf(currentNewIndex);
    if (currentPosition >= 0) {
      return { queue: nextQueue, order: nextOrder, orderPosition: currentPosition };
    }
  }

  // Current entry was pruned: prefer the next surviving entry at or after its old order slot.
  for (let oldPosition = Math.max(0, orderPosition); oldPosition < order.length; oldPosition += 1) {
    const nextIndex = oldToNew.get(order[oldPosition]);
    const nextPosition = nextIndex === undefined ? -1 : nextOrder.indexOf(nextIndex);
    if (nextPosition >= 0) return { queue: nextQueue, order: nextOrder, orderPosition: nextPosition };
  }
  return { queue: nextQueue, order: nextOrder, orderPosition: nextOrder.length - 1 };
}

export function queueEntrySourceKey(entry: QueueEntry): string {
  return trackSourceKey(entry.item.source);
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}
