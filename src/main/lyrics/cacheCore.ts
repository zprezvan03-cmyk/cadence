/**
 * Runtime-agnostic persistent lyrics cache core for Cadence.
 * Shared between the Tauri WebView2 bridge and Node unit/integration tests.
 *
 * Layout (schema version 3): one entry per **track**, holding every lyrics variant known for that
 * track no matter where it came from — local TTML/QRC/LRC/SRT/TXT sidecars, the audio file's
 * embedded tag, a file the user picked by hand, a manually selected search result, and the remote
 * providers. Manual search queries keep their own metadata-keyed entries so repeated searches stay
 * offline-capable without duplicating the lyrics of a track.
 *
 * Within a track entry the two origins are kept apart on purpose:
 *  - `candidates`  local files / tags / user choices (re-validated by the service on resolve)
 *  - `network`     the remote providers' definitive answer, with its own timestamp so the 30-day
 *                  positive / 12-hour negative TTLs keep working exactly as before.
 */

import { detectFormat } from "@braccato/parsers";
import {
  LYRICS_CACHE_TTL_MS,
  LYRICS_NEGATIVE_CACHE_TTL_MS,
} from "../../shared/upstream/better-lyrics/constants";
import type { LyricsCandidate } from "../../shared/types";

/** Where a cached candidate originally came from. */
export type CachedOrigin = "local" | "network" | "manual";

/** A lyrics candidate as stored on disk: the payload plus everything needed to replay it. */
export interface CachedLyricsCandidate extends LyricsCandidate {
  /** Original payload format (`ttml`, `qrc`, `lrc`, `srt`, `plain`, …), recorded when stored. */
  format: string;
  origin: CachedOrigin;
  /** When this exact payload was first stored (ms since epoch); survives later rewrites. */
  cachedAt: number;
}

/** Minimal identity of the track an entry belongs to; `id` is null for manual-search entries. */
export interface CachedTrackIdentity {
  id: number | null;
  title: string;
  artist: string;
  album: string;
  duration: number;
}

export interface CachedNetworkSection {
  /** When the network stage last produced a *definitive* answer. */
  savedAt: number;
  /** Definitive answer with no candidates: nothing found anywhere. */
  negative: boolean;
  candidates: CachedLyricsCandidate[];
  /**
   * Provider module ids (`better-lyrics`, `unison`, `binimum`, `lrclib`) that completed normally
   * for this answer, so later passes search only never/newly-enabled providers. Absent on
   * entries written before this field existed; those are treated as fully covered.
   */
  queriedModules?: string[];
  /** Provider-order slot keys that were enabled when this answer was produced. */
  enabledKeys?: string[];
}

export interface LyricsCacheEntry {
  savedAt: number;
  kind: "track" | "search";
  track: CachedTrackIdentity;
  /** Local files, embedded tags and hand-picked files. */
  candidates: CachedLyricsCandidate[];
  network?: CachedNetworkSection;
}

/**
 * `version` 2 and older are dropped rather than migrated: they only hold remote payloads keyed by
 * metadata, without the track identity, formats or manual selections this version promises, and
 * the original lyrics are one lookup away.
 */
interface CacheFile {
  version: 3;
  entries: Record<string, LyricsCacheEntry>;
}

const CACHE_VERSION = 3;

const MAX_ENTRIES = 800;

/**
 * A bundle re-written with byte-identical content within this window is not persisted again, so
 * re-playing a track never rewrites the file for nothing. Older copies still refresh their
 * timestamp normally.
 */
const IDENTICAL_WRITE_WINDOW_MS = 60_000;

/** Candidate handed to the cache; `cachedAt` is assigned/preserved by the cache itself. */
export interface CachedCandidateInput {
  candidate: LyricsCandidate;
  format?: string;
  origin: CachedOrigin;
}

export interface LyricsCachePersistence {
  initialJson?: string | null;
  persist?: (json: string) => void | Promise<void>;
}

