/**
 * Runtime-agnostic recursive library scanner core.
 * Shared between the Tauri WebView2 bridge and Node unit/integration tests.
 */

import type { LibraryScanResult, ScanProgress } from "../../shared/types";
import { isPathInside } from "../media/allowlist";
import type { ParsedTrack } from "./metadataCore";
import type { LibraryStoreCore } from "./storeCore";

export const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".svn",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".Trash",
  ".Trashes",
  "@eaDir",
]);

export const MAX_SCAN_DEPTH = 32;

export interface WalkedAudioFile {
  path: string;
  size: number;
  mtimeMs: number;
  hasSidecarLyrics: boolean;
  animatedArtPath: string | null;
}

export interface WalkResult {
  files: WalkedAudioFile[];
  errors: { path: string; reason: string }[];
}

export interface ScannerHostIo {
  walkFolders(folders: string[], onFileSeen?: () => void): Promise<WalkResult>;
  parseTrack(file: WalkedAudioFile, artworkDirectory: string): Promise<ParsedTrack>;
}

export interface ScanCoreOptions {
  folders: string[];
  onProgress?: (progress: ScanProgress) => void;
  force?: boolean;
}

export async function scanLibraryCore(
  store: LibraryStoreCore,
  options: ScanCoreOptions,
  io: ScannerHostIo
): Promise<LibraryScanResult> {
  const startedAt = Date.now();
  const errors: { path: string; reason: string }[] = [];
  const progress: ScanProgress = {
    running: true,
    phase: "walking",
    foldersTotal: options.folders.length,
    filesSeen: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    errors,
    message: "Looking for audio files…",
    startedAt,
    finishedAt: null,
  };
  const emit = () => options.onProgress?.({ ...progress, errors: [...errors] });
  emit();

  const walked = await io.walkFolders(options.folders, () => {
    progress.filesSeen += 1;
    if (progress.filesSeen % 50 === 0) emit();
  });
  progress.filesSeen = walked.files.length;
  errors.push(...walked.errors);

  const files = walked.files;
  progress.phase = "reading";
  progress.message = `Reading ${files.length} files…`;
  emit();

  let added = 0;
  let updated = 0;
  const seenPaths = new Set<string>();

  const CONCURRENCY = 4;
  let cursor = 0;

  const worker = async () => {
    while (cursor < files.length) {
      const index = cursor++;
      const file = files[index];
      seenPaths.add(file.path);
      try {
        const existing = store.getTrackByPath(file.path);
        if (
          existing &&
          !options.force &&
          existing.fileSize === file.size &&
          existing.mtimeMs === file.mtimeMs
        ) {
          progress.filesSkipped += 1;
          progress.filesProcessed += 1;
          if (existing.hasSidecarLyrics !== file.hasSidecarLyrics) {
            store.setSidecarLyricsFlag(existing.id, file.hasSidecarLyrics);
          }
          if (progress.filesProcessed % 25 === 0) emit();
          continue;
        }

        const parsed = await io.parseTrack(file, store.artworkDirectory);
        const result = store.upsertTrack({
          ...parsed,
          hasEmbeddedLyrics: parsed.embeddedLyrics !== null,
          artworkFile: parsed.artworkFile ?? existing?.artworkFile ?? null,
          animatedArtPath: parsed.animatedArtPath ?? existing?.animatedArtPath ?? null,
          accentColor: existing?.accentColor ?? null,
        });
        if (result.inserted) added += 1;
        else updated += 1;
      } catch (error) {
        errors.push({ path: file.path, reason: (error as Error).message });
      } finally {
        progress.filesProcessed += 1;
        if (progress.filesProcessed % 10 === 0) {
          progress.message = `Reading ${progress.filesProcessed}/${files.length}…`;
          emit();
        }
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  progress.phase = "saving";
  progress.message = "Saving library…";
  emit();

  const stale = new Set<string>();
  for (const track of store.getTracks()) {
    const trackedUnderScannedFolder = options.folders.some(
      folder => track.path !== folder && isPathInside(folder, track.path)
    );
    if (!trackedUnderScannedFolder) continue;
    if (!seenPaths.has(track.path)) stale.add(track.path);
  }
  const removed = store.removeTracks(stale);
  store.flush();

  progress.running = false;
  progress.phase = errors.length > 0 && files.length === 0 ? "error" : "done";
  progress.message = files.length === 0 ? "No audio files found" : `Library ready — ${files.length} files`;
  progress.finishedAt = Date.now();
  progress.errors = errors;
  emit();

  return { added, updated, removed, errors, durationMs: Date.now() - startedAt };
}
