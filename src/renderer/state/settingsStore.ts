import { create } from "zustand";
import type { AppSettings, DeepPartial } from "../../shared/types";
import { bridge } from "./bridge";

interface SettingsState {
  settings: AppSettings | null;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  patch: (patch: DeepPartial<AppSettings>) => Promise<void>;
  reset: () => Promise<void>;
}

let inflightLoad: Promise<void> | null = null;
let mutationSeq = 0;

export const useSettings = create<SettingsState>()((set, get) => ({
  settings: null,
  loaded: false,
  error: null,
  load: async () => {
    if (inflightLoad) return inflightLoad;
    const seqAtStart = mutationSeq;
    inflightLoad = (async () => {
      try {
        const settings = await bridge.settings.get();
        // Never let a late initial hydration overwrite settings changed while load() was in flight.
        if (seqAtStart === mutationSeq) {
          set({ settings, loaded: true, error: null });
        } else {
          set({ loaded: true, error: null });
        }
      } catch (error) {
        set({ loaded: true, error: (error as Error).message });
      } finally {
        inflightLoad = null;
      }
    })();
    return inflightLoad;
  },
  patch: async (patch: DeepPartial<AppSettings>) => {
    const seq = ++mutationSeq;
    const current = get().settings;
    if (current) set({ settings: mergeSettings(current, patch) });
    const settings = await bridge.settings.patch(patch);
    if (seq === mutationSeq) {
      set({ settings, loaded: true, error: null });
    }
  },
  reset: async () => {
    const seq = ++mutationSeq;
    const settings = await bridge.settings.reset();
    if (seq === mutationSeq) {
      set({ settings, loaded: true, error: null });
    }
  },
}));

/** Optimistic local merge so a slider never waits on the IPC round trip. */
function mergeSettings(base: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = (base as unknown as Record<string, unknown>)[key];
    result[key] =
      value && typeof value === "object" && !Array.isArray(value) && existing && typeof existing === "object"
        ? { ...(existing as object), ...(value as object) }
        : value;
  }
  return result as unknown as AppSettings;
}
