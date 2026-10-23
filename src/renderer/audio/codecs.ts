/**
 * Which containers and codecs the Chromium media stack inside Electron can actually decode.
 *
 * This is not a guess: each entry was checked by loading a real encoded file through the app's own
 * `<audio>` element in the browser harness (`tests/browser/run-app.mjs`, one `format-*` check per
 * format). Anything outside this table is reported to the user as unsupported instead of failing
 * with a bare "Playback failed".
 */

export type CodecSupport = "supported" | "unsupported" | "unknown";

/** Codecs that Chromium's bundled FFmpeg demuxer/decoder refuses. */
const UNSUPPORTED_CODECS = [
  "alac", // Apple Lossless: FFmpegDemuxer reports "no supported streams"
  "ape", // Monkey's Audio
  "wavpack",
  "dsd",
  "dsf",
  "wma",
  "aiff",
];

const SUPPORTED_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".aac", ".mp4", ".wav", ".ogg", ".oga", ".opus", ".webm"]);

export function codecSupport(track: { codec?: string | null; path?: string | null }): CodecSupport {
  const codec = (track.codec ?? "").toLowerCase();
  if (!codec) return "unknown";
  for (const unsupported of UNSUPPORTED_CODECS) {
    if (codec.includes(unsupported)) return "unsupported";
  }
  return "supported";
}

export function extensionSupported(path: string | null | undefined): boolean {
  if (!path) return true;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return true;
  return SUPPORTED_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * Human explanation for a decode failure, so a user can act on it rather than guess.
 * `code` is `HTMLMediaElement.error.code`.
 */
export function explainPlaybackFailure(code: number | null, track: { codec?: string | null; path?: string | null } | null): string {
  const codecName = track?.codec?.trim() || "This file";
  const support = codecSupport(track ?? {});
  if (code === 4 || code === 3) {
    if (support === "unsupported") {
      return `${codecName} is not decodable by Chromium's built-in media stack. Convert the file to FLAC or WAV to play it in Cadence.`;
    }
    return `This file could not be decoded (${codecName}). It may be corrupt, truncated or use an unsupported codec.`;
  }
  if (code === 2) return "The file could not be read from disk. It may have been moved, renamed or disconnected.";
  if (code === 1) return "Playback was interrupted. Press play to continue.";
  return "Playback failed.";
}
