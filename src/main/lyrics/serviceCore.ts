/**
 * Runtime-agnostic Cadence lyrics service: provider orchestration, manual search, and fallback.
 * Shared between the Tauri WebView2 bridge and Node unit/integration tests.
 */

import type { LibraryStoreCore } from "../library/storeCore";
import type {
  LyricsCandidate,
  LyricsResolveRequest,
  LyricsResolveResult,
  LyricsSearchRequest,
  LyricsSearchResponse,
} from "../../shared/types";
import {
  DEFAULT_PROVIDER_ORDER,
  migrateProviderOrder,
  providerConfig,
  providerPriority,
  untoggleProvider,
} from "../../shared/upstream/better-lyrics/constants";
import { LyricsCacheCore } from "./cacheCore";
import { fetchLrclib, searchLrclib } from "./lrclib";
import { fetchBetterLyrics, searchBetterLyrics } from "./betterLyrics";
import { fetchUnison, searchUnison } from "./unison";
import { fetchBinimum, searchBinimum } from "./binimum";
import type { LocalLyricsReader } from "./localLyricsCore";
import type { ProviderOutcome, ProviderQuery, ProviderStatus } from "./http";

interface NetworkModule {
  id: string;
  keys: readonly string[];
  run(query: ProviderQuery, enabledKeys: ReadonlySet<string>, signal?: AbortSignal): Promise<ProviderOutcome>;
}

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

const SEARCH_MODULES: readonly {
  id: string;
  keys: readonly string[];
  run: (query: ProviderQuery, enabledKeys: ReadonlySet<string>, signal?: AbortSignal) => Promise<ProviderOutcome>;
}[] = [
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

export type LyricsLibraryLookup = Pick<LibraryStoreCore, "getTrack" | "getLyrics">;

export class LyricsServiceCore {
  private readonly inFlight = new Map<string, Promise<NetworkResult>>();
  private readonly searchInFlight = new Map<string, Promise<LyricsSearchResponse>>();

  constructor(
    private readonly store: LyricsLibraryLookup,
    private readonly cache: LyricsCacheCore,
    private readonly localReader: LocalLyricsReader
  ) {}

  private orderFor(providerOrder: string[] | undefined): string[] {
    const migrated = migrateProviderOrder(providerOrder);
    return migrated.length ? migrated : [...DEFAULT_PROVIDER_ORDER];
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

    const enabledKeys = new Set<string>(order.filter(key => !key.startsWith("d_")));
    const hasSlot = (key: string): boolean => order.some(entry => untoggleProvider(entry) === key);

    const pushLocal = (candidate: LyricsCandidate | null, provider: string, label: string, unavailable?: string) => {
      if (!candidate) {
        if (unavailable) providerStatus.push({ provider, status: "skipped", detail: unavailable });
        else providerStatus.push({ provider, status: "miss" });
        return;
      }
      candidates.push(candidate);
      providerStatus.push({ provider, status: "hit", detail: label });
    };

    if (trackPath && (hasSlot("local-rich") || hasSlot("local-lrc"))) {
      const sidecar =
        (await this.localReader.readSidecarLyrics(trackPath)) ??
        (await this.localReader.readLyricsFolder(trackPath, track?.trackNo ?? null, track?.title ?? request.title));
      const richFormat = sidecar?.format === "ttml" || sidecar?.format === "qrc";
      const presentKey = sidecar ? (richFormat ? "local-rich" : "local-lrc") : null;

      for (const key of ["local-rich", "local-lrc"] as const) {
        if (!hasSlot(key)) continue;
        if (!enabledKeys.has(key)) {
          providerStatus.push({ provider: key, status: "skipped", detail: "Provider disabled" });
          continue;
        }
        if (!sidecar) {
          providerStatus.push({ provider: key, status: "miss" });
          continue;
        }
        if (presentKey !== key) {
          providerStatus.push({ provider: key, status: "miss" });
          continue;
        }
        pushLocal(
          {
            source: key,
            provider: richFormat ? "Local TTML/QRC" : "Local LRC",
            text: sidecar.text,
            syncHint: richFormat ? "richsync" : "synced",
            language: null,
            songwriters: [],
            sourceHref: sidecar.path,
            cached: true,
          },
          key,
          sidecar.path
        );
      }
    } else {
      for (const key of ["local-rich", "local-lrc"] as const) {
        if (hasSlot(key)) providerStatus.push({ provider: key, status: "skipped", detail: "Provider disabled" });
      }
    }

    if (hasSlot("embedded-tag")) {
      if (!enabledKeys.has("embedded-tag")) {
        providerStatus.push({ provider: "embedded-tag", status: "skipped", detail: "Provider disabled" });
      } else {
        const embedded = this.store.getLyrics(request.trackId);
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
      }
    }

    const cacheKey = LyricsCacheCore.key(request.artist, request.title, request.album, request.duration);
    const networkResult = await this.resolveNetwork(request, enabledKeys, cacheKey, signal);
    candidates.push(...networkResult.candidates);
    providerStatus.push(...networkResult.status);

    for (const entry of order) {
      const key = untoggleProvider(entry);
      const config = providerConfig(key);
      if (config && !config.available && !providerStatus.some(status => status.provider === key)) {
        providerStatus.push({
          provider: key,
          status: "skipped",
          detail: `Unavailable: ${config.unavailableReason ?? "no keyless endpoint"}`,
        });
      }
    }

    candidates.sort((a, b) => providerPriority(a.source) - providerPriority(b.source));

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
      return Promise.race([lookup, rejectWhenAborted(signal)]);
    }
    return lookup;
  }

  private inFlightKey(cacheKey: string, enabledKeys: ReadonlySet<string>): string {
    return `${cacheKey}::${[...enabledKeys].sort().join(",")}`;
  }

  async searchLyrics(
    request: LyricsSearchRequest,
    providerOrder?: string[],
    signal?: AbortSignal
  ): Promise<LyricsSearchResponse> {
    const order = this.orderFor(providerOrder);
    const enabledKeys = new Set<string>(order.filter(key => !key.startsWith("d_")));
    const title = request.title.trim();
    const artist = request.artist?.trim() ?? "";
    const album = request.album?.trim() ?? "";
    const duration = Number(request.duration) || 0;
    const query: ProviderQuery = { title, artist, album, duration };
    const cacheKey = LyricsCacheCore.searchKey(artist, title, album, duration);

    const activeModules = SEARCH_MODULES.filter(module => module.keys.some(key => enabledKeys.has(key)));

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

    const seen = new Set<string>();
    const results: LyricsCandidate[] = [];
    for (const candidate of gathered) {
      const dedupeKey = `${candidate.source}:${candidate.text}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      results.push(candidate);
      if (results.length >= MAX_SEARCH_RESULTS) break;
    }
    results.sort((a, b) => providerPriority(a.source) - providerPriority(b.source));

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
      if ((outcome.reason as Error)?.name === "AbortError") throw outcome.reason;
      definitive = false;
      status.push({ provider: module.id, status: "error", detail: (outcome.reason as Error)?.message ?? "Request failed" });
    });

    return { candidates, status, definitive };
  }

  async resolveUserFile(trackId: number, path: string): Promise<LyricsResolveResult> {
    const file = await this.localReader.readLyricsFile(path);
    if (!file) {
      return {
        candidates: [],
        providerStatus: [{ provider: "user-file", status: "error", detail: "Unreadable file" }],
      };
    }
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
