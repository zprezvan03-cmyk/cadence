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
  const filtered = result.candidates.filter(candidate => enabledKeys.has(candidate.source));
  const hit = result.statuses.some(entry => entry.status === "hit");
  return {
    candidates: filtered,
    statuses:
      hit && filtered.length === 0
        ? [{ provider: "lrclib", status: "miss", detail: "No matching enabled LRCLIB variant" }]
        : result.statuses,
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
const SYNTHETIC_ARTISTS = new Set(["unknown artist", "<unknown>"]);
const SYNTHETIC_ALBUMS = new Set(["unknown album", "<unknown>"]);

function normalizeQueryField(value: string | null | undefined, placeholders: ReadonlySet<string>): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  return placeholders.has(trimmed.replace(/\s+/g, " ").toLowerCase()) ? "" : trimmed;
}

export function normalizeProviderQuery(input: {
  title: string;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
}): ProviderQuery {
  return {
    title: input.title.trim(),
    artist: normalizeQueryField(input.artist, SYNTHETIC_ARTISTS),
    album: normalizeQueryField(input.album, SYNTHETIC_ALBUMS),
    duration: Number(input.duration) || 0,
  };
}

const NETWORK_MODULE_BY_KEY = new Map<string, NetworkModule>();
for (const module of NETWORK_MODULES) {
  for (const key of module.keys) {
    NETWORK_MODULE_BY_KEY.set(key, module);
  }
}

function buildOrderIndex(order: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  order.forEach((entry, index) => {
    const key = untoggleProvider(entry);
    if (!map.has(key)) map.set(key, index);
  });
  return map;
}

function compareByConfiguredOrder(
  a: LyricsCandidate,
  b: LyricsCandidate,
  orderIndex: ReadonlyMap<string, number>
): number {
  const rankA = orderIndex.get(a.source) ?? Number.MAX_SAFE_INTEGER;
  const rankB = orderIndex.get(b.source) ?? Number.MAX_SAFE_INTEGER;
  if (rankA !== rankB) return rankA - rankB;
  return providerPriority(a.source) - providerPriority(b.source);
}

