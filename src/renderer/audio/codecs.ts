/**
 * Which containers and codecs the Chromium media stack inside Electron can actually decode.
 *
 * This is not a guess: each entry was checked by loading a real encoded file through the app's own
 * `<audio>` element in the browser harness (`tests/browser/run-app.mjs`, one `format-*` check per
 * format). Anything outside this table is reported to the user as unsupported instead of failing
 * with a bare "Playback failed".
 */

export type CodecSupport = "supported" | "unsupported" | "unknown";

export type MediaAccessStatus = number | "network-error" | null;

export interface PlaybackFailureContext {
  httpStatus?: MediaAccessStatus;
  mediaMessage?: string | null;
}

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
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot <= slash) return true;
  return SUPPORTED_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * True when Chromium's media error string comes from the demuxer/decoder pipeline (meaning the
 * stream was reachable and readable, rather than failing an allowlist or filesystem open).
 */
export function isDecoderOrDemuxerMessage(mediaMessage: string | null | undefined): boolean {
  if (!mediaMessage) return false;
  return /demuxer_error|decoder_error|audio_renderer_error|pipelinestatus|ffmpegdemuxer/i.test(mediaMessage);
}

/**
 * Probes the stream URL on playback failure so HTTP 403 (allowlist rejection) and HTTP 404
 * (missing file) are never misclassified as unsupported-codec or corrupt-file errors.
 */
export async function probeMediaAccessStatus(
  url: string | null | undefined,
  fetchImpl: typeof fetch | undefined = globalThis.fetch
): Promise<MediaAccessStatus> {
  if (!url || typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
    });
    void response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch {
    return "network-error";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Human explanation for a playback failure, keeping file-access errors (403/404/network) distinct
 * from unsupported-codec and corrupt-stream failures. `code` is `HTMLMediaElement.error.code`.
 */
export function explainPlaybackFailure(
  code: number | null,
  track: { codec?: string | null; path?: string | null } | null,
  context?: PlaybackFailureContext
): string {
  const status = context?.httpStatus ?? null;
  if (status === 403) {
    return "Access to this file was blocked because it is outside your configured music folders.";
  }
  if (status === 404) {
    return "The file could not be read from disk. It may have been moved, renamed or disconnected.";
  }
  if (status === "network-error" || (typeof status === "number" && status >= 400)) {
    return "The file could not be read from disk. It may have been moved, renamed or disconnected.";
  }

  const codecName = track?.codec?.trim() || "This file";
  const support = codecSupport(track ?? {});
  if (code === 4 || code === 3) {
    const mediaMessage = context?.mediaMessage ?? null;
    // Chromium surfaces HTTP 403/404 and unreadable streams on `<audio>` as code 4 with
    // "MEDIA_ELEMENT_ERROR: Format error" rather than a demuxer/decoder pipeline error.
    const confirmedReadable = typeof status === "number" && status >= 200 && status < 300;
    if (!confirmedReadable && mediaMessage && /media_element_error:\s*format error/i.test(mediaMessage)) {
      return "The file could not be read from disk. It may have been moved, renamed or blocked.";
    }
    if (support === "unsupported") {
      return `${codecName} is not decodable by Chromium's built-in media stack. Convert the file to FLAC or WAV to play it in Cadence.`;
    }
    return `This file could not be decoded (${codecName}). It may be corrupt, truncated or use an unsupported codec.`;
  }
  if (code === 2) return "The file could not be read from disk. It may have been moved, renamed or disconnected.";
  if (code === 1) return "Playback was interrupted. Press play to continue.";
  return "Playback failed.";
}
