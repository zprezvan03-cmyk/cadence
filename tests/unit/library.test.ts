import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LibraryStore } from "../../src/main/library/store";
import { scanLibrary } from "../../src/main/library/scanner";
import { AUDIO_EXTENSIONS, isAudioFile, readTrackMetadata } from "../../src/main/library/metadata";

const fixtures = resolve(import.meta.dirname, "../../.artifacts/fixtures/formats");
const musicDir = join(tmpdir(), "cadence-library-fixtures");
let workDir: string;
let libraryPath: string;

/** Minimal media URL stand-in; the store only uses it to build artwork links. */
const mediaUrl = (path: string, isArtwork?: boolean) => `cadence-media://${isArtwork ? "artwork" : "audio"}${path}`;

beforeAll(() => {
  if (!existsSync(join(fixtures, "fixture.flac"))) {
    throw new Error("Audio fixtures are missing. Run: python3 tests/fixtures/generate-audio.py");
  }
  rmSync(musicDir, { recursive: true, force: true });
  mkdirSync(musicDir, { recursive: true });
  cpSync(fixtures, musicDir, { recursive: true });
});

afterAll(() => {
  rmSync(musicDir, { recursive: true, force: true });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("metadata", () => {
  it("only treats real audio extensions as audio", () => {
    expect(AUDIO_EXTENSIONS).toEqual(expect.arrayContaining([".flac", ".mp3", ".m4a", ".wav", ".ogg", ".opus"]));
    expect(isAudioFile("/music/song.flac")).toBe(true);
    expect(isAudioFile("/music/song.MP3")).toBe(true);
    expect(isAudioFile("/music/cover.png")).toBe(false);
    expect(isAudioFile("/music/song.lrc")).toBe(false);
  });

  it.each([
    ["fixture.flac", "FLAC", "Fixture FLAC", 2],
    ["fixture.mp3", "MPEG 1 Layer 3", "Fixture MP3", 1],
    ["fixture-aac.m4a", "MPEG-4/AAC", "Fixture AAC", 1],
    ["fixture-alac.m4a", "ALAC", "Fixture ALAC", 1],
    ["fixture.ogg", "Vorbis I", "Fixture Ogg Vorbis", 3],
    ["fixture.opus", "Opus", "Fixture Opus", 3],
  ])("reads tags, duration, artwork and embedded lyrics from %s", async (file, codec, title, trackNo) => {
    workDir ??= mkdtempSync(join(tmpdir(), "cadence-artwork-"));
    const artworkDir = join(workDir, "artwork");
    const parsed = await readTrackMetadata(join(musicDir, file), artworkDir);

    expect(parsed.codec).toContain(codec.split(" ")[0]);
    expect(parsed.title).toBe(title);
    expect(parsed.artist).toBe("Harness Artist");
    expect(parsed.album).toBe("Test Bench");
    expect(parsed.trackNo).toBe(trackNo);
    expect(parsed.year).toBe(2024);
    expect(parsed.duration).toBeGreaterThan(5.5);
    expect(parsed.playable).toBe(true);

    expect(parsed.artworkFile).toMatch(/^[0-9a-f]{40}\.png$/);
    const artworkPath = join(artworkDir, parsed.artworkFile!);
    expect(existsSync(artworkPath)).toBe(true);
    expect(readFileSync(artworkPath).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(parsed.embeddedLyrics).not.toBeNull();
    // Tags that carry synced text are converted to LRC so the renderer can use word/line timing.
    if (parsed.embeddedLyrics?.kind === "lrc") {
      expect(parsed.embeddedLyrics.text).toMatch(/^\[\d{2}:\d{2}\.\d{2}\]/m);
    }
    expect(parsed.embeddedLyrics?.text).toContain("Fixture first line");
  });

  it("flags a corrupt file instead of dropping it", async () => {
    workDir ??= mkdtempSync(join(tmpdir(), "cadence-artwork-"));
    const parsed = await readTrackMetadata(join(musicDir, "broken.flac"), join(workDir, "artwork"));
    expect(parsed.title).toBe("broken");
    expect(parsed.playable).toBe(true); // the extension is supported; decoding may still fail
    expect(parsed.embeddedLyrics).toBeNull();
    expect(parsed.duration).toBe(0);
  });

  it("deduplicates identical artwork by content hash", async () => {
    workDir ??= mkdtempSync(join(tmpdir(), "cadence-artwork-"));
    const artworkDir = join(workDir, "artwork-shared");
    const a = await readTrackMetadata(join(musicDir, "fixture.flac"), artworkDir);
    const b = await readTrackMetadata(join(musicDir, "fixture.mp3"), artworkDir);
    expect(a.artworkFile).toBe(b.artworkFile);
  });
});

describe("scanning", () => {
  it("imports the folder, records metadata, artwork and sidecar lyrics", async () => {
    workDir ??= mkdtempSync(join(tmpdir(), "cadence-artwork-"));
    const store = new LibraryStore(join(workDir, "library.db"), join(workDir, "artwork"), mediaUrl, { disableSqlite: true });
    const result = await scanLibrary(store, { folders: [musicDir] });
    store.flush();

    // 7 decodable formats plus the corrupt file, which is kept and flagged rather than dropped.
    expect(result.added).toBe(8);
    expect(result.errors).toEqual([]);
    const tracks = store.getTracks();
    expect(tracks.length).toBe(8);

    const wav = tracks.find(track => track.path.endsWith("fixture.wav"))!;
    expect(wav.title).toBe("fixture");
    expect(wav.hasSidecarLyrics).toBe(true);
    expect(wav.playable).toBe(true);
    expect(wav.artworkFile).toBeNull();

    const flac = tracks.find(track => track.path.endsWith("fixture.flac"))!;
    expect(flac.artist).toBe("Harness Artist");
    expect(store.getLyrics(flac.id)?.text).toContain("Fixture first line");
    expect(flac.hasEmbeddedLyrics).toBe(true);

    const broken = tracks.find(track => track.path.endsWith("broken.flac"))!;
    expect(broken.title).toBe("broken");
  });

  it("skips unchanged files on a second scan and removes vanished files", async () => {
    workDir ??= mkdtempSync(join(tmpdir(), "cadence-artwork-"));
    const store = new LibraryStore(join(workDir, "library2.db"), join(workDir, "artwork2"), mediaUrl);
    expect(store.engine).toBe("sqlite");
    const first = await scanLibrary(store, { folders: [musicDir] });
    expect(first.added).toBe(8);
    const skipped: number[] = [];
    const second = await scanLibrary(store, {
      folders: [musicDir],
      onProgress: progress => {
        if (progress.phase === "done") skipped.push(progress.filesSkipped);
      },
    });
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(Math.max(...skipped)).toBeGreaterThanOrEqual(8);

    rmSync(join(musicDir, "fixture.ogg"));
    const third = await scanLibrary(store, { folders: [musicDir] });
    expect(third.removed).toBe(1);
    expect(store.getTracks().some(track => track.path.endsWith("fixture.ogg"))).toBe(false);
    // Restore for other tests.
    cpSync(join(fixtures, "fixture.ogg"), join(musicDir, "fixture.ogg"));
  });
});

describe("library store", () => {
  let store: LibraryStore;

  beforeAll(async () => {
    workDir ??= mkdtempSync(join(tmpdir(), "cadence-artwork-"));
    libraryPath = join(workDir, "store.db");
    store = new LibraryStore(libraryPath, join(workDir, "artwork3"), mediaUrl);
    await scanLibrary(store, { folders: [musicDir] });
    store.flush();
  });

  it("uses SQLite when the runtime exposes node:sqlite", () => {
    expect(store.engine).toBe("sqlite");
    expect(existsSync(libraryPath)).toBe(true);
  });

  it("aggregates albums, artists and playlists", () => {
    const albums = store.getAlbums();
    expect(albums.length).toBeGreaterThanOrEqual(2); // "Test Bench" and "Unknown album"
    const bench = albums.find(album => album.name === "Test Bench")!;
    expect(bench.trackCount).toBe(6);
    expect(bench.artworkUrl).toContain("cadence-media://artwork");
    expect(store.getArtists().some(artist => artist.name === "Harness Artist")).toBe(true);
  });

  it("searches title, artist and album", () => {
    expect(store.search("fixture mp3").map(track => track.title)).toContain("Fixture MP3");
    expect(store.search("harness artist").length).toBe(6);
    expect(store.search("test bench").length).toBe(6);
    expect(store.search("zzzz-no-match")).toEqual([]);
  });

  it("favorites and play counts round-trip through SQLite", () => {
    const track = store.getTracks()[0];
    store.setFavorite(track.id, true);
    store.recordPlay(track.id);
    expect(store.getTrack(track.id)?.favorite).toBe(true);
    expect(store.getTrack(track.id)?.playCount).toBe(1);

    const reopened = new LibraryStore(libraryPath, join(workDir, "artwork3"), mediaUrl);
    expect(reopened.engine).toBe("sqlite");
    expect(reopened.getTrack(track.id)?.favorite).toBe(true);
    expect(reopened.getTrack(track.id)?.playCount).toBe(1);
    expect(reopened.getTracks()[0].lastPlayedAt).toBeGreaterThan(0);
  });

  it("manages playlist contents and ordering", () => {
    const ids = store.getTracks().slice(0, 3).map(track => track.id);
    const playlist = store.createPlaylist("Road trip", ids);
    expect(playlist.trackCount).toBe(3);
    expect(playlist.artworkUrl).toContain("cadence-media://artwork");

    store.addTracksToPlaylist(playlist.id, [ids[0], 9999]);
    expect(store.getPlaylistTrackIds(playlist.id)).toEqual(ids);

    store.reorderPlaylist(playlist.id, [ids[2], ids[0], ids[1]]);
    expect(store.getPlaylistTrackIds(playlist.id)).toEqual([ids[2], ids[0], ids[1]]);

    store.removeTrackFromPlaylist(playlist.id, ids[0]);
    expect(store.getPlaylistTrackIds(playlist.id)).toEqual([ids[2], ids[1]]);

    store.renamePlaylist(playlist.id, "Long drive");
    expect(store.getPlaylists()[0].name).toBe("Long drive");

    store.deletePlaylist(playlist.id);
    expect(store.getPlaylists()).toEqual([]);
  });

  it("persists folders", () => {
    store.addFolder("/music/one");
    store.addFolder("/music/one");
    store.addFolder("/music/two");
    expect(store.getFolders()).toEqual(["/music/one", "/music/two"]);
    store.removeFolder("/music/two");
    store.flush();

    const reopened = new LibraryStore(libraryPath, join(workDir, "artwork3"), mediaUrl);
    expect(reopened.getFolders()).toEqual(["/music/one"]);
  });

  it("falls back to the JSON document store when SQLite is unavailable", async () => {
    const jsonDir = join(workDir, "json");
    const jsonStore = new LibraryStore(join(jsonDir, "library.db"), join(jsonDir, "artwork"), mediaUrl, {
      disableSqlite: true,
    });
    expect(jsonStore.engine).toBe("json");
    const result = await scanLibrary(jsonStore, { folders: [musicDir] });
    expect(result.added).toBe(8);
    jsonStore.flush();

    const jsonPath = join(jsonDir, "library.json");
    expect(existsSync(jsonPath)).toBe(true);
    const reopened = new LibraryStore(join(jsonDir, "library.db"), join(jsonDir, "artwork"), mediaUrl, {
      disableSqlite: true,
    });
    expect(reopened.getTracks().length).toBe(jsonStore.getTracks().length);
    writeFileSync(jsonPath, "{ not json");
    const recovered = new LibraryStore(join(jsonDir, "library.db"), join(jsonDir, "artwork"), mediaUrl, {
      disableSqlite: true,
    });
    expect(recovered.getTracks()).toEqual([]);
  });
});
