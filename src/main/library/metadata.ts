/**
 * Cadence metadata + artwork extraction.
 *
 * Uses `music-metadata` (MIT) for tags and embedded pictures. Written for Cadence; nothing here is
 * upstream Better Lyrics code.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseFile } from "music-metadata";

export const AUDIO_EXTENSIONS = [
  ".flac",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".ogg",
  ".oga",
  ".opus",
  ".mp4",
  ".m4b",
  ".aiff",
  ".aif",
  ".webm",
] as const;

export const LYRICS_SIDECAR_EXTENSIONS = [".lrc", ".ttml", ".qrc", ".srt", ".txt"] as const;

/** Chromium decodes all of these natively, which is why no native audio decoder is required. */
const PLAYABLE_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".webm"]);

export interface ParsedPicture {
  data: Buffer;
  format: string;
}

/** Animated covers are a sidecar video next to the audio file (Apple Music style). */
export function animatedArtCandidates(audioPath: string): string[] {
  const directory = dirname(audioPath);
  const base = basename(audioPath, extname(audioPath));
  return [
    join(directory, "cover.mp4"),
    join(directory, "cover.webm"),
    join(directory, "Cover.mp4"),
    join(directory, "Cover.webm"),
    join(directory, base + ".mp4"),
    join(directory, base + ".webm"),
    join(directory, base + "-animated.mp4"),
  ].filter(candidate => candidate !== audioPath);
}

export function findAnimatedArt(audioPath: string): string | null {
  for (const candidate of animatedArtCandidates(audioPath)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ParsedTrack {
  path: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  genre: string;
  year: number | null;
  trackNo: number | null;
  discNo: number | null;
  duration: number;
  bitrate: number | null;
  sampleRate: number | null;
  channels: number | null;
  codec: string;
  container: string;
  fileSize: number;
  mtimeMs: number;
  artworkFile: string | null;
  animatedArtPath: string | null;
  embeddedLyrics: { text: string; kind: string } | null;
  hasSidecarLyrics: boolean;
  playable: boolean;
}

export function isAudioFile(path: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
}

export function isPlayableExtension(path: string): boolean {
  return PLAYABLE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * A sidecar lyric file named after the audio file, plus the common `<artist> - <title>.lrc`
 * variants found in the same folder.
 */
export function findSidecarLyrics(audioPath: string, stat?: { size: number; mtimeMs: number }): string | null {
  const dir = dirname(audioPath);
  const base = basename(audioPath, extname(audioPath));
  for (const extension of LYRICS_SIDECAR_EXTENSIONS) {
    for (const candidate of [join(dir, base + extension), join(dir, base + extension.toUpperCase())]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  if (stat) {
    // Nothing else to check; kept for callers that already have a stat result.
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function millisecondsToLrcTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `[${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}]`;
}

/**
 * `common.lyrics` can carry either plain text or a structured `syncText` list. Structured lists are
 * converted back to LRC so the ported Braccato parser handles every source the same way.
 */
function lyricsFromTags(common: any): { text: string; kind: string } | null {
  const entries = common?.lyrics;
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    const syncText = entry?.syncText;
    if (Array.isArray(syncText) && syncText.length > 0) {
      const lines = syncText
        .filter((item: any) => typeof item?.text === "string" && typeof item?.timestamp === "number")
        .map((item: any) => `${millisecondsToLrcTimestamp(item.timestamp)}${item.text}`);
      if (lines.length > 0) return { text: lines.join("\n"), kind: "lrc" };
    }
  }

  for (const entry of entries) {
    if (typeof entry?.text === "string" && entry.text.trim().length > 0) {
      return { text: entry.text, kind: "text" };
    }
  }
  return null;
}

export async function readTrackMetadata(path: string, artworkDir: string): Promise<ParsedTrack> {
  const extension = extname(path).toLowerCase();
  const fallbackTitle = basename(path, extension);

  let metadata: Awaited<ReturnType<typeof parseFile>> | null = null;
  let parseError: unknown = null;
  try {
    metadata = await parseFile(path, { duration: true, skipCovers: false });
  } catch (error) {
    parseError = error;
  }

  if (!metadata) {
    const { statSync } = await import("node:fs");
    const stat = statSync(path);
    if (parseError) {
      // A file the parser cannot read may still be decodable audio. Keep it, flagged, so the UI can
      // show it and offer to remove it, instead of silently dropping it from the library.
      console.warn(`[Cadence] Metadata unreadable for ${path}:`, (parseError as Error).message);
    }
    return {
      path,
      title: fallbackTitle,
      artist: "Unknown artist",
      albumArtist: "Unknown artist",
      album: "Unknown album",
      genre: "",
      year: null,
      trackNo: null,
      discNo: null,
      duration: 0,
      bitrate: null,
      sampleRate: null,
      channels: null,
      codec: extension.replace(".", "").toUpperCase(),
      container: extension.replace(".", ""),
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      artworkFile: null,
      animatedArtPath: findAnimatedArt(path),
      embeddedLyrics: null,
      hasSidecarLyrics: findSidecarLyrics(path) !== null,
      playable: isPlayableExtension(path),
    };
  }

  const common = metadata.common ?? ({} as any);
  const format = metadata.format ?? ({} as any);
  const { statSync } = await import("node:fs");
  const stat = statSync(path);

  let artworkFile: string | null = null;
  const picture = Array.isArray(common.picture) ? common.picture[0] : null;
  if (picture?.data) {
    artworkFile = saveArtwork(
      { data: Buffer.from(picture.data), format: picture.format ?? "image/jpeg" },
      artworkDir
    );
  }

  return {
    path,
    title: typeof common.title === "string" && common.title.trim() ? common.title.trim() : fallbackTitle,
    artist: Array.isArray(common.artists) && common.artists.length > 0 ? common.artists.join(", ") : common.artist || "Unknown artist",
    albumArtist: common.albumartist || common.artist || "Unknown artist",
    album: common.album || "Unknown album",
    genre: Array.isArray(common.genre) && common.genre.length > 0 ? common.genre.join(", ") : "",
    year: toNumber(common.year),
    trackNo: toNumber(common.track?.no),
    discNo: toNumber(common.disk?.no),
    duration: typeof format.duration === "number" ? format.duration : 0,
    bitrate: toNumber(format.bitrate),
    sampleRate: toNumber(format.sampleRate),
    channels: toNumber(format.numberOfChannels),
    codec: String(format.codec || extension.replace(".", "")).slice(0, 40),
    container: String(format.container || extension.replace(".", "")).slice(0, 40),
    fileSize: stat.size,
    mtimeMs: stat.mtimeMs,
    artworkFile,
    animatedArtPath: findAnimatedArt(path),
    embeddedLyrics: lyricsFromTags(common),
    hasSidecarLyrics: findSidecarLyrics(path) !== null,
    playable: isPlayableExtension(path),
  };
}

const formatToExtension: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};

/** Content-addressed artwork cache, so the same cover is stored once for a whole album. */
export function saveArtwork(picture: ParsedPicture, artworkDir: string): string {
  mkdirSync(artworkDir, { recursive: true });
  const normalizedFormat = picture.format.toLowerCase().split(";")[0].trim();
  const extension = formatToExtension[normalizedFormat] ?? ".jpg";
  const hash = createHash("sha1").update(picture.data).digest("hex");
  const fileName = `${hash}${extension}`;
  const target = join(artworkDir, fileName);
  if (!existsSync(target)) writeFileSync(target, picture.data);
  return fileName;
}