export interface LyricsCacheSummary {
  key: string;
  kind: "track" | "search";
  trackId: number | null;
  title: string;
  artist: string;
  album: string;
  duration: number;
  /** Display names of every provider/source present, in stored order. */
  sources: string[];
  /** Distinct payload formats present, in stored order. */
  formats: string[];
  candidateCount: number;
  savedAt: number;
  /** True when only a definitive "nothing found" answer is stored. */
  negative: boolean;
  /** True when a definitive remote answer is stored. */
  hasNetwork: boolean;
}

function byteLength(text: string): number {
  if (typeof TextEncoder === "undefined") return text.length * 2;
  return new TextEncoder().encode(text).length;
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

/** Tolerant of untrusted/hand-edited files: anything that doesn't look right is ignored. */
function normalizeStoredCandidate(value: unknown, fallbackOrigin: CachedOrigin): CachedLyricsCandidate | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CachedLyricsCandidate>;
  if (
    typeof candidate.source !== "string" ||
    typeof candidate.provider !== "string" ||
    typeof candidate.text !== "string" ||
    candidate.text.trim().length === 0 ||
    typeof candidate.syncHint !== "string" ||
    !Array.isArray(candidate.songwriters)
  ) {
    return null;
  }
  return {
    source: candidate.source,
    provider: candidate.provider,
    text: candidate.text,
    syncHint: candidate.syncHint as LyricsCandidate["syncHint"],
    language: typeof candidate.language === "string" ? candidate.language : null,
    songwriters: candidate.songwriters.filter((entry): entry is string => typeof entry === "string"),
    sourceHref: typeof candidate.sourceHref === "string" ? candidate.sourceHref : null,
    cached: true,
    ...(candidate.matchTitle !== undefined ? { matchTitle: candidate.matchTitle } : {}),
    ...(candidate.matchArtist !== undefined ? { matchArtist: candidate.matchArtist } : {}),
    ...(candidate.matchAlbum !== undefined ? { matchAlbum: candidate.matchAlbum } : {}),
    ...(candidate.matchDuration !== undefined ? { matchDuration: candidate.matchDuration } : {}),
    format: typeof candidate.format === "string" && candidate.format ? candidate.format : detectFormat(candidate.text),
    origin:
      candidate.origin === "local" || candidate.origin === "manual" || candidate.origin === "network"
        ? candidate.origin
        : fallbackOrigin,
    cachedAt: Number.isFinite(candidate.cachedAt) ? Number(candidate.cachedAt) : Date.now(),
  };
}

function normalizeEntry(value: unknown): LyricsCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<LyricsCacheEntry>;
  if (raw.kind !== "track" && raw.kind !== "search") return null;
  if (!raw.track || typeof raw.track !== "object") return null;
  const savedAt = Number(raw.savedAt);
  if (!Number.isFinite(savedAt)) return null;
  const track = raw.track as Partial<CachedTrackIdentity>;
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates
        .map(candidate => normalizeStoredCandidate(candidate, "local"))
        .filter((candidate): candidate is CachedLyricsCandidate => candidate !== null)
    : [];

  let network: CachedNetworkSection | undefined;
  if (raw.network && typeof raw.network === "object") {
    const section = raw.network as Partial<CachedNetworkSection>;
    if (Number.isFinite(Number(section.savedAt))) {
      const stringList = (value: unknown): string[] | undefined =>
        Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string")
          : undefined;
      network = {
        savedAt: Number(section.savedAt),
        negative: Boolean(section.negative),
        candidates: Array.isArray(section.candidates)
          ? section.candidates
              .map(candidate => normalizeStoredCandidate(candidate, "network"))
              .filter((candidate): candidate is CachedLyricsCandidate => candidate !== null)
          : [],
        ...(stringList(section.queriedModules)
          ? { queriedModules: stringList(section.queriedModules) }
          : {}),
        ...(stringList(section.enabledKeys) ? { enabledKeys: stringList(section.enabledKeys) } : {}),
      };
    }
  }

  return {
    savedAt,
    kind: raw.kind,
    track: {
      id: Number.isFinite(Number(track.id)) ? Number(track.id) : null,
      title: typeof track.title === "string" ? track.title : "",
      artist: typeof track.artist === "string" ? track.artist : "",
      album: typeof track.album === "string" ? track.album : "",
      duration: Number.isFinite(Number(track.duration)) ? Number(track.duration) : 0,
    },
    candidates,
    ...(network ? { network } : {}),
  };
}

