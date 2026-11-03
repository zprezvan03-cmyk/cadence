import { describe, expect, it } from "vitest";
import {
  computeListeningStats,
  onRepeatTracks,
  rediscoverTracks,
  topLibraryTracks,
} from "../../src/renderer/features/stats/listeningStats";
import type { HistoryEntry, Track } from "../../src/shared/types";

const at = (dayOffset: number, hour = 12, minute = 0): number =>
  new Date(2026, 0, 15 + dayOffset, hour, minute).getTime();
const now = at(0);

function makeTrack(overrides: Partial<Track> = {}): Track {
  const id = overrides.id ?? 1;
  return {
    id,
    path: `/music/${id}.mp3`,
    streamUrl: `cadence-media:///music/${id}.mp3`,
    title: `Track ${id}`,
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album",
    genre: "",
    year: 2024,
    trackNo: 1,
    discNo: null,
    duration: 120,
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
    ...overrides,
  };
}

let nextEntryId = 1;

function makeEntry(track: Track, playedAt: number): HistoryEntry {
  return {
    id: nextEntryId++,
    source: { kind: "local", trackId: track.id },
    playedAt,
    payload: {
      source: { kind: "local", trackId: track.id },
      trackId: track.id,
      path: track.path,
      title: track.title,
      artist: track.artist,
      albumArtist: track.albumArtist,
      album: track.album,
      artworkUrl: track.artworkUrl,
      duration: track.duration,
    },
  };
}

describe("computeListeningStats", () => {
  it("aggregates rankings, genres, buckets, and streaks from history", () => {
    const alpha = makeTrack({
      id: 1,
      title: "Alpha",
      artist: "Artist One",
      albumArtist: "Artist One",
      album: "First",
      genre: "Rock; Indie",
      duration: 100,
      playCount: 9,
      lastPlayedAt: at(-1),
    });
    const Bravo = makeTrack({
      id: 2,
      title: "Bravo",
      artist: "Artist One",
      albumArtist: "Artist One",
      album: "First",
      genre: "Rock",
      duration: 200,
      playCount: 1,
      lastPlayedAt: at(-1),
    });
    const Charlie = makeTrack({
      id: 3,
      title: "Charlie",
      artist: "Artist Two",
      albumArtist: "Artist Two",
      album: "Second",
      genre: "Jazz",
      duration: 300,
      playCount: 4,
      lastPlayedAt: at(-8),
    });
    const removed = makeTrack({
      id: 99,
      title: "Gone",
      artist: "Vanished",
      albumArtist: "Vanished",
      album: "Lost",
      duration: 50,
    });

    const stats = computeListeningStats(
      [
        makeEntry(Charlie, at(-8, 11)),
        makeEntry(alpha, at(-2, 9)),
        makeEntry(removed, at(-3, 23)),
        makeEntry(alpha, Number.NaN),
        makeEntry(Bravo, at(-1, 10)),
        makeEntry(alpha, at(0, 9)),
        makeEntry(alpha, at(-1, 9)),
      ],
      [alpha, Bravo, Charlie],
      { now, topLimit: 10, days: 5 },
    );

    expect(stats.historyPlayCount).toBe(6);
    expect(stats.libraryPlayCount).toBe(14);
    expect(stats.startedTrackSeconds).toBe(850);
    expect(stats.uniqueTrackCount).toBe(4);
    expect(stats.uniqueArtistCount).toBe(3);
    expect(stats.playsLast7Days).toBe(5);
    expect(stats.playsLast30Days).toBe(6);
    expect(stats.currentStreakDays).toBe(4);

    expect(stats.topTracks.map(track => [track.title, track.playCount])).toEqual([
      ["Alpha", 3],
      ["Bravo", 1],
      ["Gone", 1],
      ["Charlie", 1],
    ]);
    expect(stats.topTracks[2].track).toBeNull();
    expect(stats.topArtists.map(artist => [artist.artist, artist.playCount, artist.uniqueTrackCount])).toEqual([
      ["Artist One", 4, 2],
      ["Vanished", 1, 1],
      ["Artist Two", 1, 1],
    ]);
    expect(stats.topAlbums.map(album => [album.album, album.playCount, album.uniqueTrackCount])).toEqual([
      ["First", 4, 2],
      ["Lost", 1, 1],
      ["Second", 1, 1],
    ]);
    expect(stats.genres).toEqual([
      { genre: "Rock", playCount: 4 },
      { genre: "Indie", playCount: 3 },
      { genre: "Jazz", playCount: 1 },
      { genre: "Unknown genre", playCount: 1 },
    ]);
    expect(stats.playsByDay.map(day => day.count)).toEqual([0, 1, 1, 2, 1]);
    expect(stats.playsByDay.at(-1)?.dateKey).toBe("2026-01-15");
    expect(stats.playsByHour[9]).toBe(3);
    expect(stats.playsByHour[10]).toBe(1);
    expect(stats.playsByHour[11]).toBe(1);
    expect(stats.playsByHour[23]).toBe(1);
  });

  it("counts a streak ending yesterday but not one separated by a missing day", () => {
    const track = makeTrack();
    const endingYesterday = computeListeningStats(
      [makeEntry(track, at(-1)), makeEntry(track, at(-2)), makeEntry(track, at(-4))],
      [track],
      { now },
    );
    const stale = computeListeningStats([makeEntry(track, at(-2)), makeEntry(track, at(-3))], [track], {
      now,
    });

    expect(endingYesterday.currentStreakDays).toBe(2);
    expect(stale.currentStreakDays).toBe(0);
  });

  it("zero-fills requested local day buckets when history is empty", () => {
    const stats = computeListeningStats([], [], { now, days: 3 });

    expect(stats.playsByDay.map(day => [day.dateKey, day.count])).toEqual([
      ["2026-01-13", 0],
      ["2026-01-14", 0],
      ["2026-01-15", 0],
    ]);
    expect(stats.topTracks).toEqual([]);
    expect(stats.currentStreakDays).toBe(0);
  });
});

