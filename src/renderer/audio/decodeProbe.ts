/**
 * Decode Tester probing.
 *
 * Cadence has exactly one audio decoding pipeline — Chromium's media stack behind the
 * `cadence-media` Range protocol, driven by an `<audio>` element — so the tester reuses it instead
 * of shipping a second decoder. Each file is loaded into a detached, muted `<audio>` element (the
 * shared playback element in `engine.ts` is never touched) and the probe forces real demuxing and
 * decoding at several points across the stream: the first frames (`loadeddata`), then a muted
 * playback burst after seeking to sampled positions towards the middle and the end of the file.
 * A file only passes when the decoder actually produced advancing media time at every sample.
 *
 * Files are streamed by the media protocol in bounded Range chunks; nothing loads a whole file
 * (or its decoded PCM) into memory, and scanning never writes to disk.
 *
 * Failures are classified with the same distinctions playback errors use (`codecs.ts`): a file the
 * decoder cannot reach (HTTP 403/404 from the media protocol) is "inaccessible", a codec Chromium
 * has no decoder for is "unsupported-codec", a stream that decodes at the start but dies towards
 * the end is "truncated", and only the rest are genuine "decode-error"s. A metadata (tag) reading
 * failure is never treated as a decode failure: the probe ignores tags entirely.
 */

import type { DecodeProblem, DecodeProblemKind, Track } from "../../shared/types";
import {
  codecSupport,
  explainPlaybackFailure,
  probeMediaAccessStatus,
  type MediaAccessStatus,
} from "./codecs";

export type DecodeProbeTrack = Pick<Track, "id" | "path" | "streamUrl" | "codec" | "duration">;

export const DECODE_PROBLEM_KIND_LABELS: Record<DecodeProblemKind, string> = {
  "decode-error": "Decode error",
  "unsupported-codec": "Unsupported codec",
  truncated: "Truncated or incomplete",
  inaccessible: "Inaccessible",
  timeout: "Timed out",
};

/** Fractions of the duration at which decoding is forced, in order. */
export const DECODE_SAMPLE_FRACTIONS = [0, 0.2, 0.4, 0.6, 0.8, 0.93] as const;

/**
 * Absolute sample points (seconds) for a file of the given duration. Short files collapse to
 * fewer points so a two-second jingle is not seeked four times within the same frame window.
 */
export function decodeSamplePoints(durationSeconds: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [0];
  const lastSeekable = Math.max(0, durationSeconds - 0.05);
  const points: number[] = [];
  for (const fraction of DECODE_SAMPLE_FRACTIONS) {
    const point = Math.min(fraction * durationSeconds, lastSeekable);
    if (!points.some(existing => Math.abs(existing - point) < 0.75)) {
      points.push(Math.round(point * 1000) / 1000);
    }
  }
  return points.length > 0 ? points : [0];
}

/** Basename that understands both POSIX and Windows separators (mirrors `metadataCore.pathBasename`). */
export function fileNameFromPath(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSep >= 0 ? trimmed.slice(lastSep + 1) || trimmed : trimmed;
}

/** Order-preserving de-duplication that also drops blank entries. */
export function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * The exported `.txt` contract: UTF-8, one problematic file path per line, trailing newline.
 * The Rust `cmd_decode_export_list` command writes exactly this shape after re-validating the
 * paths against the library allowlist.
 */
export function buildDecodeExportText(paths: string[]): string {
  const unique = dedupePaths(paths);
  return unique.length === 0 ? "" : `${unique.join("\n")}\n`;
}