/** Candidates of an entry flattened for display and legacy lookups. */
export function flattenEntry(entry: LyricsCacheEntry): CachedLyricsCandidate[] {
  return [...entry.candidates, ...(entry.network?.candidates ?? [])];
}

function comparable(entry: LyricsCacheEntry): string {
  return JSON.stringify({
    kind: entry.kind,
    track: entry.track,
    candidates: entry.candidates,
    network: entry.network,
  });
}

export class LyricsCacheCore {
  private data: CacheFile = { version: CACHE_VERSION, entries: {} };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /**
   * Bumped by {@link clear}. A lookup that was already in flight when the user cleared the cache
   * carries the previous token, so its result is dropped instead of writing the entries the user
   * just deleted straight back to disk.
   */
  private generation = 0;

  constructor(private readonly persistence: LyricsCachePersistence = {}) {
    if (persistence.initialJson) {
      try {
        const parsed = JSON.parse(persistence.initialJson) as Partial<CacheFile>;
        if (parsed?.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === "object") {
          const entries: Record<string, LyricsCacheEntry> = {};
          for (const [key, value] of Object.entries(parsed.entries)) {
            const entry = normalizeEntry(value);
            if (entry) entries[key] = entry;
          }
          this.data = { version: CACHE_VERSION, entries };
        }
      } catch {
        this.data = { version: CACHE_VERSION, entries: {} };
      }
    }
  }

  /* ------------------------------------------------------------------ keys */

  /** Metadata key, still used for manual-search entries. */
  static key(artist: string, title: string, album: string, duration: number): string {
    return `${artist.toLocaleLowerCase()}|${title.toLocaleLowerCase()}|${album.toLocaleLowerCase()}|${Math.round(duration)}`;
  }

  static searchKey(artist: string, title: string, album: string, duration: number): string {
    return `search:${this.key(artist, title, album, duration)}`;
  }

  /**
   * Stable identity for a library track. The numeric library id is the reliable identifier; the
   * entry also records normalized metadata so a re-tagged file (same id, different title) never
   * replays another song's lyrics. Tracks without an id fall back to their metadata.
   */
  static trackKey(
    trackId: number | null | undefined,
    identity?: { artist?: string; title?: string; album?: string; duration?: number }
  ): string {
    if (typeof trackId === "number" && Number.isFinite(trackId)) return `track:${trackId}`;
    return `track:meta:${this.key(
      identity?.artist ?? "",
      identity?.title ?? "",
      identity?.album ?? "",
      identity?.duration ?? 0
    )}`;
  }

  /**
   * Whether two identity records describe the same song. Titles/artists/albums are compared
   * normalized; duration is compared with a two-second tolerance (re-scans round differently) and
   * ignored when either side has no duration.
   */
  static sameIdentity(a: CachedTrackIdentity, b: CachedTrackIdentity): boolean {
    if (normalized(a.title) !== normalized(b.title)) return false;
    if (normalized(a.artist) !== normalized(b.artist)) return false;
    if (normalized(a.album) !== normalized(b.album)) return false;
    if (a.duration > 0 && b.duration > 0 && Math.abs(a.duration - b.duration) > 2) return false;
    return true;
  }

  /**
   * Whether a stored remote answer is still inside its positive or negative TTL. The negative
   * TTL is the user-configurable Not Found cooldown; only `savedAt` (the last definitive
   * attempt) is stored, so changing the cooldown re-evaluates every entry immediately.
   */
  static networkIsFresh(
    section: CachedNetworkSection | undefined,
    now = Date.now(),
    negativeTtlMs: number = LYRICS_NEGATIVE_CACHE_TTL_MS
  ): boolean {
    if (!section) return false;
    const ttl = section.negative ? negativeTtlMs : LYRICS_CACHE_TTL_MS;
    return now - section.savedAt <= ttl;
  }