describe("discovery shelves", () => {
  const evergreen = makeTrack({
    id: 1,
    title: "Evergreen",
    playCount: 20,
    lastPlayedAt: at(-40),
  });
  const looped = makeTrack({ id: 2, title: "Looped", playCount: 0, lastPlayedAt: null });
  const recent = makeTrack({ id: 3, title: "Recent", playCount: 8, lastPlayedAt: at(-1) });
  const forgotten = makeTrack({ id: 4, title: "Forgotten", playCount: 0, lastPlayedAt: null });
  const unplayed = makeTrack({ id: 5, title: "Unplayed", playCount: 0, lastPlayedAt: null });
  const tracks = [evergreen, looped, recent, forgotten, unplayed];
  const entries = [
    makeEntry(looped, at(0)),
    makeEntry(looped, at(-1)),
    makeEntry(looped, at(-2)),
    makeEntry(looped, Number.NaN),
    makeEntry(evergreen, at(-40)),
    makeEntry(forgotten, at(-50)),
  ];

  it("uses the larger of the all-time library counter and retained history for top tracks", () => {
    expect(topLibraryTracks(tracks, entries, { now }).map(item => [item.track.title, item.playCount])).toEqual([
      ["Evergreen", 20],
      ["Recent", 8],
      ["Looped", 3],
      ["Forgotten", 1],
    ]);
  });

  it("finds tracks repeated inside the recent window", () => {
    expect(onRepeatTracks(tracks, entries, { now })).toEqual([
      expect.objectContaining({
        track: looped,
        playCount: 3,
        recentPlayCount: 3,
        lastPlayedAt: at(0),
      }),
    ]);
  });

  it("surfaces previously played tracks that have gone quiet, oldest first", () => {
    expect(rediscoverTracks(tracks, entries, { now }).map(item => item.track.title)).toEqual([
      "Forgotten",
      "Evergreen",
    ]);
  });
});
