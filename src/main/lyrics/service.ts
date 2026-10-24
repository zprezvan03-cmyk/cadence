/**
 * Cadence lyrics service: provider orchestration and fallback.
 *
 * Provider ordering follows the upstream Better Lyrics model (local/Better Lyrics first, plain
 * text last) and reuses `mergePreferredProviders` from the extension so a persisted order that
 * predates a new provider still migrates the same way. Written for Cadence around ported pieces.
 *
 * Network providers (Better Lyrics API, Unison, LRCLIB) run in parallel, each against its own
 * host; candidates are merged in provider order and cached together under the track's metadata
 * key. Transient errors are never cached, a previous track's response can never replace the
 * current one (caller abort + renderer generation tokens), and identical concurrent lookups share
 * one in-flight request.
 */

import type { LibraryStore } from "../library/store";
import type {
  LyricsCandidate,
  LyricsResolveRequest,
  LyricsResolveResult,
  LyricsSearchRequest,
  LyricsSearchResponse,
} from "../../shared/types";
import {
  DEFAULT_PROVIDER_ORDER,
  type LyricSourceKey,
} from "../../shared/upstream/better-lyrics/constants";
import { mergePreferredProviders } from "../../shared/upstream/better-lyrics/providerList";
import { LyricsCache } from "./cache";
import { fetchLrclib, searchLrclib } from "./lrclib";
import { fetchBetterLyrics, searchBetterLyrics } from "./betterLyrics";
import { fetchUnison, searchUnison } from "./unison";
import { fetchBinimum, searchBinimum } from "./binimum";
import { readEmbeddedLyrics, readLyricsFile, readLyricsFolder, readSidecarLyrics } from "./localLyrics";
import type { ProviderOutcome, ProviderQuery, ProviderStatus } from "./http";

interface NetworkModule {
  id: string;
  keys: readonly string[];
  run(query: ProviderQuery, enabledKeys: ReadonlySet<string>, signal?: AbortSignal): Promise<ProviderOutcome>;
}

/** LRCLIB keeps its existing client; this adapter only narrows candidates to the enabled keys. */
async function runLrclib(query: ProviderQuery, enabledKeys: ReadonlySet<string>, signal?: AbortSignal): Promise<ProviderOutcome> {
  const result = await fetchLrclib(query, signal);
  return {
    candidates: result.candidates.filter(candidate => enabledKeys.has(candidate.source)),
    statuses: result.statuses,
  };
}

const NETWORK_MODULES: readonly NetworkModule[] = [
  {
    id: "better-lyrics",
    keys: ["blyrics-richsynced", "blyrics-wordsynced", "blyrics-synced"],
    run: fetchBetterLyrics,
  },
  {
    id: "unison",
    keys: ["unison-richsynced", "unison-wordsynced", "unison-synced", "unison-plain"],
    run: fetchUnison,
  },
  {
    id: "binimum",
    keys: ["binimum-richsynced", "binimum-synced"],
    run: fetchBinimum,
  },
  { id: "lrclib", keys: ["lrclib-synced", "lrclib-plain"], run: runLrclib },
];

/** Manual-search runners, one per network module; only modules with an enabled key participate. */
const SEARCH_MODULES: readonly { id: string; keys: readonly string[]; run: (query: ProviderQuery, enabledKeys: ReadonlySet<string>, signal?: AbortSignal) => Promise<ProviderOutcome> }[] = [
  {
    id: "better-lyrics",
    keys: ["blyrics-richsynced", "blyrics-wordsynced", "blyrics-synced"],
    run: searchBetterLyrics,
  },
  {
    id: "unison",
    keys: ["unison-richsynced", "unison-wordsynced", "unison-synced", "unison-plain"],
    run: searchUnison,
  },
  { id: "binimum", keys: ["binimum-richsynced", "binimum-synced"], run: searchBinimum },
  { id: "lrclib", keys: ["lrclib-synced", "lrclib-plain"], run: searchLrclib },
];

const MAX_SEARCH_RESULTS = 30;

interface NetworkResult {
  candidates: LyricsCandidate[];
  status: ProviderStatus[];
  /** True when no provider reported a transient error, so the result may be cached. */
  definitive: boolean;
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true }
    );
  });
}

