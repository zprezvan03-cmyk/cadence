/**
 * Renderer store for the YouTube Music source inside Cadence.
 *
 * Owns the provider session (guest by default; optional connected account whose cookie lives in
 * the OS secret store), all catalog state (home, search + suggestions, artist/album/playlist
 * pages, explore/charts/moods) and the search history. Every remote item it hands out is a
 * MediaItem with a `youtube-music` TrackSource, so it flows straight into the existing unified
 * queue, Now Playing, history and lyrics pipeline.
 */

import { create } from "zustand";
import type {
  YtmAlbumPage,
  YtmArtistPage,
  YtmChartsPage,
  YtmExplorePage,
  YtmHomePage,
  YtmMoodOrGenre,
  YtmPlaylistPage,
  YtmSearchFilter,
  YtmSearchResults,
  YtmSuggestions,
} from "../../shared/ytmusic";
import {
  getYouTubeMusicProvider,
  YtmProviderError,
  type YouTubeMusicProvider,
} from "../../main/ytmusic/provider";
import { bridge, hasBridge } from "./bridge";
import { useSettings } from "./settingsStore";

const SEARCH_HISTORY_KEY = "cadence.ytm.searchHistory.v1";
const ACCOUNT_SECRET_ACCOUNT = "google-account-cookie";
export const YTM_SECRET_SERVICE = "cadence";

type LoadState = "idle" | "loading" | "ready" | "error";

interface PagedState<T> {
  status: LoadState;
  data: T | null;
  continuation: string | null;
  error: string | null;
  loadingMore: boolean;
}

function initialPaged<T>(): PagedState<T> {
  return { status: "idle", data: null, continuation: null, error: null, loadingMore: false };
}

export interface YtmSearchState extends PagedState<YtmSearchResults> {
  query: string;
  filter: YtmSearchFilter;
}

export type YtmAccountStatus =
  | { mode: "guest" }
  | { mode: "connected"; name: string }
  | { mode: "error"; detail: string };

export interface YtmState {
  account: YtmAccountStatus;
  home: PagedState<YtmHomePage>;
  searchState: YtmSearchState;
  suggestions: { items: YtmSuggestions; status: LoadState; error: string | null };
  artistPages: Record<string, PagedState<YtmArtistPage>>;
  albumPages: Record<string, PagedState<YtmAlbumPage>>;
  playlistPages: Record<string, PagedState<YtmPlaylistPage>>;
  explore: PagedState<YtmExplorePage>;
  charts: PagedState<YtmChartsPage>;
  moods: PagedState<YtmMoodOrGenre[]>;
  searchHistory: string[];

  provider(): YouTubeMusicProvider;
  syncSessionFromSettings(): void;
  loadHome(refresh?: boolean): Promise<void>;
  loadMoreHome(): Promise<void>;
  performSearch(query: string, filter?: YtmSearchFilter): Promise<void>;
  loadMoreSearch(): Promise<void>;
  setFilter(filter: YtmSearchFilter): Promise<void>;
  fetchSuggestions(input: string): Promise<void>;
  loadArtist(browseId: string): Promise<void>;
  loadAlbum(browseId: string): Promise<void>;
  loadPlaylist(id: string): Promise<void>;
  loadMorePlaylist(id: string): Promise<void>;
  loadExplore(): Promise<void>;
  loadCharts(): Promise<void>;
  loadMoods(): Promise<void>;
  connectAccount(cookie: string, name: string): Promise<void>;
  disconnectAccount(): Promise<void>;
  checkAccount(): Promise<void>;
}

