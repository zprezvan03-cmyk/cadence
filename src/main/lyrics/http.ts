/**
 * Small HTTP layer for the network lyrics providers.
 *
 * In Tauri desktop builds, `runtimeFetch` delegates to the native Rust `reqwest` command so
 * external APIs receive proper `User-Agent` / `Lrclib-Client` headers without WebView2 CORS limits;
 * in unit tests it defaults to `globalThis.fetch`. Uses no credentials or private keys, and gives
 * each request a bounded timeout combined with the caller's abort signal for track-change cancels.
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
  retryAfterSeconds?: number;
}

export interface ProviderOutcome {
  candidates: LyricsCandidate[];
  statuses: ProviderStatus[];
}

export const CLIENT_NAME =
  "Cadence Player v0.2.2 (https://github.com/zprezvan03-cmyk/betterlyrics-standalone)";

export type RuntimeFetch = typeof fetch;

let activeFetch: RuntimeFetch = (...args) => globalThis.fetch(...args);

/**
 * Installs a runtime HTTP transport (e.g. Tauri's native Rust `reqwest` command so external APIs
 * receive proper User-Agent / Lrclib-Client headers without WebView2 CORS restrictions). Defaults
 * to `globalThis.fetch` so Vitest `vi.stubGlobal("fetch", ...)` continues working seamlessly.
 */
export function setRuntimeFetch(fn: RuntimeFetch): void {
  activeFetch = fn;
}

export function runtimeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return activeFetch(input, init);
}

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
export async function getJson(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>
): Promise<JsonResponse> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await runtimeFetch(url, {
      headers: { Accept: "application/json", "User-Agent": CLIENT_NAME, ...extraHeaders },
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw new LyricsHttpError("Request aborted", "aborted");
    const name = (error as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError" || timeout.aborted) {
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

/** GET a plain-text document (e.g. a TTML file behind a storage URL), with the same error model. */
export async function getText(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ status: number; ok: boolean; headers: Headers; text: string }> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new LyricsHttpError("Refusing to fetch a non-http(s) URL", "malformed");
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await runtimeFetch(target.toString(), {
      headers: { Accept: "text/plain, application/xml, */*", "User-Agent": CLIENT_NAME },
      signal: combined,
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, headers: response.headers, text };
  } catch (error) {
    if (signal?.aborted) throw new LyricsHttpError("Request aborted", "aborted");
    const name = (error as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError" || timeout.aborted) {
      throw new LyricsHttpError("Request timed out", "timeout");
    }
    throw new LyricsHttpError((error as Error).message || "Network request failed", "network");
  }
}

export function retryAfter(headers: Headers): number | undefined {
  const raw = headers.get("Retry-After")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const parsedDate = Date.parse(raw);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, Math.ceil((parsedDate - Date.now()) / 1000));
  }
  return undefined;
}

/** Maps an HTTP error to a user-facing status detail, keeping rate limits distinct from misses. */
export function describeHttpError(error: unknown): {
  status: ProviderStatusKind;
  detail: string;
  retryAfterSeconds?: number;
} {
  if (error instanceof LyricsHttpError) {
    switch (error.kind) {
      case "rate-limit":
        return {
          status: "error",
          detail: error.retryAfterSeconds
            ? `Rate limited; retry after ${error.retryAfterSeconds}s`
            : "Rate limited",
          retryAfterSeconds: error.retryAfterSeconds,
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
