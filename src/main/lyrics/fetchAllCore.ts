/**
 * Persistent Fetch All Lyrics background job (runtime-agnostic core).
 *
 * The engine owns *scheduling only*: queue construction with playback-history priority,
 * duplicate-recording sharing, pause/resume/cancel/retry, progress accounting and restart
 * persistence. Every actual lookup goes through the injected `resolveTrack`, which the bridge
 * wires to the same `LyricsServiceCore` (same providers, cache, central concurrency limiter and
 * in-flight request sharing) that Autofetch and manual searches use — there is no second
 * fetching system. Live HTTP requests are never persisted; a restart simply re-queues whatever
 * was mid-flight.
 */

import type {
  LyricsFetchJobSnapshot,
  LyricsFetchStats,
  LyricsResolveResult,
} from "../../shared/types";
import type { TrackLyricsAssessment } from "./serviceCore";
import { clusterRecordings } from "./recordingIdentity";

export type FetchEntryStatus =
  | "pending"
  | "processing"
  | "found"
  | "not-found"
  | "failed"
  | "rate-limited"
  | "invalid-metadata"
  | "skipped";

export type FetchJobState = "idle" | "running" | "paused" | "completed" | "canceled";

export interface FetchQueueEntry {
  trackId: number;
  /** Conservative recording cluster key; duplicates share one network answer. */
  recordingKey: string;
  status: FetchEntryStatus;
  attempts: number;
  /** Last time this entry was actually attempted (ms since epoch), never a computed retry date. */
  lastAttemptAt: number | null;
  detail?: string;
}

export interface FetchTrackInfo {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  hasSidecarLyrics?: boolean;
  hasEmbeddedLyrics?: boolean;
  lastPlayedAt?: number | null;
}

interface JobRecord {
  id: string;
  state: Exclude<FetchJobState, "idle">;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  entries: FetchQueueEntry[];
}

interface JobFile {
  version: 1;
  job: JobRecord | null;
}

export interface FetchAllPersistence {
  initialJson?: string | null;
  persist?: (json: string) => void | Promise<void>;
}

export interface FetchAllDeps {
  /** Paged library access so queue construction never materialises a second full copy. */
  tracksPage(offset: number, limit: number): { tracks: FetchTrackInfo[]; total: number };
  getTrack(trackId: number): FetchTrackInfo | null;
  assess(track: FetchTrackInfo): TrackLyricsAssessment;
  resolveTrack(
    track: FetchTrackInfo,
    options: { force: boolean; signal: AbortSignal }
  ): Promise<LyricsResolveResult>;
  /** Copies a duplicate recording's cached network answer; returns false when nothing to share. */
  shareResult(fromTrackId: number, toTrack: FetchTrackInfo): boolean;
  /** Current track first, then listening-history track ids, newest first. */
  getPriority(): Promise<{ currentTrackId: number | null; historyTrackIds: number[] }>;
  /** Parallel track processors (provider requests stay bounded by the service limiter). */
  getParallelTracks(): number;
  onProgress?(snapshot: LyricsFetchJobSnapshot): void;
  now?: () => number;
  idFactory?: () => string;
}

const PAGE_SIZE = 250;
const TERMINAL: ReadonlySet<FetchEntryStatus> = new Set([
  "found",
  "not-found",
  "failed",
  "rate-limited",
  "invalid-metadata",
  "skipped",
]);

/**
 * Queue priority (spec Part 2.4): currently playing, then recently played (history, newest
 * first), then previously played (by `lastPlayedAt`), then never played in library order.
 * Pure and stable: ties always fall back to the input (library) order.
 */
export function orderFetchQueue<T extends { id: number; lastPlayedAt?: number | null }>(
  tracks: readonly T[],
  priority: { currentTrackId: number | null; historyTrackIds: readonly number[] }
): T[] {
  const historyRank = new Map<number, number>();
  priority.historyTrackIds.forEach((id, index) => {
    if (!historyRank.has(id)) historyRank.set(id, index);
  });
  const decorated = tracks.map((track, libraryIndex) => ({ track, libraryIndex }));
  decorated.sort((a, b) => {
    const bucket = (entry: (typeof decorated)[number]): number => {
      if (entry.track.id === priority.currentTrackId) return 0;
      if (historyRank.has(entry.track.id)) return 1;
      if (entry.track.lastPlayedAt) return 2;
      return 3;
    };
    const bucketDiff = bucket(a) - bucket(b);
    if (bucketDiff !== 0) return bucketDiff;
    const aHistory = historyRank.get(a.track.id);
    const bHistory = historyRank.get(b.track.id);
    if (aHistory !== undefined && bHistory !== undefined && aHistory !== bHistory) {
      return aHistory - bHistory;
    }
    const playedDiff = (b.track.lastPlayedAt ?? 0) - (a.track.lastPlayedAt ?? 0);
    if (playedDiff !== 0 && bucket(a) === 2) return playedDiff;
    return a.libraryIndex - b.libraryIndex;
  });
  return decorated.map(entry => entry.track);
}

