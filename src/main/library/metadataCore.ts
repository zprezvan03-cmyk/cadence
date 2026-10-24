/**
 * Runtime-agnostic audio metadata + content-addressed artwork extraction core.
 * Uses `music-metadata` (`parseFromTokenizer`) + `RangeTokenizer` + WebCrypto SHA-1 so WebView2
 * and Node share identical tag, cover art, animated cover, and embedded USLT/SYLT extraction.
 */

import { parseFromTokenizer } from "music-metadata";
import { resolvePathApi } from "../media/allowlist";
import { RangeTokenizer, type ReadChunkFn } from "./rangeTokenizer";

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

const PLAYABLE_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".webm"]);

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

export function pathBasename(filePath: string, suffix?: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed;
  if (suffix && base.toLowerCase().endsWith(suffix.toLowerCase())) {
    return base.slice(0, base.length - suffix.length);
  }
  return base;
}

export function pathExtname(filePath: string): string {
  const base = pathBasename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

export function pathDirname(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (lastSep < 0) return ".";
  if (lastSep === 0) return trimmed[0];
  if (lastSep === 2 && /^[a-zA-Z]:/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`;
  return trimmed.slice(0, lastSep);
}

export function pathJoin(dir: string, ...parts: string[]): string {
  return resolvePathApi(undefined, dir).join(dir, ...parts);
}

export function isAudioFile(path: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(pathExtname(path).toLowerCase());
}

export function isPlayableExtension(path: string): boolean {
  return PLAYABLE_EXTENSIONS.has(pathExtname(path).toLowerCase());
}

export function animatedArtCandidates(audioPath: string): string[] {
  const directory = pathDirname(audioPath);
  const base = pathBasename(audioPath, pathExtname(audioPath));
  return [
    pathJoin(directory, "cover.mp4"),
    pathJoin(directory, "cover.webm"),
    pathJoin(directory, "Cover.mp4"),
    pathJoin(directory, "Cover.webm"),
    pathJoin(directory, `${base}.mp4`),
    pathJoin(directory, `${base}.webm`),
    pathJoin(directory, `${base}-animated.mp4`),
  ].filter(candidate => candidate !== audioPath);
}

export function sidecarLyricsCandidates(audioPath: string): string[] {
  const directory = pathDirname(audioPath);
  const base = pathBasename(audioPath, pathExtname(audioPath));
  const out: string[] = [];
  for (const extension of LYRICS_SIDECAR_EXTENSIONS) {
    out.push(pathJoin(directory, base + extension));
    out.push(pathJoin(directory, base + extension.toUpperCase()));
  }
  return out;
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

export function lyricsFromTags(common: any): { text: string; kind: string } | null {
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

export const ARTWORK_FORMAT_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};

export async function sha1Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await globalThis.crypto.subtle.digest("SHA-1", copy);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function artworkExtensionForMime(format: string): string {
  const normalizedFormat = (format || "image/jpeg").toLowerCase().split(";")[0].trim();
  return ARTWORK_FORMAT_TO_EXTENSION[normalizedFormat] ?? ".jpg";
}

export interface MetadataHostIo {
  fileSize: number;
  mtimeMs: number;
  readChunk: ReadChunkFn;
  saveArtwork: (data: Uint8Array, format: string) => Promise<string>;
  fileExists: (path: string) => boolean | Promise<boolean>;
}

export async function readTrackMetadataCore(path: string, io: MetadataHostIo): Promise<ParsedTrack> {
  const extension = pathExtname(path).toLowerCase();
  const fallbackTitle = pathBasename(path, extension);

  let animatedArtPath: string | null = null;
  for (const candidate of animatedArtCandidates(path)) {
    if (await io.fileExists(candidate)) {
      animatedArtPath = candidate;
      break;
    }
  }

  let hasSidecarLyrics = false;
  for (const candidate of sidecarLyricsCandidates(path)) {
    if (await io.fileExists(candidate)) {
      hasSidecarLyrics = true;
      break;
    }
  }

  let metadata: Awaited<ReturnType<typeof parseFromTokenizer>> | null = null;
  let parseError: unknown = null;
  const tokenizer = new RangeTokenizer(path, io.fileSize, io.readChunk);
  try {
    metadata = await parseFromTokenizer(tokenizer, { duration: true, skipCovers: false });
  } catch (error) {
    parseError = error;
  } finally {
    await tokenizer.close().catch(() => undefined);
  }

  if (!metadata) {
    if (parseError) {
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
      fileSize: io.fileSize,
      mtimeMs: io.mtimeMs,
      artworkFile: null,
      animatedArtPath,
      embeddedLyrics: null,
      hasSidecarLyrics,
      playable: isPlayableExtension(path),
    };
  }

  const common = metadata.common ?? ({} as any);
  const format = metadata.format ?? ({} as any);

  let artworkFile: string | null = null;
  const picture = Array.isArray(common.picture) ? common.picture[0] : null;
  if (picture?.data) {
    const bytes = picture.data instanceof Uint8Array ? picture.data : new Uint8Array(picture.data);
    artworkFile = await io.saveArtwork(bytes, picture.format ?? "image/jpeg");
  }

  return {
    path,
    title: typeof common.title === "string" && common.title.trim() ? common.title.trim() : fallbackTitle,
    artist:
      Array.isArray(common.artists) && common.artists.length > 0
        ? common.artists.join(", ")
        : common.artist || "Unknown artist",
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
    fileSize: io.fileSize,
    mtimeMs: io.mtimeMs,
    artworkFile,
    animatedArtPath,
    embeddedLyrics: lyricsFromTags(common),
    hasSidecarLyrics,
    playable: isPlayableExtension(path),
  };
}
