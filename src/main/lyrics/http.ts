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

/**
 * Central, process-wide concurrency limiter for provider work. Autofetch, Fetch All and manual
 * searches all run their provider modules through the single instance owned by
 * `LyricsServiceCore`, so the total number of provider requests in flight is bounded no matter
 * how many consumers ask at once. Queued work is FIFO; raising the limit immediately releases
 * queued runners, lowering it lets in-flight work finish.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private max: number) {}

  get limit(): number {
    return this.max;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  setLimit(max: number): void {
    this.max = Math.max(1, Math.floor(max) || 1);
    this.pump();
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    // Fast path: with a free slot the task starts *synchronously*, exactly as an unlimited
    // call would. Provider abort wiring depends on this: a caller that aborts in the same
    // tick must find the request already listening for the abort, not queued behind a
    // microtask with an already-aborted signal it never sees fire.
    if (this.active < this.max && this.queue.length === 0) {
      this.active += 1;
      let result: Promise<T>;
      try {
        result = Promise.resolve(task());
      } catch (error) {
        result = Promise.reject(error);
      }
      return result.finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
    return this.runQueued(task);
  }

  private async runQueued<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max && this.queue.length === 0) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private pump(): void {
    while (this.active < this.max && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/**
 * Provider-request parallelism per Settings preset. Deliberately small: the four provider
 * modules fan out per track, so even "high" stays well below anything that could resemble
 * hundreds of simultaneous requests, and low-memory systems stay responsive.
 */
export const FETCH_CONCURRENCY_PRESETS = {
  low: { providerRequests: 2, parallelTracks: 1 },
  balanced: { providerRequests: 4, parallelTracks: 2 },
  high: { providerRequests: 8, parallelTracks: 4 },
} as const;

/** True when an error must abort the whole resolve rather than fall through to the next provider. */
export function isAbort(error: unknown): boolean {
  return (error as Error)?.name === "AbortError" || (error instanceof LyricsHttpError && error.kind === "aborted");
}
