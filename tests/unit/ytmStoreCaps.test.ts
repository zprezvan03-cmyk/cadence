/**
 * Regression tests for the Stage 7 performance audit: per-detail page maps in the YTM store are
 * bounded (oldest evicted beyond 8 entries) and suggestion responses from a stale input are
 * dropped. The InnerTube provider is stubbed — no test reaches the network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

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

const artistPage = (id: string) => ({
  artist: { browseId: id, title: `Artist ${id}`, ...({} as object) },
  sections: [],
  continuation: null,
});

async function setup(providerOverrides: Record<string, unknown>) {
  vi.resetModules();
  vi.stubGlobal("localStorage", new MemoryStorage());
  const { setYouTubeMusicProvider } = await import("../../src/main/ytmusic/provider");
  const fake = {
    setSession: () => {},
    artist: vi.fn(async (id: string) => artistPage(id)),
    suggestions: vi.fn(async (input: string) => ({ queries: [input], items: [] })),
    ...providerOverrides,
  };
  setYouTubeMusicProvider(fake as never);
  const { useYtm } = await import("../../src/renderer/state/ytmusicStore");
  return { useYtm, fake };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ytm store bounded caches", () => {
  it("caps artistPages at 8 entries and evicts the oldest visited artist", async () => {
    const { useYtm } = await setup({});
    for (let i = 0; i < 10; i += 1) {
      await useYtm.getState().loadArtist(`UC${i}`);
    }
    const keys = Object.keys(useYtm.getState().artistPages);
    expect(keys.length).toBeLessThanOrEqual(8);
    expect(keys).not.toContain("UC0");
    expect(keys).not.toContain("UC1");
    expect(keys[keys.length - 1]).toBe("UC9");
    // The currently viewed artist is never evicted.
    await useYtm.getState().loadArtist("UC9");
    expect(Object.keys(useYtm.getState().artistPages)).toContain("UC9");
  });

  it("drops a stale suggestion response when the input has moved on", async () => {
    let resolveFirst!: (value: unknown) => void;
    const suggestions = vi.fn((input: string) => {
      if (input === "yoa") return new Promise(resolve => (resolveFirst = resolve));
      return Promise.resolve({ queries: [input], items: [] });
    });
    const { useYtm } = await setup({ suggestions });

    const slow = useYtm.getState().fetchSuggestions("yoa");
    await useYtm.getState().fetchSuggestions("yoas");
    expect(useYtm.getState().suggestions.items.queries).toEqual(["yoas"]);
    expect(useYtm.getState().suggestions.status).toBe("ready");

    // The slower, older response arrives last and must be dropped.
    resolveFirst({ queries: ["yoa"], items: [] });
    await slow;
    expect(useYtm.getState().suggestions.items.queries).toEqual(["yoas"]);
  });
});
