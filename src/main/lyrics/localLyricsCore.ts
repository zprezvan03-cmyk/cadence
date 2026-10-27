/**
 * Runtime-agnostic local sidecar & folder lyrics helpers for Cadence.
 */

import {
  LYRICS_SIDECAR_EXTENSIONS,
  pathBasename,
  pathDirname,
  pathExtname,
  pathJoin,
} from "../library/metadataCore";

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
  /**
   * Optional directory listing (file and directory names). When available, discovery uses the real
   * names on disk, so mixed-case extensions work on case-sensitive filesystems too. Return `null`
   * when listing is unavailable; the reader then probes generated case variants instead.
   */
  listFiles?(directory: string): Promise<readonly string[] | null | undefined>;
}

export interface LocalLyricsReaderOptions {
  /** Set on case-insensitive filesystems so generated variants don't read the same file twice. */
  caseInsensitivePaths?: boolean;
}

interface LyricPathCandidate {
  path: string;
  format: string;
}

const SUPPORTED_EXTENSIONS = new Set<string>(LYRICS_SIDECAR_EXTENSIONS.map(extension => extension.toLowerCase()));
const EXTENSION_RANK = new Map<string, number>(
  LYRICS_SIDECAR_EXTENSIONS.map((extension, index) => [extension.toLowerCase(), index])
);

function formatForPath(filePath: string): string | null {
  const extension = pathExtname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(extension) ? FORMAT_BY_EXTENSION[extension] ?? "text" : null;
}

/** Every upper/lower spelling of a supported extension, e.g. `.ttml`, `.TTML`, `.TtMl`, … */
function extensionCaseVariants(extension: string): string[] {
  const letters = extension.slice(1).toLowerCase();
  const variants = new Set<string>([extension.toLowerCase(), extension.toUpperCase()]);
  for (let mask = 0; mask < 1 << letters.length; mask += 1) {
    let variant = ".";
    for (let index = 0; index < letters.length; index += 1) {
      variant += mask & (1 << index) ? letters[index].toUpperCase() : letters[index];
    }
    variants.add(variant);
  }
  return [...variants];
}

function addCandidate(
  out: LyricPathCandidate[],
  seen: Set<string>,
  directory: string,
  name: string,
  caseInsensitivePaths: boolean
): void {
  const format = formatForPath(name);
  if (!format) return;
  const candidatePath = pathJoin(directory, name);
  const key = caseInsensitivePaths ? candidatePath.toLowerCase() : candidatePath;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ path: candidatePath, format });
}

/** Case-insensitive stem/extension match against actual directory entries. */
function matchingNames(names: readonly string[], stem: string): string[] {
  return names
    .filter(name => {
      const extension = pathExtname(name).toLowerCase();
      const fileStem = pathBasename(name, pathExtname(name));
      return SUPPORTED_EXTENSIONS.has(extension) && fileStem.toLowerCase() === stem.toLowerCase();
    })
    .sort((left, right) => {
      const leftExt = pathExtname(left).toLowerCase();
      const rightExt = pathExtname(right).toLowerCase();
      const rank = (EXTENSION_RANK.get(leftExt) ?? 99) - (EXTENSION_RANK.get(rightExt) ?? 99);
      if (rank !== 0) return rank;
      const exactLeft = pathBasename(left, pathExtname(left)) === stem ? 0 : 1;
      const exactRight = pathBasename(right, pathExtname(right)) === stem ? 0 : 1;
      return exactLeft - exactRight || left.localeCompare(right);
    });
}

function sidecarCandidates(
  audioPath: string,
  names: readonly string[] | null,
  caseInsensitivePaths: boolean
): LyricPathCandidate[] {
  const directory = pathDirname(audioPath);
  const stem = pathBasename(audioPath, pathExtname(audioPath));
  const out: LyricPathCandidate[] = [];
  const seen = new Set<string>();

  if (names) {
    for (const name of matchingNames(names, stem)) addCandidate(out, seen, directory, name, caseInsensitivePaths);
  } else {
    // Hosts without a directory listing still get case-insensitive extension support. On a
    // case-insensitive filesystem these variants collapse to one read per extension.
    for (const extension of LYRICS_SIDECAR_EXTENSIONS) {
      for (const variant of extensionCaseVariants(extension)) {
        addCandidate(out, seen, directory, stem + variant, caseInsensitivePaths);
      }
    }
  }
  return out;
}

