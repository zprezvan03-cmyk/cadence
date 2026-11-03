/**
 * Cadence's InnerTube client for YouTube Music.
 *
 * Architectural reference: ArchiveTune's `InnerTube.kt` / `YouTubeClient.kt`
 * (rukamori/ArchiveTune @ c7f0e243c637e039bce4b92fecdf7179804114fb, core submodule
 * rukamori/core @ fefeefa4a8e74d80b262ad944f5adca6b1a897f7, both GPL-3.0). The endpoint names,
 * client profile fields and context shape are interface facts of YouTube's InnerTube API; all
 * code here is original TypeScript written for Cadence — no upstream code is copied.
 *
 * Transport goes through `runtimeFetch` (src/main/lyrics/http.ts): in the desktop app that is the
 * native Rust `cmd_http_fetch` (reqwest), which is what makes these calls CORS-free; in tests it
 * is a stubbed `fetch`. No request leaves the app except to `music.youtube.com` / `www.youtube.com`.
 *
 * Compliance stance (deliberate deviations from ArchiveTune, per project policy):
 *  - Guest mode uses only an anonymous visitor-data context. No account cookie is required.
 *  - A connected account's cookie is forwarded VERBATIM as a `Cookie` header. Cadence never
 *    derives SAPISID/SAPISIDHASH authorization, never mints PO tokens, and never initializes
 *    BotGuard — those are bot-detection mechanisms and are out of scope.
 *  - The `player` endpoint is called with a plain context (no `serviceIntegrityDimensions`), and
 *    ciphered `signatureCipher` stream URLs are reported as unusable rather than deciphered.
 */

import { runtimeFetch } from "../lyrics/http";

/** Pinned client profile, mirroring ArchiveTune's WEB_REMIX profile (YouTube Music web client). */
export interface InnerTubeClientProfile {
  clientName: string;
  clientVersion: string;
  clientId: string;
  userAgent: string;
  origin: string;
  referer: string;
}

export const WEB_REMIX_PROFILE: InnerTubeClientProfile = {
  clientName: "WEB_REMIX",
  clientVersion: "1.20260707.12.00",
  clientId: "67",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
  origin: "https://music.youtube.com",
  referer: "https://music.youtube.com/",
};

export interface InnerTubeSession {
  /** Anonymous visitor id (regex ^Cg[t|s]). Not a credential; safe in ordinary settings. */
  visitorData: string | null;
  /**
   * Optional connected-account cookie, forwarded verbatim. Stored only in the OS secret store,
   * never in settings JSON, never logged, never sent anywhere except music.youtube.com.
   */
  cookie: string | null;
  gl: string;
  hl: string;
}

export const DEFAULT_SESSION: InnerTubeSession = {
  visitorData: null,
  cookie: null,
  gl: "US",
  hl: "en",
};

export type InnerTubeErrorKind = "http" | "network" | "timeout" | "aborted" | "malformed";

export class InnerTubeError extends Error {
  constructor(
    message: string,
    readonly kind: InnerTubeErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = "InnerTubeError";
  }
}

