/**
 * Cadence queue math, kept pure so it can be tested without a browser.
 */

import { mediaItemFromLocalTrack, trackSourceKey, youtubeCanonicalUrl } from "../../shared/media";
import type {
  MediaItem,
  QueueEntry,
  QueueEntryOrigin,
  RepeatMode,
  Track,
  TrackSource,
} from "../../shared/types";

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

export function localQueueEntry(
  trackId: number,
  occurrenceId: string,
  track?: Track | null,
  origin: QueueEntryOrigin = "context"
): QueueEntry {
  return {
    occurrenceId,
    item: track ? mediaItemFromLocalTrack(track) : localStubItem(trackId),
    origin,
  };
}

export function mediaQueueEntry(
  item: MediaItem,
  occurrenceId: string,
  origin: QueueEntryOrigin = "context"
): QueueEntry {
  return { occurrenceId, item: { ...item, source: { ...item.source } }, origin };
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
    title: cleanString(item.title, source.kind === "local" ? "Loading local track…" : "Loading remote item…"),
    artistLabel: cleanString(item.artistLabel),
    channelId: cleanNullableString(item.channelId),
    channelTitle: cleanNullableString(item.channelTitle),
    albumLabel: cleanNullableString(item.albumLabel),
    durationSeconds: cleanDuration(item.durationSeconds),
    artworkUrl: cleanNullableString(item.artworkUrl),
    publishedAt: cleanNullableString(item.publishedAt),
    availability:
      availability === "ready" ||
      availability === "restricted" ||
      availability === "unavailable" ||
      availability === "live"
        ? availability
        : availability === "not-embeddable"
          ? "restricted"
          : "unknown",
    fetchedAt: typeof item.fetchedAt === "number" && Number.isFinite(item.fetchedAt) ? item.fetchedAt : 0,
  };
}

/**
 * Accepts the legacy numeric session queue as well as the source-aware occurrence queue.
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
  const origin: QueueEntryOrigin =
    record.origin === "manual" || record.origin === "autoplay" || record.origin === "context"
      ? record.origin
      : "context";
  return { occurrenceId, item, origin };
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

/**
 * Inserts manually queued entries ("Play Next") immediately after `orderPosition`,
 * at the front of the `[Manual]` queue partition.
 * If any requested item already exists as an upcoming `"autoplay"` entry, that entry
 * is removed from the AutoPlay tail so manual queue items always take strict priority.
 */
export function insertManualEntriesNext(
  queue: readonly QueueEntry[],
  order: readonly number[],
  orderPosition: number,
  requestedEntries: readonly QueueEntry[]
): { queue: QueueEntry[]; order: number[]; orderPosition: number } {
  if (requestedEntries.length === 0) {
    return { queue: [...queue], order: [...order], orderPosition };
  }
  const manualTagged = requestedEntries.map(e => ({ ...e, origin: "manual" as const }));
  if (queue.length === 0 || order.length === 0) {
    return {
      queue: manualTagged,
      order: manualTagged.map((_, idx) => idx),
      orderPosition: 0,
    };
  }

  const requestedKeys = new Set(manualTagged.map(queueEntrySourceKey));
  // Drop any upcoming autoplay slots that match the newly requested manual items
  const prunedOrder: number[] = [];
  for (let pos = 0; pos < order.length; pos++) {
    const qIdx = order[pos];
    const entry = queue[qIdx];
    if (
      pos > orderPosition &&
      entry?.origin === "autoplay" &&
      requestedKeys.has(queueEntrySourceKey(entry))
    ) {
      continue;
    }
    prunedOrder.push(qIdx);
  }

  const startIndex = queue.length;
  const nextQueue = [...queue, ...manualTagged];
  const addedIndices = manualTagged.map((_, idx) => startIndex + idx);
  const insertAt = Math.min(prunedOrder.length, Math.max(0, orderPosition + 1));
  const nextOrder = [...prunedOrder];
  nextOrder.splice(insertAt, 0, ...addedIndices);

  return { queue: nextQueue, order: nextOrder, orderPosition };
}

/**
 * Inserts manually queued entries ("Add to Queue") into the queue with strict priority
 * over all `"autoplay"` entries.
 *
 * - Manual entries are placed after any already-queued upcoming `"manual"` and `"context"`
 *   entries, and strictly BEFORE the first upcoming `"autoplay"` entry (`[Current] -> [Manual] -> [Context] -> [AutoPlay]`
 *   when context precedes or `[Current] -> [Manual] -> [AutoPlay]` when playing through manual/autoplay).
 * - More specifically, to satisfy the invariant `[Current] -> [Manual] -> [Context] -> [AutoPlay]`
 *   everywhere (including across subsequent shuffle toggles), `addToQueue` inserts at the end of
 *   the upcoming `"manual"` block (immediately after `orderPosition` + any existing upcoming `"manual"`
 *   entries, ahead of `"context"` and `"autoplay"` entries).
 */