export class LyricsService {
  /** Metadata key → shared in-flight network lookup, so concurrent resolves fetch once. */
  private readonly inFlight = new Map<string, Promise<NetworkResult>>();
  /** Manual-search key → shared in-flight search, so repeated submits never fan out twice. */
  private readonly searchInFlight = new Map<string, Promise<LyricsSearchResponse>>();

  constructor(
    private readonly store: LibraryStore,
    private readonly cache: LyricsCache
  ) {}

  private orderFor(providerOrder: string[] | undefined): LyricSourceKey[] {
    const merged = mergePreferredProviders(providerOrder?.length ? providerOrder : DEFAULT_PROVIDER_ORDER, DEFAULT_PROVIDER_ORDER);
    const valid = merged.filter((key): key is LyricSourceKey =>
      (DEFAULT_PROVIDER_ORDER as string[]).includes(key)
    );
    return valid.length ? valid : (DEFAULT_PROVIDER_ORDER as LyricSourceKey[]);
  }

  async resolve(
    request: LyricsResolveRequest,
    providerOrder?: string[],
    signal?: AbortSignal
  ): Promise<LyricsResolveResult> {
    const order = this.orderFor(providerOrder);
    const candidates: LyricsCandidate[] = [];
    const providerStatus: LyricsResolveResult["providerStatus"] = [];
    const track = this.store.getTrack(request.trackId);
    const trackPath = track?.path ?? null;

    const pushLocal = (candidate: LyricsCandidate | null, provider: string, label: string, unavailable?: string) => {
      if (!candidate) {
        // A local provider with no track path was never consulted; say so rather than "miss".
        if (unavailable) providerStatus.push({ provider, status: "skipped", detail: unavailable });
        else providerStatus.push({ provider, status: "miss" });
        return;
      }
      candidates.push(candidate);
      providerStatus.push({ provider, status: "hit", detail: label });
    };

    if (trackPath && order.includes("local-sidecar")) {
      const sidecar =
        (await readSidecarLyrics(trackPath)) ??
        (await readLyricsFolder(trackPath, track?.trackNo ?? null, track?.title ?? request.title));
      pushLocal(
        sidecar
          ? {
              source: "local-sidecar",
              provider: "Local file",
              text: sidecar.text,
              syncHint: sidecar.format === "ttml" || sidecar.format === "qrc" ? "richsync" : "synced",
              language: null,
              songwriters: [],
              sourceHref: sidecar.path,
              cached: true,
            }
          : null,
        "local-sidecar",
        sidecar?.path ?? "",
        trackPath ? undefined : "Track is not in the library"
      );
    } else if (order.includes("local-sidecar")) {
      providerStatus.push({ provider: "local-sidecar", status: "skipped", detail: "Provider disabled" });
    }

    if (order.includes("embedded-tag")) {
      const embedded = readEmbeddedLyrics(this.store, request.trackId);
      pushLocal(
        embedded
          ? {
              source: "embedded-tag",
              provider: "Embedded tag",
              text: embedded.text,
              syncHint: embedded.kind === "lrc" ? "synced" : "none",
              language: null,
              songwriters: [],
              sourceHref: trackPath,
              cached: true,
            }
          : null,
        "embedded-tag",
        "USLT/SYLT tag",
        trackPath ? undefined : "Track is not in the library"
      );
    } else if (order.includes("embedded-tag")) {
      providerStatus.push({ provider: "embedded-tag", status: "skipped", detail: "Provider disabled" });
    }

    const enabledKeys = new Set<string>(order);
    const cacheKey = LyricsCache.key(request.artist, request.title, request.album, request.duration);
    const networkResult = await this.resolveNetwork(request, enabledKeys, cacheKey, signal);
    candidates.push(...networkResult.candidates);
    providerStatus.push(...networkResult.status);

    // Stable order: local sources before network ones, matching upstream priority.
    const orderIndex = (source: string): number => (DEFAULT_PROVIDER_ORDER as string[]).indexOf(source);
    candidates.sort((a, b) => orderIndex(a.source) - orderIndex(b.source));

    return { candidates, providerStatus };
  }

