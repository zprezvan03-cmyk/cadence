/**
 * Cadence library controller: owns the store, the folder list, scans and change notifications.
 * Written for Cadence.
 */

import { EventEmitter } from "node:events";
import type {
  LibraryScanResult,
  LibrarySnapshot,
  ScanProgress,
  Track,
} from "../../shared/types";
import type { MediaAllowlist } from "../protocol";
import { scanLibrary } from "./scanner";
import { LibraryStore } from "./store";

export interface LibraryPaths {
  dbPath: string;
  artworkDirectory: string;
}

const IDLE_PROGRESS: ScanProgress = {
  running: false,
  phase: "idle",
  foldersTotal: 0,
  filesSeen: 0,
  filesProcessed: 0,
  filesSkipped: 0,
  errors: [],
  message: "Library not scanned yet",
  startedAt: null,
  finishedAt: null,
};

export class LibraryController extends EventEmitter {
  readonly store: LibraryStore;
  private progress: ScanProgress = { ...IDLE_PROGRESS };
  private scanning: Promise<LibraryScanResult> | null = null;

  constructor(
    paths: LibraryPaths,
    private readonly allowlist: MediaAllowlist,
    private readonly mediaUrl: (path: string, isArtwork?: boolean) => string
  ) {
    super();
    this.store = new LibraryStore(paths.dbPath, paths.artworkDirectory, mediaUrl);
    this.allowlist.addRoot(paths.artworkDirectory);
    this.syncAllowlist();
  }

  get engine(): "sqlite" | "json" {
    return this.store.engine;
  }

  get artworkDirectory(): string {
    return this.store.artworkDirectory;
  }

  private syncAllowlist(): void {
    for (const folder of this.store.getFolders()) this.allowlist.addRoot(folder);
  }

  getProgress(): ScanProgress {
    return this.progress;
  }

  snapshot(): LibrarySnapshot {
    const tracks = this.store.getTracks().map(track => this.store.toTrack(track));
    return {
      tracks,
      albums: this.store.getAlbums(),
      artists: this.store.getArtists(),
      playlists: this.store.getPlaylists(),
      folders: this.store.getFolders(),
      scan: this.progress,
      counts: this.store.counts(),
    };
  }

  search(query: string): Track[] {
    return this.store.search(query);
  }

  getTrack(id: number): Track | null {
    const track = this.store.getTrack(id);
    return track ? this.store.toTrack(track) : null;
  }

  async addFolder(folder: string): Promise<LibraryScanResult> {
    this.store.addFolder(folder);
    this.allowlist.addRoot(folder);
    return this.rescan(false);
  }

  async removeFolder(folder: string): Promise<void> {
    this.store.removeFolder(folder);
    const remaining = this.store.getFolders();
    const stale = new Set(
      this.store
        .getTracks()
        .filter(track => track.path.startsWith(folder + "/") || track.path.startsWith(folder + "\\"))
        .map(track => track.path)
    );
    if (remaining.length === 0) {
      // Nothing left to scope the removal to, so only remove the tracks under this folder.
      this.store.removeTracks(stale);
    }
    this.store.flush();
    this.emit("changed");
  }

  rescan(force = false): Promise<LibraryScanResult> {
    if (this.scanning) return this.scanning;
    const folders = this.store.getFolders();
    if (folders.length === 0) {
      this.progress = {
        ...IDLE_PROGRESS,
        phase: "done",
        message: "Add a music folder to build your library",
        finishedAt: Date.now(),
      };
      this.emit("progress", this.progress);
      this.emit("changed");
      return Promise.resolve({ added: 0, updated: 0, removed: 0, errors: [], durationMs: 0 });
    }

    this.scanning = scanLibrary(this.store, {
      folders,
      force,
      onProgress: progress => {
        this.progress = progress;
        this.emit("progress", progress);
      },
    })
      .then(result => {
        this.emit("changed");
        return result;
      })
      .finally(() => {
        this.scanning = null;
      });

    return this.scanning;
  }

  notifyChanged(): void {
    this.emit("changed");
  }

  isScanning(): boolean {
    return this.scanning !== null;
  }

  close(): void {
    this.store.close();
  }
}
