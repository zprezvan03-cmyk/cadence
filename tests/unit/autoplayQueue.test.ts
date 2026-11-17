import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/audio/engine", () => ({
  audioEngine: {
    load: vi.fn().mockResolvedValue(true),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    seek: vi.fn(),
    prewarm: vi.fn(),
    preloadNext: vi.fn().mockResolvedValue(true),
    transitionTo: vi.fn().mockResolvedValue(true),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    setRate: vi.fn(),
    setTrackGain: vi.fn(),
    applyEqualizer: vi.fn(),
    paused: false,
    element: { src: "cadence-media:///music/1.flac", error: null },
  },
}));

import {
  appendAutoPlayEntries,
  appendManualEntriesBeforeAutoPlay,
  buildPartitionedUnshuffledOrder,
  insertManualEntriesNext,
  localQueueEntry,
} from "../../src/renderer/player/queue";
import { useHistory } from "../../src/renderer/state/historyStore";
import { useIntelligence } from "../../src/renderer/state/intelligenceStore";
import { useLibrary } from "../../src/renderer/state/libraryStore";
import { usePlayer } from "../../src/renderer/state/playerStore";
import { useSettings } from "../../src/renderer/state/settingsStore";
import { setTrackRegistry } from "../../src/renderer/state/trackRegistry";
import { audioEngine } from "../../src/renderer/audio/engine";
import { DEFAULT_SETTINGS } from "../../src/main/settingsCore";
import type { QueueEntry, Track } from "../../src/shared/types";

function makeTrack(overrides: Partial<Track> & { id: number; title: string; artist: string }): Track {
  return {
    id: overrides.id,
    path: overrides.path ?? `/music/${overrides.artist}/${overrides.title}.flac`,
    streamUrl: `cadence-media:///music/${overrides.id}.flac`,
    title: overrides.title,
    artist: overrides.artist,
    albumArtist: overrides.albumArtist ?? overrides.artist,
    album: overrides.album ?? "Album",
    genre: overrides.genre ?? "Indie Rock",
    year: overrides.year ?? 2022,
    trackNo: overrides.trackNo ?? 1,
    discNo: 1,
    duration: overrides.duration ?? 200,
    bitrate: 900_000,
    sampleRate: 44_100,
    channels: 2,
    codec: "FLAC",
    container: "FLAC",
    fileSize: 20_000_000,
    mtimeMs: 0,
    artworkUrl: null,
    animatedArtUrl: null,
    accentColor: null,
    hasEmbeddedLyrics: false,
    favorite: overrides.favorite ?? false,
    addedAt: overrides.addedAt ?? 1_700_000_000_000,
    lastPlayedAt: overrides.lastPlayedAt ?? null,
    playCount: overrides.playCount ?? 0,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    replayGainTrackPeak: null,
    replayGainAlbumPeak: null,
    hasSidecarLyrics: false,
    playable: true,
  };
}