  private async resolveNetwork(
    request: LyricsResolveRequest,
    enabledKeys: ReadonlySet<string>,
    cacheKey: string,
    signal?: AbortSignal
  ): Promise<NetworkResult> {
    const query: ProviderQuery = {
      title: request.title,
      artist: request.artist,
      album: request.album,
      duration: request.duration,
    };

    const activeModules = NETWORK_MODULES.filter(module => module.keys.some(key => enabledKeys.has(key)));

    if (request.localOnly || activeModules.length === 0) {
      const detail = request.localOnly ? "Offline mode" : "Provider disabled";
      return {
        candidates: [],
        definitive: true,
        status: NETWORK_MODULES.map(module => ({ provider: module.id, status: "skipped" as const, detail })),
      };
    }

    const cached = this.cache.get(cacheKey);
    if (cached !== null) {
      const wanted = cached.filter(candidate => enabledKeys.has(candidate.source));
      return {
        candidates: wanted,
        definitive: true,
        status: activeModules.map(module => this.cachedStatus(module, wanted)),
      };
    }

    const lookup = this.sharedLookup(cacheKey, query, enabledKeys);
    if (signal) {
      // The shared lookup keeps running for other callers; an aborted caller just stops waiting.
      return Promise.race([lookup, rejectWhenAborted(signal)]);
    }
    return lookup;
  }

  /** The in-flight signature includes the enabled set so a disabled provider is never queried. */
  private inFlightKey(cacheKey: string, enabledKeys: ReadonlySet<string>): string {
    return `${cacheKey}::${[...enabledKeys].sort().join(",")}`;
  }

  /**
   * Manual lyric search across every enabled network module. Automatic resolution is never
   * touched: this only answers an explicit user query from the Lyrics Selector. Positive result
   * sets are cached under their searched metadata (and re-served offline); empty answers and
   * transient failures are not cached, so retrying with corrected spelling always reaches out.
   */
  async searchLyrics(
    request: LyricsSearchRequest,
    providerOrder?: string[],
    signal?: AbortSignal
  ): Promise<LyricsSearchResponse> {
    const order = this.orderFor(providerOrder);
    const enabledKeys = new Set<string>(order);
    const title = request.title.trim();
    const artist = request.artist?.trim() ?? "";
    const album = request.album?.trim() ?? "";
    const duration = Number(request.duration) || 0;
    const query: ProviderQuery = { title, artist, album, duration };
    const cacheKey = LyricsCache.searchKey(artist, title, album, duration);

    const activeModules = SEARCH_MODULES.filter(module => module.keys.some(key => enabledKeys.has(key)));

    // Cache first so the same manual search works fully offline, including all alternative rows.
    const cached = this.cache.get(cacheKey);
    if (cached !== null) {
      const rows = cached.filter(candidate => enabledKeys.has(candidate.source));
      return {
        results: rows,
        cached: true,
        providerStatus: activeModules.map(module => this.cachedStatus(module, rows)),
      };
    }

    if (request.localOnly) {
      return {
        results: [],
        cached: true,
        providerStatus: activeModules.map(module => ({ provider: module.id, status: "skipped" as const, detail: "Offline mode" })),
      };
    }
    if (!title) {
      return {
        results: [],
        cached: false,
        providerStatus: activeModules.map(module => ({ provider: module.id, status: "skipped" as const, detail: "Title required" })),
      };
    }

    const flightKey = `${cacheKey}::${[...enabledKeys].sort().join(",")}`;
    const existing = this.searchInFlight.get(flightKey);
    if (existing) return existing;

    const promise = this.runSearch(query, activeModules, enabledKeys, cacheKey, signal).finally(() => {
      this.searchInFlight.delete(flightKey);
    });
    this.searchInFlight.set(flightKey, promise);
    if (signal) return Promise.race([promise, rejectWhenAborted(signal)]);
    return promise;
  }