function errorMessage(error: unknown): string {
  if (error instanceof YtmProviderError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function saveSearchHistory(history: string[]): void {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* history is a convenience */
  }
}

export const useYtm = create<YtmState>()((set, get) => {
  const provider = getYouTubeMusicProvider();

  const syncSessionFromSettings = () => {
    const ytm = useSettings.getState().settings?.youtubeMusic;
    provider.setSession({
      visitorData: ytm?.visitorData ?? null,
      gl: ytm?.gl ?? "US",
      hl: ytm?.hl ?? "en",
      cookie: null, // cookie is attached per request, never stored on the provider
    });
  };

  /** Attach the connected account's cookie for one provider call, if connected. */
  const withAccount = async <T>(task: (cookie: string | null) => Promise<T>): Promise<T> => {
    const account = get().account;
    let cookie: string | null = null;
    if (account.mode === "connected" && hasBridge()) {
      try {
        cookie = await bridge.secrets.get({ service: YTM_SECRET_SERVICE, account: ACCOUNT_SECRET_ACCOUNT });
      } catch {
        cookie = null;
      }
    }
    return task(cookie);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patchPaged = (key: "home" | "explore" | "charts" | "moods", patch: Record<string, any>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set(state => ({ ...state, [key]: { ...(state as any)[key], ...patch } }));

  return {
    account: { mode: "guest" },
    home: initialPaged(),
    searchState: { ...initialPaged(), query: "", filter: "all" },
    suggestions: { items: { queries: [], items: [] }, status: "idle", error: null },
    artistPages: {},
    albumPages: {},
    playlistPages: {},
    explore: initialPaged(),
    charts: initialPaged(),
    moods: initialPaged(),
    searchHistory: loadSearchHistory(),

    provider: () => provider,
    syncSessionFromSettings,

    async loadHome(refresh = false) {
      syncSessionFromSettings();
      const state = get().home;
      if (state.status === "loading") return;
      if (state.status === "ready" && !refresh) return;
      patchPaged("home", { status: "loading", error: null });
      try {
        const page = await provider.home();
        set({ home: { status: "ready", data: page, continuation: page.continuation, error: null, loadingMore: false } });
        // Persist the anonymous visitor id so the next launch skips the sw.js_data lookup.
        const visitorData = provider.getSession().visitorData;
        const current = useSettings.getState().settings?.youtubeMusic?.visitorData;
        if (visitorData && visitorData !== current) {
          void useSettings.getState().patch({ youtubeMusic: { visitorData } } ).catch(() => undefined);
        }
      } catch (error) {
        patchPaged("home", { status: "error", error: errorMessage(error) });
      }
    },

    async loadMoreHome() {
      const state = get().home;
      if (state.status !== "ready" || !state.continuation || state.loadingMore) return;
      patchPaged("home", { loadingMore: true });
      try {
        const page = await provider.home(state.continuation);
        set(current => {
          const data = current.home.data;
          if (!data) return {};
          return {
            home: {
              ...current.home,
              loadingMore: false,
              data: { ...data, sections: [...data.sections, ...page.sections] },
              continuation: page.continuation,
            },
          };
        });
      } catch (error) {
        patchPaged("home", { loadingMore: false, error: errorMessage(error) });
      }
    },

    async performSearch(query, filter) {
      const trimmed = query.trim();
      if (!trimmed) return;
      syncSessionFromSettings();
      const activeFilter = filter ?? get().searchState.filter;
      set(state => ({
        searchState: { ...state.searchState, query: trimmed, filter: activeFilter, status: "loading", error: null },
      }));
      try {
        const results = await withAccount(cookie => {
          if (cookie) provider.setSession({ cookie });
          return provider.search(trimmed, activeFilter);
        });
        set(state => ({
          searchState: {
            ...state.searchState,
            status: "ready",
            data: results,
            continuation: results.continuation,
            error: null,
            loadingMore: false,
          },
          searchHistory: (() => {
            const next = [trimmed, ...get().searchHistory.filter(h => h !== trimmed)].slice(0, 20);
            saveSearchHistory(next);
            return next;
          })(),
        }));
      } catch (error) {
        set(state => ({ searchState: { ...state.searchState, status: "error", error: errorMessage(error) } }));
      }
    },

    async loadMoreSearch() {
      const state = get().searchState;
      if (state.status !== "ready" || !state.continuation || state.loadingMore) return;
      set(current => ({ searchState: { ...current.searchState, loadingMore: true } }));
      try {
        const results = await provider.search(state.query, state.filter, state.continuation);
        set(current => ({
          searchState: {
            ...current.searchState,
            loadingMore: false,
            data: current.searchState.data
              ? { ...results, items: [...current.searchState.data.items, ...results.items] }
              : results,
            continuation: results.continuation,
          },
        }));
      } catch (error) {
        set(current => ({ searchState: { ...current.searchState, loadingMore: false, error: errorMessage(error) } }));
      }
    },

    async setFilter(filter) {
      const query = get().searchState.query.trim();
      if (!query) return;
      await get().performSearch(query, filter);
    },

    async fetchSuggestions(input) {
      const trimmed = input.trim();
      if (!trimmed) {
        set({ suggestions: { items: { queries: [], items: [] }, status: "idle", error: null } });
        return;
      }
      try {
        const items = await provider.suggestions(trimmed);
        // Only apply if the input has not moved on meanwhile.
        set(state => ({
          suggestions: { items, status: "ready", error: null },
        }));
      } catch (error) {
        set({ suggestions: { items: { queries: [], items: [] }, status: "error", error: errorMessage(error) } });
      }
    },

    async loadArtist(browseId) {
      set(state => ({ artistPages: { ...state.artistPages, [browseId]: state.artistPages[browseId] ?? initialPaged() } }));
      set(state => ({
        artistPages: { ...state.artistPages, [browseId]: { ...state.artistPages[browseId], status: "loading", error: null } },
      }));
      try {
        const page = await provider.artist(browseId);
        set(state => ({
          artistPages: {
            ...state.artistPages,
            [browseId]: { status: "ready", data: page, continuation: page.continuation, error: null, loadingMore: false },
          },
        }));
      } catch (error) {
        set(state => ({
          artistPages: { ...state.artistPages, [browseId]: { ...state.artistPages[browseId], status: "error", error: errorMessage(error) } },
        }));
      }
    },

    async loadAlbum(browseId) {
      set(state => ({
        albumPages: { ...state.albumPages, [browseId]: { ...(state.albumPages[browseId] ?? initialPaged()), status: "loading", error: null } },
      }));
      try {
        const page = await provider.album(browseId);
        set(state => ({
          albumPages: { ...state.albumPages, [browseId]: { status: "ready", data: page, continuation: page.continuation, error: null, loadingMore: false } },
        }));
      } catch (error) {
        set(state => ({
          albumPages: { ...state.albumPages, [browseId]: { ...state.albumPages[browseId], status: "error", error: errorMessage(error) } },
        }));
      }
    },

    async loadPlaylist(id) {
      set(state => ({
        playlistPages: { ...state.playlistPages, [id]: { ...(state.playlistPages[id] ?? initialPaged()), status: "loading", error: null } },
      }));
      try {
        const page = await provider.playlist(id);
        set(state => ({
          playlistPages: { ...state.playlistPages, [id]: { status: "ready", data: page, continuation: page.continuation, error: null, loadingMore: false } },
        }));
      } catch (error) {
        set(state => ({
          playlistPages: { ...state.playlistPages, [id]: { ...state.playlistPages[id], status: "error", error: errorMessage(error) } },
        }));
      }
    },

    async loadMorePlaylist(id) {
      const state = get().playlistPages[id];
      if (!state || state.status !== "ready" || !state.continuation || state.loadingMore) return;
      set(current => ({
        playlistPages: { ...current.playlistPages, [id]: { ...state, loadingMore: true } },
      }));
      try {
        const page = await provider.playlist(id, state.continuation);
        set(current => {
          const existing = current.playlistPages[id];
          if (!existing?.data) return {};
          return {
            playlistPages: {
              ...current.playlistPages,
              [id]: {
                ...existing,
                loadingMore: false,
                data: { ...page, tracks: [...existing.data.tracks, ...page.tracks] },
                continuation: page.continuation,
              },
            },
          };
        });
      } catch (error) {
        set(current => ({
          playlistPages: { ...current.playlistPages, [id]: { ...state, loadingMore: false, error: errorMessage(error) } },
        }));
      }
    },

    async loadExplore() {
      const state = get().explore;
      if (state.status === "loading" || state.status === "ready") return;
      patchPaged("explore", { status: "loading", error: null });
      try {
        const page = await provider.explore();
        patchPaged("explore", { status: "ready", data: page, continuation: null, error: null });
      } catch (error) {
        patchPaged("explore", { status: "error", error: errorMessage(error) });
      }
    },

    async loadCharts() {
      const state = get().charts;
      if (state.status === "loading" || state.status === "ready") return;
      patchPaged("charts", { status: "loading", error: null });
      try {
        const page = await provider.charts();
        patchPaged("charts", { status: "ready", data: page, continuation: page.continuation, error: null });
      } catch (error) {
        patchPaged("charts", { status: "error", error: errorMessage(error) });
      }
    },

    async loadMoods() {
      const state = get().moods;
      if (state.status === "loading" || state.status === "ready") return;
      patchPaged("moods", { status: "loading", error: null });
      try {
        const page = await provider.moodsAndGenres();
        patchPaged("moods", { status: "ready", data: page, continuation: null, error: null });
      } catch (error) {
        patchPaged("moods", { status: "error", error: errorMessage(error) });
      }
    },

    async connectAccount(cookie, name) {
      if (!hasBridge()) {
        set({ account: { mode: "error", detail: "The desktop shell is required to store the account cookie safely." } });
        return;
      }
      const trimmed = cookie.trim();
      if (!trimmed) {
        set({ account: { mode: "error", detail: "Paste the Cookie header value from music.youtube.com first." } });
        return;
      }
      try {
        await bridge.secrets.store({ service: YTM_SECRET_SERVICE, account: ACCOUNT_SECRET_ACCOUNT, secret: trimmed });
        void useSettings.getState().patch({ youtubeMusic: { accountName: name.trim() || "Google account" } } ).catch(() => undefined);
        set({ account: { mode: "connected", name: name.trim() || "Google account" } });
      } catch (error) {
        set({ account: { mode: "error", detail: `Could not store the cookie in the OS secret store: ${errorMessage(error)}` } });
      }
    },

    async disconnectAccount() {
      if (hasBridge()) {
        try {
          await bridge.secrets.delete({ service: YTM_SECRET_SERVICE, account: ACCOUNT_SECRET_ACCOUNT });
        } catch {
          /* best effort */
        }
      }
      provider.setSession({ cookie: null });
      void useSettings.getState().patch({ youtubeMusic: { accountName: null } } ).catch(() => undefined);
      set({ account: { mode: "guest" } });
    },

    async checkAccount() {
      const name = useSettings.getState().settings?.youtubeMusic?.accountName ?? null;
      if (!name) {
        set({ account: { mode: "guest" } });
        return;
      }
      if (!hasBridge()) {
        set({ account: { mode: "connected", name } });
        return;
      }
      try {
        const cookie = await bridge.secrets.get({ service: YTM_SECRET_SERVICE, account: ACCOUNT_SECRET_ACCOUNT });
        if (cookie) {
          set({ account: { mode: "connected", name } });
        } else {
          // Secret store entry is gone (e.g. keyring cleared): fall back to guest, drop the name.
          void useSettings.getState().patch({ youtubeMusic: { accountName: null } } ).catch(() => undefined);
          set({ account: { mode: "guest" } });
        }
      } catch (error) {
        set({ account: { mode: "error", detail: errorMessage(error) } });
      }
    },
  };
});