/**
 * Terminal classification of one resolve. "Not found" requires a definitive answer (every
 * participating provider completed normally); any provider error/timeout with no candidates is
 * a temporary failure, and a rate-limit detail is kept distinct. Temporary failures are never
 * retried automatically — `retryFailed` is the only way back.
 */
export function classifyResolveResult(
  result: LyricsResolveResult
): "found" | "not-found" | "failed" | "rate-limited" {
  if (result.candidates.length > 0) return "found";
  if (result.definitive) return "not-found";
  const rateLimited = result.providerStatus.some(
    entry => entry.status === "error" && /rate limit/i.test(entry.detail ?? "")
  );
  return rateLimited ? "rate-limited" : "failed";
}

function emptySnapshot(): LyricsFetchJobSnapshot {
  return {
    jobId: null,
    state: "idle",
    total: 0,
    processed: 0,
    found: 0,
    notFound: 0,
    failed: 0,
    skipped: 0,
    currentTrack: null,
    startedAt: null,
    finishedAt: null,
  };
}

function normalizeEntry(value: unknown): FetchQueueEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<FetchQueueEntry>;
  if (!Number.isFinite(Number(raw.trackId)) || typeof raw.recordingKey !== "string") return null;
  const statuses: FetchEntryStatus[] = [
    "pending",
    "processing",
    "found",
    "not-found",
    "failed",
    "rate-limited",
    "invalid-metadata",
    "skipped",
  ];
  return {
    trackId: Number(raw.trackId),
    recordingKey: raw.recordingKey,
    status: statuses.includes(raw.status as FetchEntryStatus) ? (raw.status as FetchEntryStatus) : "pending",
    attempts: Number.isFinite(Number(raw.attempts)) ? Number(raw.attempts) : 0,
    lastAttemptAt: Number.isFinite(Number(raw.lastAttemptAt)) ? Number(raw.lastAttemptAt) : null,
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
  };
}

let fallbackIdCounter = 0;

export class LyricsFetchAllCore {
  private job: JobRecord | null = null;
  /** Index of the first not-yet-dispatched entry; promotion inserts here. */
  private cursor = 0;
  private readonly active = new Map<number, AbortController>();
  private workersRunning = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** recordingKey → representative track id with a terminal found/not-found answer. */
  private readonly completedRecordings = new Map<string, { trackId: number; status: "found" | "not-found" }>();

