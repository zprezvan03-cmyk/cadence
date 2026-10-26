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
  providerOrderRank,
  untoggleProvider,
} from "../../shared/upstream/better-lyrics/constants";
import {
  LyricsCacheCore,
  type CachedNetworkSection,
  type CachedOrigin,
  type CachedTrackIdentity,
  type LyricsCacheEntry,
} from "./cacheCore";
import { fetchLrclib, searchLrclib } from "./lrclib";
import { fetchBetterLyrics, searchBetterLyrics } from "./betterLyrics";
import { fetchUnison, searchUnison } from "./unison";
import { fetchBinimum, searchBinimum } from "./binimum";
import type { LocalLyrics, LocalLyricsReader } from "./localLyricsCore";
import { isAbort, type ProviderOutcome, type ProviderQuery, type ProviderStatus } from "./http";
import { inspectLyricsPayload } from "./syncInspection";

interface NetworkModule {
  id: string;
  keys: readonly string[];
  run(query: ProviderQuery, enabledKeys: ReadonlySet<string>, signal?: AbortSignal): Promise<ProviderOutcome>;
}

async function runLrclib(
  query: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal
): Promise<ProviderOutcome> {
  const result = await fetchLrclib(query, signal, enabledKeys);
  return {
    candidates: result.candidates.filter(candidate => enabledKeys.has(candidate.source)),
    statuses: result.statuses,
  };
}