  private async runSearch(
    query: ProviderQuery,
    modules: typeof SEARCH_MODULES,
    enabledKeys: ReadonlySet<string>,
    cacheKey: string,
    signal?: AbortSignal
  ): Promise<LyricsSearchResponse> {
    const settled = await Promise.allSettled(modules.map(module => module.run(query, enabledKeys, signal)));

    const gathered: LyricsCandidate[] = [];
    const providerStatus: ProviderStatus[] = [];
    let definitive = true;

    settled.forEach((outcome, index) => {
      const module = modules[index];
      if (outcome.status === "fulfilled") {
        gathered.push(...outcome.value.candidates);
        providerStatus.push(...outcome.value.statuses);
        if (outcome.value.statuses.some(entry => entry.status === "error")) definitive = false;
        return;
      }
      if ((outcome.reason as Error)?.name === "AbortError") throw outcome.reason;
      definitive = false;
      providerStatus.push({ provider: module.id, status: "error", detail: (outcome.reason as Error)?.message ?? "Request failed" });
    });

    // Same record can come back from several providers; keep one row per source + lyric text.
    const seen = new Set<string>();
    const results: LyricsCandidate[] = [];
    const orderIndex = (source: string): number => (DEFAULT_PROVIDER_ORDER as string[]).indexOf(source);
    for (const candidate of gathered) {
      const dedupeKey = `${candidate.source}:${candidate.text}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      results.push(candidate);
      if (results.length >= MAX_SEARCH_RESULTS) break;
    }
    results.sort((a, b) => orderIndex(a.source) - orderIndex(b.source));

    // Only definitive, non-empty answers enter the cache: a 429/timeout/401 must not be remembered
    // as "nothing found", and empty searches stay retryable with corrected metadata.
    if (definitive && results.length > 0) this.cache.set(cacheKey, results);

    return { results, providerStatus, cached: false };
  }

  private cachedStatus(module: { id: string; keys: readonly string[] }, cached: readonly LyricsCandidate[]): ProviderStatus {
    const hit = cached.some(candidate => module.keys.includes(candidate.source));
    return hit
      ? { provider: module.id, status: "hit", detail: "Cached lyrics" }
      : { provider: module.id, status: "miss", detail: "Cached negative result" };
  }

  private sharedLookup(cacheKey: string, query: ProviderQuery, enabledKeys: ReadonlySet<string>): Promise<NetworkResult> {
    const flightKey = this.inFlightKey(cacheKey, enabledKeys);
    const existing = this.inFlight.get(flightKey);
    if (existing) return existing;

    const promise = this.runNetworkModules(query, enabledKeys)
      .then(result => {
        // Only persist definitive outcomes: a rate limit, timeout or keyless 401 must not become
        // a 12-hour negative cache entry that blocks a later, successful lookup.
        if (result.definitive) this.cache.set(cacheKey, result.candidates);
        return result;
      })
      .finally(() => {
        this.inFlight.delete(flightKey);
      });
    this.inFlight.set(flightKey, promise);
    return promise;
  }

  private async runNetworkModules(query: ProviderQuery, enabledKeys: ReadonlySet<string>): Promise<NetworkResult> {
    const settled = await Promise.allSettled(
      NETWORK_MODULES.map(module => module.run(query, enabledKeys))
    );

    const candidates: LyricsCandidate[] = [];
    const status: ProviderStatus[] = [];
    let definitive = true;

    settled.forEach((outcome, index) => {
      const module = NETWORK_MODULES[index];
      if (outcome.status === "fulfilled") {
        candidates.push(...outcome.value.candidates);
        status.push(...outcome.value.statuses);
        if (outcome.value.statuses.some(entry => entry.status === "error")) definitive = false;
        return;
      }
      // Aborts propagate from the provider clients; everything else is a classified provider error.
      if ((outcome.reason as Error)?.name === "AbortError") throw outcome.reason;
      definitive = false;
      status.push({ provider: module.id, status: "error", detail: (outcome.reason as Error)?.message ?? "Request failed" });
    });

    return { candidates, status, definitive };
  }

  async resolveUserFile(trackId: number, path: string): Promise<LyricsResolveResult> {
    const file = await readLyricsFile(path);
    if (!file) return { candidates: [], providerStatus: [{ provider: "user-file", status: "error", detail: "Unreadable file" }] };
    const track = this.store.getTrack(trackId);
    return {
      candidates: [
        {
          source: "user-file",
          provider: "Chosen file",
          text: file.text,
          syncHint: file.format === "ttml" || file.format === "qrc" ? "richsync" : "synced",
          language: null,
          songwriters: [],
          sourceHref: file.path,
          cached: true,
        },
      ],
      providerStatus: [{ provider: "user-file", status: "hit", detail: track?.title ?? file.path }],
    };
  }

  flush(): void {
    this.cache.flush();
  }
}
