/**
 * Edits to the persisted lyrics provider order (`settings.lyrics.providerOrder`).
 *
 * The order is the single source of truth for provider priority: Settings renders it, the lyrics
 * service resolves against it, and `migrateProviderOrder` normalises it on load. That migration
 * re-inserts any default provider the stored order is missing (so an app update can ship a new
 * provider), which means a plain `splice` is not a durable way to switch a provider off — the next
 * load would merge it straight back in, re-enabled.
 *
 * Upstream already has a representation for "known, but not active": the `d_` prefix, which
 * `migrateProviderOrder` preserves. These helpers keep every known provider in the array and flip
 * that prefix, so removing a provider in Settings survives navigation, a reload and a restart,
 * while still leaving genuinely new providers free to be merged in.
 */

import { untoggleProvider } from "./upstream/better-lyrics/constants";

const DISABLED_PREFIX = "d_";

export function isDisabledEntry(entry: string): boolean {
  return entry.startsWith(DISABLED_PREFIX);
}

/** Entries the user has switched on, in priority order. */
export function activeProviderEntries(order: readonly string[]): string[] {
  return order.filter(entry => !isDisabledEntry(entry));
}

/**
 * Swaps an active provider with its active neighbour. Disabled entries keep their slot in the
 * stored array, so they neither block a move nor get dragged around by one.
 */
export function moveProviderInOrder(order: readonly string[], key: string, direction: -1 | 1): string[] {
  const next = [...order];
  const activeIndexes = next.flatMap((entry, index) => (isDisabledEntry(entry) ? [] : [index]));
  const slot = activeIndexes.findIndex(index => untoggleProvider(next[index]) === key);
  const target = slot + direction;
  if (slot === -1 || target < 0 || target >= activeIndexes.length) return next;
  const from = activeIndexes[slot];
  const to = activeIndexes[target];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Switches a provider off, keeping its position so re-adding it restores the same priority. */
export function removeProviderFromOrder(order: readonly string[], key: string): string[] {
  if (!order.some(entry => untoggleProvider(entry) === key && !isDisabledEntry(entry))) return [...order];
  return order.map(entry =>
    untoggleProvider(entry) === key && !isDisabledEntry(entry) ? `${DISABLED_PREFIX}${entry}` : entry
  );
}

/** Switches a provider back on in place, or appends it when the order has never seen it. */
export function addProviderToOrder(order: readonly string[], key: string): string[] {
  if (order.some(entry => entry === key)) return [...order];
  if (order.some(entry => untoggleProvider(entry) === key)) {
    return order.map(entry => (untoggleProvider(entry) === key ? key : entry));
  }
  return [...order, key];
}
