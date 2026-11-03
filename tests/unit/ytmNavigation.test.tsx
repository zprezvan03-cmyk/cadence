// @vitest-environment jsdom
/**
 * Regression tests for "black screen when clicking a YouTube Music search result".
 *
 * Root cause fixed here: YtmAlbumView called usePlayer hooks AFTER its loading/error early
 * returns, so the loading -> ready transition changed the hook count and React threw
 * "Rendered more hooks than during the previous render", unmounting the whole app (no error
 * boundary existed). The fix hoists the hooks and App now wraps every routed view in
 * ViewErrorBoundary, so a render error can never black the window again.
 *
 * These tests render the real route-level views with a stubbed InnerTube provider and cover:
 * every result type's navigation, loading -> ready transitions, failed detail requests,
 * missing/invalid ids, rapid repeated navigation, back navigation with search-state
 * preservation, playback failure while viewing content, and the error boundary itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement, type ComponentType } from "react";

vi.mock("../../src/renderer/state/settingsStore", () => ({
  useSettings: {
    getState: () => ({
      settings: {
        youtubeMusic: { visitorData: "CgtX", gl: "US", hl: "en", accountName: null },
        lyrics: { providerOrder: [], autoFetch: false },
      },
      loaded: true,
    }),
  },
}));
vi.mock("../../src/renderer/state/bridge", () => ({
  hasBridge: () => false,
  bridge: { secrets: { get: async () => null, store: async () => {}, delete: async () => true } },
}));

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

function track(id: string, title: string) {
  return {
    kind: "song" as const,
    videoId: id,
    title,
    artists: [{ name: "Rick Astley", browseId: "UCuAXFkgsw1L7xaCfnd5JJOw" }],
    album: { title: "Whenever You Need Somebody", browseId: "MPREb_album1" },
    durationSeconds: 212,
    durationText: "3:32",
    artworkUrl: null,
    explicit: false,
    viewCountText: null,
    playlistId: "OLAK5uy_pl1",
    setVideoId: null,
  };
}

const searchResults = {
  filter: "all" as const,
  topResult: { type: "song" as const, track: track("dQw4w9WgXcQ", "Never Gonna Give You Up") },
  items: [
    { type: "song" as const, track: track("s1", "Never Gonna Give You Up") },
    { type: "song" as const, track: track("s2", "Together Forever") },
    {
      type: "album" as const,
      album: { browseId: "MPREb_album1", title: "Whenever You Need Somebody", year: 1987, artists: [{ name: "Rick Astley", browseId: "UCuAXFkgsw1L7xaCfnd5JJOw" }], artworkUrl: null, playlistId: "OLAK5uy_pl1", trackCountText: "12 songs" },
    },
    {
      type: "artist" as const,
      artist: { browseId: "UCuAXFkgsw1L7xaCfnd5JJOw", name: "Rick Astley", artworkUrl: null, subscriberCountText: "2.5M subscribers" },
    },
    {
      type: "playlist" as const,
      playlist: { id: "VLPLtest1", title: "Rick Astley Mix", author: { name: "Rick Astley", browseId: "UCuAXFkgsw1L7xaCfnd5JJOw" }, artworkUrl: null, trackCountText: "50 songs", viewCountText: null },
    },
  ],
  continuation: "SEARCH_TOK",
};

const artistPage = {
  browseId: "UCuAXFkgsw1L7xaCfnd5JJOw",
  name: "Rick Astley",
  subscriberCountText: "2.5M subscribers",
  artworkUrl: null,
  description: null,
  shelves: [
    { title: "Popular", subtitle: null, items: [{ type: "song" as const, track: track("s1", "Never Gonna Give You Up") }], continuation: null, moreBrowseId: null, moreParams: null },
    {
      title: "Albums",
      subtitle: null,
      items: [{ type: "album" as const, album: { browseId: "MPREb_album1", title: "Whenever You Need Somebody", year: 1987, artists: [], artworkUrl: null, playlistId: "OLAK5uy_pl1", trackCountText: "12 songs" } }],
      continuation: null,
      moreBrowseId: null,
      moreParams: null,
    },
  ],
  continuation: null,
};

const albumPage = {
  browseId: "MPREb_album1",
  title: "Whenever You Need Somebody",
  artists: [{ name: "Rick Astley", browseId: "UCuAXFkgsw1L7xaCfnd5JJOw" }],
  year: 1987,
  artworkUrl: null,
  description: null,
  trackCountText: "12 songs",
  durationText: "41 min",
  tracks: [track("s1", "Never Gonna Give You Up"), track("s2", "Together Forever")],
  continuation: null,
};

const playlistPage = {
  id: "VLPLtest1",
  title: "Rick Astley Mix",
  author: { name: "Rick Astley", browseId: "UCuAXFkgsw1L7xaCfnd5JJOw" },
  description: null,
  trackCountText: "50 songs",
  viewCountText: "1,234 views",
  artworkUrl: null,
  tracks: [track("s1", "Never Gonna Give You Up"), track("s2", "Together Forever")],
  continuation: "PL_TOK",
};

interface FakeProvider {
  search: ReturnType<typeof vi.fn>;
  artist: ReturnType<typeof vi.fn>;
  album: ReturnType<typeof vi.fn>;
  playlist: ReturnType<typeof vi.fn>;
  resolveStream: ReturnType<typeof vi.fn>;
  setSession: () => void;
}

async function setupStore(overrides: Partial<FakeProvider> = {}) {
  vi.resetModules();
  vi.stubGlobal("localStorage", new MemoryStorage());
  const { setYouTubeMusicProvider } = await import("../../src/main/ytmusic/provider");
  const fake: FakeProvider = {
    setSession: () => {},
    search: vi.fn(async () => searchResults),
    artist: vi.fn(async () => artistPage),
    album: vi.fn(async () => albumPage),
    playlist: vi.fn(async () => playlistPage),
    resolveStream: vi.fn(async () => ({ itag: 140, url: "https://rr.example/audio", mimeType: "audio/mp4", bitrate: 128000, durationMs: 212000 })),
    ...overrides,
  };
  setYouTubeMusicProvider(fake as never);
  const { useYtm } = await import("../../src/renderer/state/ytmusicStore");
  const { useUi } = await import("../../src/renderer/state/uiStore");
  return { useYtm, useUi, fake };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function renderView(component: ComponentType<Record<string, string>>, props: Record<string, string>) {
  const view = render(createElement(component, props));
  await act(async () => {
    await new Promise(r => setTimeout(r, 30));
  });
  await act(async () => {});
  return view;
}

describe("ytm search-result navigation (black-screen regression)", () => {
  it("search view renders rows and cards for every result type", async () => {
    const { useYtm } = await setupStore();
    const { YtmSearchView } = await import("../../src/renderer/features/ytmusic/YtmSearchView");
    const view = render(createElement(YtmSearchView, { query: "rick astley" }));
    await act(async () => {
      await useYtm.getState().performSearch("rick astley", "all");
    });
    await act(async () => {});
    expect(view.container.querySelectorAll("[data-testid=ytm-track-row]").length).toBe(2);
    const cardKeys = [...view.container.querySelectorAll("[data-testid=ytm-card]")].map(c => c.getAttribute("data-item-key"));
    expect(cardKeys).toContain("video:dQw4w9WgXcQ");
    expect(cardKeys).toContain("album:MPREb_album1");
    expect(cardKeys).toContain("artist:UCuAXFkgsw1L7xaCfnd5JJOw");
    expect(cardKeys).toContain("playlist:VLPLtest1");
  });

  it.each([
    ["YtmArtistView", { artistId: "UCuAXFkgsw1L7xaCfnd5JJOw" }, "ytm-artist-view", "Rick Astley"],
    ["YtmAlbumView", { albumId: "MPREb_album1" }, "ytm-album-view", "Whenever You Need Somebody"],
    ["YtmPlaylistView", { playlistId: "VLPLtest1" }, "ytm-playlist-view", "Rick Astley Mix"],
  ] as const)(
    "%s survives the loading -> ready transition and renders content (the original crash)",
    async (componentName, props, testId, expectedText) => {
      await setupStore();
      const mod = await import("../../src/renderer/features/ytmusic/YtmDetailViews");
      const Component = (mod as never as Record<string, ComponentType<Record<string, string>>>)[componentName];
      // Render while the page is still loading, then let the request resolve: the hook count
      // must not change across that transition.
      const view = await renderView(Component, props);
      const el = view.container.querySelector(`[data-testid=${testId}]`);
      expect(el, `expected ${testId}; html: ${view.container.innerHTML.slice(0, 300)}`).not.toBeNull();
      expect(el!.textContent).toContain(expectedText);
    }
  );

  it.each([
    ["YtmArtistView", { artistId: "UCx" }, "ytm-artist-error"],
    ["YtmAlbumView", { albumId: "MPREb_x" }, "ytm-album-error"],
    ["YtmPlaylistView", { playlistId: "VLx" }, "ytm-playlist-error"],
  ] as const)("%s shows an error state with Retry on a failed detail request (never black)", async (componentName, props, errorTestId) => {
    await setupStore({
      artist: vi.fn(async () => { throw new Error("HTTP 500"); }),
      album: vi.fn(async () => { throw new Error("HTTP 500"); }),
      playlist: vi.fn(async () => { throw new Error("HTTP 500"); }),
    });
    const mod = await import("../../src/renderer/features/ytmusic/YtmDetailViews");
    const Component = (mod as never as Record<string, ComponentType<Record<string, string>>>)[componentName];
    const view = await renderView(Component, props);
    const el = view.container.querySelector(`[data-testid=${errorTestId}]`);
    expect(el, `expected ${errorTestId}; html: ${view.container.innerHTML.slice(0, 300)}`).not.toBeNull();
    expect(el!.textContent).toContain("Retry");
  });

  it("missing/empty ids render a loading or error state, never a crash", async () => {
    await setupStore({
      artist: vi.fn(async () => { throw new Error("not found"); }),
    });
    const { YtmArtistView } = await import("../../src/renderer/features/ytmusic/YtmDetailViews");
    const view = await renderView(YtmArtistView, { artistId: "" });
    const hasState = view.container.querySelector("[data-testid=ytm-artist-loading], [data-testid=ytm-artist-error]");
    expect(hasState).not.toBeNull();
  });

  it("rapid repeated navigation between result types keeps rendering content", async () => {
    await setupStore();
    const mod = await import("../../src/renderer/features/ytmusic/YtmDetailViews");
    const { YtmArtistView, YtmAlbumView, YtmPlaylistView } = mod as never as Record<string, ComponentType<Record<string, string>>>;
    const sequence: [ComponentType<Record<string, string>>, Record<string, string>, string][] = [
      [YtmArtistView, { artistId: "UCuAXFkgsw1L7xaCfnd5JJOw" }, "ytm-artist-view"],
      [YtmAlbumView, { albumId: "MPREb_album1" }, "ytm-album-view"],
      [YtmPlaylistView, { playlistId: "VLPLtest1" }, "ytm-playlist-view"],
      [YtmAlbumView, { albumId: "MPREb_album1" }, "ytm-album-view"],
    ];
    for (const [Component, props, testId] of sequence) {
      const view = await renderView(Component, props);
      expect(view.container.querySelector(`[data-testid=${testId}]`), testId).not.toBeNull();
      cleanup();
    }
  });

  it("back navigation preserves the search query, results and category without a duplicate request", async () => {
    const { useYtm, useUi, fake } = await setupStore();
    const { YtmSearchView } = await import("../../src/renderer/features/ytmusic/YtmSearchView");
    const { YtmArtistView } = await import("../../src/renderer/features/ytmusic/YtmDetailViews");
    await act(async () => {
      await useYtm.getState().performSearch("rick astley", "songs");
    });
    const searchView = render(createElement(YtmSearchView, { query: "rick astley" }));
    await act(async () => {});
    expect(searchView.container.querySelectorAll("[data-testid=ytm-track-row]").length).toBe(2);
    const callsAfterSearch = fake.search.mock.calls.length;

    // Navigate into an artist detail and back to the same search query.
    const artistView = render(createElement(YtmArtistView, { artistId: "UCuAXFkgsw1L7xaCfnd5JJOw" }));
    await act(async () => {});
    expect(artistView.container.querySelector("[data-testid=ytm-artist-view]")).not.toBeNull();
    cleanup();
    useUi.getState().navigate({ name: "ytm-search", query: "rick astley" });
    const searchAgain = render(createElement(YtmSearchView, { query: "rick astley" }));
    await act(async () => {
      await new Promise(r => setTimeout(r, 30));
    });
    await act(async () => {});
    // Results are still there and no duplicate search was issued for the same query.
    expect(searchAgain.container.querySelectorAll("[data-testid=ytm-track-row]").length).toBe(2);
    expect(fake.search.mock.calls.length).toBe(callsAfterSearch);
    expect(useYtm.getState().searchState.query).toBe("rick astley");
    expect(useYtm.getState().searchState.filter).toBe("songs");
  });

  it("a failed playback attempt while viewing content does not unmount the page", async () => {
    await setupStore({
      resolveStream: vi.fn(async () => {
        throw new Error("blocked: signatureCipher-only stream (no deciphering)");
      }),
    });
    const { YtmAlbumView } = await import("../../src/renderer/features/ytmusic/YtmDetailViews");
    const { usePlayer } = await import("../../src/renderer/state/playerStore");
    const { mediaItemFromYtmTrack } = await import("../../src/shared/ytmusic");
    const view = await renderView(YtmAlbumView, { albumId: "MPREb_album1" });
    expect(view.container.querySelector("[data-testid=ytm-album-view]")).not.toBeNull();
    await act(async () => {
      await usePlayer.getState().playMediaItem(mediaItemFromYtmTrack(track("s1", "Never Gonna Give You Up")));
    });
    // The page is still rendered; the failure is surfaced as player state, not a black screen.
    expect(view.container.querySelector("[data-testid=ytm-album-view]")).not.toBeNull();
    expect(usePlayer.getState().remoteStatus ?? usePlayer.getState().error).toBeTruthy();
  });

  it("ViewErrorBoundary shows an error fallback with Retry/Back instead of a black screen", async () => {
    await setupStore();
    const { ViewErrorBoundary } = await import("../../src/renderer/app/ViewErrorBoundary");
    const Bomb = () => {
      throw new Error("boom in view");
    };
    const view = render(createElement(ViewErrorBoundary, {}, createElement(Bomb)));
    const el = view.container.querySelector("[data-testid=view-error]");
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("boom in view");
    expect(el!.textContent).toContain("Retry");
    expect(el!.textContent).toContain("Back");
  });
});
