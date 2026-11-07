/**
 * Renderer mirror of the persistent Fetch All Lyrics job that lives in the bridge.
 * The store only caches the latest snapshot (plus library coverage stats) so the top bar,
 * Settings and onboarding render from one place; all work happens bridge-side and keeps
 * running regardless of navigation.
 */

import { create } from "zustand";
import type { LyricsFetchJobSnapshot, LyricsFetchStats } from "../../shared/types";
import { bridge, hasBridge } from "./bridge";

const IDLE_SNAPSHOT: LyricsFetchJobSnapshot = {
  jobId: null,
  state: "idle",
  total: 0,
  processed: 0,
  found: 0,
  notFound: 0,
  failed: 0,
  skipped: 0,
  currentTrack: null,
  startedAt: null,
  finishedAt: null,
};

interface FetchAllState {
  snapshot: LyricsFetchJobSnapshot;
  stats: LyricsFetchStats | null;
  initialized: boolean;
  init: () => void;
  refreshStats: () => Promise<void>;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
  retryFailed: () => Promise<void>;
}

function fetchAllApi() {
  return hasBridge() ? bridge.lyrics.fetchAll : undefined;
}

export const useFetchAll = create<FetchAllState>()((set, get) => {
  const apply = (snapshot: LyricsFetchJobSnapshot) => set({ snapshot });
  const call = async (action: ((api: NonNullable<typeof bridge.lyrics.fetchAll>) => Promise<LyricsFetchJobSnapshot>) | undefined) => {
    const api = fetchAllApi();
    if (!api || !action) return;
    try {
      apply(await action(api));
    } catch (error) {
      console.warn("[Cadence] Fetch All action failed:", error);
    }
  };

  return {
    snapshot: IDLE_SNAPSHOT,
    stats: null,
    initialized: false,

    init: () => {
      if (get().initialized) return;
      set({ initialized: true });
      const api = fetchAllApi();
      if (!api) return;
      api.onProgress(apply);
      void api
        .getState()
        .then(apply)
        .catch(() => undefined);
    },

    refreshStats: async () => {
      const api = fetchAllApi();
      if (!api) return;
      try {
        set({ stats: await api.stats() });
      } catch {
        /* stats are informational; the job controls keep working without them */
      }
    },

    start: () => call(api => api.start()),
    pause: () => call(api => api.pause()),
    resume: () => call(api => api.resume()),
    cancel: () => call(api => api.cancel()),
    retryFailed: () => call(api => api.retryFailed()),
  };
});

export { IDLE_SNAPSHOT as IDLE_FETCH_ALL_SNAPSHOT };
