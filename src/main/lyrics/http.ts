/**
 * Small HTTP layer for the network lyrics providers.
 *
 * All lyrics traffic runs in the Electron main process (never the renderer), uses no credentials
 * and carries a client identifier instead of an API key. Each request gets its own timeout,
 * combined with the caller's abort signal so track changes can cancel in-flight work. Written for
 * Cadence.
 */

import type { LyricsCandidate } from "../../shared/types";

export interface ProviderQuery {
  title: string;
  artist: string;
  album: string;
  duration: number;
}

export type ProviderStatusKind = "hit" | "miss" | "error" | "skipped";

export interface ProviderStatus {
  provider: string;
  status: ProviderStatusKind;
  detail?: string;
}

export interface ProviderOutcome {
  candidates: LyricsCandidate[];
  statuses: ProviderStatus[];
}

export const CLIENT_NAME =
  "Cadence Player v0.1.0 (https://github.com/zprezvan03-cmyk/betterlyrics-standalone)";

export class LyricsHttpError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "network" | "rate-limit" | "server" | "malformed" | "aborted",
    readonly httpStatus?: number,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "LyricsHttpError";
  }
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  json: unknown;
}

/**
 * GET a JSON document. 404/401/429/5xx are returned as normal responses (the provider clients map
 * them to misses/errors themselves); transport failures, timeouts and malformed JSON become
 * {@link LyricsHttpError} with a classified `kind`.
 */
export async function getJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<JsonResponse> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": CLIENT_NAME },
      signal: combined,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      if (signal?.aborted) throw new LyricsHttpError("Request aborted", "aborted");
      throw new LyricsHttpError("Request timed out", "timeout");
    }
    throw new LyricsHttpError((error as Error).message || "Network request failed", "network");
  }

  const text = await response.text();
  let json: unknown = null;
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new LyricsHttpError("Malformed JSON response", "malformed", response.status);
      }
      // Error bodies may be plain text (e.g. 429/422); keep the status and treat the body as absent.
      json = null;
    }
  }
  return { status: response.status, ok: response.ok, headers: response.headers, json };
}

export function retryAfter(headers: Headers): number | undefined {
  const raw = headers.get("Retry-After");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Maps an HTTP error to a user-facing status detail, keeping rate limits distinct from misses. */
export function describeHttpError(error: unknown): { status: ProviderStatusKind; detail: string } {
  if (error instanceof LyricsHttpError) {
    switch (error.kind) {
      case "rate-limit":
        return {
          status: "error",
          detail: error.retryAfterSeconds
            ? `Rate limited; retry after ${error.retryAfterSeconds}s`
            : "Rate limited",
        };
      case "timeout":
        return { status: "error", detail: "Request timed out" };
      case "network":
        return { status: "error", detail: `Network error: ${error.message}` };
      case "malformed":
        return { status: "error", detail: "Malformed response" };
      case "server":
        return { status: "error", detail: `Server error (${error.httpStatus ?? "?"})` };
      case "aborted":
        throw error;
    }
  }
  if ((error as Error)?.name === "AbortError") throw error;
  return { status: "error", detail: (error as Error)?.message || "Request failed" };
}

/** True when an error must abort the whole resolve rather than fall through to the next provider. */
export function isAbort(error: unknown): boolean {
  return (error as Error)?.name === "AbortError" || (error instanceof LyricsHttpError && error.kind === "aborted");
}