function firstEnabledOrderIndex(
  keys: readonly string[],
  orderIndex: ReadonlyMap<string, number>,
  enabledKeys: ReadonlySet<string>
): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const key of keys) {
    if (!enabledKeys.has(key)) continue;
    const rank = orderIndex.get(key) ?? Number.MAX_SAFE_INTEGER;
    if (rank < best) best = rank;
  }
  return best;
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
  private readonly moduleInFlight = new Map<string, Promise<ProviderOutcome>>();
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
    const orderIndex = buildOrderIndex(order);
    const enabledKeys = new Set<string>(order.filter(key => !key.startsWith("d_")));

    const candidates: LyricsCandidate[] = [];
    const providerStatus: LyricsResolveResult["providerStatus"] = [];
    const track = this.store.getTrack(request.trackId);
    const trackPath = track?.path ?? null;

    let sidecarLoaded = false;
    let sidecarCache: Awaited<ReturnType<LocalLyricsReader["readSidecarLyrics"]>> = null;
    const loadSidecar = async () => {
      if (sidecarLoaded || !trackPath) return sidecarCache;
      sidecarLoaded = true;
      sidecarCache =
        (await this.localReader.readSidecarLyrics(trackPath)) ??
        (await this.localReader.readLyricsFolder(trackPath, track?.trackNo ?? null, track?.title ?? request.title));
      return sidecarCache;
    };

    const query = normalizeProviderQuery(request);
    const cacheKey = LyricsCacheCore.key(query.artist, query.title, query.album, query.duration);
    const enabledNetworkKeys = [...enabledKeys].filter(key => NETWORK_MODULE_BY_KEY.has(key));
    const cachedNetwork =
      !request.localOnly && enabledNetworkKeys.length > 0
        ? this.cache.get(cacheKey, enabledNetworkKeys)
        : null;
    const wantedCachedNetwork = cachedNetwork
      ? cachedNetwork.filter(candidate => enabledKeys.has(candidate.source) && candidate.text.trim().length > 0)
      : null;

    const firstEnabledModuleKey = new Map<string, string>();
    const firstSlotModuleKey = new Map<string, string>();
    for (const entry of order) {
      const key = untoggleProvider(entry);
      const module = NETWORK_MODULE_BY_KEY.get(key);
      if (!module) continue;
      if (!firstSlotModuleKey.has(module.id)) {
        firstSlotModuleKey.set(module.id, key);
      }
      if (!entry.startsWith("d_") && !firstEnabledModuleKey.has(module.id)) {
        firstEnabledModuleKey.set(module.id, key);
      }
    }

    const handledModules = new Set<string>();
    const freshNetworkCandidates: LyricsCandidate[] = [];
    let networkDefinitive = true;

    for (const entry of order) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const disabled = entry.startsWith("d_");
      const key = untoggleProvider(entry);

      if (key === "local-rich" || key === "local-lrc") {
        if (!trackPath || disabled) {
          providerStatus.push({ provider: key, status: "skipped", detail: "Provider disabled" });
          continue;
        }
        const sidecar = await loadSidecar();
        const richFormat = sidecar?.format === "ttml" || sidecar?.format === "qrc";
        const presentKey = sidecar ? (richFormat ? "local-rich" : "local-lrc") : null;
        if (!sidecar || presentKey !== key || !sidecar.text.trim()) {
          providerStatus.push({ provider: key, status: "miss" });
          continue;
        }
        candidates.push({
          source: key,
          provider: richFormat ? "Local TTML/QRC" : "Local LRC",
          text: sidecar.text,
          syncHint: richFormat ? "richsync" : "synced",
          language: null,
          songwriters: [],
          sourceHref: sidecar.path,
          cached: true,
        });
        providerStatus.push({ provider: key, status: "hit", detail: sidecar.path });
        continue;
      }

      if (key === "embedded-tag") {
        if (disabled) {
          providerStatus.push({ provider: "embedded-tag", status: "skipped", detail: "Provider disabled" });
          continue;
        }
        const embedded = this.store.getLyrics(request.trackId);
        if (!embedded || !embedded.text.trim()) {
          if (!trackPath) {
            providerStatus.push({ provider: "embedded-tag", status: "skipped", detail: "Track is not in the library" });
          } else {
            providerStatus.push({ provider: "embedded-tag", status: "miss" });
          }
          continue;
        }
        candidates.push({
          source: "embedded-tag",
          provider: "Embedded tag",
          text: embedded.text,
          syncHint: embedded.kind === "lrc" ? "synced" : "none",
          language: null,
          songwriters: [],
          sourceHref: trackPath,
          cached: true,
        });
        providerStatus.push({ provider: "embedded-tag", status: "hit", detail: "USLT/SYLT tag" });
        continue;
      }

      const config = providerConfig(key);
      if (config && !config.available) {
        if (!providerStatus.some(status => status.provider === key)) {
          providerStatus.push({
            provider: key,
            status: "skipped",
            detail: disabled
              ? "Provider disabled"
              : `Unavailable: ${config.unavailableReason ?? "no keyless endpoint"}`,
          });
        }
        continue;
      }

      const module = NETWORK_MODULE_BY_KEY.get(key);
      if (!module || handledModules.has(module.id)) continue;

      if (request.localOnly) {
        handledModules.add(module.id);
        providerStatus.push({ provider: module.id, status: "skipped", detail: "Offline mode" });
        continue;
      }

      const triggerKey = firstEnabledModuleKey.get(module.id);
      if (!triggerKey) {
        if (firstSlotModuleKey.get(module.id) === key) {
          handledModules.add(module.id);
          providerStatus.push({ provider: module.id, status: "skipped", detail: "Provider disabled" });
        }
        continue;
      }

      if (key !== triggerKey) continue;
      handledModules.add(module.id);

      if (wantedCachedNetwork !== null) {
        const moduleCached = wantedCachedNetwork.filter(candidate => module.keys.includes(candidate.source));
        candidates.push(...moduleCached);
        providerStatus.push(this.cachedStatus(module, wantedCachedNetwork));
        continue;
      }

      const moduleEnabledKeys = new Set<string>(
        order.filter(item => !item.startsWith("d_") && module.keys.includes(untoggleProvider(item)))
      );
      const outcome = await this.runSingleNetworkModule(module, cacheKey, query, moduleEnabledKeys, signal);
      const valid = outcome.candidates.filter(
        candidate => moduleEnabledKeys.has(candidate.source) && candidate.text.trim().length > 0
      );
      candidates.push(...valid);
      freshNetworkCandidates.push(...valid);
      providerStatus.push(...outcome.statuses);
      if (outcome.statuses.some(status => status.status === "error")) {
        networkDefinitive = false;
      }
    }

    for (const module of NETWORK_MODULES) {
      if (!handledModules.has(module.id)) {
        providerStatus.push({
          provider: module.id,
          status: "skipped",
          detail: request.localOnly ? "Offline mode" : "Provider disabled",
        });
      }
    }

    if (!request.localOnly && wantedCachedNetwork === null && enabledNetworkKeys.length > 0 && networkDefinitive) {
      this.cache.set(cacheKey, freshNetworkCandidates, enabledNetworkKeys);
    }

    candidates.sort((a, b) => compareByConfiguredOrder(a, b, orderIndex));

    return { candidates, providerStatus };
  }

  async searchLyrics(
    request: LyricsSearchRequest,
    providerOrder?: string[],
    signal?: AbortSignal
  ): Promise<LyricsSearchResponse> {
    const order = this.orderFor(providerOrder);
    const orderIndex = buildOrderIndex(order);
    const enabledKeys = new Set<string>(order.filter(key => !key.startsWith("d_")));
    const query = normalizeProviderQuery(request);
    const cacheKey = LyricsCacheCore.searchKey(query.artist, query.title, query.album, query.duration);

    const activeModules = [...SEARCH_MODULES]
      .filter(module => module.keys.some(key => enabledKeys.has(key)))
      .sort(
        (a, b) =>
          firstEnabledOrderIndex(a.keys, orderIndex, enabledKeys) -
          firstEnabledOrderIndex(b.keys, orderIndex, enabledKeys)
      );
    const enabledSearchKeys = [...enabledKeys].filter(key =>
      SEARCH_MODULES.some(module => module.keys.includes(key))
    );

    const cached = request.localOnly
      ? this.cache.get(cacheKey)
      : this.cache.get(cacheKey, enabledSearchKeys);
    if (cached !== null) {
      const rows = cached
        .filter(candidate => enabledKeys.has(candidate.source) && candidate.text.trim().length > 0)
        .sort((a, b) => compareByConfiguredOrder(a, b, orderIndex));
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
    if (!query.title) {
      return {
        results: [],
        cached: false,
        providerStatus: activeModules.map(module => ({ provider: module.id, status: "skipped" as const, detail: "Title required" })),
      };
    }

    const flightKey = `${cacheKey}::${[...enabledKeys].join(",")}`;
    const existing = this.searchInFlight.get(flightKey);
    if (existing) {
      return signal ? Promise.race([existing, rejectWhenAborted(signal)]) : existing;
    }

    const promise = this.runSearch(
      query,
      activeModules,
      enabledKeys,
      enabledSearchKeys,
      orderIndex,
      cacheKey,
      signal
    ).finally(() => {
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
    enabledSearchKeys: readonly string[],
    orderIndex: ReadonlyMap<string, number>,
    cacheKey: string,
    signal?: AbortSignal
  ): Promise<LyricsSearchResponse> {
    const gathered: LyricsCandidate[] = [];
    const providerStatus: ProviderStatus[] = [];
    let definitive = true;

    for (const module of modules) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const moduleEnabledKeys = new Set<string>(
        [...enabledKeys].filter(key => module.keys.includes(key))
      );
      try {
        const outcome = await module.run(query, moduleEnabledKeys, signal);
        gathered.push(...outcome.candidates);
        providerStatus.push(...outcome.statuses);
        if (outcome.statuses.some(entry => entry.status === "error")) definitive = false;
      } catch (reason) {
        if ((reason as Error)?.name === "AbortError") throw reason;
        definitive = false;
        providerStatus.push({
          provider: module.id,
          status: "error",
          detail: (reason as Error)?.message ?? "Request failed",
        });
      }
    }

    const seen = new Set<string>();
    const results: LyricsCandidate[] = [];
    for (const candidate of gathered) {
      if (!candidate.text.trim()) continue;
      const dedupeKey = `${candidate.source}:${candidate.text}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      results.push(candidate);
      if (results.length >= MAX_SEARCH_RESULTS) break;
    }
    results.sort((a, b) => compareByConfiguredOrder(a, b, orderIndex));

    if (definitive && results.length > 0) this.cache.set(cacheKey, results, enabledSearchKeys);

    return { results, providerStatus, cached: false };
  }

  private cachedStatus(module: { id: string; keys: readonly string[] }, cached: readonly LyricsCandidate[]): ProviderStatus {
    const hit = cached.some(candidate => module.keys.includes(candidate.source));
    return hit
      ? { provider: module.id, status: "hit", detail: "Cached lyrics" }
      : { provider: module.id, status: "miss", detail: "Cached negative result" };
  }

  private runSingleNetworkModule(
    module: NetworkModule,
    cacheKey: string,
    query: ProviderQuery,
    moduleEnabledKeys: ReadonlySet<string>,
    signal?: AbortSignal
  ): Promise<ProviderOutcome> {
    const flightKey = `${module.id}::${cacheKey}::${[...moduleEnabledKeys].join(",")}`;
    let inFlight = this.moduleInFlight.get(flightKey);
    if (!inFlight) {
      inFlight = this.invokeModule(module, query, moduleEnabledKeys).finally(() => {
        this.moduleInFlight.delete(flightKey);
      });
      this.moduleInFlight.set(flightKey, inFlight);
    }
    if (signal) {
      return Promise.race([inFlight, rejectWhenAborted(signal)]);
    }
    return inFlight;
  }

  private async invokeModule(
    module: NetworkModule,
    query: ProviderQuery,
    enabledKeys: ReadonlySet<string>
  ): Promise<ProviderOutcome> {
    try {
      return await module.run(query, enabledKeys);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      return {
        candidates: [],
        statuses: [
          {
            provider: module.id,
            status: "error",
            detail: (error as Error)?.message ?? "Request failed",
          },
        ],
      };
    }
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
