/**
 * Runtime-agnostic local sidecar & folder lyrics helpers for Cadence.
 */

import { LYRICS_SIDECAR_EXTENSIONS, pathBasename, pathDirname, pathExtname, pathJoin } from "../library/metadataCore";

export interface LocalLyrics {
  text: string;
  path: string;
  format: string;
}

export const FORMAT_BY_EXTENSION: Record<string, string> = {
  ".lrc": "lrc",
  ".ttml": "ttml",
  ".qrc": "qrc",
  ".srt": "srt",
  ".txt": "text",
};

export interface LocalLyricsIo {
  readTextFile(path: string): Promise<string | null>;
  writeTextFile?(path: string, text: string): Promise<void>;
}

export function createLocalLyricsReader(io: LocalLyricsIo) {
  return {
    async readSidecarLyrics(audioPath: string): Promise<LocalLyrics | null> {
      const directory = pathDirname(audioPath);
      const base = pathBasename(audioPath, pathExtname(audioPath));
      for (const extension of LYRICS_SIDECAR_EXTENSIONS) {
        for (const fileName of [base + extension, base + extension.toUpperCase()]) {
          const candidate = pathJoin(directory, fileName);
          try {
            const text = await io.readTextFile(candidate);
            if (!text || text.trim().length === 0) continue;
            return { text, path: candidate, format: FORMAT_BY_EXTENSION[extension] ?? "text" };
          } catch {
            /* try next */
          }
        }
      }
      return null;
    },

    async readLyricsFolder(audioPath: string, trackNo: number | null, title: string): Promise<LocalLyrics | null> {
      const directory = pathDirname(audioPath);
      const lyricsDirectory = pathJoin(directory, "Lyrics");
      const stems = new Set<string>();
      if (trackNo !== null) {
        stems.add(`${String(trackNo).padStart(2, "0")} - ${title}`);
        stems.add(String(trackNo));
      }
      stems.add(title);
      stems.add(pathBasename(audioPath, pathExtname(audioPath)));

      for (const stem of stems) {
        for (const extension of LYRICS_SIDECAR_EXTENSIONS) {
          const candidate = pathJoin(lyricsDirectory, stem + extension);
          try {
            const text = await io.readTextFile(candidate);
            if (text && text.trim().length > 0) {
              return { text, path: candidate, format: FORMAT_BY_EXTENSION[extension] ?? "text" };
            }
          } catch {
            /* next */
          }
        }
      }
      return null;
    },

    async readLyricsFile(path: string): Promise<LocalLyrics | null> {
      try {
        const text = await io.readTextFile(path);
        if (!text || !text.trim()) return null;
        return { text, path, format: FORMAT_BY_EXTENSION[pathExtname(path).toLowerCase()] ?? "text" };
      } catch {
        return null;
      }
    },

    async writeSidecarLyrics(audioPath: string, text: string): Promise<string> {
      if (!io.writeTextFile) throw new Error("Sidecar writing is not configured");
      const ext = pathExtname(audioPath);
      const target = `${audioPath.slice(0, audioPath.length - ext.length)}.lrc`;
      await io.writeTextFile(target, text);
      return target;
    },
  };
}

export type LocalLyricsReader = ReturnType<typeof createLocalLyricsReader>;
