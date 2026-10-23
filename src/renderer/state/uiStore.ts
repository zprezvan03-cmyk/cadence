import { create } from "zustand";

export type LibraryTab = "songs" | "albums" | "artists" | "playlists" | "favorites";

export type Route =
  | { name: "home" }
  | { name: "library"; tab: LibraryTab }
  | { name: "search"; query: string }
  | { name: "album"; albumId: string }
  | { name: "artist"; artistId: string }
  | { name: "playlist"; playlistId: number }
  | { name: "lyrics" }
  | { name: "settings" };

interface UiState {
  route: Route;
  queueOpen: boolean;
  nowPlayingOpen: boolean;
  fullscreenLyrics: boolean;
  searchFocused: boolean;
  playlistPicker: { trackIds: number[] } | null;
  toast: string | null;
  navigate: (route: Route) => void;
  goBack: () => void;
  goForward: () => void;
  toggleQueue: (open?: boolean) => void;
  toggleNowPlaying: (open?: boolean) => void;
  setFullscreenLyrics: (value: boolean) => void;
  setSearchFocused: (value: boolean) => void;
  openPlaylistPicker: (trackIds: number[]) => void;
  closePlaylistPicker: () => void;
  showToast: (message: string) => void;
  syncFromHash: () => void;
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
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
      const tab = (["songs", "albums", "artists", "playlists", "favorites"] as LibraryTab[]).includes(
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
    case "settings":
      return { name: "settings" };
    default:
      return { name: "home" };
  }
}

export const useUi = create<UiState>()((set, get) => ({
  route: typeof location !== "undefined" ? hashToRoute(location.hash) : { name: "home" },
  queueOpen: false,
  nowPlayingOpen: false,
  fullscreenLyrics: false,
  searchFocused: false,
  playlistPicker: null,
  toast: null,
  navigate: route => {
    const hash = routeToHash(route);
    if (location.hash !== hash) location.hash = hash;
    set({ route, searchFocused: false });
  },
  goBack: () => history.back(),
  goForward: () => history.forward(),
  toggleQueue: open => set(state => ({ queueOpen: open ?? !state.queueOpen })),
  toggleNowPlaying: open => set(state => ({ nowPlayingOpen: open ?? !state.nowPlayingOpen })),
  setFullscreenLyrics: value => set({ fullscreenLyrics: value }),
  setSearchFocused: value => set({ searchFocused: value }),
  openPlaylistPicker: trackIds => set({ playlistPicker: { trackIds } }),
  closePlaylistPicker: () => set({ playlistPicker: null }),
  showToast: message => {
    set({ toast: message });
    window.setTimeout(() => {
      if (get().toast === message) set({ toast: null });
    }, 2600);
  },
  syncFromHash: () => set({ route: hashToRoute(location.hash) }),
}));

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    useUi.getState().syncFromHash();
  });
}
