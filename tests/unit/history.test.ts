import { afterEach, describe, expect, it } from "vitest";
import { useHistory } from "../../src/renderer/state/historyStore";
import type { HistoryEntry } from "../../src/shared/types";

const track = (overrides: Partial<{ id: number; title: string; artist: string; album: string }> = {}): import("../../src/shared/types").Track => ({
  id: overrides.id ?? 42,
  path: `/music/${overrides.title ?? "song"}.mp3`,
  streamUrl: `cadence-media:///music/${overrides.title ?? "song"}.mp3`,
  title: overrides.title ?? "Song",
  artist: overrides.artist ?? "Artist",
  albumArtist: overrides.artist ?? "Artist",
  album: overrides.album ?? "Album",
  genre: "",
  year: 2024,
  trackNo: 1,
  discNo: null,
  duration: 210,
  bitrate: null,
  sampleRate: null,
  channels: null,
  codec: "MP3",
  container: "mp3",
  fileSize: 1234,
  mtimeMs: 0,
  artworkUrl: null,
  animatedArtUrl: null,
  accentColor: null,
  hasEmbeddedLyrics: false,
  favorite: false,
  addedAt: 0,
  lastPlayedAt: null,
  playCount: 0,
  hasSidecarLyrics: false,
  playable: true,
});

function installBridge(seed: Array<{ trackId: number; playedAt: number; payload: unknown }> = []): void {
  const entries: Array<{
    id: number;
    trackId: number;
    playedAt: number;
    payload: unknown;
  }> = seed.map((row, index) => ({ id: index + 1, playedAt: row.playedAt, trackId: row.trackId, payload: row.payload }));
  (globalThis as { window?: { cadence?: unknown } }).window = {
    cadence: {
      history: {
        add: async (args: { trackId: number; playedAt: number; payload: string }) => {
          entries.push({
            id: entries.length + 1,
            trackId: args.trackId,
            playedAt: args.playedAt,
            payload: JSON.parse(args.payload),
          });
        },
        list: async () =>
          [...entries].sort((a, b) => b.playedAt - a.playedAt || b.id - a.id),
        clear: async () => {
          entries.length = 0;
        },
      },
    } as unknown,
  };
}

afterEach(() => {
  useHistory.setState({ entries: [], loading: false, error: null, loaded: false });
  (globalThis as { window?: unknown }).window = undefined;
});

describe("history store", () => {
  it("loads entries newest first from the bridge", async () => {
    const now = Date.now();
    installBridge([
      { trackId: 1, playedAt: now - 2000, payload: { title: "Older" } },
      { trackId: 2, playedAt: now, payload: { title: "Newer" } },
    ]);
    await useHistory.getState().load();
    expect(useHistory.getState().entries.map(entry => entry.payload.title)).toEqual([
      "Newer",
      "Older",
    ]);
    expect(useHistory.getState().loading).toBe(false);
  });

  it("adds a played track and persists it through the bridge", async () => {
    installBridge();
    await useHistory.getState().add(track({ id: 7, title: "New track" }));
    const state = useHistory.getState();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].trackId).toBe(7);
    expect(state.entries[0].payload.title).toBe("New track");
    expect(state.entries[0].playedAt).toBeGreaterThan(0);
  });

  it("keeps optimistic entries until a reload merges with the server", async () => {
    const now = Date.now();
    installBridge([{ trackId: 1, playedAt: now - 1000, payload: { title: "Older" } }]);
    await useHistory.getState().load();
    await useHistory.getState().add(track({ id: 9, title: "Now playing" }));
    expect(useHistory.getState().entries.map(entry => entry.payload.title)).toEqual([
      "Now playing",
      "Older",
    ]);
  });

  it("clears history locally and through the bridge", async () => {
    installBridge([{ trackId: 1, playedAt: Date.now(), payload: { title: "Any" } }]);
    await useHistory.getState().load();
    expect(useHistory.getState().entries).toHaveLength(1);
    await useHistory.getState().clear();
    expect(useHistory.getState().entries).toHaveLength(0);
  });

  it("restores history from persisted storage across a simulated restart", async () => {
    const now = Date.now();
    // First "session": load persisted entries into the store.
    installBridge([
      { trackId: 1, playedAt: now - 2000, payload: { title: "Track A" } },
      { trackId: 2, playedAt: now - 1000, payload: { title: "Track B" } },
    ]);
    await useHistory.getState().load();
    expect(useHistory.getState().entries.map(e => e.payload.title)).toEqual([
      "Track B",
      "Track A",
    ]);
    expect(useHistory.getState().loaded).toBe(true);

    // Simulate app restart: store state resets, but the bridge (SQLite) still has the data.
    useHistory.setState({ entries: [], loading: false, error: null, loaded: false });
    installBridge([
      { trackId: 1, playedAt: now - 2000, payload: { title: "Track A" } },
      { trackId: 2, playedAt: now - 1000, payload: { title: "Track B" } },
    ]);

    // Second "session": load should restore from the bridge.
    await useHistory.getState().load();
    expect(useHistory.getState().entries.map(e => e.payload.title)).toEqual([
      "Track B",
      "Track A",
    ]);
    expect(useHistory.getState().loaded).toBe(true);
  });

  it("plays the same track twice without collapsing sessions", async () => {
    installBridge();
    await useHistory.getState().add(track({ id: 3, title: "Repeated" }));
    await useHistory.getState().add(track({ id: 3, title: "Repeated" }));
    expect(useHistory.getState().entries).toHaveLength(2);
  });

  it("does not crash when the bridge is missing", async () => {
    // No window.cadence installed.
    await expect(useHistory.getState().load()).resolves.toBeUndefined();
    expect(useHistory.getState().entries).toHaveLength(0);
    await expect(useHistory.getState().add(track())).resolves.toBeUndefined();
    expect(useHistory.getState().entries).toHaveLength(1);
    await expect(useHistory.getState().clear()).resolves.toBeUndefined();
    expect(useHistory.getState().entries).toHaveLength(0);
    expect(useHistory.getState().error).toBeNull();
  });
});
