/**
 * Installed system fonts, shared by every font picker in the app.
 *
 * The host enumerates the platform font store (see `src-tauri/src/fonts.rs`); this store caches the
 * result for the session and can be refreshed on demand, so a font installed while Cadence is
 * running appears after a refresh without a restart. Browser-only builds and test harnesses have no
 * host command and fall back to the well-known families in `shared/fonts`.
 *
 * A scan reads the name table of every font file on the machine, so automatic refreshes (window
 * focus) pass `maxAgeMs` to avoid rescanning on every alt-tab; the explicit Refresh button and the
 * first load always run.
 */

import { create } from "zustand";
import { FALLBACK_FONT_FAMILIES, normalizeSystemFontFamilies, type SystemFontFamily } from "../../shared/fonts";
import { bridge } from "./bridge";

interface LoadOptions {
  /** Skip the cache and rescan. */
  force?: boolean;
  /** With `force`, still reuse the cache when it is younger than this. */
  maxAgeMs?: number;
}

interface SystemFontsState {
  families: SystemFontFamily[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** When the last successful (or fallback) scan finished, in epoch ms; 0 before the first. */
  scannedAt: number;
  load: (options?: LoadOptions) => Promise<void>;
}

async function fetchFamilies(): Promise<SystemFontFamily[]> {
  const list = (bridge as { fonts?: { list?: () => Promise<SystemFontFamily[]> } }).fonts?.list;
  if (typeof list !== "function") return [...FALLBACK_FONT_FAMILIES];
  return normalizeSystemFontFamilies(await list.call(bridge.fonts));
}

export const useSystemFonts = create<SystemFontsState>()((set, get) => ({
  families: [],
  loaded: false,
  loading: false,
  error: null,
  scannedAt: 0,
  load: async (options = {}) => {
    const state = get();
    if (state.loading) return;
    if (state.loaded && !options.force) return;
    if (state.loaded && options.maxAgeMs !== undefined && Date.now() - state.scannedAt < options.maxAgeMs) return;
    set({ loading: true, error: null });
    try {
      set({ families: await fetchFamilies(), loaded: true, loading: false, scannedAt: Date.now() });
    } catch (error) {
      // A platform that cannot be scanned must never leave the app without a font: keep the
      // generic presets and report the reason so the picker can say so.
      set({
        families: [...FALLBACK_FONT_FAMILIES],
        loaded: true,
        loading: false,
        scannedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));