describe("queue.ts — strict manual priority over AutoPlay and partition helpers", () => {
  it("enforces [Current] -> [Manual] -> [Context] -> [AutoPlay] across insertManualEntriesNext and appendManualEntriesBeforeAutoPlay", () => {
    const t0 = makeTrack({ id: 10, title: "Current Song", artist: "Artist A" });
    const t1 = makeTrack({ id: 11, title: "Context Song", artist: "Artist B" });
    const a1 = makeTrack({ id: 20, title: "AutoPlay 1", artist: "Artist C" });
    const a2 = makeTrack({ id: 21, title: "AutoPlay 2", artist: "Artist D" });
    const m1 = makeTrack({ id: 30, title: "Manual Add 1", artist: "Artist E" });
    const m2 = makeTrack({ id: 31, title: "Manual Add 2", artist: "Artist F" });
    const mNext = makeTrack({ id: 32, title: "Manual Play Next", artist: "Artist G" });

    let queue: QueueEntry[] = [
      localQueueEntry(t0.id, "occ-0", t0, "context"),
      localQueueEntry(t1.id, "occ-1", t1, "context"),
      localQueueEntry(a1.id, "occ-a1", a1, "autoplay"),
      localQueueEntry(a2.id, "occ-a2", a2, "autoplay"),
    ];
    let order = [0, 1, 2, 3];
    let orderPosition = 0;

    // 1. Add m1 and m2 to queue -> must go right after Current, ahead of Context and AutoPlay
    const afterAdd1 = appendManualEntriesBeforeAutoPlay(queue, order, orderPosition, [
      localQueueEntry(m1.id, "occ-m1", m1),
      localQueueEntry(m2.id, "occ-m2", m2),
    ]);
    queue = afterAdd1.queue;
    order = afterAdd1.order;
    orderPosition = afterAdd1.orderPosition;

    const orderedIds1 = order.map(idx =>
      queue[idx].item.source.kind === "local" ? queue[idx].item.source.trackId : -1
    );
    expect(orderedIds1).toEqual([10, 30, 31, 11, 20, 21]);

    // 2. Play Next mNext -> must go at the front of the Manual block (immediately after Current)
    const afterPlayNext = insertManualEntriesNext(queue, order, orderPosition, [
      localQueueEntry(mNext.id, "occ-mnext", mNext),
    ]);
    queue = afterPlayNext.queue;
    order = afterPlayNext.order;

    const orderedIds2 = order.map(idx =>
      queue[idx].item.source.kind === "local" ? queue[idx].item.source.trackId : -1
    );
    expect(orderedIds2).toEqual([10, 32, 30, 31, 11, 20, 21]);

    // 3. If user manually queues a track that was already in AutoPlay (id=21), it is promoted out of AutoPlay into Manual
    const afterPromote = appendManualEntriesBeforeAutoPlay(queue, order, orderPosition, [
      localQueueEntry(a2.id, "occ-a2-manual", a2),
    ]);
    const orderedIds3 = afterPromote.order.map(idx =>
      afterPromote.queue[idx].item.source.kind === "local"
        ? afterPromote.queue[idx].item.source.trackId
        : -1
    );
    expect(orderedIds3).toEqual([10, 32, 30, 31, 21, 11, 20]);
  });

  it("preserves manual priority ahead of context and AutoPlay at the tail when unshuffling", () => {
    const queue: QueueEntry[] = [
      localQueueEntry(1, "c-0", makeTrack({ id: 1, title: "C0", artist: "A" }), "context"),
      localQueueEntry(2, "c-1", makeTrack({ id: 2, title: "C1", artist: "A" }), "context"),
      localQueueEntry(3, "c-2", makeTrack({ id: 3, title: "C2", artist: "A" }), "context"),
      localQueueEntry(4, "m-1", makeTrack({ id: 4, title: "M1", artist: "B" }), "manual"),
      localQueueEntry(5, "a-1", makeTrack({ id: 5, title: "A1", artist: "C" }), "autoplay"),
    ];
    // Currently at queue[1] (orderPosition = 0), followed by manual [3], shuffled context [2, 0], autoplay [4]
    const shuffledOrder = [1, 3, 2, 0, 4];
    const unshuffled = buildPartitionedUnshuffledOrder(queue, shuffledOrder, 0);

    // queue[0] was before queue[1] in context, then current queue[1], then upcoming manual [3], then after context [2], then autoplay [4]
    expect(unshuffled.order).toEqual([0, 1, 3, 2, 4]);
    expect(unshuffled.orderPosition).toBe(1);
    expect(unshuffled.order[unshuffled.orderPosition]).toBe(1);
  });

  it("appendAutoPlayEntries deduplicates against existing queue tracks and appends at the tail", () => {
    const t1 = makeTrack({ id: 1, title: "T1", artist: "A" });
    const t2 = makeTrack({ id: 2, title: "T2", artist: "B" });
    const t3 = makeTrack({ id: 3, title: "T3", artist: "C" });

    const queue = [localQueueEntry(1, "occ-1", t1, "context")];
    const order = [0];

    const res = appendAutoPlayEntries(queue, order, [
      localQueueEntry(1, "dup-1", t1, "autoplay"),
      localQueueEntry(2, "auto-2", t2, "autoplay"),
      localQueueEntry(3, "auto-3", t3, "autoplay"),
    ]);

    expect(res.addedCount).toBe(2);
    expect(res.queue).toHaveLength(3);
    expect(res.order).toEqual([0, 1, 2]);
    expect(res.queue[1].origin).toBe("autoplay");
    expect(res.queue[2].origin).toBe("autoplay");
  });
});

