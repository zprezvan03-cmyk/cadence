import { describe, expect, it } from "vitest";
import {
  LibraryStoreCore,
  type LibraryPersistenceAdapter,
  type NewTrack,
  type StoredTrack,
} from "../../src/main/library/storeCore";
import {
  evaluateSmartPlaylist,
  normalizeSmartPlaylistRule,
} from "../../src/shared/smartPlaylists";
import {
  duplicateKeeperScore,
  findDuplicateGroups,
  formatFileSize,
  normalizeDuplicateText,
} from "../../src/renderer/features/library/duplicates";
import type { Track } from "../../src/shared/types";

const persistence: LibraryPersistenceAdapter = { engine: "json", writeThrough: true };
const mediaUrl = (path: string, isArtwork?: boolean) => `media://${isArtwork ? "art" : "file"}${path}`;

function newTrack(overrides: Partial<NewTrack> = {}): NewTrack {
  return {
    path: "/music/track.flac",
    title: "Track",
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album",
    genre: "",
    year: 2024,
    trackNo: 1,
    discNo: null,
    duration: 200,
    bitrate: null,
    sampleRate: 44100,
    channels: 2,
    codec: "FLAC",
    container: "flac",
    fileSize: 20_000_000,
    mtimeMs: 0,
    artworkFile: null,
    animatedArtPath: null,
    accentColor: null,
    hasEmbeddedLyrics: false,
    hasSidecarLyrics: false,
    playable: true,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    replayGainTrackPeak: null,
    replayGainAlbumPeak: null,
    metadataOverride: null,
    ...overrides,
  };
}

function storedTrack(overrides: Partial<StoredTrack> = {}): StoredTrack {
  return {
    ...newTrack(),
    id: 1,
    favorite: false,
    addedAt: 0,
    lastPlayedAt: null,
    playCount: 0,
    ...overrides,
  };
}

function makeStore(tracks: StoredTrack[] = []): LibraryStoreCore {
  return new LibraryStoreCore("/artwork", mediaUrl, persistence, { tracks });
}

