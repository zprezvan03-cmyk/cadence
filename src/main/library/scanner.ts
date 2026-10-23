/**
 * Cadence recursive library scanner.
 *
 * Walks configured folders, reads tags, caches artwork and upserts tracks. Unreadable files are
 * reported and skipped rather than aborting the scan; files that disappear between scans are
 * removed from the library. Written for Cadence.
 */

import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import type { LibraryScanResult, ScanProgress } from "../../shared/types";
import { isAudioFile, findSidecarLyrics, readTrackMetadata } from "./metadata";
import type { LibraryStore } from "./store";

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".svn",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".Trash",
  ".Trashes",
  "@eaDir",
]);

const MAX_DEPTH = 32;

export interface ScanOptions {
  folders: string[];
  onProgress?: (progress: ScanProgress) => void;
  /** Force metadata re-read even when size and mtime are unchanged. */
  force?: boolean;
}

async function walk(
  root: string,
  directory: string,
  depth: number,
  out: string[],
  onFile: (path: string) => void
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    console.warn(`[Cadence] Cannot read directory ${directory}:`, (error as Error).message);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await walk(root, fullPath, depth + 1, out, onFile);
    } else if (entry.isFile() && isAudioFile(fullPath)) {
      out.push(fullPath);
      onFile(fullPath);
    }
  }
}

export async function scanLibrary(store: LibraryStore, options: ScanOptions): Promise<LibraryScanResult> {
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

  const files: string[] = [];
  for (const folder of options.folders) {
    try {
      const stat = await fs.stat(folder);
      if (!stat.isDirectory()) {
        errors.push({ path: folder, reason: "Not a directory" });
        continue;
      }
      await walk(folder, folder, 0, files, () => {
        progress.filesSeen += 1;
        if (progress.filesSeen % 50 === 0) emit();
      });
    } catch (error) {
      errors.push({ path: folder, reason: (error as Error).message });
    }
  }

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
      const path = files[index];
      seenPaths.add(path);
      try {
        const existing = store.getTrackByPath(path);
        let stat: { size: number; mtimeMs: number } | null = null;
        try {
          const fileStat = await fs.stat(path);
          stat = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
        } catch (error) {
          errors.push({ path, reason: (error as Error).message });
          continue;
        }

        if (
          existing &&
          !options.force &&
          existing.fileSize === stat.size &&
          existing.mtimeMs === stat.mtimeMs
        ) {
          progress.filesSkipped += 1;
          progress.filesProcessed += 1;
          if (existing.hasSidecarLyrics !== (findSidecarLyrics(path) !== null)) {
            store.setSidecarLyricsFlag(existing.id, findSidecarLyrics(path) !== null);
          }
          if (progress.filesProcessed % 25 === 0) emit();
          continue;
        }

        const parsed = await readTrackMetadata(path, store.artworkDirectory);
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
        errors.push({ path, reason: (error as Error).message });
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

  // Remove tracks that live under a scanned folder but no longer exist.
  const stale = new Set<string>();
  for (const track of store.getTracks()) {
    const trackedUnderScannedFolder = options.folders.some(folder => {
      const rel = relative(folder, track.path);
      return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(".." + sep);
    });
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