function folderCandidates(
  audioPath: string,
  trackNo: number | null,
  title: string,
  lyricsDirectory: string,
  names: readonly string[] | null,
  caseInsensitivePaths: boolean
): LyricPathCandidate[] {
  const stems = new Set<string>();
  if (trackNo !== null) {
    stems.add(`${String(trackNo).padStart(2, "0")} - ${title}`);
    stems.add(String(trackNo));
  }
  stems.add(title);
  stems.add(pathBasename(audioPath, pathExtname(audioPath)));

  const out: LyricPathCandidate[] = [];
  const seen = new Set<string>();
  for (const stem of stems) {
    if (names) {
      for (const name of matchingNames(names, stem)) addCandidate(out, seen, lyricsDirectory, name, caseInsensitivePaths);
      continue;
    }
    for (const extension of LYRICS_SIDECAR_EXTENSIONS) {
      for (const variant of [extension, extension.toUpperCase()]) {
        addCandidate(out, seen, lyricsDirectory, stem + variant, caseInsensitivePaths);
      }
    }
  }
  return out;
}

export function createLocalLyricsReader(io: LocalLyricsIo, options: LocalLyricsReaderOptions = {}) {
  const caseInsensitivePaths = options.caseInsensitivePaths ?? false;

  const listDirectory = async (directory: string): Promise<readonly string[] | null> => {
    if (!io.listFiles) return null;
    try {
      return (await io.listFiles(directory)) ?? null;
    } catch (error) {
      console.warn(`[Cadence] Cannot list lyrics directory ${directory}:`, error);
      return null;
    }
  };

  /** Reads every candidate independently: one bad file never stops the remaining sidecars. */
  const readCandidates = async (
    candidates: readonly LyricPathCandidate[],
    listed: boolean
  ): Promise<LocalLyrics[]> => {
    const settled = await Promise.all(
      candidates.map(async (candidate): Promise<LocalLyrics | null> => {
        try {
          const text = await io.readTextFile(candidate.path);
          if (!text || text.trim().length === 0) {
            if (listed) console.warn(`[Cadence] Empty or unreadable lyrics sidecar: ${candidate.path}`);
            return null;
          }
          return { text, path: candidate.path, format: candidate.format };
        } catch (error) {
          // Generated candidates are mostly absent files; only warn for names that came from a
          // real directory listing, where a failed read means an inaccessible user file.
          if (listed) console.warn(`[Cadence] Cannot read lyrics sidecar ${candidate.path}:`, error);
          return null;
        }
      })
    );
    return settled.filter((entry): entry is LocalLyrics => entry !== null);
  };

  /** All supported sidecars next to the audio file. Discovery does not rank LRC over TTML. */
  const readAllSidecarLyrics = async (audioPath: string): Promise<LocalLyrics[]> => {
    const names = await listDirectory(pathDirname(audioPath));
    return readCandidates(sidecarCandidates(audioPath, names, caseInsensitivePaths), names !== null);
  };

  /** Legacy single-result helper, kept for callers that only need one file. */
  const readSidecarLyrics = async (audioPath: string): Promise<LocalLyrics | null> => {
    const all = await readAllSidecarLyrics(audioPath);
    return all[0] ?? null;
  };

  /** All matching files in the `<audio dir>/Lyrics/` convention, without an early return. */
  const readAllLyricsFolder = async (
    audioPath: string,
    trackNo: number | null,
    title: string
  ): Promise<LocalLyrics[]> => {
    const directory = pathDirname(audioPath);
    const parentNames = await listDirectory(directory);
    const lyricsName = parentNames?.find(name => name.toLowerCase() === "lyrics");
    const lyricsDirectory = pathJoin(directory, lyricsName ?? "Lyrics");
    const names = await listDirectory(lyricsDirectory);
    return readCandidates(
      folderCandidates(audioPath, trackNo, title, lyricsDirectory, names, caseInsensitivePaths),
      names !== null
    );
  };

  /** Legacy single-result helper for the Lyrics/ folder convention. */
  const readLyricsFolder = async (
    audioPath: string,
    trackNo: number | null,
    title: string
  ): Promise<LocalLyrics | null> => {
    const all = await readAllLyricsFolder(audioPath, trackNo, title);
    return all[0] ?? null;
  };

  const readLyricsFile = async (path: string): Promise<LocalLyrics | null> => {
    try {
      const text = await io.readTextFile(path);
      if (!text || !text.trim()) return null;
      return { text, path, format: FORMAT_BY_EXTENSION[pathExtname(path).toLowerCase()] ?? "text" };
    } catch {
      return null;
    }
  };

  const writeSidecarLyrics = async (audioPath: string, text: string): Promise<string> => {
    if (!io.writeTextFile) throw new Error("Sidecar writing is not configured");
    const ext = pathExtname(audioPath);
    const target = `${audioPath.slice(0, audioPath.length - ext.length)}.lrc`;
    await io.writeTextFile(target, text);
    return target;
  };

  // Plain function properties: the Node adapter re-exports them unbound.
  return {
    readAllSidecarLyrics,
    readSidecarLyrics,
    readAllLyricsFolder,
    readLyricsFolder,
    readLyricsFile,
    writeSidecarLyrics,
  };
}

export type LocalLyricsReader = ReturnType<typeof createLocalLyricsReader>;