const NETWORK_MODULES: readonly NetworkModule[] = [
  {
    id: "better-lyrics",
    // `blyrics-line` is produced by the same `/getLyrics` call as `blyrics-richsynced`; listing it
    // keeps the module active (and its cached status honest) when only the line slot is enabled.
    keys: ["blyrics-richsynced", "blyrics-line", "blyrics-wordsynced", "blyrics-synced"],
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

const SEARCH_MODULES: readonly NetworkModule[] = [
  {
    id: "better-lyrics",
    keys: ["blyrics-richsynced", "blyrics-line", "blyrics-wordsynced", "blyrics-synced"],
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
const MAX_RETRY_AFTER_CAP_SECONDS = 300;

interface NetworkResult {
  candidates: LyricsCandidate[];
  status: ProviderStatus[];
  definitive: boolean;
  /** Where the answer came from: a fresh fan-out, the stored answer, or no lookup at all. */
  source: "network" | "cache" | "skipped";
}

/** One locally sourced candidate plus the format and provenance it should be cached with. */
interface LocalHit {
  candidate: LyricsCandidate;
  format: string;
  origin: "local" | "manual";
}

interface InFlightEntry<T> {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
}

function makeAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Drops the cache bookkeeping fields before a candidate goes back to the renderer. */
function stripCacheMeta(candidate: LyricsCandidate): LyricsCandidate {
  const copy = { ...candidate } as LyricsCandidate & {
    format?: string;
    origin?: CachedOrigin;
    cachedAt?: number;
  };
  delete copy.format;
  delete copy.origin;
  delete copy.cachedAt;
  return copy;
}

function shareInFlight<T>(
  map: Map<string, InFlightEntry<T>>,
  key: string,
  signal: AbortSignal | undefined,
  factory: (sharedSignal: AbortSignal) => Promise<T>
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(makeAbortError());
  }

  let entry = map.get(key);
  if (!entry) {
    const controller = new AbortController();
    const currentEntry: InFlightEntry<T> = {
      controller,
      promise: Promise.resolve() as unknown as Promise<T>,
      waiters: 0,
    };
    const promise = factory(controller.signal).finally(() => {
      if (map.get(key) === currentEntry) {
        map.delete(key);
      }
    });
    // Prevent unhandled rejection warnings if all callers abort before `promise` settles.
    promise.catch(() => undefined);
    currentEntry.promise = promise;
    entry = currentEntry;
    map.set(key, entry);
  }

  const activeEntry = entry;
  activeEntry.waiters += 1;

  if (!signal) {
    return activeEntry.promise.finally(() => {
      activeEntry.waiters = Math.max(0, activeEntry.waiters - 1);
    });
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      activeEntry.waiters = Math.max(0, activeEntry.waiters - 1);
      if (activeEntry.waiters === 0) {
        if (map.get(key) === activeEntry) map.delete(key);
        activeEntry.controller.abort();
      }
      reject(makeAbortError());
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    activeEntry.promise.then(
      value => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        activeEntry.waiters = Math.max(0, activeEntry.waiters - 1);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        activeEntry.waiters = Math.max(0, activeEntry.waiters - 1);
        reject(error);
      }
    );
  });
}

export type LyricsLibraryLookup = Pick<LibraryStoreCore, "getTrack" | "getLyrics">;

export class LyricsServiceCore {
  private readonly inFlight = new Map<string, InFlightEntry<NetworkResult>>();
  private readonly searchInFlight = new Map<string, InFlightEntry<LyricsSearchResponse>>();
  private readonly rateLimitedUntil = new Map<string, number>();

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
    if (signal?.aborted) throw makeAbortError();

    const order = this.orderFor(providerOrder);
    const candidates: LyricsCandidate[] = [];
    const providerStatus: LyricsResolveResult["providerStatus"] = [];
    const track = this.store.getTrack(request.trackId);
    const trackPath = track?.path ?? null;

    const enabledKeys = new Set<string>(order.filter(key => !key.startsWith("d_")));
    const hasSlot = (key: string): boolean => order.some(entry => untoggleProvider(entry) === key);

    // Everything the local stage found this pass, with the format it was stored in and whether it
    // came from a file/tag ("local") or from a copy the user picked earlier ("manual").
    const localHits: LocalHit[] = [];
    const pushLocal = (
      candidate: LyricsCandidate | null,
      format: string,
      provider: string,
      label: string,
      unavailable?: string
    ) => {
      if (!candidate) {
        if (unavailable) providerStatus.push({ provider, status: "skipped", detail: unavailable });
        else providerStatus.push({ provider, status: "miss" });
        return;
      }
      localHits.push({ candidate, format, origin: "local" });
      providerStatus.push({ provider, status: "hit", detail: label });
    };

    if (trackPath && (hasSlot("local-rich") || hasSlot("local-lrc"))) {
      // Discovery stage: collect every sidecar, not just the first extension that happens to win.
      // The Lyrics/ folder stays the existing fallback when no file sits next to the audio.
      const discovered: LocalLyrics[] = [];
      if (typeof this.localReader.readAllSidecarLyrics === "function") {
        discovered.push(...(await this.localReader.readAllSidecarLyrics(trackPath)));
      } else {
        const single = await this.localReader.readSidecarLyrics(trackPath);
        if (single) discovered.push(single);
      }
      if (discovered.length === 0) {
        const folderArgs = [trackPath, track?.trackNo ?? null, track?.title ?? request.title] as const;
        if (typeof this.localReader.readAllLyricsFolder === "function") {
          discovered.push(...(await this.localReader.readAllLyricsFolder(...folderArgs)));
        } else {
          const fallback = await this.localReader.readLyricsFolder(...folderArgs);
          if (fallback) discovered.push(fallback);
        }
      }

      // Parsing/attribution stage: inspect all files, then keep at most one candidate per local
      // provider slot. Duplicate paths (or the same text reached twice) never become extra rows.
      type LocalKey = "local-rich" | "local-lrc";
      const seen = new Set<string>();
      const chosen = new Map<LocalKey, { file: LocalLyrics; inspected: ReturnType<typeof inspectLyricsPayload> }>();
      const usableCounts = new Map<LocalKey, number>();
      const problems = new Map<LocalKey, string[]>();

      for (const file of discovered) {
        const dedupeKey = `${file.path.toLowerCase()}\u0000${file.text}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const key: LocalKey = file.format === "ttml" || file.format === "qrc" ? "local-rich" : "local-lrc";
        if (!hasSlot(key) || !enabledKeys.has(key)) continue;

        const inspected = inspectLyricsPayload(file.text, {
          durationSeconds: request.duration,
          title: request.title,
          artist: request.artist,
        });
        // Rich sidecars must actually parse as that rich format. A broken TTML that degrades to
        // plain text must not become a "hit" just because the plain-text parser is permissive.
        const expectedFormat = file.format === "ttml" ? "ttml" : file.format === "qrc" ? "qrc" : null;
        const formatMismatch = expectedFormat !== null && inspected.format !== expectedFormat;
        if (!inspected.usable || formatMismatch) {
          // Parsing errors are reported with the file and reason, never silently turned into a
          // miss while a valid sibling LRC continues through its own provider slot.
          const reason =
            inspected.error ??
            (formatMismatch
              ? `expected ${expectedFormat?.toUpperCase()}, parsed as ${inspected.format}`
              : inspected.format === "ttml"
                ? "no usable timed lines"
                : "no usable lines");
          const detail = `Unusable ${file.format} lyrics in ${file.path}: ${reason}`;
          console.warn(`[Cadence] ${detail}`);
          problems.set(key, [...(problems.get(key) ?? []), detail]);
          continue;
        }
        usableCounts.set(key, (usableCounts.get(key) ?? 0) + 1);
        if (!chosen.has(key)) chosen.set(key, { file, inspected });
      }

      for (const key of ["local-rich", "local-lrc"] as const) {
        if (!hasSlot(key)) continue;
        if (!enabledKeys.has(key)) {
          providerStatus.push({ provider: key, status: "skipped", detail: "Provider disabled" });
          continue;
        }
        const hit = chosen.get(key);
        if (hit) {
          const extra = (usableCounts.get(key) ?? 1) - 1;
          pushLocal(
            {
              source: key,
              provider: providerConfig(key)?.displayName ?? (key === "local-rich" ? "Local TTML/QRC" : "Local LRC"),
              text: hit.file.text,
              syncHint: hit.inspected.syncType,
              language: hit.inspected.language,
              songwriters: hit.inspected.songwriters,
              sourceHref: hit.file.path,
              cached: true,
            },
            hit.file.format,
            key,
            `${hit.file.path}${extra > 0 ? ` (+${extra} more sidecar${extra === 1 ? "" : "s"})` : ""}`
          );
          continue;
        }
        const errors = problems.get(key);
        if (errors?.length) {
          providerStatus.push({ provider: key, status: "error", detail: errors.join("; ") });
        } else {
          providerStatus.push({ provider: key, status: "miss" });
        }
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
        const inspected = embedded
          ? inspectLyricsPayload(embedded.text, {
              durationSeconds: request.duration,
              title: request.title,
              artist: request.artist,
            })
          : null;
        pushLocal(
          embedded && inspected?.usable
            ? {
                source: "embedded-tag",
                provider: "Embedded tag",
                text: embedded.text,
                syncHint: inspected.syncType,
                language: inspected.language,
                songwriters: inspected.songwriters,
                sourceHref: trackPath,
                cached: true,
              }
            : null,
          inspected?.format ?? "plain",
          "embedded-tag",
          "USLT/SYLT tag",
          trackPath ? undefined : "Track is not in the library"
        );
      }
    }

    // The cache is consulted before any network request. A track bundle keeps the local copies and
    // the remote answer side by side, keyed by the library id so two same-titled songs never mix.
    const trackKey = LyricsCacheCore.trackKey(request.trackId, request);
    const identity = this.identityFor(request, track?.id ?? null);
    const cachedEntry = this.cachedTrackEntry(trackKey, identity);
    const generation = this.cache.currentGeneration();

    if (cachedEntry) {
      await this.restoreCachedLocal(cachedEntry, {
        track,
        trackPath,
        enabledKeys,
        localHits,
        providerStatus,
      });
    }

    const networkResult = await this.resolveNetwork(request, enabledKeys, cachedEntry?.network ?? null, signal);
    // A result the user chose by hand wins over the automatic one for the same provider, so the
    // selector never shows two rows with the same identity.
    const manualSources = new Set(
      localHits.filter(hit => hit.origin === "manual").map(hit => hit.candidate.source)
    );
    candidates.push(...localHits.map(hit => hit.candidate));
    candidates.push(...networkResult.candidates.filter(candidate => !manualSources.has(candidate.source)));
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

    candidates.sort((a, b) => providerOrderRank(a.source, order) - providerOrderRank(b.source, order));

    // Store what this pass actually produced. Local files are re-read on every resolve, so their
    // copies stay current; the remote section only advances when the providers answered
    // definitively, and an incomplete answer keeps the previous one instead of erasing it.
    this.cache.putTrack(
      trackKey,
      identity,
      localHits.map(hit => ({ candidate: hit.candidate, format: hit.format, origin: hit.origin })),
      networkResult.source === "network" && networkResult.definitive
        ? {
            candidates: networkResult.candidates.map(candidate => ({
              candidate,
              origin: "network" as const,
            })),
            negative: networkResult.candidates.length === 0,
          }
        : null,
      generation
    );

    return { candidates, providerStatus };
  }

  /** Identity used for the per-track cache entry; the library row wins over the request fields. */
  private identityFor(request: LyricsResolveRequest, trackId: number | null): CachedTrackIdentity {
    const track = trackId === null ? null : this.store.getTrack(trackId);
    return {
      id: trackId,
      title: track?.title ?? request.title ?? "",
      artist: track?.artist ?? request.artist ?? "",
      album: track?.album ?? request.album ?? "",
      duration: Number(track?.duration ?? request.duration) || 0,
    };
  }

  private cachedTrackEntry(key: string, identity: CachedTrackIdentity): LyricsCacheEntry | null {
    const entry = this.cache.getEntry(key);
    if (!entry || entry.kind !== "track") return null;
    // The id is stable but the tags are not: a re-tagged file must never replay the old lyrics.
    return LyricsCacheCore.sameIdentity(entry.track, identity) ? entry : null;
  }

  /**
   * Re-adds cached local copies that the live pass could not reproduce. A sidecar that still
   * exists is left alone (the user replaced it), while a file that is gone, an unavailable track
   * or an explicit user choice keeps its cached copy so the lyrics survive an offline drive.
   */
  private async restoreCachedLocal(
    entry: LyricsCacheEntry,
    context: {
      track: ReturnType<LyricsLibraryLookup["getTrack"]>;
      trackPath: string | null;
      enabledKeys: ReadonlySet<string>;
      localHits: LocalHit[];
      providerStatus: LyricsResolveResult["providerStatus"];
    }
  ): Promise<void> {
    const live = new Set(context.localHits.map(hit => hit.candidate.source));
    // When the live pass found any local lyrics at all, the local picture is current: a cached
    // file-backed copy is only ever a fallback for a track whose sources cannot be read.
    const hasLiveLocal = context.localHits.some(hit => hit.origin === "local");
    for (const previous of entry.candidates) {
      if (live.has(previous.source)) continue;

      const isUserChoice = previous.origin === "manual" || previous.source === "user-file";
      const isEmbedded = previous.source === "embedded-tag";
      const isSidecar = previous.source === "local-rich" || previous.source === "local-lrc";
      if (!isUserChoice && !isEmbedded && !isSidecar) continue;
      if (!isUserChoice && !context.enabledKeys.has(previous.source)) continue;
      if (!isUserChoice && hasLiveLocal) continue;

      // An embedded tag or a sidecar is re-read on every resolve; only its disappearance justifies
      // replaying the stored copy. A chosen file lives outside the library and is always restored.
      if (!isUserChoice) {
        if (isEmbedded) {
          if (context.track) continue;
        } else if (previous.sourceHref && typeof this.localReader.readLyricsFile === "function") {
          const stillThere = await this.localReader.readLyricsFile(previous.sourceHref);
          if (stillThere) continue;
        } else if (context.trackPath) {
          continue;
        }
      }

      context.localHits.push({
        candidate: stripCacheMeta(previous),
        format: previous.format,
        origin: isUserChoice ? "manual" : "local",
      });
      const detail = isUserChoice
        ? previous.source === "user-file"
          ? "Chosen file (cached copy)"
          : "Chosen search result (cached copy)"
        : isEmbedded
          ? "Cached copy (track unavailable)"
          : "Cached copy (source file unavailable)";
      const status = context.providerStatus.find(item => item.provider === previous.source);
      if (status) {
        status.status = "hit";
        status.detail = detail;
      } else {
        context.providerStatus.push({ provider: previous.source, status: "hit", detail });
      }
    }
  }

  private async resolveNetwork(
    request: LyricsResolveRequest,
    enabledKeys: ReadonlySet<string>,
    cached: CachedNetworkSection | null,
    signal?: AbortSignal
  ): Promise<NetworkResult> {
    const query: ProviderQuery = {
      title: request.title,
      artist: request.artist,
      album: request.album,
      duration: request.duration,
    };

    const activeModules = NETWORK_MODULES.filter(module => module.keys.some(key => enabledKeys.has(key)));

    // Offline mode only stops the *network*: a remotely fetched copy that is already on disk is
    // local data now, so it keeps working (and a stale copy beats no lyrics on a plane).
    const serveCached = cached !== null && (request.localOnly || LyricsCacheCore.networkIsFresh(cached));

    if (!serveCached && (request.localOnly || activeModules.length === 0)) {
      const detail = request.localOnly ? "Offline mode" : "Provider disabled";
      return {
        candidates: [],
        definitive: false,
        source: "skipped",
        status: NETWORK_MODULES.map(module => ({ provider: module.id, status: "skipped" as const, detail })),
      };
    }

    if (serveCached && cached) {
      const wanted = cached.candidates.filter(candidate => enabledKeys.has(candidate.source));
      // Cached results for a slot the user has since switched off are dropped, never re-labelled
      // as an enabled sibling — and the status says so rather than claiming a cached miss.
      const droppedByConfig = cached.candidates.filter(candidate => !enabledKeys.has(candidate.source));
      return {
        candidates: wanted.map(stripCacheMeta),
        definitive: true,
        source: "cache",
        status: NETWORK_MODULES.map(module =>
          module.keys.some(key => enabledKeys.has(key))
            ? this.cachedStatus(module, wanted, droppedByConfig, request.localOnly ? "Cached copy (offline)" : undefined)
            : { provider: module.id, status: "skipped" as const, detail: "Provider disabled" }
        ),
      };
    }

    return this.sharedLookup(LyricsCacheCore.key(request.artist, request.title, request.album, request.duration), query, enabledKeys, signal);
  }

  private inFlightKey(cacheKey: string, enabledKeys: ReadonlySet<string>): string {
    return `${cacheKey}::${[...enabledKeys].sort().join(",")}`;
  }

  async searchLyrics(
    request: LyricsSearchRequest,
    providerOrder?: string[],
    signal?: AbortSignal
  ): Promise<LyricsSearchResponse> {
    if (signal?.aborted) throw makeAbortError();

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
      const rows = cached
        .filter(candidate => enabledKeys.has(candidate.source))
        .sort((a, b) => providerOrderRank(a.source, order) - providerOrderRank(b.source, order))
        .map(stripCacheMeta);
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
        providerStatus: activeModules.map(module => ({
          provider: module.id,
          status: "skipped" as const,
          detail: "Offline mode",
        })),
      };
    }
    if (!title) {
      return {
        results: [],
        cached: false,
        providerStatus: activeModules.map(module => ({
          provider: module.id,
          status: "skipped" as const,
          detail: "Title required",
        })),
      };
    }

    const flightKey = `${cacheKey}::${[...enabledKeys].sort().join(",")}`;
    const response = await shareInFlight(this.searchInFlight, flightKey, signal, sharedSignal =>
      this.runSearch(query, activeModules, enabledKeys, cacheKey, sharedSignal)
    );
    return {
      ...response,
      results: [...response.results].sort(
        (a, b) => providerOrderRank(a.source, order) - providerOrderRank(b.source, order)
      ),
    };
  }

  private checkRateLimit(moduleId: string): ProviderOutcome | null {
    const until = this.rateLimitedUntil.get(moduleId);
    if (until === undefined) return null;
    const now = Date.now();
    if (now >= until) {
      this.rateLimitedUntil.delete(moduleId);
      return null;
    }
    const remaining = Math.max(1, Math.ceil((until - now) / 1000));
    return {
      candidates: [],
      statuses: [
        {
          provider: moduleId,
          status: "error",
          detail: `Rate limited; retry after ${remaining}s`,
          retryAfterSeconds: remaining,
        },
      ],
    };
  }

  private recordRateLimits(moduleId: string, statuses: readonly ProviderStatus[]): void {
    for (const entry of statuses) {
      if (entry.status === "error" && entry.retryAfterSeconds && entry.retryAfterSeconds > 0) {
        const capped = Math.min(entry.retryAfterSeconds, MAX_RETRY_AFTER_CAP_SECONDS);
        this.rateLimitedUntil.set(moduleId, Date.now() + capped * 1000);
      }
    }
  }

  private runModule(
    module: NetworkModule,
    query: ProviderQuery,
    enabledKeys: ReadonlySet<string>,
    signal?: AbortSignal
  ): Promise<ProviderOutcome> {
    if (!module.keys.some(key => enabledKeys.has(key))) {
      return Promise.resolve({
        candidates: [],
        statuses: [{ provider: module.id, status: "skipped", detail: "Provider disabled" }],
      });
    }
    const blocked = this.checkRateLimit(module.id);
    if (blocked) return Promise.resolve(blocked);
    return module.run(query, enabledKeys, signal);
  }

  private async runSearch(
    query: ProviderQuery,
    modules: readonly NetworkModule[],
    enabledKeys: ReadonlySet<string>,
    cacheKey: string,
    signal?: AbortSignal
  ): Promise<LyricsSearchResponse> {
    // Taken before the request: a clear that happens while it runs invalidates the write below.
    const generation = this.cache.currentGeneration();
    const settled = await Promise.allSettled(
      modules.map(module => this.runModule(module, query, enabledKeys, signal))
    );

    const gathered: LyricsCandidate[] = [];
    const providerStatus: ProviderStatus[] = [];
    let definitive = true;

    settled.forEach((outcome, index) => {
      const module = modules[index];
      if (outcome.status === "fulfilled") {
        this.recordRateLimits(module.id, outcome.value.statuses);
        gathered.push(...outcome.value.candidates);
        providerStatus.push(...outcome.value.statuses);
        if (outcome.value.statuses.some(entry => entry.status === "error")) definitive = false;
        return;
      }
      if (isAbort(outcome.reason)) throw outcome.reason;
      definitive = false;
      providerStatus.push({
        provider: module.id,
        status: "error",
        detail: (outcome.reason as Error)?.message ?? "Request failed",
      });
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

    if (definitive && results.length > 0) this.cache.putSearch(cacheKey, query, results, generation);

    return { results, providerStatus, cached: false };
  }

  private cachedStatus(
    module: { id: string; keys: readonly string[] },
    cached: readonly LyricsCandidate[],
    droppedByConfig: readonly LyricsCandidate[] = [],
    hitDetail = "Cached lyrics"
  ): ProviderStatus {
    const hit = cached.some(candidate => module.keys.includes(candidate.source));
    if (hit) return { provider: module.id, status: "hit", detail: hitDetail };
    // Same wording as the live fetch path, so switching a slot off reads the same whether the
    // answer came from the API or from the cache.
    const disabled = droppedByConfig.filter(candidate => module.keys.includes(candidate.source));
    if (disabled.length > 0) {
      const names = [
        ...new Set(disabled.map(candidate => providerConfig(candidate.source)?.displayName ?? candidate.provider)),
      ];
      return { provider: module.id, status: "miss", detail: `${names.join(", ")} disabled for this track` };
    }
    return { provider: module.id, status: "miss", detail: "Cached negative result" };
  }

  private sharedLookup(
    cacheKey: string,
    query: ProviderQuery,
    enabledKeys: ReadonlySet<string>,
    signal?: AbortSignal
  ): Promise<NetworkResult> {
    const flightKey = this.inFlightKey(cacheKey, enabledKeys);
    return shareInFlight(this.inFlight, flightKey, signal, sharedSignal =>
      this.runNetworkModules(query, enabledKeys, sharedSignal)
    );
  }

  private async runNetworkModules(
    query: ProviderQuery,
    enabledKeys: ReadonlySet<string>,
    signal?: AbortSignal
  ): Promise<NetworkResult> {
    const settled = await Promise.allSettled(
      NETWORK_MODULES.map(module => this.runModule(module, query, enabledKeys, signal))
    );

    const candidates: LyricsCandidate[] = [];
    const status: ProviderStatus[] = [];
    let definitive = true;

    settled.forEach((outcome, index) => {
      const module = NETWORK_MODULES[index];
      if (outcome.status === "fulfilled") {
        this.recordRateLimits(module.id, outcome.value.statuses);
        candidates.push(...outcome.value.candidates);
        status.push(...outcome.value.statuses);
        if (outcome.value.statuses.some(entry => entry.status === "error")) definitive = false;
        return;
      }
      if (isAbort(outcome.reason)) throw outcome.reason;
      definitive = false;
      status.push({
        provider: module.id,
        status: "error",
        detail: (outcome.reason as Error)?.message ?? "Request failed",
      });
    });

    return { candidates, status, definitive, source: "network" };
  }

  /**
   * Records a file the user picked by hand (Settings/Now Playing → "Choose file"). The renderer
   * parses and displays it itself, but the copy must reach the persistent cache too, otherwise the
   * choice would be forgotten on the next restart.
   */
  rememberUserFile(trackId: number, path: string, text: string): void {
    const track = this.store.getTrack(trackId);
    if (!track || !text.trim()) return;
    const identity = this.identityFor(
      { trackId, title: track.title, artist: track.artist, album: track.album, duration: track.duration },
      track.id
    );
    const inspected = inspectLyricsPayload(text, {
      durationSeconds: track.duration,
      title: track.title,
      artist: track.artist,
    });
    this.cache.rememberCandidate(LyricsCacheCore.trackKey(trackId, identity), identity, {
      candidate: {
        source: "user-file",
        provider: "Chosen file",
        text,
        syncHint: inspected.usable ? inspected.syncType : "none",
        language: inspected.language,
        songwriters: inspected.songwriters,
        sourceHref: path,
        cached: true,
      },
      format: inspected.format,
      origin: "manual",
    });
  }

  /** Records a manual-search result the user explicitly chose for this track. */
  rememberSelection(trackId: number, candidate: LyricsCandidate): void {
    const track = this.store.getTrack(trackId);
    if (!track || !candidate?.text) return;
    const identity = this.identityFor(
      { trackId, title: track.title, artist: track.artist, album: track.album, duration: track.duration },
      track.id
    );
    this.cache.rememberCandidate(LyricsCacheCore.trackKey(trackId, identity), identity, {
      candidate: stripCacheMeta(candidate),
      origin: "manual",
    });
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
    const inspected = inspectLyricsPayload(file.text, {
      durationSeconds: track?.duration,
      title: track?.title,
      artist: track?.artist,
    });
    const fallbackHint =
      file.format === "ttml" || file.format === "qrc"
        ? "richsync"
        : file.format === "text"
          ? "none"
          : "synced";
    return {
      candidates: [
        {
          source: "user-file",
          provider: "Chosen file",
          text: file.text,
          syncHint: inspected.usable ? inspected.syncType : fallbackHint,
          language: inspected.language,
          songwriters: inspected.songwriters,
          sourceHref: file.path,
          cached: true,
        },
      ],
      providerStatus: [{ provider: "user-file", status: "hit", detail: track?.title ?? file.path }],
    };
  }

  /** Entries a failed clear removed from memory but could not yet remove from disk. */
  private unpersistedClearedEntries = 0;

  clearRateLimits(): void {
    this.rateLimitedUntil.clear();
  }

  /**
   * Empties the lyrics/search cache and waits for the emptied file to reach disk, rejecting when
   * that write fails so the caller can report the real outcome. Lookups that are already running
   * keep serving their caller but can no longer repopulate what was just deleted.
   *
   * Only the provider cache is touched: the library database, settings, sidecar lyrics files and
   * artwork are user data and are left alone.
   */
  async clearCache(): Promise<number> {
    // A previous attempt may have emptied memory but failed to reach disk; those entries are still
    // cached on disk, so the retry is what really removes them and must say so.
    const removedEntries = this.cache.size() + this.unpersistedClearedEntries;
    this.cache.clear();
    try {
      await this.cache.persistNow();
    } catch (error) {
      this.unpersistedClearedEntries = removedEntries;
      throw error;
    }
    this.unpersistedClearedEntries = 0;
    return removedEntries;
  }

  flush(): void {
    this.cache.flush();
  }
}
