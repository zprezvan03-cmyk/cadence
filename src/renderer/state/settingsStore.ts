import { create } from "zustand";
import type { AppSettings, DeepPartial } from "../../shared/types";
import { bridge } from "./bridge";

let mutationRevision = 0;

interface SettingsState {
  settings: AppSettings | null;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  patch: (patch: DeepPartial<AppSettings>) => Promise<void>;
  reset: () => Promise<void>;
}

export const useSettings = create<SettingsState>()((set, get) => ({
  settings: null,
  loaded: false,
  error: null,
  load: async () => {
    try {
      const settings = await bridge.settings.get();
      set({ settings, loaded: true, error: null });
    } catch (error) {
      set({ loaded: true, error: (error as Error).message });
    }
  },
  patch: async (patch: DeepPartial<AppSettings>) => {
    const revision = ++mutationRevision;
    const current = get().settings;
    if (current) set({ settings: mergeSettings(current, patch) });
    const settings = await bridge.settings.patch(patch);
    // IPC responses can arrive out of order. Keep the newest optimistic mutation instead of
    // allowing an older full-settings response to undo a control the user changed afterwards.
    if (revision === mutationRevision) set({ settings });
  },
  reset: async () => {
    const revision = ++mutationRevision;
    const settings = await bridge.settings.reset();
    if (revision === mutationRevision) set({ settings });
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
