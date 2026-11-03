import { afterEach, describe, expect, it } from "vitest";
import { useHistory } from "../../src/renderer/state/historyStore";
import type { HistoryEntry, HistoryPayload, MediaItem, TrackSource } from "../../src/shared/types";

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
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  replayGainTrackPeak: null,
  replayGainAlbumPeak: null,
  hasSidecarLyrics: false,
  playable: true,
});

function localSeedPayload(trackId: number, payload: unknown): HistoryPayload {
  const title =
    payload && typeof payload === "object" && "title" in payload
      ? String((payload as { title?: unknown }).title ?? "Song")
      : "Song";
  return {
    source: { kind: "local", trackId },
    trackId,
    path: `/music/${title}.mp3`,
    title,
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album",
    artworkUrl: null,
    duration: 210,
  };
}

function installBridge(seed: Array<{ trackId: number; playedAt: number; payload: unknown }> = []): void {
  const entries: HistoryEntry[] = seed.map((row, index) => ({
    id: index + 1,
    source: { kind: "local", trackId: row.trackId },
    playedAt: row.playedAt,
    payload: localSeedPayload(row.trackId, row.payload),
  }));
  (globalThis as { window?: { cadence?: unknown } }).window = {
    cadence: {
      history: {
        add: async (args: { source: TrackSource; playedAt: number; payload: HistoryPayload }) => {
          entries.push({
            id: entries.length + 1,
            source: args.source,
            playedAt: args.playedAt,
            payload: args.payload,
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
    expect(state.entries[0].source).toEqual({ kind: "local", trackId: 7 });
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

  it("adds an observed remote play without inventing a local track ID", async () => {
    installBridge();
    const remoteItem: MediaItem = {
      source: {
        kind: "youtube",
        remoteId: "remoteVideo1",
        canonicalUrl: "https://www.youtube.com/watch?v=remoteVideo1",
      },
      title: "Remote song",
      artistLabel: "Remote artist",
      channelId: "UCremote",
      channelTitle: "Remote artist",
      albumLabel: null,
      durationSeconds: 181,
      artworkUrl: null,
      publishedAt: null,
      availability: "unknown",
      fetchedAt: 0,
    };
    await useHistory.getState().addRemote(remoteItem);
    const entry = useHistory.getState().entries[0];
    expect(entry.source).toEqual({
      kind: "youtube",
      remoteId: "remoteVideo1",
      canonicalUrl: "https://www.youtube.com/watch?v=remoteVideo1",
    });
    expect(entry.payload).toMatchObject({
      title: "Remote song",
      artist: "Remote artist",
      channelId: "UCremote",
      playbackMechanism: "remote-provider",
    });
    expect(entry.payload).not.toHaveProperty("trackId");
    expect(entry.payload).not.toHaveProperty("path");
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