describe("playerStore — AutoPlay replenishment, manual queue priority, and telemetry integration", () => {
  const libraryTracks = [
    makeTrack({ id: 1, title: "Seed Indie 1", artist: "Alvvays", genre: "Indie Rock; Shoegaze", duration: 200 }),
    makeTrack({ id: 2, title: "Indie Match 2", artist: "Slowdive", genre: "Shoegaze; Dream Pop", duration: 220 }),
    makeTrack({ id: 3, title: "Indie Match 3", artist: "Beach House", genre: "Dream Pop; Indie", duration: 240 }),
    makeTrack({ id: 4, title: "Indie Match 4", artist: "Lush", genre: "Shoegaze; Indie Rock", duration: 210 }),
    makeTrack({ id: 5, title: "Manual Choice", artist: "Daft Punk", genre: "Electronic", duration: 250 }),
    makeTrack({ id: 6, title: "Play Next Choice", artist: "Justice", genre: "Electronic", duration: 230 }),
  ];

  beforeEach(() => {
    setTrackRegistry(new Map(libraryTracks.map(t => [t.id, t])));
    useLibrary.setState({
      snapshot: {
        tracks: libraryTracks,
        folders: ["/music"],
        playlists: [],
        scan: { running: false, phase: "done", filesSeen: 6, filesIndexed: 6, currentFile: null, startedAt: 0, finishedAt: 0, errors: [] },
      },
      tracksById: new Map(libraryTracks.map(t => [t.id, t])),
      recordPlay: vi.fn().mockResolvedValue(undefined),
    } as never);
    useHistory.setState({
      entries: [],
      add: vi.fn().mockResolvedValue(undefined),
    } as never);
    useIntelligence.getState().resetForTests();
    useSettings.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        playback: {
          ...structuredClone(DEFAULT_SETTINGS.playback),
          autoPlay: true,
          shuffleMode: "smart",
          smartShufflePopularity: false, // disable background network fetch during unit test
        },
      },
      loaded: true,
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    usePlayer.getState().clearQueue();
    setTrackRegistry(new Map());
  });

  it("auto-replenishes AutoPlay tracks when playing a 1-track queue with repeat='off' and prioritizes subsequent manual additions ahead of AutoPlay", async () => {
    await usePlayer.getState().playQueue([1], 0);

    const stateAfterStart = usePlayer.getState();
    // AutoPlay should have appended tracks from the library after track 1
    expect(stateAfterStart.order.length).toBeGreaterThan(1);
    const initialUpcoming = stateAfterStart.order
      .slice(1)
      .map(idx => stateAfterStart.queue[idx]);
    expect(initialUpcoming.every(e => e.origin === "autoplay")).toBe(true);

    // Now user calls addToQueue([5]) and playNext([6])
    usePlayer.getState().addToQueue([5]);
    usePlayer.getState().playNext([6]);

    const stateAfterManual = usePlayer.getState();
    const orderedEntries = stateAfterManual.order.map(idx => stateAfterManual.queue[idx]);
    const orderedIds = orderedEntries.map(e =>
      e.item.source.kind === "local" ? e.item.source.trackId : -1
    );

    // Current is 1, followed immediately by Play Next (6) and Add to Queue (5), and all AutoPlay entries come AFTER 6 and 5!
    expect(orderedIds[0]).toBe(1);
    expect(orderedIds[1]).toBe(6);
    expect(orderedIds[2]).toBe(5);
    expect(orderedEntries[1].origin).toBe("manual");
    expect(orderedEntries[2].origin).toBe("manual");
    for (let i = 3; i < orderedEntries.length; i++) {
      expect(orderedEntries[i].origin).toBe("autoplay");
    }

    // Toggling shuffle ON and OFF keeps manual entries 6 and 5 strictly ahead of AutoPlay entries
    usePlayer.getState().toggleShuffle();
    const shuffledState = usePlayer.getState();
    const shuffledIds = shuffledState.order.map(idx => {
      const s = shuffledState.queue[idx].item.source;
      return s.kind === "local" ? s.trackId : -1;
    });
    expect(shuffledIds.slice(0, 3)).toEqual([1, 6, 5]);
  });

  it("records session-safe skip and completion telemetry into useIntelligence during playback", async () => {
    await usePlayer.getState().playQueue([1, 2], 0);
    usePlayer.setState({ isPlaying: true, duration: 200 });

    // Listen to Track 1 for 18 seconds -> deliberate skip (12s..45s window) when user clicks Next
    for (let sec = 1; sec <= 18; sec++) {
      usePlayer.getState().syncTime(sec, 200, 200);
    }
    await usePlayer.getState().next(false);

    const intelMap = useIntelligence.getState().byRecordingKey;
    const track1Record = [...intelMap.values()].find(r => r.trackId === 1);
    expect(track1Record).toBeDefined();
    expect(track1Record?.skipCount).toBe(1);
    expect(track1Record?.completeCount).toBe(0);
  });
});