export interface DecodeFailureInfo {
  /** `HTMLMediaElement.error.code`, when the element reported one. */
  code?: number | null;
  mediaMessage?: string | null;
  /** HTTP status of a one-byte Range probe of the stream URL (`probeMediaAccessStatus`). */
  httpStatus?: MediaAccessStatus;
  timedOut?: boolean;
  /** Playback reached `ended` long before the reported duration. */
  prematureEnd?: boolean;
  /** The media clock leapt forward discontinuously: the decoder skipped undecodable audio. */
  skippedAhead?: boolean;
  /** Position (seconds) the probe had reached when decoding failed. */
  atSeconds?: number | null;
  durationSeconds?: number | null;
  /** Earlier sample points decoded fine, so the failure is local to later audio data. */
  decodedEarlierSamples?: boolean;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Maps a raw probe failure to a problem kind plus a user-facing message, keeping file-access
 * failures, unsupported codecs and genuine corruption apart (same rules as playback errors).
 */
export function classifyDecodeFailure(
  track: { codec?: string | null; path?: string | null },
  info: DecodeFailureInfo
): { kind: DecodeProblemKind; message: string } {
  const code = info.code ?? null;
  const status = info.httpStatus ?? null;
  const mediaMessage = info.mediaMessage ?? null;

  if (status === 403 || status === 404 || status === "network-error" || (typeof status === "number" && status >= 400)) {
    return {
      kind: "inaccessible",
      message: explainPlaybackFailure(code ?? 4, track, { httpStatus: status, mediaMessage }),
    };
  }
  if (code === 2) {
    return {
      kind: "inaccessible",
      message: "The file could not be read from disk. It may have been moved, renamed or disconnected.",
    };
  }

  const support = codecSupport(track);
  const noSupportedStreams = /no_supported_streams/i.test(mediaMessage ?? "");
  if (noSupportedStreams || (support === "unsupported" && (code === 3 || code === 4))) {
    const codecName = track.codec?.trim() || "This file's codec";
    return {
      kind: "unsupported-codec",
      message:
        support === "unsupported"
          ? explainPlaybackFailure(4, track, { httpStatus: 206, mediaMessage: mediaMessage ?? "DEMUXER_ERROR_NO_SUPPORTED_STREAMS" })
          : `${codecName} has no supported audio stream for Chromium's built-in media stack. Convert the file to FLAC or WAV to play it in Cadence.`,
    };
  }

  const atSeconds = info.atSeconds ?? null;
  const durationSeconds = info.durationSeconds ?? null;
  const failedNearEnd =
    atSeconds !== null && durationSeconds !== null && durationSeconds > 0 && atSeconds >= durationSeconds * 0.8;
  if (info.prematureEnd || (info.decodedEarlierSamples && failedNearEnd)) {
    return {
      kind: "truncated",
      message:
        atSeconds !== null && durationSeconds
          ? `Decoding stopped at ${formatClock(atSeconds)} of ${formatClock(durationSeconds)}. The file may be truncated or corrupt near the end.`
          : "Decoding stopped before the end of the file. The file may be truncated or corrupt near the end.",
    };
  }

  if (info.skippedAhead) {
    return {
      kind: "decode-error",
      message:
        atSeconds !== null && durationSeconds
          ? `The decoder skipped over undecodable audio at ${formatClock(atSeconds)} of ${formatClock(durationSeconds)}. The file may be corrupt.`
          : "The decoder skipped over undecodable audio. The file may be corrupt.",
    };
  }

  if (info.timedOut) {
    return {
      kind: "timeout",
      message: "Timed out waiting for decoded audio. The file may be corrupt, truncated or on a very slow disk.",
    };
  }

  if (code === 1) {
    return { kind: "decode-error", message: "Decoding was interrupted before any audio was produced." };
  }

  return {
    kind: "decode-error",
    message: explainPlaybackFailure(code ?? 4, track, { httpStatus: status, mediaMessage }),
  };
}

// ---------------------------------------------------------------------------
// The probe itself
// ---------------------------------------------------------------------------

export interface DecodeProbeOptions {
  signal?: AbortSignal;
  loadTimeoutMs?: number;
  sampleTimeoutMs?: number;
  /** Media seconds that must actually play (decode) at every sample point. */
  minAdvanceSeconds?: number;
  playbackRate?: number;
  createElement?: () => HTMLAudioElement;
  fetchImpl?: typeof fetch;
}

export type DecodeProbeResult = { ok: true } | { ok: false; kind: DecodeProblemKind; message: string };

class ProbeTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for decoded audio");
    this.name = "ProbeTimeoutError";
  }
}

class ProbeMediaError extends Error {
  prematureEnd: boolean;
  skippedAhead: boolean;
  /** Media position where decoding broke, when more precise than the sample point. */
  atSeconds: number | null;
  constructor(message: string, options: { prematureEnd?: boolean; skippedAhead?: boolean; atSeconds?: number } = {}) {
    super(message);
    this.name = "ProbeMediaError";
    this.prematureEnd = options.prematureEnd ?? false;
    this.skippedAhead = options.skippedAhead ?? false;
    this.atSeconds = options.atSeconds ?? null;
  }
}

function abortError(): Error {
  const error = new Error("Decode scan canceled");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error as Error | null)?.name === "AbortError";
}