  constructor(
    private readonly deps: FetchAllDeps,
    private readonly persistence: FetchAllPersistence = {}
  ) {
    if (persistence.initialJson) {
      try {
        const parsed = JSON.parse(persistence.initialJson) as Partial<JobFile>;
        if (parsed?.version === 1 && parsed.job && typeof parsed.job === "object") {
          const raw = parsed.job as JobRecord;
          const entries = Array.isArray(raw.entries)
            ? raw.entries.map(normalizeEntry).filter((e): e is FetchQueueEntry => e !== null)
            : [];
          this.job = {
            id: String(raw.id ?? "restored"),
            state: (["running", "paused", "completed", "canceled"] as const).includes(raw.state)
              ? raw.state
              : "paused",
            createdAt: Number(raw.createdAt) || this.now(),
            startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : null,
            updatedAt: Number(raw.updatedAt) || this.now(),
            finishedAt: Number.isFinite(Number(raw.finishedAt)) ? Number(raw.finishedAt) : null,
            entries,
          };
        }
      } catch {
        this.job = null;
      }
    }
    this.rebuildDerived();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private nextId(): string {
    return this.deps.idFactory ? this.deps.idFactory() : `job-${this.now()}-${++fallbackIdCounter}`;
  }

  /** Recomputes cursor + completed-recording index after load or queue rebuild. */
  private rebuildDerived(): void {
    this.completedRecordings.clear();
    this.cursor = 0;
    if (!this.job) return;
    for (const entry of this.job.entries) {
      // Work that was mid-flight when the app closed restarts cleanly as pending.
      if (entry.status === "processing") entry.status = "pending";
      if (entry.status === "found" || entry.status === "not-found") {
        if (!this.completedRecordings.has(entry.recordingKey)) {
          this.completedRecordings.set(entry.recordingKey, { trackId: entry.trackId, status: entry.status });
        }
      }
    }
    while (this.cursor < this.job.entries.length && this.job.entries[this.cursor].status !== "pending") {
      this.cursor += 1;
    }
  }

  /**
   * Called once by the host after construction: a job that was running when the app closed
   * resumes automatically; paused stays paused (user intent), canceled/completed never resume.
   */
  restore(): LyricsFetchJobSnapshot {
    if (this.job?.state === "running") {
      this.rebuildDerived();
      this.kickWorkers();
    }
    return this.snapshot();
  }

  snapshot(): LyricsFetchJobSnapshot {
    if (!this.job) return emptySnapshot();
    let found = 0;
    let notFound = 0;
    let failed = 0;
    let skipped = 0;
    let processed = 0;
    let current: FetchQueueEntry | null = null;
    for (const entry of this.job.entries) {
      if (entry.status === "found") found += 1;
      else if (entry.status === "not-found") notFound += 1;
      else if (entry.status === "failed" || entry.status === "rate-limited") failed += 1;
      else if (entry.status === "skipped" || entry.status === "invalid-metadata") skipped += 1;
      else if (entry.status === "processing" && !current) current = entry;
      if (TERMINAL.has(entry.status)) processed += 1;
    }
    const currentTrack = current ? this.deps.getTrack(current.trackId) : null;
    return {
      jobId: this.job.id,
      state: this.job.state,
      total: this.job.entries.length,
      processed,
      found,
      notFound,
      failed,
      skipped,
      currentTrack: current
        ? {
            trackId: current.trackId,
            title: currentTrack?.title ?? "",
            artist: currentTrack?.artist ?? "",
          }
        : null,
      startedAt: this.job.startedAt,
      finishedAt: this.job.finishedAt,
    };
  }

  /** Raw entries for tests/hosts that need per-track detail; snapshots stay the UI contract. */
  entries(): readonly FetchQueueEntry[] {
    return this.job ? [...this.job.entries] : [];
  }

  /** Library coverage without starting anything (onboarding page + Settings). */
  async stats(): Promise<LyricsFetchStats> {
    let totalTracks = 0;
    let withLyrics = 0;
    let needsSearch = 0;
    let fullyProcessed = 0;
    let offset = 0;
    for (;;) {
      const page = this.deps.tracksPage(offset, PAGE_SIZE);
      totalTracks = page.total;
      for (const track of page.tracks) {
        const assessment = this.deps.assess(track);
        if (assessment.hasLyrics) withLyrics += 1;
        if (assessment.needsWork) needsSearch += 1;
        if (assessment.fullyProcessed) fullyProcessed += 1;
      }
      offset += page.tracks.length;
      if (page.tracks.length === 0 || offset >= page.total) break;
      await yieldToHost();
    }
    return { totalTracks, withLyrics, needsSearch, fullyProcessed };
  }

  /**
   * Builds a fresh queue (chunked over library pages) and starts processing. When a compatible
   * job is already running or paused it is returned unchanged instead of duplicated.
   */
  async start(): Promise<LyricsFetchJobSnapshot> {
    if (this.job && (this.job.state === "running" || this.job.state === "paused")) {
      if (this.job.state === "paused") return this.resume();
      return this.snapshot();
    }

    const priority = await this.deps.getPriority().catch(() => ({
      currentTrackId: null,
      historyTrackIds: [] as number[],
    }));

    const eligible: FetchTrackInfo[] = [];
    const terminal: FetchQueueEntry[] = [];
    const allForClustering: FetchTrackInfo[] = [];
    let offset = 0;
    for (;;) {
      const page = this.deps.tracksPage(offset, PAGE_SIZE);
      for (const track of page.tracks) {
        allForClustering.push(track);
        const assessment = this.deps.assess(track);
        if (assessment.reason === "invalid-metadata") {
          terminal.push({
            trackId: track.id,
            recordingKey: `track:${track.id}`,
            status: "invalid-metadata",
            attempts: 0,
            lastAttemptAt: null,
            detail: "Missing title metadata",
          });
        } else if (assessment.needsWork) {
          eligible.push(track);
        }
        // Fully processed / in-cooldown / nothing outstanding: not queued at all.
      }
      offset += page.tracks.length;
      if (page.tracks.length === 0 || offset >= page.total) break;
      await yieldToHost();
    }

    const recordingKeys = clusterRecordings(allForClustering);
    const ordered = orderFetchQueue(eligible, priority);
    const now = this.now();
    this.job = {
      id: this.nextId(),
      state: "running",
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      entries: [
        ...ordered.map(track => ({
          trackId: track.id,
          recordingKey: recordingKeys.get(track.id) ?? `track:${track.id}`,
          status: "pending" as const,
          attempts: 0,
          lastAttemptAt: null,
        })),
        ...terminal,
      ],
    };
    this.rebuildDerived();
    await this.persistNow().catch(() => undefined);
    this.emit();
    if (this.job.entries.every(entry => TERMINAL.has(entry.status))) {
      this.finishJob();
    } else {
      this.kickWorkers();
    }
    return this.snapshot();
  }

  pause(): LyricsFetchJobSnapshot {
    if (this.job?.state === "running") {
      this.job.state = "paused";
      this.job.updatedAt = this.now();
      this.markDirty();
      void this.persistNow().catch(() => undefined);
      this.emit();
    }
    return this.snapshot();
  }

  resume(): LyricsFetchJobSnapshot {
    if (this.job?.state === "paused") {
      this.job.state = "running";
      this.job.updatedAt = this.now();
      this.markDirty();
      this.emit();
      this.kickWorkers();
    }
    return this.snapshot();
  }

  /**
   * Stops active requests where possible and removes pending work. Everything already fetched
   * stays in the lyrics cache untouched; a canceled job never auto-resumes.
   */
  cancel(): LyricsFetchJobSnapshot {
    if (!this.job || this.job.state === "completed" || this.job.state === "canceled") {
      return this.snapshot();
    }
    this.job.state = "canceled";
    this.job.finishedAt = this.now();
    this.job.updatedAt = this.now();
    for (const controller of this.active.values()) controller.abort();
    for (const entry of this.job.entries) {
      if (entry.status === "pending" || entry.status === "processing") {
        entry.status = "skipped";
        entry.detail = "Canceled";
      }
    }
    this.markDirty();
    void this.persistNow().catch(() => undefined);
    this.emit();
    return this.snapshot();
  }

  /** Manually re-queues temporary failures and rate-limited tracks (never automatic). */
  retryFailed(): LyricsFetchJobSnapshot {
    if (!this.job) return this.snapshot();
    let changed = false;
    for (const entry of this.job.entries) {
      if (entry.status === "failed" || entry.status === "rate-limited") {
        entry.status = "pending";
        entry.detail = undefined;
        changed = true;
      }
    }
    if (!changed) return this.snapshot();
    // Retried entries go to the front of the remaining work, preserving their relative order.
    const retried = this.job.entries.filter(entry => entry.status === "pending");
    const rest = this.job.entries.filter(entry => entry.status !== "pending");
    this.job.entries = [...rest.slice(0, this.firstNonTerminalIndex(rest)), ...retried, ...rest.slice(this.firstNonTerminalIndex(rest))];
    this.job.state = "running";
    this.job.finishedAt = null;
    this.job.updatedAt = this.now();
    this.rebuildDerived();
    this.markDirty();
    this.emit();
    this.kickWorkers();
    return this.snapshot();
  }

  private firstNonTerminalIndex(entries: FetchQueueEntry[]): number {
    const index = entries.findIndex(entry => !TERMINAL.has(entry.status));
    return index === -1 ? entries.length : index;
  }

  /**
   * Dynamic priority: a track the user just started playing jumps to the front of pending work
   * (behind anything already processing). No duplicates, no starvation bookkeeping needed —
   * each promotion moves exactly one entry.
   */
  promote(trackId: number): boolean {
    if (!this.job || this.job.state === "completed" || this.job.state === "canceled") return false;
    const index = this.job.entries.findIndex(
      (entry, i) => i >= this.cursor && entry.trackId === trackId && entry.status === "pending"
    );
    if (index === -1 || index === this.cursor) return index !== -1;
    const [entry] = this.job.entries.splice(index, 1);
    this.job.entries.splice(this.cursor, 0, entry);
    this.markDirty();
    return true;
  }

  /** Flushes pending persistence (host shutdown hook). */
  async flush(): Promise<void> {
    await this.persistNow().catch(() => undefined);
  }

  /* -------------------------------------------------------------- workers */

  private kickWorkers(): void {
    if (this.workersRunning || !this.job || this.job.state !== "running") return;
    this.workersRunning = true;
    const parallelism = Math.max(1, Math.min(8, Math.floor(this.deps.getParallelTracks()) || 1));
    const workers = Array.from({ length: parallelism }, () => this.workerLoop());
    void Promise.all(workers).finally(() => {
      this.workersRunning = false;
      if (!this.job) return;
      if (this.job.state === "running") {
        if (this.job.entries.some(entry => entry.status === "pending")) {
          // Parallelism may have grown, or a promote/start raced the drain: run again.
          this.kickWorkers();
        } else if (this.active.size === 0) {
          this.finishJob();
        }
      }
    });
  }

  private async workerLoop(): Promise<void> {
    for (;;) {
      if (!this.job || this.job.state !== "running") return;
      const entry = this.takeNext();
      if (!entry) return;
      await this.processEntry(entry);
    }
  }

  private takeNext(): FetchQueueEntry | null {
    if (!this.job) return null;
    while (this.cursor < this.job.entries.length) {
      const entry = this.job.entries[this.cursor];
      this.cursor += 1;
      if (entry.status === "pending") {
        entry.status = "processing";
        return entry;
      }
    }
    // Entries can be re-queued behind the cursor by retryFailed; rescan once from the front.
    const index = this.job.entries.findIndex(entry => entry.status === "pending");
    if (index === -1) return null;
    const entry = this.job.entries[index];
    entry.status = "processing";
    return entry;
  }

  private async processEntry(entry: FetchQueueEntry): Promise<void> {
    const job = this.job;
    if (!job) return;
    const track = this.deps.getTrack(entry.trackId);
    if (!track) {
      entry.status = "skipped";
      entry.detail = "Track no longer in the library";
      this.afterEntry();
      return;
    }

    // Duplicate recording whose representative already has a definitive answer in this job:
    // share the cached network result instead of issuing duplicate provider requests.
    const completed = this.completedRecordings.get(entry.recordingKey);
    if (completed && completed.trackId !== entry.trackId) {
      const shared = this.deps.shareResult(completed.trackId, track);
      if (shared || completed.status === "not-found") {
        entry.status = completed.status;
        entry.detail = "Shared recording result";
        this.afterEntry();
        return;
      }
    }

    const controller = new AbortController();
    this.active.set(entry.trackId, controller);
    entry.attempts += 1;
    entry.lastAttemptAt = this.now();
    this.emit();
    try {
      const result = await this.deps.resolveTrack(track, {
        // A retry (attempt > 1 via retryFailed) is an explicit manual action: bypass cooldown.
        force: entry.attempts > 1,
        signal: controller.signal,
      });
      // A cancel that landed while the request was in flight owns the final state; late
      // responses must not resurrect entries (their cache writes already happened and stay).
      if (this.job !== job || job.state === "canceled") return;
      const classification = classifyResolveResult(result);
      entry.status = classification;
      const errorDetail = result.providerStatus.find(item => item.status === "error")?.detail;
      entry.detail =
        classification === "found"
          ? undefined
          : classification === "not-found"
            ? "No provider has lyrics for this track"
            : errorDetail ?? "Temporary failure";
      if (classification === "found" || classification === "not-found") {
        if (!this.completedRecordings.has(entry.recordingKey)) {
          this.completedRecordings.set(entry.recordingKey, {
            trackId: entry.trackId,
            status: classification,
          });
        }
      }
    } catch (error) {
      if (this.job !== job || job.state === "canceled") return;
      if ((error as Error)?.name === "AbortError") {
        // Paused/canceled consumer abort: hand the entry back to the queue.
        entry.status = "pending";
        entry.attempts = Math.max(0, entry.attempts - 1);
        this.cursor = Math.min(this.cursor, job.entries.indexOf(entry));
      } else {
        entry.status = "failed";
        entry.detail = (error as Error)?.message ?? "Temporary failure";
      }
    } finally {
      this.active.delete(entry.trackId);
    }
    this.afterEntry();
  }

  private afterEntry(): void {
    if (this.job) this.job.updatedAt = this.now();
    this.markDirty();
    this.emit();
  }

  private finishJob(): void {
    if (!this.job || this.job.state !== "running") return;
    this.job.state = "completed";
    this.job.finishedAt = this.now();
    this.job.updatedAt = this.now();
    this.markDirty();
    void this.persistNow().catch(() => undefined);
    this.emit();
  }

  /* ----------------------------------------------------------- persistence */

  private emit(): void {
    this.deps.onProgress?.(this.snapshot());
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow().catch(error => {
        console.warn("[Cadence] Could not persist lyrics fetch job:", error);
      });
    }, 500);
  }

  async persistNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty && !this.job) return;
    this.dirty = false;
    if (!this.persistence.persist) return;
    const file: JobFile = { version: 1, job: this.job };
    try {
      await this.persistence.persist(JSON.stringify(file));
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }
}

function yieldToHost(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
