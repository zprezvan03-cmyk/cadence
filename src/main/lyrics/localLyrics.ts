/**
 * Cadence local lyrics sources (Node filesystem adapter over `localLyricsCore`).
 */

import { promises as fs } from "node:fs";
import type { LibraryStoreCore } from "../library/storeCore";
import { createLocalLyricsReader, type LocalLyrics } from "./localLyricsCore";

export type { LocalLyrics };

export const nodeLocalLyricsReader = createLocalLyricsReader(
  {
    async readTextFile(path) {
      try {
        return await fs.readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async listFiles(directory) {
      try {
        return await fs.readdir(directory);
      } catch {
        return null;
      }
    },
    async writeTextFile(path, text) {
      await fs.writeFile(path, text, "utf8");
    },
  },
  { caseInsensitivePaths: process.platform === "win32" }
);

export const readAllSidecarLyrics = nodeLocalLyricsReader.readAllSidecarLyrics;
export const readAllLyricsFolder = nodeLocalLyricsReader.readAllLyricsFolder;
export const readSidecarLyrics = nodeLocalLyricsReader.readSidecarLyrics;
export const readLyricsFolder = nodeLocalLyricsReader.readLyricsFolder;
export const readLyricsFile = nodeLocalLyricsReader.readLyricsFile;
export const writeSidecarLyrics = nodeLocalLyricsReader.writeSidecarLyrics;

export function readEmbeddedLyrics(store: LibraryStoreCore, trackId: number): { text: string; kind: string } | null {
  return store.getLyrics(trackId);
}