export interface PostOptions {
  params?: Record<string, string>;
  signal?: AbortSignal;
  /** Override the session cookie for this call only (never persisted). */
  cookie?: string | null;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const VISITOR_DATA_PATTERN = /^Cg[t|s]/;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class InnerTubeClient {
  private session: InnerTubeSession;
  private readonly fetchImpl: typeof fetch;

  constructor(session: InnerTubeSession = DEFAULT_SESSION, fetchImpl: typeof fetch = runtimeFetch) {
    this.session = { ...session };
    this.fetchImpl = fetchImpl;
  }

  getSession(): InnerTubeSession {
    return { ...this.session };
  }

  setSession(patch: Partial<InnerTubeSession>): void {
    this.session = { ...this.session, ...patch };
  }

  context(includeVisitorData = true): JsonRecord {
    const { clientName, clientVersion } = WEB_REMIX_PROFILE;
    const client: JsonRecord = {
      clientName,
      clientVersion,
      gl: this.session.gl,
      hl: this.session.hl,
    };
    if (includeVisitorData && this.session.visitorData) {
      client.visitorData = this.session.visitorData;
    }
    return {
      context: {
        client,
        request: { useSsl: true },
        user: { lockedSafetyMode: false },
      },
    };
  }

  private apiUrl(endpoint: string, params?: Record<string, string>): string {
    const url = new URL(`${WEB_REMIX_PROFILE.origin}/youtubei/v1/${endpoint}`);
    url.searchParams.set("prettyPrint", "false");
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private headers(cookie: string | null, includeVisitorData: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": this.session.hl,
      "X-Goog-Api-Format-Version": "1",
      "X-YouTube-Client-Name": WEB_REMIX_PROFILE.clientId,
      "X-YouTube-Client-Version": WEB_REMIX_PROFILE.clientVersion,
      "X-Origin": WEB_REMIX_PROFILE.origin,
      Referer: WEB_REMIX_PROFILE.referer,
      "User-Agent": WEB_REMIX_PROFILE.userAgent,
    };
    if (includeVisitorData && this.session.visitorData) {
      headers["X-Goog-Visitor-Id"] = this.session.visitorData;
    }
    // Connected account: verbatim cookie only. No SAPISIDHASH, no PO token, no BotGuard.
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  /** POST a JSON body to a youtubei endpoint and return the parsed response. */
  async post(endpoint: string, body: JsonRecord, options: PostOptions = {}): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.apiUrl(endpoint, options.params), {
        method: "POST",
        headers: this.headers(options.cookie ?? this.session.cookie, true),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (options.signal?.aborted) throw new InnerTubeError("Request aborted", "aborted");
      if (response.status === 401 || response.status === 403) {
        throw new InnerTubeError(
          `YouTube Music rejected the request (HTTP ${response.status})`,
          "http",
          response.status
        );
      }
      if (!response.ok) {
        throw new InnerTubeError(
          `YouTube Music request failed (HTTP ${response.status})`,
          "http",
          response.status
        );
      }
      const text = await response.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new InnerTubeError("YouTube Music returned malformed JSON", "malformed", response.status);
      }
    } catch (error) {
      if (options.signal?.aborted || controller.signal.aborted) {
        throw new InnerTubeError("Request aborted", "aborted");
      }
      if (error instanceof InnerTubeError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new InnerTubeError("Request timed out", "timeout");
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new InnerTubeError("Request timed out", "timeout");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new InnerTubeError(`Network error: ${message}`, "network");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Extract the anonymous visitor id from any InnerTube response's responseContext. */
  static visitorDataFromResponse(json: unknown): string | null {
    if (!isRecord(json)) return null;
    const params = (json.responseContext as JsonRecord | undefined)?.serviceTrackingParams;
    if (!Array.isArray(params)) return null;
    for (const param of params) {
      if (!isRecord(param)) continue;
      for (const entry of Array.isArray(param.params) ? param.params : []) {
        if (isRecord(entry) && entry.key === "VISITOR_DATA" && typeof entry.value === "string") {
          if (VISITOR_DATA_PATTERN.test(entry.value)) return entry.value;
        }
      }
    }
    return null;
  }

  /**
   * Fetch a fresh anonymous visitor id from music.youtube.com's sw.js_data, mirroring the
   * reference implementation's lookup (first string under data[0][2] matching ^Cg[t|s]).
   */
  async fetchVisitorData(signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${WEB_REMIX_PROFILE.origin}/sw.js_data`, {
        method: "GET",
        headers: { "User-Agent": WEB_REMIX_PROFILE.userAgent },
        signal: controller.signal,
      });
      if (!response.ok) throw new InnerTubeError(`sw.js_data failed (HTTP ${response.status})`, "http", response.status);
      const text = await response.text();
      const json = JSON.parse(text.startsWith(")]}'") ? text.slice(5) : text) as unknown;
      const found = findVisitorData(json);
      if (!found) throw new InnerTubeError("sw.js_data contained no visitor data", "malformed");
      this.session = { ...this.session, visitorData: found };
      return found;
    } catch (error) {
      if (error instanceof InnerTubeError) throw error;
      if (controller.signal.aborted) throw new InnerTubeError("Request timed out", "timeout");
      throw new InnerTubeError(`Network error: ${error instanceof Error ? error.message : String(error)}`, "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /* ------------------------------------------------------------- endpoints */

  /** `search` — query plus optional music filter params; continuation via query params. */
  search(query: string, params: string | null, continuation: string | null, signal?: AbortSignal): Promise<unknown> {
    const body: JsonRecord = { ...this.context(), query };
    if (params) body.params = params;
    const queryParams: Record<string, string> = {};
    if (continuation) {
      queryParams.continuation = continuation;
      queryParams.ctoken = continuation;
    }
    return this.post("search", body, { params: queryParams, signal });
  }

  /** `browse` — by browseId+params, or by continuation token. */
  browse(options: { browseId?: string | null; params?: string | null; continuation?: string | null }, signal?: AbortSignal): Promise<unknown> {
    const body: JsonRecord = { ...this.context() };
    if (options.browseId) body.browseId = options.browseId;
    if (options.params) body.params = options.params;
    if (options.continuation) body.continuation = options.continuation;
    return this.post("browse", body, { signal });
  }

  /** `next` — watch-next data: queue panel, lyrics endpoint, related. */
  next(options: {
    videoId?: string | null;
    playlistId?: string | null;
    params?: string | null;
    continuation?: string | null;
  }, signal?: AbortSignal): Promise<unknown> {
    const body: JsonRecord = {
      ...this.context(),
      isAudioOnly: true,
      enablePersistentPlaylistPanel: true,
    };
    if (options.videoId) body.videoId = options.videoId;
    if (options.playlistId) body.playlistId = options.playlistId;
    if (options.params) body.params = options.params;
    if (options.continuation) body.continuation = options.continuation;
    return this.post("next", body, { signal });
  }

  /**
   * `player` — stream resolution. Called with a plain context on purpose: no PO token
   * (`serviceIntegrityDimensions`) and no signature timestamp are attached, because generating
   * those is bot-detection evasion and out of scope for Cadence. Ciphered formats are surfaced
   * as unusable by the parser instead of being deciphered.
   */
  player(videoId: string, playlistId?: string | null, signal?: AbortSignal): Promise<unknown> {
    const body: JsonRecord = { ...this.context(), videoId };
    if (playlistId) body.playlistId = playlistId;
    return this.post("player", body, { signal });
  }

  /** `music/get_search_suggestions` — music-specific suggestions. */
  searchSuggestions(input: string, signal?: AbortSignal): Promise<unknown> {
    return this.post("music/get_search_suggestions", { ...this.context(), input }, { signal });
  }

  /** `music/get_queue` — resolve a watch queue (radio/automix) into tracks. */
  queue(videoIds?: string[] | null, playlistId?: string | null, signal?: AbortSignal): Promise<unknown> {
    const body: JsonRecord = { ...this.context() };
    if (videoIds && videoIds.length) body.videoIds = videoIds;
    if (playlistId) body.playlistId = playlistId;
    return this.post("music/get_queue", body, { signal });
  }
}

/** Deep-walk sw.js_data for the first string that looks like a visitor id. */
function findVisitorData(value: unknown): string | null {
  if (typeof value === "string") return VISITOR_DATA_PATTERN.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findVisitorData(entry);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      const found = findVisitorData(value[key]);
      if (found) return found;
    }
  }
  return null;
}