  /**
   * Negative-answer TTL in effect for this cache instance. The bridge wires it to
   * `settings.lyrics.notFoundCooldownDays`; cores constructed without settings (Node tests)
   * keep the legacy 12-hour interpretation.
   */
  private negativeTtlMs: number = LYRICS_NEGATIVE_CACHE_TTL_MS;

  setNegativeTtlMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.negativeTtlMs = ms;
  }

  getNegativeTtlMs(): number {
    return this.negativeTtlMs;
  }

  /** Instance freshness check honouring the configured Not Found cooldown. */
  networkFresh(section: CachedNetworkSection | undefined, now = Date.now()): boolean {
    return LyricsCacheCore.networkIsFresh(section, now, this.negativeTtlMs);
  }

  /* --------------------------------------------------------------- lookups */

  /** Legacy flat lookup used by manual searches and tests: all candidates for a key. */
  get(key: string): LyricsCandidate[] | null {
    const entry = this.entry(key);
    if (!entry) return null;
    const candidates = flattenEntry(entry);
    if (candidates.length === 0 && entry.network?.negative) return [];
    return candidates.map(candidate => ({ ...candidate, cached: true }));
  }

  /** The validated entry (local + network sections kept apart), or null when expired/absent. */
  getEntry(key: string): LyricsCacheEntry | null {
    const entry = this.entry(key);
    return entry ? cloneEntry(entry) : null;
  }

  /** Reads and enforces the entry TTLs, deleting an entry that can no longer answer anything. */
  private entry(key: string): LyricsCacheEntry | null {
    const entry = this.data.entries[key];
    if (!entry) return null;
    const expired = Date.now() - entry.savedAt > LYRICS_CACHE_TTL_MS;
    const networkExpired =
      entry.candidates.length === 0 && !this.networkFresh(entry.network);
    if (expired || networkExpired) {
      delete this.data.entries[key];
      this.markDirty();
      return null;
    }
    return entry;
  }

  /** Token to hand back to {@link set} when the write is the result of a long-running lookup. */
  currentGeneration(): number {
    return this.generation;
  }

  /** Number of cached songs, used to report what a clear actually removed. */
  size(): number {
    return Object.keys(this.data.entries).length;
  }

  /** Exact serialized size in bytes plus the entry breakdown, for Settings → Cache. */
  stats(): { entries: number; tracks: number; searches: number; bytes: number } {
    const keys = Object.keys(this.data.entries);
    let tracks = 0;
    for (const key of keys) if (this.data.entries[key].kind === "track") tracks += 1;
    return {
      entries: keys.length,
      tracks,
      searches: keys.length - tracks,
      // The very bytes `persist` writes (UTF-8 of the same JSON string), not an estimate.
      bytes: byteLength(JSON.stringify(this.data)),
    };
  }

  /** Rows for the cache manager: metadata only, no lyric text. */
  list(): LyricsCacheSummary[] {
    return Object.entries(this.data.entries)
      .map(([key, entry]) => {
        const candidates = flattenEntry(entry);
        const sources: string[] = [];
        const formats: string[] = [];
        for (const candidate of candidates) {
          if (!sources.includes(candidate.provider)) sources.push(candidate.provider);
          if (!formats.includes(candidate.format)) formats.push(candidate.format);
        }
        return {
          key,
          kind: entry.kind,
          trackId: entry.track.id,
          title: entry.track.title,
          artist: entry.track.artist,
          album: entry.track.album,
          duration: entry.track.duration,
          sources,
          formats,
          candidateCount: candidates.length,
          savedAt: entry.savedAt,
          negative: candidates.length === 0 && Boolean(entry.network?.negative),
          hasNetwork: Boolean(entry.network),
        };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  /* --------------------------------------------------------------- writing */

  /**
   * Stores a per-track bundle. `local` and `network` are independent sections; pass `network: null`
   * when the remote providers were not queried (or did not answer definitively) so a still-fresh
   * cached remote answer is kept instead of being replaced by an incomplete one.
   */
  putTrack(
    key: string,
    identity: CachedTrackIdentity,
    local: CachedCandidateInput[],
    network: {
      candidates: CachedCandidateInput[];
      negative: boolean;
      queriedModules?: string[];
      enabledKeys?: string[];
    } | null,
    generation: number = this.generation
  ): void {
    if (generation !== this.generation) return;
    const previous = this.data.entries[key];
    const sameTrack = previous?.kind === "track" && LyricsCacheCore.sameIdentity(previous.track, identity);
    const previousLocal = sameTrack ? previous?.candidates ?? [] : [];

    let nextNetwork: CachedNetworkSection | undefined;
    if (network) {
      nextNetwork = {
        savedAt: Date.now(),
        negative: network.negative,
        candidates: this.mergeCandidates(sameTrack ? previous?.network?.candidates ?? [] : [], network.candidates),
        ...(network.queriedModules ? { queriedModules: [...network.queriedModules] } : {}),
        ...(network.enabledKeys ? { enabledKeys: [...network.enabledKeys] } : {}),
      };
    } else if (sameTrack && previous?.network && this.networkFresh(previous.network)) {
      nextNetwork = previous.network;
    }

    this.store(key, {
      savedAt: Date.now(),
      kind: "track",
      track: { ...identity },
      candidates: this.mergeCandidates(previousLocal, local),
      ...(nextNetwork ? { network: nextNetwork } : {}),
    });
  }

  /** Stores the remote answer for an arbitrary key (manual searches keep their metadata keys). */
  set(key: string, candidates: LyricsCandidate[], generation: number = this.generation): void {
    if (generation !== this.generation) return;
    const now = Date.now();
    const previous = this.data.entries[key];
    const stored = this.mergeCandidates([], candidates.map(candidate => ({ candidate, origin: "network" as const })));
    const isSearch = key.startsWith("search:");
    this.store(key, {
      savedAt: now,
      kind: isSearch ? "search" : "track",
      track: { ...(previous?.track ?? identityFromKey(key)) },
      candidates: isSearch ? stored : [],
      ...(isSearch ? {} : { network: { savedAt: now, negative: stored.length === 0, candidates: stored } }),
    });
  }

  /** Stores manual-search rows under their query entry, keeping the query for the manager. */
  putSearch(
    key: string,
    query: { title: string; artist: string; album: string; duration: number },
    candidates: LyricsCandidate[],
    generation: number = this.generation
  ): void {
    if (generation !== this.generation) return;
    this.store(key, {
      savedAt: Date.now(),
      kind: "search",
      track: { id: null, ...query },
      candidates: this.mergeCandidates([], candidates.map(candidate => ({ candidate, origin: "network" as const }))),
    });
  }

  /**
   * Adds or replaces one locally sourced candidate (a hand-picked file, or the manual search
   * result the user chose) without touching the remote section. Used by the renderer flows that
   * never go through `resolve`.
   */
  rememberCandidate(
    key: string,
    identity: CachedTrackIdentity,
    input: CachedCandidateInput,
    generation: number = this.generation
  ): void {
    if (generation !== this.generation) return;
    const previous = this.data.entries[key];
    const sameTrack = previous?.kind === "track" && LyricsCacheCore.sameIdentity(previous.track, identity);
    const base = sameTrack ? previous?.candidates ?? [] : [];
    const replaced = base.filter(
      candidate =>
        !(
          candidate.origin === input.origin &&
          (input.origin === "manual" || candidate.source === input.candidate.source)
        )
    );
    this.store(key, {
      savedAt: Date.now(),
      kind: "track",
      track: { ...identity },
      candidates: this.mergeCandidates(replaced, [input]),
      ...(sameTrack && previous?.network && this.networkFresh(previous.network)
        ? { network: previous.network }
        : {}),
    });
  }

  /** Removes a single entry. Returns false when it was already gone. */
  remove(key: string): boolean {
    if (!this.data.entries[key]) return false;
    delete this.data.entries[key];
    this.markDirty();
    return true;
  }

  clear(): void {
    this.generation += 1;
    this.data = { version: CACHE_VERSION, entries: {} };
    this.markDirty();
  }

  /* -------------------------------------------------------------- internals */

  private toStored(
    candidate: LyricsCandidate,
    origin: CachedOrigin,
    format: string | undefined,
    previous: CachedLyricsCandidate[]
  ): CachedLyricsCandidate {
    const existing = previous.find(entry => entry.source === candidate.source && entry.text === candidate.text);
    return {
      ...candidate,
      source: String(candidate.source),
      provider: String(candidate.provider),
      text: candidate.text,
      syncHint: candidate.syncHint,
      language: candidate.language ?? null,
      songwriters: [...(candidate.songwriters ?? [])],
      sourceHref: candidate.sourceHref ?? null,
      cached: true,
      format: format || detectFormat(candidate.text),
      origin,
      cachedAt: existing?.cachedAt ?? Date.now(),
    };
  }

  private mergeCandidates(
    previous: CachedLyricsCandidate[],
    next: CachedCandidateInput[]
  ): CachedLyricsCandidate[] {
    const seen = new Set<string>();
    const out: CachedLyricsCandidate[] = [];
    for (const input of next) {
      const stored = this.toStored(input.candidate, input.origin, input.format, previous);
      const key = `${stored.origin}\u0000${stored.source}\u0000${stored.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(stored);
    }
    return out;
  }

  private store(key: string, entry: LyricsCacheEntry): void {
    const previous = this.data.entries[key];
    if (previous && Date.now() - previous.savedAt < IDENTICAL_WRITE_WINDOW_MS && comparable(previous) === comparable(entry)) {
      // Same payload re-read from the same files moments later: keep the stored timestamp and skip
      // the write, so re-playing a track never rewrites the cache file for nothing.
      return;
    }
    this.data.entries[key] = entry;
    const keys = Object.keys(this.data.entries);
    if (keys.length > MAX_ENTRIES) this.trim(keys);
    this.markDirty();
  }

  private trim(keys: string[]): void {
    keys
      .sort((a, b) => this.data.entries[a].savedAt - this.data.entries[b].savedAt)
      .slice(0, Math.max(0, keys.length - MAX_ENTRIES))
      .forEach(stale => delete this.data.entries[stale]);
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
  }

  /** Fire-and-forget persistence for the hot paths: failures are logged, never thrown. */
  flush(): void {
    void this.persistNow().catch(error => {
      console.warn("[Cadence] Could not persist lyrics cache:", error);
    });
  }

  /**
   * Persists and resolves only once the write has actually landed, rejecting when it fails, so a
   * caller that reports the result to the user (Settings → Cache) can tell the truth. A failed
   * write leaves the data marked dirty so the next flush retries it.
   */
  async persistNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    if (!this.persistence.persist) return;
    try {
      // `persist` may be synchronous (Node) or a promise (Tauri `invoke`); both are awaited here.
      await this.persistence.persist(JSON.stringify(this.data));
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }
}

function cloneEntry(entry: LyricsCacheEntry): LyricsCacheEntry {
  const cloneCandidate = (candidate: CachedLyricsCandidate): CachedLyricsCandidate => ({
    ...candidate,
    songwriters: [...candidate.songwriters],
  });
  return {
    ...entry,
    track: { ...entry.track },
    candidates: entry.candidates.map(cloneCandidate),
    ...(entry.network
      ? { network: { ...entry.network, candidates: entry.network.candidates.map(cloneCandidate) } }
      : {}),
  };
}

/** Best-effort identity for a legacy metadata key (`artist|title|album|duration`, `search:` prefixed). */
function identityFromKey(key: string): CachedTrackIdentity {
  const body = key.startsWith("search:") ? key.slice("search:".length) : key;
  const parts = body.split("|");
  const duration = Number(parts[3]);
  return {
    id: null,
    title: parts[1] ?? "",
    artist: parts[0] ?? "",
    album: parts[2] ?? "",
    duration: Number.isFinite(duration) ? duration : 0,
  };
}