/** Resolves with the first of `events` (or `"error"`) to fire; rejects on timeout/abort. */
function waitForMediaEvent(
  element: HTMLAudioElement,
  events: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const wanted = [...events, "error"];
    const cleanup = () => {
      window.clearTimeout(timer);
      for (const event of wanted) element.removeEventListener(event, handler);
      signal?.removeEventListener("abort", onAbort);
    };
    const handler = (event: Event) => {
      cleanup();
      resolve(event.type);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new ProbeTimeoutError());
    }, timeoutMs);
    for (const event of wanted) element.addEventListener(event, handler);
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Waits until the element's media clock has advanced by `advanceSeconds` (proof that frames were
 * decoded and rendered), the stream ends, an error surfaces, or the deadline passes.
 *
 * The clock is also watched for discontinuities: when Chromium meets a region it cannot decode it
 * commonly leaps `currentTime` past the hole (or straight to the reported duration and ends).
 * Real playback can never advance the media clock faster than `playbackRate × wall time`, so a
 * leap beyond that — measured against the actual elapsed wall time between polls, which keeps
 * main-thread stalls from looking like leaps — means frames were skipped, not decoded.
 */
function waitForAdvance(
  element: HTMLAudioElement,
  fromSeconds: number,
  advanceSeconds: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<"advanced" | "ended"> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;
    let lastWall = performance.now();
    let lastTime = element.currentTime;
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      window.clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = window.setInterval(() => {
      const now = performance.now();
      const wallDeltaSeconds = (now - lastWall) / 1000;
      const position = element.currentTime;
      const mediaDeltaSeconds = position - lastTime;
      const positionBeforePoll = lastTime;
      lastWall = now;
      lastTime = position;

      if (element.error) {
        cleanup();
        reject(new ProbeMediaError(element.error.message || "Media error", { atSeconds: position }));
        return;
      }
      const rate = element.playbackRate > 0 ? element.playbackRate : 1;
      if (mediaDeltaSeconds > wallDeltaSeconds * rate * 2.2 + 0.2) {
        cleanup();
        reject(
          new ProbeMediaError("Decoder skipped over undecodable audio", {
            skippedAhead: true,
            atSeconds: positionBeforePoll,
          })
        );
        return;
      }
      if (element.ended) {
        cleanup();
        resolve("ended");
        return;
      }
      if (position >= fromSeconds + advanceSeconds) {
        cleanup();
        resolve("advanced");
        return;
      }
      if (now >= deadline) {
        cleanup();
        reject(new ProbeTimeoutError());
      }
    }, 30);
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Decodes one track through a throwaway muted `<audio>` element. Rejects only on cancellation;
 * every decode failure resolves as `{ ok: false, … }` so one bad file cannot abort a scan.
 */
export async function probeTrackDecode(
  track: DecodeProbeTrack,
  options: DecodeProbeOptions = {}
): Promise<DecodeProbeResult> {
  if (!track.streamUrl) {
    return { ok: false, kind: "inaccessible", message: "The file has no playable stream in the library." };
  }
  const signal = options.signal;
  const loadTimeoutMs = options.loadTimeoutMs ?? 20_000;
  const sampleTimeoutMs = options.sampleTimeoutMs ?? 10_000;
  const minAdvanceSeconds = options.minAdvanceSeconds ?? 0.5;
  const element = options.createElement ? options.createElement() : new Audio();

  let atSeconds: number | null = 0;
  let durationSeconds: number | null = track.duration > 0 ? track.duration : null;
  let decodedEarlierSamples = false;

  try {
    element.preload = "auto";
    // Muted and zero-volume: the decoder pipeline still runs (muting happens at the output), and
    // muted playback is exempt from autoplay gestures. The element is never added to the DOM or
    // the WebAudio graph, so ongoing playback is undisturbed.
    element.muted = true;
    element.volume = 0;
    element.crossOrigin = "anonymous";
    element.playbackRate = options.playbackRate ?? 8;
    element.src = track.streamUrl;
    element.load();

    const loaded = await waitForMediaEvent(element, ["loadeddata", "canplay"], loadTimeoutMs, signal);
    if (loaded === "error") throw new ProbeMediaError(element.error?.message || "Media error");

    if (Number.isFinite(element.duration) && element.duration > 0) {
      durationSeconds = element.duration;
    }
    const points = decodeSamplePoints(durationSeconds ?? 0);

    for (let index = 0; index < points.length; index++) {
      if (signal?.aborted) throw abortError();
      const point = points[index];
      atSeconds = point;
      decodedEarlierSamples = index > 0;

      if (point > 0.01) {
        element.currentTime = point;
        const seeked = await waitForMediaEvent(element, ["seeked"], sampleTimeoutMs, signal);
        if (seeked === "error") throw new ProbeMediaError(element.error?.message || "Media error");
      }

      const before = element.currentTime;
      let playbackBlocked = false;
      try {
        await element.play();
      } catch (error) {
        if (element.error) throw new ProbeMediaError(element.error.message || "Media error");
        if ((error as Error)?.name === "NotAllowedError") {
          // Autoplay policy refused even muted playback. The seek + `loadeddata` above already
          // forced the demuxer/decoder to produce frames at this point, so do not fail the file.
          playbackBlocked = true;
        } else {
          throw new ProbeMediaError((error as Error)?.message || "Playback failed to start");
        }
      }

      if (!playbackBlocked) {
        const outcome = await waitForAdvance(element, before, minAdvanceSeconds, sampleTimeoutMs, signal);
        element.pause();
        if (outcome === "ended") {
          // Reaching `ended` is only a pass when there was barely a burst's worth of audio left to
          // play. A truncated file makes Chromium jump `currentTime` to the *reported* duration
          // and end from almost anywhere, so the element's final position proves nothing — what
          // matters is where this burst started.
          const remaining = durationSeconds !== null && durationSeconds > 0 ? durationSeconds - before : 0;
          if (remaining > minAdvanceSeconds + 0.35) {
            atSeconds = before;
            throw new ProbeMediaError("Stream ended before its reported duration", { prematureEnd: true });
          }
          break;
        }
      }
      decodedEarlierSamples = true;
    }

    return { ok: true };
  } catch (error) {
    if (isAbortError(error, signal)) throw abortError();
    const httpStatus = await probeMediaAccessStatus(track.streamUrl, options.fetchImpl).catch(() => null);
    const mediaError = error instanceof ProbeMediaError ? error : null;
    const { kind, message } = classifyDecodeFailure(track, {
      code: element.error?.code ?? null,
      mediaMessage: element.error?.message || (error as Error)?.message || null,
      httpStatus,
      timedOut: error instanceof ProbeTimeoutError,
      prematureEnd: mediaError?.prematureEnd ?? false,
      skippedAhead: mediaError?.skippedAhead ?? false,
      atSeconds: mediaError?.atSeconds ?? atSeconds,
      durationSeconds,
      decodedEarlierSamples,
    });
    return { ok: false, kind, message };
  } finally {
    try {
      element.pause();
      element.removeAttribute("src");
      element.load();
    } catch {
      /* the element is disposable; cleanup must never throw into the scan */
    }
  }
}

// ---------------------------------------------------------------------------
// Whole-library scan orchestration (probe injectable for tests)
// ---------------------------------------------------------------------------

export interface DecodeScanProgress {
  scanned: number;
  total: number;
  problems: DecodeProblem[];
}

export interface DecodeScanOutcome extends DecodeScanProgress {
  canceled: boolean;
}

export type DecodeProbeFn = (track: DecodeProbeTrack, signal?: AbortSignal) => Promise<DecodeProbeResult>;

export function problemFromTrack(
  track: DecodeProbeTrack,
  failure: { kind: DecodeProblemKind; message: string }
): DecodeProblem {
  return {
    trackId: typeof track.id === "number" ? track.id : null,
    path: track.path,
    fileName: fileNameFromPath(track.path),
    kind: failure.kind,
    message: failure.message,
    codec: track.codec ?? "",
  };
}

/**
 * Probes every unique track path with a small worker pool. Individual failures (including a probe
 * that throws unexpectedly) are recorded and the scan moves on; cancellation stops between files
 * and reports the partial results gathered so far.
 */
export async function runDecodeScan(
  tracks: DecodeProbeTrack[],
  probe: DecodeProbeFn,
  options: {
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (progress: DecodeScanProgress) => void;
  } = {}
): Promise<DecodeScanOutcome> {
  const seen = new Set<string>();
  const unique: DecodeProbeTrack[] = [];
  for (const track of tracks) {
    if (!track.path || seen.has(track.path)) continue;
    seen.add(track.path);
    unique.push(track);
  }

  const total = unique.length;
  const problems: DecodeProblem[] = [];
  let scanned = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < total) {
      if (options.signal?.aborted) return;
      const track = unique[cursor++];
      let result: DecodeProbeResult;
      try {
        result = await probe(track, options.signal);
      } catch (error) {
        if (isAbortError(error, options.signal)) return;
        result = {
          ok: false,
          kind: "decode-error",
          message: `Decoder probe failed: ${(error as Error)?.message ?? String(error)}`,
        };
      }
      scanned += 1;
      if (!result.ok) problems.push(problemFromTrack(track, result));
      options.onProgress?.({ scanned, total, problems: [...problems] });
    }
  };

  const workerCount = Math.max(1, Math.min(options.concurrency ?? 3, total || 1));
  await Promise.all(Array.from({ length: workerCount }, worker));

  return { problems, scanned, total, canceled: Boolean(options.signal?.aborted) };
}
