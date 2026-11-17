/**
 * Renderer-side artist picture state.
 *
 * Components only ever ask for an artist *by name*; this store decides when a request is actually
 * made. That keeps the UI free of provider logic and, more importantly, keeps a large library
 * responsive:
 *
 *  - one shared queue with a small concurrency limit, so scrolling an artist grid cannot spawn
 *    hundreds of simultaneous requests;
 *  - one request per artist regardless of how many cards are mounted (keyed by normalized name);
 *  - a terminal state per artist (`ready` / `missing` / `disabled`), so a failed lookup is not
 *    retried on every render;
 *  - "automatic fetching off" only changes *where* the answer comes from (cache instead of the
 *    network), so pictures already on disk keep showing;
 *  - nothing is fetched at startup; requests only happen when a component asks for a picture that
 *    is actually on screen.
 *
 * All network and filesystem work happens in the main process (`window.cadence.artistImages`).
 */

import { create } from "zustand";
import { artistImageKey } from "../../shared/artistImageCache";
import type { ArtistImageInfo } from "../../shared/types";
import { useSettings } from "./settingsStore";

export type ArtistImageStatus = "queued" | "loading" | "ready" | "missing" | "disabled" | "error";

export interface ArtistImageEntry {
  status: ArtistImageStatus;
  artistName: string;
  url: string | null;
  attribution: string | null;
  pageUrl: string | null;
  license: string | null;
  author: string | null;
  provider: string | null;
  reason?: string;
}

interface ArtistImageState {
  entries: Record<string, ArtistImageEntry>;
  /** Asks for a picture if this artist has not been resolved yet (idempotent). */
  request: (artistName: string) => void;
  /** Re-queries providers for one artist, replacing any cached picture. */
  refresh: (artistName: string) => Promise<void>;
  /** Empties the persistent cache and forgets every resolved artist. */
  clearCache: () => Promise<{ removedImages: number; removedMisses: number }>;
  /** Forgets in-memory state (e.g. after the feature is switched back on). */
  resetAll: () => void;
}

/** At most three lookups in flight; the main-process service also bounds its own work. */
const MAX_CONCURRENT = 3;
/** A cap on the pending queue keeps a fast scroll from queuing thousands of artists. */
const MAX_QUEUE = 48;

interface QueueItem {
  key: string;
  artistName: string;
}

const queue: QueueItem[] = [];
let inFlight = 0;
let queueScheduled = false;

function artistImageApi() {
  if (typeof window === "undefined") return undefined;
  return window.cadence?.artistImages;
}

function entryFromInfo(info: ArtistImageInfo, fallbackName: string): ArtistImageEntry {
  const available = info.status === "ok" && Boolean(info.url);
  return {
    status: available ? "ready" : info.status === "disabled" ? "disabled" : "missing",
    artistName: info.artistName || fallbackName,
    url: info.url,
    attribution: info.attribution,
    pageUrl: info.pageUrl,
    license: info.license,
    author: info.author,
    provider: info.provider,
    reason: info.reason,
  };
}

function disabledEntry(artistName: string, reason: string): ArtistImageEntry {
  return {
    status: "disabled",
    artistName,
    url: null,
    attribution: null,
    pageUrl: null,
    license: null,
    author: null,
    provider: null,
    reason,
  };
}

function pendingEntry(artistName: string, status: ArtistImageStatus): ArtistImageEntry {
  return {
    status,
    artistName,
    url: null,
    attribution: null,
    pageUrl: null,
    license: null,
    author: null,
    provider: null,
  };
}

export const useArtistImages = create<ArtistImageState>()((set, get) => {
  /** Runs queued lookups up to the concurrency limit. */
  const drain = (): void => {
    if (queueScheduled) return;
    queueScheduled = true;
    void Promise.resolve().then(() => {
      queueScheduled = false;
      while (inFlight < MAX_CONCURRENT && queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        const api = artistImageApi();
        if (!api) {
          set(state => ({
            entries: { ...state.entries, [next.key]: disabledEntry(next.artistName, "bridge-unavailable") },
          }));
          continue;
        }
        inFlight += 1;
        set(state => ({
          entries: { ...state.entries, [next.key]: { ...pendingEntry(next.artistName, "loading") } },
        }));
        const autoFetch = useSettings.getState().settings?.artistImages.autoFetch ?? true;
        const request = autoFetch
          ? api.resolve({ artistName: next.artistName })
          : api.cached(next.artistName).then(info => info);
        void request
          .then(info => {
            set(state => ({
              entries: {
                ...state.entries,
                [next.key]: info
                  ? entryFromInfo(info, next.artistName)
                  : { ...pendingEntry(next.artistName, "missing"), reason: "not-cached" },
              },
            }));
          })
          .catch((error: unknown) => {
            set(state => ({
              entries: {
                ...state.entries,
                [next.key]: {
                  ...pendingEntry(next.artistName, "error"),
                  reason: (error as Error)?.message ?? "artist-image-failed",
                },
              },
            }));
          })
          .finally(() => {
            inFlight = Math.max(0, inFlight - 1);
            drain();
          });
      }
    });
  };

  return {
    entries: {},

    request: artistName => {
      const name = (artistName ?? "").trim();
      if (!name) return;
      const key = artistImageKey(name);
      const existing = get().entries[key];
      if (existing) {
        // A terminal state is final unless the feature was switched off and back on.
        if (existing.status !== "disabled") return;
        if (useSettings.getState().settings?.artistImages.enabled === false) return;
      }
      const settings = useSettings.getState().settings;
      if (settings && settings.artistImages.enabled === false) {
        set(state => ({ entries: { ...state.entries, [key]: disabledEntry(name, "artist-images-disabled") } }));
        return;
      }
      if (!artistImageApi()) {
        set(state => ({ entries: { ...state.entries, [key]: disabledEntry(name, "bridge-unavailable") } }));
        return;
      }
      if (queue.some(item => item.key === key)) return;
      if (queue.length >= MAX_QUEUE) return;
      queue.push({ key, artistName: name });
      set(state => ({ entries: { ...state.entries, [key]: pendingEntry(name, "queued") } }));
      drain();
    },

    refresh: async artistName => {
      const name = (artistName ?? "").trim();
      if (!name) return;
      const key = artistImageKey(name);
      const api = artistImageApi();
      if (!api) return;
      set(state => ({ entries: { ...state.entries, [key]: pendingEntry(name, "loading") } }));
      try {
        const info = await api.refresh({ artistName: name });
        set(state => ({ entries: { ...state.entries, [key]: entryFromInfo(info, name) } }));
      } catch (error) {
        set(state => ({
          entries: {
            ...state.entries,
            [key]: { ...pendingEntry(name, "error"), reason: (error as Error)?.message ?? "artist-image-failed" },
          },
        }));
      }
    },

    clearCache: async () => {
      const api = artistImageApi();
      set({ entries: {} });
      queue.length = 0;
      if (!api) return { removedImages: 0, removedMisses: 0 };
      return api.clearCache();
    },

    resetAll: () => {
      queue.length = 0;
      set({ entries: {} });
    },
  };
});
