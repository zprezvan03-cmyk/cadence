import { create } from "zustand";

export type LibraryTab = "recently-added" | "songs" | "albums" | "artists" | "playlists" | "favorites";

export type Route =
  | { name: "home" }
  | { name: "history" }
  | { name: "stats" }
  | { name: "library"; tab: LibraryTab }
  | { name: "search"; query: string }
  | { name: "album"; albumId: string }
  | { name: "artist"; artistId: string }
  | { name: "playlist"; playlistId: number }
  | { name: "lyrics" }
  | { name: "decode-tester" }
  | { name: "settings" };

interface UiState {
  route: Route;
  queueOpen: boolean;
  nowPlayingOpen: boolean;
  searchFocused: boolean;
  playlistPicker: { trackIds: number[] } | null;
  playlistCreateRequested: boolean;
  trackEditorId: number | null;
  miniPlayer: boolean;
  shortcutsHelpOpen: boolean;
  toast: string | null;
  navigate: (route: Route) => void;
  goBack: () => void;
  goForward: () => void;
  toggleQueue: (open?: boolean) => void;
  openNowPlaying: () => void;
  closeNowPlaying: () => void;
  toggleNowPlaying: () => void;
  toggleNativeNowPlaying: () => Promise<void>;
  setSearchFocused: (value: boolean) => void;
  openPlaylistPicker: (trackIds: number[]) => void;
  closePlaylistPicker: () => void;
  openTrackEditor: (trackId: number) => void;
  closeTrackEditor: () => void;
  setMiniPlayer: (value: boolean) => void;
  toggleMiniPlayer: () => void;
  setShortcutsHelpOpen: (value: boolean) => void;
  requestPlaylistCreate: () => void;
  acknowledgePlaylistCreate: () => void;
  showToast: (message: string) => void;
  syncFromHash: () => void;
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "history":
      return "#/history";
    case "stats":
      return "#/stats";
    case "library":
      return `#/library/${route.tab}`;
    case "search":
      return `#/search/${encodeURIComponent(route.query)}`;
    case "album":
      return `#/album/${encodeURIComponent(route.albumId)}`;
    case "artist":
      return `#/artist/${encodeURIComponent(route.artistId)}`;
    case "playlist":
      return `#/playlist/${route.playlistId}`;
    case "lyrics":
      return "#/lyrics";
    case "decode-tester":
      return "#/decode-tester";
    case "settings":
      return "#/settings";
    default:
      return "#/";
  }
}

export function hashToRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "");
  const [segment, ...rest] = clean.split("/");
  const value = rest.join("/");
  switch (segment) {
    case "library": {
      const tab = (["recently-added", "songs", "albums", "artists", "playlists", "favorites"] as LibraryTab[]).includes(
        value as LibraryTab
      )
        ? (value as LibraryTab)
        : "songs";
      return { name: "library", tab };
    }
    case "search":
      return { name: "search", query: decodeURIComponent(value) };
    case "album":
      return { name: "album", albumId: decodeURIComponent(value) };
    case "artist":
      return { name: "artist", artistId: decodeURIComponent(value) };
    case "playlist":
      return { name: "playlist", playlistId: Number(value) || 0 };
    case "lyrics":
      return { name: "lyrics" };
    case "decode-tester":
      return { name: "decode-tester" };
    case "settings":
      return { name: "settings" };
    case "history":
      return { name: "history" };
    case "stats":
      return { name: "stats" };
    default:
      return { name: "home" };
  }
}

// Serialize native fullscreen requests so an Escape during F11 entry cannot leave the
// window fullscreen after the browsing UI is back. Visual Now Playing does not need IPC.
let nativeFullscreenPending = false;
let nativeEntryCancelled = false;

export const useUi = create<UiState>()((set, get) => ({
  route: typeof location !== "undefined" ? hashToRoute(location.hash) : { name: "home" },
  queueOpen: false,
  nowPlayingOpen: false,
  searchFocused: false,
  playlistPicker: null,
  playlistCreateRequested: false,
  trackEditorId: null,
  miniPlayer: false,
  shortcutsHelpOpen: false,
  toast: null,
  navigate: route => {
    const hash = routeToHash(route);
    if (location.hash !== hash) location.hash = hash;
    get().closeNowPlaying();
    set({ route, searchFocused: false });
  },
  goBack: () => history.back(),
  goForward: () => history.forward(),
  toggleQueue: open => set(state => ({ queueOpen: open ?? !state.queueOpen })),
  // Now Playing is a presentation of the live player, not a browsing destination.
  openNowPlaying: () => set({ nowPlayingOpen: true, miniPlayer: false, searchFocused: false }),
  closeNowPlaying: () => {
    const wasOpen = get().nowPlayingOpen;
    if (wasOpen) set({ nowPlayingOpen: false });
    if (nativeFullscreenPending) {
      nativeEntryCancelled = true;
      return;
    }
    const app = window.cadence?.app;
    if (!wasOpen || !app?.isFullScreen) return;
    nativeFullscreenPending = true;
    void app.isFullScreen()
      .then(full => full ? app.window("exitFullscreen") : undefined)
      .catch(() => undefined)
      .finally(() => { nativeFullscreenPending = false; });
  },
  toggleNowPlaying: () => {
    const ui = get();
    if (ui.nowPlayingOpen && !ui.miniPlayer) ui.closeNowPlaying();
    else ui.openNowPlaying();
  },
  toggleNativeNowPlaying: async () => {
    if (nativeFullscreenPending) return;
    const app = window.cadence?.app;
    if (!app?.isFullScreen || !app.window) {
      get().toggleNowPlaying();
      return;
    }
    nativeFullscreenPending = true;
    nativeEntryCancelled = false;
    try {
      if (await app.isFullScreen()) {
        set({ nowPlayingOpen: false });
        await app.window("exitFullscreen");
      } else if (!nativeEntryCancelled) {
        get().openNowPlaying();
        await app.window("fullscreen");
        // Escape or navigation during the native enter may have dismissed the surface.
        if (nativeEntryCancelled || !get().nowPlayingOpen || get().miniPlayer) await app.window("exitFullscreen");
      }
    } catch {
      // The renderer still provides Now Playing if the native window action fails.
    } finally {
      nativeFullscreenPending = false;
    }
  },
  setSearchFocused: value => set({ searchFocused: value }),
  openPlaylistPicker: trackIds => set({ playlistPicker: { trackIds } }),
  closePlaylistPicker: () => set({ playlistPicker: null }),
  openTrackEditor: trackId => set({ trackEditorId: trackId }),
  closeTrackEditor: () => set({ trackEditorId: null }),
  setMiniPlayer: value =>
    set(state => ({ miniPlayer: value, queueOpen: value ? false : state.queueOpen })),
  toggleMiniPlayer: () => get().setMiniPlayer(!get().miniPlayer),
  setShortcutsHelpOpen: value => set({ shortcutsHelpOpen: value }),
  requestPlaylistCreate: () => {
    get().navigate({ name: "library", tab: "playlists" });
    set({ playlistCreateRequested: true });
  },
  acknowledgePlaylistCreate: () => set({ playlistCreateRequested: false }),
  showToast: message => {
    set({ toast: message });
    window.setTimeout(() => {
      if (get().toast === message) set({ toast: null });
    }, 2600);
  },
  syncFromHash: () => {
    const route = hashToRoute(location.hash);
    if (routeToHash(route) === routeToHash(get().route)) return;
    get().closeNowPlaying();
    set({ route, searchFocused: false });
  },
}));

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    useUi.getState().syncFromHash();
  });
}
