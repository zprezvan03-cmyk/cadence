/**
 * Binary transport for artist profile pictures.
 *
 * The shared resolver only cares about "bytes in, bytes out", but the generic Tauri transport
 * (`src/main/lyrics/http.ts`) is text-based: it returns the response body as a `String`, which is
 * exactly right for the JSON APIs it was written for and destroys binary payloads (invalid UTF-8
 * becomes U+FFFD, so a JPEG no longer starts with `FF D8` and the validator rejects a perfectly good
 * portrait). Every image therefore goes through `cmd_http_fetch_image`, which returns the body over
 * the binary IPC channel unchanged and reports the HTTP status through its error string.
 *
 * Keeping the mapping here (rather than inline in the bridge) means the whole "what reaches the
 * validator" question is testable without a Tauri runtime.
 */

import type { ArtistImageFetchFn, ArtistImageFetchResponse } from "../../shared/artistImageService";

/** The subset of Tauri's `invoke` this module needs. */
export type ImageInvoke = (command: string, payload: Record<string, unknown>) => Promise<unknown>;

export interface ArtistImageFetchOptions {
  /** Per-request ceiling; the Rust side clamps to 0.5–300 s. */
  timeoutMs?: number;
  /** Request-id namespace, used by the abort channel. */
  requestIdPrefix?: string;
  /** Extra headers (a descriptive User-Agent is sent by the Rust client already). */
  headers?: Record<string, string>;
}

export const DEFAULT_ARTIST_IMAGE_FETCH_TIMEOUT_MS = 20_000;

const HTTP_STATUS_ERROR = /^HTTP:(\d{3})$/;

/**
 * Normalizes whatever an `IpcResponse` returns into bytes. Tauri hands back an `ArrayBuffer`, but
 * mocks, older bridges and the scanner's chunk reader also see `Uint8Array` views and plain arrays,
 * and a lossy conversion here is precisely the bug this module exists to prevent.
 */
export function toByteArray(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  throw new TypeError("Unsupported image payload");
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    /* fall through */
  }
  return String(error ?? "");
}

/**
 * Builds the download function the artist-image service uses. Transport failures keep the same
 * vocabulary as the rest of the app (`AbortError`, `TimeoutError`, `TypeError` with an `NETWORK:`
 * prefix stripped), and a non-2xx answer becomes an ordinary `{ ok: false, status }` response so the
 * pipeline can record a precise reason instead of a generic download failure.
 */
export function createArtistImageFetch(
  invoke: ImageInvoke,
  options: ArtistImageFetchOptions = {}
): ArtistImageFetchFn {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ARTIST_IMAGE_FETCH_TIMEOUT_MS;
  const prefix = options.requestIdPrefix ?? "artist-image";
  const headers = { Accept: "image/*", ...options.headers };
  let counter = 0;

  return async (url, signal): Promise<ArtistImageFetchResponse> => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const requestId = `${prefix}-${counter++}`;
    const onAbort = () => {
      void Promise.resolve(invoke("cmd_http_abort", { requestId })).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const raw = await invoke("cmd_http_fetch_image", {
        args: { requestId, url, headers, timeoutMs },
      });
      return {
        ok: true,
        status: 200,
        // No body header survives the binary channel; the validator sniffs the real format from the
        // magic bytes, which is the check that matters anyway.
        contentType: null,
        bytes: toByteArray(raw),
      };
    } catch (error) {
      const message = describeThrown(error);
      const status = HTTP_STATUS_ERROR.exec(message.trim());
      if (status) {
        return { ok: false, status: Number(status[1]), contentType: null, bytes: new Uint8Array(0) };
      }
      if (signal?.aborted || message.includes("ABORTED")) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (message.includes("TIMEOUT")) {
        throw new DOMException("Request timed out", "TimeoutError");
      }
      throw new TypeError(message.replace(/^NETWORK:\s*/, "") || "Network request failed");
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
