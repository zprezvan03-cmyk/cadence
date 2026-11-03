/**
 * Search state management regression tests for the YouTube Music store: one query retains all its
 * results, new queries replace old ones, pagination appends (deduplicated by stable id), stale /
 * out-of-order responses never overwrite newer state, and failed pagination preserves results.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/state/settingsStore", () => ({
  useSettings: {
    getState: () => ({
      settings: { youtubeMusic: { visitorData: "CgtX", gl: "US", hl: "en", accountName: null } },
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

interface FakeTrack {
  kind: "song";
  videoId: string;
  title: string;
  artists: { name: string; browseId: string }[];
  album: null;
  durationSeconds: number;
  durationText: string;
  artworkUrl: null;
  explicit: boolean;
  viewCountText: null;
  playlistId: null;
  setVideoId: null;
}

function track(id: string): FakeTrack {
  return {
    kind: "song",
    videoId: id,
    title: `Song ${id}`,
    artists: [{ name: "Artist", browseId: "UC1" }],
    album: null,
    durationSeconds: 200,
    durationText: "3:20",
    artworkUrl: null,
    explicit: false,
    viewCountText: null,
    playlistId: null,
    setVideoId: null,
  };
}

function results(ids: string[], continuation: string | null = null) {
  return {
    filter: "all" as const,
    topResult: null,
    items: ids.map(id => ({ type: "song" as const, track: track(id) })),
    continuation,
  };
}

async function setup(searchImpl: (query: string, filter: string, cont?: string | null) => Promise<ReturnType<typeof results>>) {
  vi.resetModules();
  vi.stubGlobal("localStorage", new MemoryStorage());
  const { setYouTubeMusicProvider } = await import("../../src/main/ytmusic/provider");
  const fake = { setSession: () => {}, search: vi.fn(searchImpl) };
  setYouTubeMusicProvider(fake as never);
  const { useYtm } = await import("../../src/renderer/state/ytmusicStore");
  return { useYtm, fake };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ytm search store state management", () => {
  it("one query retains all its results", async () => {
    const { useYtm } = await setup(async () => results(["a", "b", "c", "d", "e"], "TOK"));
    await useYtm.getState().performSearch("yoasobi", "all");
    const state = useYtm.getState().searchState;
    expect(state.status).toBe("ready");
    expect(state.data?.items.map(i => (i as { type: string; track: FakeTrack }).track.videoId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(state.continuation).toBe("TOK");
  });

  it("a new query replaces the previous query's results", async () => {
    const { useYtm } = await setup(async query =>
      query === "first" ? results(["a", "b"]) : results(["x"])
    );
    await useYtm.getState().performSearch("first", "all");
    await useYtm.getState().performSearch("second", "all");
    const state = useYtm.getState().searchState;
    expect(state.query).toBe("second");
    expect(state.data?.items.map(i => (i as { type: string; track: FakeTrack }).track.videoId)).toEqual(["x"]);
  });

  it("out-of-order responses from an older query never overwrite the newer query", async () => {
    let resolveFirst: (value: ReturnType<typeof results>) => void = () => {};
    const { useYtm, fake } = await setup(async query => {
      if (query === "slow") {
        return new Promise<ReturnType<typeof results>>(resolve => {
          resolveFirst = resolve;
        });
      }
      return results(["new1", "new2"]);
    });
    const slowPromise = useYtm.getState().performSearch("slow", "all");
    await useYtm.getState().performSearch("fast", "all");
    expect(useYtm.getState().searchState.data?.items.length).toBe(2);
    // The slow response arrives last — it must be dropped.
    resolveFirst(results(["stale1"]));
    await slowPromise;
    const state = useYtm.getState().searchState;
    expect(state.query).toBe("fast");
    expect(state.data?.items.map(i => (i as { type: string; track: FakeTrack }).track.videoId)).toEqual(["new1", "new2"]);
    expect(fake.search).toHaveBeenCalledTimes(2);
  });

  it("load-more appends the next page and deduplicates overlapping ids", async () => {
    const pages: Record<string, ReturnType<typeof results>> = {
      page1: results(["a", "b", "c"], "TOK2"),
      page2: results(["c", "d", "e"], null), // "c" overlaps the first page
    };
    const { useYtm } = await setup(async (_q, _f, cont) => (cont ? pages.page2 : pages.page1));
    await useYtm.getState().performSearch("q", "all");
    expect(useYtm.getState().searchState.data?.items.length).toBe(3);
    await useYtm.getState().loadMoreSearch();
    const state = useYtm.getState().searchState;
    expect(state.data?.items.map(i => (i as { type: string; track: FakeTrack }).track.videoId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(state.continuation).toBeNull();
  });

  it("loading-more does not clear existing results and failed pagination preserves them", async () => {
    const { useYtm } = await setup(async (_q, _f, cont) => {
      if (cont) throw new Error("continuation exploded");
      return results(["a", "b"], "TOK");
    });
    await useYtm.getState().performSearch("q", "all");
    await useYtm.getState().loadMoreSearch();
    const state = useYtm.getState().searchState;
    expect(state.status).toBe("ready");
    expect(state.data?.items.length).toBe(2); // results preserved
    expect(state.error).toContain("continuation exploded");
    expect(state.loadingMore).toBe(false);
  });

  it("provider errors surface without wiping previous state shape", async () => {
    const { useYtm } = await setup(async () => {
      throw new Error("boom");
    });
    await useYtm.getState().performSearch("q", "all");
    const state = useYtm.getState().searchState;
    expect(state.status).toBe("error");
    expect(state.error).toContain("boom");
  });

  it("empty and single-result responses are stored as-is (no invented results)", async () => {
    const { useYtm } = await setup(async query =>
      query === "empty" ? results([]) : results(["only"])
    );
    await useYtm.getState().performSearch("empty", "all");
    expect(useYtm.getState().searchState.data?.items).toEqual([]);
    await useYtm.getState().performSearch("single", "all");
    expect(useYtm.getState().searchState.data?.items.length).toBe(1);
  });
});