function rendererTrack(overrides: Partial<Track> = {}): Track {
  const id = overrides.id ?? 1;
  return {
    id,
    path: `/music/${id}.flac`,
    streamUrl: `media:///music/${id}.flac`,
    title: "Song",
    artist: "The Artist",
    albumArtist: "The Artist",
    album: "Album",
    genre: "Rock",
    year: 2024,
    trackNo: 1,
    discNo: null,
    duration: 200,
    bitrate: null,
    sampleRate: 44100,
    channels: 2,
    codec: "FLAC",
    container: "flac",
    fileSize: 20_000_000,
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

describe("metadata overrides", () => {
  it("survives a rescan, refreshes the scanned baseline, and resets cleanly", () => {
    const store = makeStore();
    const { id } = store.upsertTrack(
      newTrack({
        path: "/music/a.flac",
        title: "Old Title",
        artist: "Old Artist",
        albumArtist: "Old Artist",
        album: "Old Album",
        genre: "Rock",
        year: 2000,
        trackNo: 1,
        artworkFile: "old-cover.png",
      }),
    );

    expect(store.setTrackMetadata(id, { title: "  Edited Title  ", artist: "Edited Artist", year: 2024 })).toBe(true);
    expect(store.setTrackArtwork(id, "custom-cover.png")).toBe(true);
    let track = store.getTrack(id)!;
    expect(track.title).toBe("Edited Title");
    expect(track.artist).toBe("Edited Artist");
    expect(track.album).toBe("Old Album");
    expect(track.year).toBe(2024);
    expect(track.artworkFile).toBe("custom-cover.png");
    expect(store.toTrack(track).metadataEdited).toBe(true);
    expect(track.metadataOverride?.original.title).toBe("Old Title");

    // A rescan finds new file tags: unedited fields follow the file, edited fields stay.
    store.upsertTrack(
      newTrack({
        path: "/music/a.flac",
        title: "New File Title",
        artist: "Old Artist",
        albumArtist: "Old Artist",
        album: "New File Album",
        genre: "Jazz",
        year: 2001,
        trackNo: 2,
        artworkFile: "new-file-cover.png",
      }),
    );
    track = store.getTrack(id)!;
    expect(track.title).toBe("Edited Title");
    expect(track.artist).toBe("Edited Artist");
    expect(track.album).toBe("New File Album");
    expect(track.genre).toBe("Jazz");
    expect(track.year).toBe(2024);
    expect(track.trackNo).toBe(2);
    expect(track.artworkFile).toBe("custom-cover.png");
    expect(track.metadataOverride?.original).toMatchObject({
      title: "New File Title",
      album: "New File Album",
      artworkFile: "new-file-cover.png",
    });

    expect(store.resetTrackArtwork(id)).toBe(true);
    expect(store.getTrack(id)?.artworkFile).toBe("new-file-cover.png");
    expect(store.removeTrackArtwork(id)).toBe(true);
    expect(store.getTrack(id)?.artworkFile).toBeNull();

    expect(store.clearTrackMetadata(id)).toBe(true);
    track = store.getTrack(id)!;
    expect(track).toMatchObject({
      title: "New File Title",
      artist: "Old Artist",
      year: 2001,
      artworkFile: "new-file-cover.png",
      metadataOverride: null,
    });
    expect(store.toTrack(track).metadataEdited).toBe(false);

    // Editing a field back to its scanned value leaves no override behind.
    expect(store.setTrackMetadata(id, { title: "New File Title" })).toBe(true);
    expect(store.getTrack(id)?.metadataOverride).toBeNull();
    // A blank title is never accepted.
    expect(store.setTrackMetadata(id, { title: "   " })).toBe(false);
    expect(store.getTrack(id)?.title).toBe("New File Title");
  });
});

describe("smart playlists", () => {
  const tracks = [
    storedTrack({
      id: 1,
      path: "/music/1.flac",
      title: "Alpha",
      artist: "Artist One",
      albumArtist: "Artist One",
      genre: "Rock; Indie",
      favorite: true,
      addedAt: 500,
      lastPlayedAt: 1000,
      playCount: 5,
    }),
    storedTrack({
      id: 2,
      path: "/music/2.flac",
      title: "Bravo",
      artist: "Artist Two",
      albumArtist: "Artist Two",
      genre: "Jazz",
      addedAt: 400,
      lastPlayedAt: 5000,
      playCount: 1,
    }),
    storedTrack({
      id: 3,
      path: "/music/3.flac",
      title: "Charlie",
      artist: "Artist One",
      albumArtist: "Artist One",
      genre: "Rock",
      addedAt: 300,
      lastPlayedAt: null,
      playCount: 0,
    }),
    storedTrack({
      id: 4,
      path: "/music/4.flac",
      title: "Delta",
      artist: "Artist Three",
      albumArtist: "Artist Three",
      genre: "Pop",
      favorite: true,
      addedAt: 200,
      lastPlayedAt: 3000,
      playCount: 10,
    }),
  ];

  it("evaluates presets in their documented order", () => {
    expect(evaluateSmartPlaylist(tracks, { preset: "most-played" })).toEqual([4, 1, 2]);
    expect(evaluateSmartPlaylist(tracks, { preset: "recently-played" })).toEqual([2, 4, 1]);
    expect(evaluateSmartPlaylist(tracks, { preset: "recently-added", limit: 2 })).toEqual([1, 2]);
    expect(evaluateSmartPlaylist(tracks, { preset: "never-played" })).toEqual([3]);
    expect(evaluateSmartPlaylist(tracks, { preset: "genre", value: "rock" })).toEqual([1, 3]);
    expect(evaluateSmartPlaylist(tracks, { preset: "artist", value: "artist one" })).toEqual([1, 3]);
    expect(normalizeSmartPlaylistRule({ preset: "genre", value: "  " })).toBeNull();
    expect(normalizeSmartPlaylistRule({ preset: "most-played", limit: 99999 })?.limit).toBe(1000);
  });

  it("stores rules, evaluates membership live, and refuses hand edits", () => {
    const store = makeStore(tracks.map(track => ({ ...track })));
    const top = store.createSmartPlaylist("Top", { preset: "most-played", limit: 2 });
    expect(top).toMatchObject({ kind: "smart", trackCount: 2 });
    expect(store.getPlaylistTrackIds(top!.id)).toEqual([4, 1]);
    expect(store.createSmartPlaylist("Broken", { preset: "genre", value: " " })).toBeNull();

    store.addTracksToPlaylist(top!.id, [2]);
    store.removeTrackFromPlaylist(top!.id, 4);
    store.reorderPlaylist(top!.id, [1, 4]);
    expect(store.getPlaylistTrackIds(top!.id)).toEqual([4, 1]);

    expect(store.updateSmartPlaylist(top!.id, { preset: "favorites" })).toBe(true);
    expect(store.getPlaylistTrackIds(top!.id)).toEqual([1, 4]);
    // Membership is live: favouriting another track changes the playlist with no edit to it.
    store.setFavorite(2, true);
    expect(store.getPlaylistTrackIds(top!.id)).toEqual([1, 2, 4]);
    expect(store.getPlaylists().find(playlist => playlist.id === top!.id)?.smart).toEqual({
      preset: "favorites",
    });
  });
});

describe("duplicate detection", () => {
  it("groups normalized title/artist matches within the duration tolerance", () => {
    const tracks = [
      rendererTrack({
        id: 1,
        path: "/music/song.flac",
        title: "Song (feat. Guest)",
        artist: "The Artist",
        duration: 200,
        codec: "FLAC",
        fileSize: 30_000_000,
        sampleRate: 48000,
        playCount: 1,
      }),
      rendererTrack({
        id: 2,
        path: "/music/song.mp3",
        title: "Song",
        artist: "The Artist feat. Guest",
        duration: 201,
        codec: "MP3",
        container: "mp3",
        fileSize: 8_000_000,
        bitrate: 320_000,
      }),
      rendererTrack({ id: 3, path: "/music/live.flac", title: "Song (Live)", duration: 200 }),
      rendererTrack({ id: 4, path: "/music/long.flac", title: "Song", duration: 210 }),
      rendererTrack({ id: 5, path: "/music/other.flac", title: "Other", duration: 200 }),
    ];

    const groups = findDuplicateGroups(tracks);
    expect(groups).toHaveLength(1);
    expect(groups[0].tracks.map(track => track.id)).toEqual([1, 2]);
    expect(groups[0].keeperId).toBe(1);
    expect(groups[0].reclaimableBytes).toBe(8_000_000);
    expect(normalizeDuplicateText("Déjà Vu (feat. Someone)")).toBe("deja vu");
    expect(formatFileSize(8_000_000)).toBe("7.6 MB");
  });

  it("lets the user's own signals outweigh a weak quality difference for the keeper", () => {
    const plainLossless = rendererTrack({ codec: "FLAC", fileSize: 1_000_000, sampleRate: 44100 });
    const lovedMp3 = rendererTrack({
      codec: "MP3",
      container: "mp3",
      fileSize: 8_000_000,
      bitrate: 320_000,
      favorite: true,
      metadataEdited: true,
      playCount: 80,
      hasSidecarLyrics: true,
      artworkUrl: "media://cover",
    });
    expect(duplicateKeeperScore(lovedMp3)).toBeGreaterThan(duplicateKeeperScore(plainLossless));
  });
});
