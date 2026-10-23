/**
 * Cadence local lyrics sources: sidecar files next to the audio file, and lyrics embedded in tags.
 * Offline by construction — this is the path the player uses with no network.
 */

import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { LYRICS_SIDECAR_EXTENSIONS } from "../library/metadata";
import type { LibraryStore } from "../library/store";

export interface LocalLyrics {
  text: string;
  path: string;
  format: string;
}

const FORMAT_BY_EXTENSION: Record<string, string> = {
  ".lrc": "lrc",
  ".ttml": "ttml",
  ".qrc": "qrc",
  ".srt": "srt",
  ".txt": "text",
};

/** Sidecar files named after the track, e.g. `Song.flac` → `Song.lrc`, `Song.ttml`. */
export async function readSidecarLyrics(audioPath: string): Promise<LocalLyrics | null> {
  const directory = audioPath.slice(0, audioPath.length - basename(audioPath).length);
  const base = basename(audioPath, extname(audioPath));
  for (const extension of LYRICS_SIDECAR_EXTENSIONS) {
    for (const fileName of [base + extension, base + extension.toUpperCase()]) {
      const candidate = join(directory, fileName);
      try {
        const text = await fs.readFile(candidate, "utf8");
        if (text.trim().length === 0) continue;
        return { text, path: candidate, format: FORMAT_BY_EXTENSION[extension] ?? "text" };
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null;
}

/**
 * A `Lyrics/` folder next to the album, a convention several taggers use:
 * `Album/Lyrics/01 - Title.lrc`.
 */
export async function readLyricsFolder(audioPath: string, trackNo: number | null, title: string): Promise<LocalLyrics | null> {
  const directory = audioPath.slice(0, audioPath.length - basename(audioPath).length);
  const lyricsDirectory = join(directory, "Lyrics");
  const stems = new Set<string>();
  if (trackNo !== null) {
    stems.add(`${String(trackNo).padStart(2, "0")} - ${title}`);
    stems.add(String(trackNo));
  }
  stems.add(title);
  stems.add(basename(audioPath, extname(audioPath)));

  for (const stem of stems) {
    for (const extension of LYRICS_SIDECAR_EXTENSIONS) {
      const candidate = join(lyricsDirectory, stem + extension);
      try {
        const text = await fs.readFile(candidate, "utf8");
        if (text.trim().length > 0) {
          return { text, path: candidate, format: FORMAT_BY_EXTENSION[extension] ?? "text" };
        }
      } catch {
        /* next */
      }
    }
  }
  return null;
}

export function readEmbeddedLyrics(store: LibraryStore, trackId: number): { text: string; kind: string } | null {
  return store.getLyrics(trackId);
}

export async function readLyricsFile(path: string): Promise<LocalLyrics | null> {
  try {
    const text = await fs.readFile(path, "utf8");
    if (!text.trim()) return null;
    return { text, path, format: FORMAT_BY_EXTENSION[extname(path).toLowerCase()] ?? "text" };
  } catch {
    return null;
  }
}

/** Used by "Save lyrics next to the track" in the lyrics view. */
export async function writeSidecarLyrics(audioPath: string, text: string): Promise<string> {
  const target = `${audioPath.slice(0, audioPath.length - extname(audioPath).length)}.lrc`;
  await fs.writeFile(target, text, "utf8");
  return target;
}