export function appendManualEntriesBeforeAutoPlay(
  queue: readonly QueueEntry[],
  order: readonly number[],
  orderPosition: number,
  requestedEntries: readonly QueueEntry[]
): { queue: QueueEntry[]; order: number[]; orderPosition: number } {
  if (requestedEntries.length === 0) {
    return { queue: [...queue], order: [...order], orderPosition };
  }
  const manualTagged = requestedEntries.map(e => ({ ...e, origin: "manual" as const }));
  if (queue.length === 0 || order.length === 0) {
    return {
      queue: manualTagged,
      order: manualTagged.map((_, idx) => idx),
      orderPosition: 0,
    };
  }

  const requestedKeys = new Set(manualTagged.map(queueEntrySourceKey));
  // Remove any duplicate upcoming autoplay occurrences of the same track so the manual entry supersedes it
  const prunedOrder: number[] = [];
  for (let pos = 0; pos < order.length; pos++) {
    const qIdx = order[pos];
    const entry = queue[qIdx];
    if (
      pos > orderPosition &&
      entry?.origin === "autoplay" &&
      requestedKeys.has(queueEntrySourceKey(entry))
    ) {
      continue;
    }
    prunedOrder.push(qIdx);
  }

  const startIndex = queue.length;
  const nextQueue = [...queue, ...manualTagged];
  const addedIndices = manualTagged.map((_, idx) => startIndex + idx);

  // Find insertion point at the end of the contiguous upcoming "manual" block after orderPosition
  // (which is always strictly before any upcoming "context" or "autoplay" entry).
  let insertAt = Math.min(prunedOrder.length, Math.max(0, orderPosition + 1));
  while (insertAt < prunedOrder.length) {
    const entry = nextQueue[prunedOrder[insertAt]];
    if (entry?.origin === "manual") {
      insertAt += 1;
    } else {
      break;
    }
  }

  const nextOrder = [...prunedOrder];
  nextOrder.splice(insertAt, 0, ...addedIndices);

  return { queue: nextQueue, order: nextOrder, orderPosition };
}

/**
 * Appends AutoPlay entries (`origin: "autoplay"`) to the very tail of the queue order,
 * skipping any track already present in `queue`.
 */
export function appendAutoPlayEntries(
  queue: readonly QueueEntry[],
  order: readonly number[],
  autoPlayEntries: readonly QueueEntry[]
): { queue: QueueEntry[]; order: number[]; addedCount: number } {
  if (autoPlayEntries.length === 0) {
    return { queue: [...queue], order: [...order], addedCount: 0 };
  }
  const existingKeys = new Set(queue.map(queueEntrySourceKey));
  const filtered: QueueEntry[] = [];
  for (const entry of autoPlayEntries) {
    const key = queueEntrySourceKey(entry);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    filtered.push({ ...entry, origin: "autoplay" });
  }
  if (filtered.length === 0) {
    return { queue: [...queue], order: [...order], addedCount: 0 };
  }
  const startIndex = queue.length;
  const nextQueue = [...queue, ...filtered];
  const nextOrder = [...order, ...filtered.map((_, idx) => startIndex + idx)];
  return { queue: nextQueue, order: nextOrder, addedCount: filtered.length };
}

/**
 * Restores an unshuffled order while preserving the strict priority of upcoming `"manual"`
 * entries ahead of `"context"` entries and `"autoplay"` entries at the tail.
 * When all entries are `"context"`, returns the exact identity order `[0, 1, ..., n-1]`.
 */
export function buildPartitionedUnshuffledOrder(
  queue: readonly QueueEntry[],
  order: readonly number[],
  orderPosition: number
): { order: number[]; orderPosition: number } {
  if (queue.length === 0) return { order: [], orderPosition: 0 };
  const currentIdx = Math.max(0, Math.min(order[orderPosition] ?? 0, queue.length - 1));
  const hasNonContext = queue.some(e => e.origin === "manual" || e.origin === "autoplay");
  if (!hasNonContext) {
    const identity = Array.from({ length: queue.length }, (_, idx) => idx);
    return { order: identity, orderPosition: currentIdx };
  }

  const upcomingManual: number[] = [];
  const upcomingAutoPlay: number[] = [];
  const upcomingManualSet = new Set<number>();
  const upcomingAutoPlaySet = new Set<number>();

  for (let pos = orderPosition + 1; pos < order.length; pos++) {
    const qIdx = order[pos];
    if (qIdx === currentIdx) continue;
    const origin = queue[qIdx]?.origin ?? "context";
    if (origin === "manual" && !upcomingManualSet.has(qIdx)) {
      upcomingManual.push(qIdx);
      upcomingManualSet.add(qIdx);
    } else if (origin === "autoplay" && !upcomingAutoPlaySet.has(qIdx)) {
      upcomingAutoPlay.push(qIdx);
      upcomingAutoPlaySet.add(qIdx);
    }
  }

  const beforeContext: number[] = [];
  const afterContext: number[] = [];
  for (let idx = 0; idx < queue.length; idx++) {
    if (idx === currentIdx) continue;
    if (upcomingManualSet.has(idx) || upcomingAutoPlaySet.has(idx)) continue;
    const origin = queue[idx]?.origin ?? "context";
    if (origin === "autoplay") {
      upcomingAutoPlay.push(idx);
      upcomingAutoPlaySet.add(idx);
      continue;
    }
    if (idx < currentIdx) {
      beforeContext.push(idx);
    } else {
      afterContext.push(idx);
    }
  }

  const nextOrder = [
    ...beforeContext,
    currentIdx,
    ...upcomingManual,
    ...afterContext,
    ...upcomingAutoPlay,
  ];
  return {
    order: nextOrder,
    orderPosition: beforeContext.length,
  };
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
