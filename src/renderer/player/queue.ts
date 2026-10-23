/**
 * Cadence queue math, kept pure so it can be tested without a browser.
 */

import type { RepeatMode } from "../../shared/types";

export type Rng = () => number;

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

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}
