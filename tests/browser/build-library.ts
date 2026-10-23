/**
 * Build a library snapshot from the real main-process modules for the browser harness.
 *
 * Runs the actual scanner (`scanLibrary`) and SQLite store against the generated audio fixtures,
 * writes `.artifacts/harness/library.json`, and copies the extracted artwork next to it so the
 * static harness server can serve it. Nothing here is used by the shipped application.
 *
 * Usage: npx vite-node tests/browser/build-library.ts
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { LibraryStore } from "../../src/main/library/store";
import { scanLibrary } from "../../src/main/library/scanner";

const root = resolve(import.meta.dirname, "../..");
const fixtures = join(root, ".artifacts/fixtures/formats");
const workDir = join(root, ".artifacts/harness");
const artworkDir = join(workDir, "artwork");
const dbPath = join(workDir, "library.db");

if (!existsSync(join(fixtures, "fixture.flac"))) {
  throw new Error("Fixtures missing. Run: python3 tests/fixtures/generate-audio.py");
}

rmSync(dbPath, { recursive: true, force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(artworkDir, { recursive: true, force: true });
mkdirSync(artworkDir, { recursive: true });

/** Media URLs point at the harness HTTP server, which serves the same files with Range support. */
const mediaUrl = (path: string) => `/media/${encodeURIComponent(basename(path) || "file")}`;

const store = new LibraryStore(dbPath, artworkDir, mediaUrl);
const scan = await scanLibrary(store, { folders: [fixtures] });

const artworkFiles = new Set<string>();
const snapshot = {
  tracks: store.getTracks().map(track => ({
    ...store.toTrack(track),
    streamUrl: `/audio/${encodeURIComponent(basename(track.path))}`,
    artworkUrl: track.artworkFile ? `/artwork/${encodeURIComponent(track.artworkFile)}` : null,
  })),
  albums: store.getAlbums(),
  artists: store.getArtists(),
  playlists: store.getPlaylists(),
  folders: store.getFolders(),
  counts: {
    tracks: store.getTracks().length,
    albums: store.getAlbums().length,
    artists: store.getArtists().length,
  },
  scan: {
    running: false,
    phase: "done",
    foldersTotal: 1,
    filesSeen: scan.added,
    filesProcessed: scan.added,
    filesSkipped: 0,
    errors: scan.errors,
    message: `Library ready — ${scan.added} files`,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  },
  engine: store.engine,
};

// Copy every artwork file referenced by the snapshot to a flat directory the server can reach.
for (const track of store.getTracks()) {
  if (track.artworkFile) artworkFiles.add(track.artworkFile);
}
for (const file of artworkFiles) {
  copyFileSync(join(artworkDir, file), join(workDir, file));
}
const artworkFromUrl = (url: string | null): string | null => {
  if (!url) return null;
  const file = basename(decodeURIComponent(url));
  return artworkFiles.has(file) ? `/artwork/${encodeURIComponent(file)}` : null;
};
for (const album of snapshot.albums) {
  album.artworkUrl = artworkFromUrl(album.artworkUrl);
}
for (const artist of snapshot.artists) {
  artist.artworkUrl = artworkFromUrl(artist.artworkUrl);
}
for (const playlist of snapshot.playlists) {
  playlist.artworkUrl = null;
}

writeFileSync(join(workDir, "library.json"), JSON.stringify({ snapshot, engine: store.engine, scan }, null, 2));
console.log(`snapshot: ${snapshot.tracks.length} tracks, engine ${store.engine}`);
for (const track of snapshot.tracks) {
  console.log(`  #${track.id} ${track.title} — ${track.artist} [${track.codec}] ${track.duration.toFixed(2)}s artwork=${Boolean(track.artworkUrl)}`);
}
