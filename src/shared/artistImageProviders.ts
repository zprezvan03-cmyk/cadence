/**
 * Multi-source artist/profile-picture providers for Cadence.
 *
 * The system is deliberately provider-agnostic: every source is an independent module implementing
 * `ArtistImageProvider`, so adding another catalogue later means writing one class and listing its
 * id — never touching the fetching pipeline, the cache or the UI.
 *
 * Providers verified against their live APIs while writing this module:
 *
 * | Source              | Artist portraits?                    | Credentials        | Notes                                               |
 * | ------------------- | ------------------------------------ | ------------------ | --------------------------------------------------- |
 * | Last.fm             | Yes (`artist.getinfo` `image[]`)     | user API key       | Hosted on `lastfm.freetls.fastly.net`, community art |
 * | Wikidata (via MBID) | Yes (property P18 on Wikimedia Commons) | none            | Freely licensed; author + licence must be credited   |
 * | Deezer              | Yes (`search/artist` `picture_*`)    | none               | Public catalogue, ~50 requests / 5 s                 |
 * | MusicBrainz         | **No** — metadata & MBIDs only       | none               | Used here only as the identity resolver              |
 * | Cover Art Archive   | **No** — release covers only         | none               | Evaluated and excluded (`feasible: false`)           |
 * | Apple iTunes Search | **No** — `entity=musicArtist` has no artwork; only album art | none | Evaluated and excluded (`feasible: false`) |
 * | fanart.tv           | Yes, but personal key + attribution terms | user key      | Not implemented; listed for diagnostics only         |
 *
 * MusicBrainz has no artist images of its own and its terms require a descriptive User-Agent plus
 * at most one request per second, both of which are enforced here. Wikidata is only ever consulted
 * through a MusicBrainz identity (MBID → `wikidata` URL relation), never by searching Wikidata by
 * name, so a namesake's portrait cannot be picked up.
 */

import { normalizeCatalogText } from "./popularityProviders";

export type ArtistImageProviderId =
  | "lastfm"
  | "wikidata"
  | "deezer"
  | "musicbrainz"
  | "cover-art-archive"
  | "itunes"
  | "fanart-tv";

/** Providers that can actually return an artist portrait today. */
export type ArtistImageSourceId = "lastfm" | "wikidata" | "deezer";

export const DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER: readonly ArtistImageSourceId[] = [
  "lastfm",
  "wikidata",
  "deezer",
];

export const ARTIST_IMAGE_PROVIDER_IDS: readonly ArtistImageSourceId[] = ["lastfm", "wikidata", "deezer"];

export const ARTIST_IMAGE_PROVIDER_LABELS: Record<ArtistImageProviderId, string> = {
  lastfm: "Last.fm",
  wikidata: "Wikidata / Wikimedia Commons",
  deezer: "Deezer",
  musicbrainz: "MusicBrainz",
  "cover-art-archive": "Cover Art Archive",
  itunes: "Apple iTunes",
  "fanart-tv": "fanart.tv",
};

export const DEFAULT_ARTIST_IMAGE_USER_AGENT =
  "Cadence Player (https://github.com/zprezvan03-cmyk/cadence)";

/** Last.fm's own "this artist has no image" placeholder hashes. */
const LASTFM_PLACEHOLDER_HASHES = new Set([
  "2a96cbd8b46e442fc41c2b86b821562f", // artist
  "c6f59c1e5e7240a4c0d427abd71f3dbb", // album
  "4128a6eb29f94943c9d206c08e625904", // track
  "818148bf682d429dc215c1705eb27b98", // user avatar
]);

/**
 * Deezer's anonymous-artist picture is a grey square whose image hash is empty
 * (`.../images/artist//1000x1000-000000-80-0-0.jpg`). The trailing `-000000-80-0-0` segment is just
 * the CDN resize recipe present on every real picture, so only an empty hash marks a placeholder.
 */
function isDeezerPlaceholder(url: string): boolean {
  if (!url.trim()) return true;
  const match = /\/images\/artist\/([^/]*)\//i.exec(url);
  if (!match) return false;
  return (match[1] ?? "").trim().length === 0;
}

export function isPlaceholderArtistImageUrl(url: string | null | undefined): boolean {
  const value = (url ?? "").trim();
  if (!value) return true;
  const lowered = value.toLowerCase();
  for (const hash of LASTFM_PLACEHOLDER_HASHES) {
    if (lowered.includes(hash)) return true;
  }
  if (lowered.includes("default_artist") || lowered.includes("/noimage")) return true;
  return false;
}

export interface ArtistImageQuery {
  /** Artist name exactly as it appears in the library. */
  name: string;
  /** MusicBrainz artist ID when the library already knows it (avoids a search round trip). */
  mbid?: string | null;
  /** Album the picture is being shown for; unused by current sources, kept for future providers. */
  album?: string | null;
}

export interface ArtistImageCandidate {
  provider: ArtistImageSourceId;
  /** Remote image URL, still unvalidated: the service downloads and inspects it next. */
  imageUrl: string;
  /** The artist name the provider matched, used for identity verification/diagnostics. */
  matchedArtistName: string | null;
  /** MusicBrainz ID when the provider supplied one. */
  mbid: string | null;
  /** Provider-declared pixel size, when it reports one. */
  width: number | null;
  height: number | null;
  /** Human page for the artist at this provider (used for attribution links). */
  pageUrl: string | null;
  /** Credit line the provider's terms require, e.g. `Last.fm` or `Jane Doe · CC BY-SA 4.0`. */
  attribution: string;
  license: string | null;
  licenseUrl: string | null;
  author: string | null;
  /** 0..1: provider trust combined with name/identity match strength. */
  confidence: number;
}

export type ArtistImageProviderStatus =
  | "hit"
  | "miss"
  | "error"
  | "skipped"
  | "rate-limited"
  | "not-configured";

export interface ArtistImageProviderResult {
  provider: ArtistImageProviderId;
  status: ArtistImageProviderStatus;
  candidate: ArtistImageCandidate | null;
  /** Stable, machine-readable reason (`no-image`, `artist-name-mismatch`, `license-not-allowed`, …). */
  detail?: string;
  retryAfterSeconds?: number;
}

export interface ArtistImageProviderFeasibility {
  provider: ArtistImageProviderId;
  name: string;
  /** True only for providers shipped with a working implementation. */
  implemented: boolean;
  /** True when the provider can actually return an artist portrait. */
  feasible: boolean;
  requiresCredentials: boolean;
  attributionRequired: boolean;
  license: string | null;
  strengths: string[];
  limitations: string[];
  statusReason: string;
}

export interface ArtistIdentity {
  mbid: string;
  name: string;
  /** 0..1 confidence that this MusicBrainz entity is the library artist. */
  matchScore: number;
  disambiguation: string | null;
  aliases: string[];
  /** Wikidata QID taken from the MBID's `wikidata` URL relationship. */
  wikidataId: string | null;
  musicBrainzUrl: string;
}

export interface ArtistIdentityResolver {
  /** Searches MusicBrainz for the library artist and loads its Wikidata relation. */
  resolve(
    query: ArtistImageQuery,
    config: ArtistImageProviderConfig,
    signal?: AbortSignal
  ): Promise<ArtistIdentity | null>;
  /** Loads a known MusicBrainz artist (and its Wikidata relation) directly. */
  lookupByMbid(
    mbid: string,
    config: ArtistImageProviderConfig,
    signal?: AbortSignal
  ): Promise<ArtistIdentity | null>;
}

export interface ArtistImageProviderConfig {
  /** Master switch (`settings.artistImages.enabled`). */
  enabled: boolean;
  /** Provider priority; unknown or unavailable ids are simply skipped. */
  providerOrder: readonly string[];
  /** User-supplied Last.fm API key (`settings.scrobbling.apiKey`). */
  lastFmApiKey: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Descriptive User-Agent required by MusicBrainz and polite for every other source. */
  userAgent: string;
  /** Custom transport; defaults to the runtime `fetch`. */
  fetchFn?: typeof fetch;
  /** Shared MusicBrainz identity resolver (created on demand when omitted). */
  identityResolver?: ArtistIdentityResolver;
  /** Overridable per-provider request spacing (tests set this to 0). */
  minProviderIntervalMs?: Partial<Record<ArtistImageProviderId, number>>;
}

export interface ArtistImageProvider {
  readonly id: ArtistImageSourceId;
  readonly name: string;
  readonly requiresCredentials: boolean;
  evaluateFeasibility(config: ArtistImageProviderConfig): ArtistImageProviderFeasibility;
  isAvailable(config: ArtistImageProviderConfig): boolean;
  lookup(
    query: ArtistImageQuery,
    config: ArtistImageProviderConfig,
    signal?: AbortSignal
  ): Promise<ArtistImageProviderResult>;
}

const DEFAULT_PROVIDER_INTERVAL_MS: Record<ArtistImageProviderId, number> = {
  lastfm: 220,
  wikidata: 320,
  deezer: 220,
  musicbrainz: 1100,
  "cover-art-archive": 1100,
  itunes: 1100,
  "fanart-tv": 1100,
};

export function createArtistImageProviderConfig(
  partial: Partial<ArtistImageProviderConfig> = {}
): ArtistImageProviderConfig {
  return {
    enabled: partial.enabled ?? true,
    providerOrder: normalizeArtistImageProviderOrder(partial.providerOrder),
    lastFmApiKey: partial.lastFmApiKey ?? "",
    timeoutMs: partial.timeoutMs ?? 6000,
    userAgent: partial.userAgent ?? DEFAULT_ARTIST_IMAGE_USER_AGENT,
    fetchFn: partial.fetchFn,
    identityResolver: partial.identityResolver,
    minProviderIntervalMs: partial.minProviderIntervalMs,
  };
}

/**
 * Keeps a stored provider order valid: unknown entries are dropped, duplicates collapse, and any
 * known provider the order is missing is appended, so shipping a new provider in an update reaches
 * existing users without a settings migration.
 */
export function normalizeArtistImageProviderOrder(
  order: readonly string[] | null | undefined
): ArtistImageSourceId[] {
  const seen = new Set<ArtistImageSourceId>();
  const result: ArtistImageSourceId[] = [];
  for (const entry of order ?? []) {
    if (!ARTIST_IMAGE_PROVIDER_IDS.includes(entry as ArtistImageSourceId)) continue;
    const id = entry as ArtistImageSourceId;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/** Artist names that can never be resolved to a real portrait. */
export function isUnresolvableArtistName(raw: string): boolean {
  const normalized = normalizeCatalogText(raw);
  if (!normalized) return true;
  if (
    normalized === "unknown" ||
    normalized === "unknown artist" ||
    normalized === "unknown artists" ||
    normalized === "various" ||
    normalized === "various artists" ||
    normalized === "va" ||
    normalized === "no artist" ||
    normalized === "[unknown]" ||
    normalized === "untitled"
  ) {
    return true;
  }
  return false;
}

/** Normalized form used for identity comparison: case-, accent- and punctuation-insensitive. */
export function normalizeArtistName(raw: string): string {
  return normalizeCatalogText(raw).replace(/\s+/g, " ").trim();
}

/** Same normalization, with a leading article removed so "The Beatles" matches "Beatles". */
function artistNameVariants(raw: string): string[] {
  const base = normalizeArtistName(raw);
  if (!base) return [];
  const variants = new Set<string>([base]);
  const withoutArticle = base.replace(/^(?:the|a|an)\s+/, "");
  if (withoutArticle && withoutArticle !== base) variants.add(withoutArticle);
  return [...variants];
}

/**
 * Leading words that mark the rest of a provider name as a *qualification* of the same act
 * ("Nagorizakura feat. Someone", "Nirvana & The Melvins"), rather than a different artist that
 * merely shares a prefix ("Nirvana UK", "Nirvana Tribute Band" — note the latter is a real tribute
 * act and is deliberately rejected).
 */
const COLLABORATION_QUALIFIER =
  /^(?:feat\.?|ft\.?|featuring|and|&|with|vs\.?|presents|x)\b/i;

function jaccard(left: string, right: string): number {
  const a = new Set(left.split(" ").filter(Boolean));
  const b = new Set(right.split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Identity match in [0, 1] between the library artist and a provider's matched name.
 *
 * Only an exact normalized name (including article-less forms) reaches 1. A collaboration qualifier
 * on either side reaches 0.95 — that is the same primary act. Anything else is capped at 0.85 so a
 * namesake such as "Nirvana UK" can never clear `MIN_ARTIST_IMAGE_NAME_MATCH`; a tribute or cover
 * act that happens to prefix the real name is therefore rejected as well.
 */
export function artistNameMatchScore(queryName: string, candidateName: string | null | undefined): number {
  const candidate = (candidateName ?? "").trim();
  if (!candidate) return 0;
  const queryVariants = artistNameVariants(queryName);
  const candidateVariants = artistNameVariants(candidate);
  if (queryVariants.length === 0 || candidateVariants.length === 0) return 0;
  for (const query of queryVariants) {
    for (const other of candidateVariants) {
      if (query === other) return 1;
    }
  }
  let best = 0;
  for (const query of queryVariants) {
    for (const other of candidateVariants) {
      const candidateExtends = other.startsWith(`${query} `);
      const queryExtends = query.startsWith(`${other} `);
      if (candidateExtends || queryExtends) {
        const remainder = candidateExtends ? other.slice(query.length + 1) : query.slice(other.length + 1);
        best = Math.max(best, COLLABORATION_QUALIFIER.test(remainder) ? 0.95 : 0.85);
      }
      best = Math.max(best, Math.min(0.8, jaccard(query, other)));
    }
  }
  return best;
}

/** Minimum name similarity accepted before a provider result may be cached. */
export const MIN_ARTIST_IMAGE_NAME_MATCH = 0.9;

/* ------------------------------------------------------------------ transports */

interface JsonFetchOutcome {
  ok: boolean;
  status: number;
  retryAfterSeconds?: number;
  json: unknown;
}

function resolveFetch(config: ArtistImageProviderConfig): typeof fetch {
  return config.fetchFn ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
}

async function fetchJson(
  url: string,
  config: ArtistImageProviderConfig,
  signal?: AbortSignal,
  accept = "application/json"
): Promise<JsonFetchOutcome> {
  const fetchFn = resolveFetch(config);
  const timeout = AbortSignal.timeout(Math.max(500, config.timeoutMs));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchFn(url, {
    method: "GET",
    headers: { Accept: accept, "User-Agent": config.userAgent },
    signal: combined,
  });
  let retryAfterSeconds: number | undefined;
  const retryHeader = response.headers?.get?.("Retry-After");
  if (retryHeader) {
    const parsed = Number(retryHeader);
    if (Number.isFinite(parsed) && parsed > 0) retryAfterSeconds = Math.ceil(parsed);
  }
  const text = await response.text();
  let json: unknown = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { ok: response.ok, status: response.status, retryAfterSeconds, json };
}

/** Per-provider request spacing, so a burst of artist rows cannot trip a provider's rate limit. */
class ProviderThrottle {
  private nextAllowedAt = 0;
  constructor(private readonly intervalMs: number) {}

  async wait(): Promise<void> {
    if (this.intervalMs <= 0) return;
    const now = Date.now();
    const delay = this.nextAllowedAt - now;
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.intervalMs;
    if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
  }
}

function throttleFor(config: ArtistImageProviderConfig, id: ArtistImageProviderId): ProviderThrottle {
  return new ProviderThrottle(config.minProviderIntervalMs?.[id] ?? DEFAULT_PROVIDER_INTERVAL_MS[id]);
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") return [value as T];
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ------------------------------------------------------------------ 1. Last.fm */

/** Last.fm sizes, smallest to largest; the provider returns them in this order. */
const LASTFM_SIZE_RANK: Record<string, number> = {
  small: 1,
  medium: 2,
  large: 3,
  extralarge: 4,
  mega: 5,
};

export class LastFmArtistImageProvider implements ArtistImageProvider {
  readonly id = "lastfm" as const;
  readonly name = "Last.fm";
  readonly requiresCredentials = true;

  private readonly throttle: ProviderThrottle;
  constructor(config: ArtistImageProviderConfig) {
    this.throttle = throttleFor(config, this.id);
  }

  evaluateFeasibility(config: ArtistImageProviderConfig): ArtistImageProviderFeasibility {
    return {
      provider: this.id,
      name: this.name,
      implemented: true,
      feasible: true,
      requiresCredentials: true,
      attributionRequired: false,
      license: null,
      strengths: [
        "Widest coverage for mainstream and niche artists",
        "Returns several sizes (up to 300×300 and original upload)",
        "Same catalogue that already powers Cadence's popularity lookups",
      ],
      limitations: [
        "Requires the user's own Last.fm API key (Cadence ships none)",
        "Community-contributed photos: no licence metadata is exposed",
        "Placeholder image hashes must be filtered out",
      ],
      statusReason: config.lastFmApiKey.trim()
        ? "Ready: Last.fm API key configured"
        : "Configure a Last.fm API key in Settings → Scrobbling to enable this source",
    };
  }

  isAvailable(config: ArtistImageProviderConfig): boolean {
    return Boolean(config.lastFmApiKey.trim());
  }

  async lookup(
    query: ArtistImageQuery,
    config: ArtistImageProviderConfig,
    signal?: AbortSignal
  ): Promise<ArtistImageProviderResult> {
    const apiKey = config.lastFmApiKey.trim();
    if (!apiKey) {
      return { provider: this.id, status: "not-configured", candidate: null, detail: "missing-api-key" };
    }
    if (isUnresolvableArtistName(query.name)) {
      return { provider: this.id, status: "miss", candidate: null, detail: "unresolvable-artist-name" };
    }
    await this.throttle.wait();
    const url =
      "https://ws.audioscrobbler.com/2.0/?method=artist.getinfo" +
      `&artist=${encodeURIComponent(query.name)}&api_key=${encodeURIComponent(apiKey)}` +
      "&format=json&autocorrect=1";

    let outcome: JsonFetchOutcome;
    try {
      outcome = await fetchJson(url, config, signal);
    } catch (error) {
      return { provider: this.id, status: "error", candidate: null, detail: describeThrown(error) };
    }
    if (outcome.status === 429) {
      return {
        provider: this.id,
        status: "rate-limited",
        candidate: null,
        detail: "lastfm-rate-limited",
        retryAfterSeconds: outcome.retryAfterSeconds,
      };
    }
    const body = asRecord(outcome.json);
    const errorCode = num(body.error);
    if (errorCode === 6 || errorCode === 8) {
      // 6 = artist not found, 8 = operation failed (usually an unknown artist).
      return { provider: this.id, status: "miss", candidate: null, detail: "artist-not-found" };
    }
    if (!outcome.ok || errorCode !== null) {
      return {
        provider: this.id,
        status: "error",
        candidate: null,
        detail: `lastfm-http-${outcome.status}${errorCode !== null ? `-${errorCode}` : ""}`,
      };
    }

    const artist = asRecord(body.artist);
    const matchedName = str(artist.name);
    const matchScore = artistNameMatchScore(query.name, matchedName);
    if (matchScore < MIN_ARTIST_IMAGE_NAME_MATCH) {
      return {
        provider: this.id,
        status: "miss",
        candidate: null,
        detail: "artist-name-mismatch",
      };
    }
    const mbid = str(artist.mbid);
    if (query.mbid && mbid && query.mbid !== mbid) {
      return { provider: this.id, status: "miss", candidate: null, detail: "mbid-mismatch" };
    }

    const images = asArray<Record<string, unknown>>(artist.image)
      .map(entry => ({
        url: str(entry["#text"]) ?? str(entry.text),
        rank: LASTFM_SIZE_RANK[String(entry.size ?? "").toLowerCase()] ?? 0,
      }))
      .filter((entry): entry is { url: string; rank: number } => Boolean(entry.url))
      .filter(entry => !isPlaceholderArtistImageUrl(entry.url))
      .sort((a, b) => b.rank - a.rank);

    const best = images[0];
    if (!best) {
      return { provider: this.id, status: "miss", candidate: null, detail: "no-image" };
    }
    return {
      provider: this.id,
      status: "hit",
      candidate: {
        provider: this.id,
        imageUrl: best.url,
        matchedArtistName: matchedName,
        mbid,
        width: null,
        height: null,
        pageUrl: str(artist.url),
        attribution: "Last.fm",
        license: null,
        licenseUrl: null,
        author: null,
        // Name match alone decides how much of the provider's trust survives: a fuzzy match keeps
        // proportionally less confidence so a better-anchored source can win a refresh.
        confidence: clamp01(0.88 * matchScore + 0.02 * Math.min(1, best.rank / 5)),
      },
    };
  }
}

/* ------------------------------------------------------------------ 2. Deezer */

export class DeezerArtistImageProvider implements ArtistImageProvider {
  readonly id = "deezer" as const;
  readonly name = "Deezer";
  readonly requiresCredentials = false;

  private readonly throttle: ProviderThrottle;
  constructor(config: ArtistImageProviderConfig) {
    this.throttle = throttleFor(config, this.id);
  }

  evaluateFeasibility(): ArtistImageProviderFeasibility {
    return {
      provider: this.id,
      name: this.name,
      implemented: true,
      feasible: true,
      requiresCredentials: false,
      attributionRequired: false,
      license: null,
      strengths: [
        "No API key or account required",
        "Editorial artist portraits up to 1000×1000",
        "Useful for artists Last.fm has no picture for",
      ],
      limitations: [
        "Public API budget of roughly 50 requests per 5 s",
        "No licence metadata; images are Deezer catalogue artwork",
        "Anonymous artists return a grey placeholder square",
      ],
      statusReason: "Ready: public API, no credentials required",
    };
  }

  isAvailable(): boolean {
    return true;
  }

  async lookup(
    query: ArtistImageQuery,
    config: ArtistImageProviderConfig,
    signal?: AbortSignal
  ): Promise<ArtistImageProviderResult> {
    if (isUnresolvableArtistName(query.name)) {
      return { provider: this.id, status: "miss", candidate: null, detail: "unresolvable-artist-name" };
    }
    await this.throttle.wait();
    const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(query.name)}&limit=5`;

    let outcome: JsonFetchOutcome;
    try {
      outcome = await fetchJson(url, config, signal);
    } catch (error) {
      return { provider: this.id, status: "error", candidate: null, detail: describeThrown(error) };
    }
    if (outcome.status === 429 || outcome.status === 403) {
      return {
        provider: this.id,
        status: "rate-limited",
        candidate: null,
        detail: "deezer-rate-limited",
        retryAfterSeconds: outcome.retryAfterSeconds,
      };
    }
    if (!outcome.ok) {
      return { provider: this.id, status: "error", candidate: null, detail: `deezer-http-${outcome.status}` };
    }

    const results = asArray<Record<string, unknown>>(asRecord(outcome.json).data);
    if (results.length === 0) {
      return { provider: this.id, status: "miss", candidate: null, detail: "artist-not-found" };
    }
    const ranked = results
      .map(entry => ({
        entry,
        name: str(entry.name),
        match: artistNameMatchScore(query.name, str(entry.name)),
        fans: num(entry.nb_fan) ?? 0,
      }))
      .filter(candidate => candidate.match >= MIN_ARTIST_IMAGE_NAME_MATCH)
      .sort((a, b) => b.match - a.match || b.fans - a.fans);
    const best = ranked[0];
    if (!best) {
      return { provider: this.id, status: "miss", candidate: null, detail: "artist-name-mismatch" };
    }

    const picture =
      str(best.entry.picture_xl) ??
      str(best.entry.picture_big) ??
      str(best.entry.picture_medium) ??
      null;
    if (!picture || isDeezerPlaceholder(picture)) {
      return { provider: this.id, status: "miss", candidate: null, detail: "no-image" };
    }
    const artistId = num(best.entry.id);
    return {
      provider: this.id,
      status: "hit",
      candidate: {
        provider: this.id,
        imageUrl: picture,
        matchedArtistName: best.name,
        mbid: null,
        width: null,
        height: null,
        pageUrl: artistId ? `https://www.deezer.com/artist/${artistId}` : null,
        attribution: "Deezer",
        license: null,
        licenseUrl: null,
        author: null,
        confidence: clamp01(0.8 * best.match),
      },
    };
  }
}

/* ----------------------------------------------------- 3. MusicBrainz identity */

const MUSICBRAINZ_API = "https://musicbrainz.org/ws/2";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidMusicBrainzId(value: string | null | undefined): boolean {
  return typeof value === "string" && MBID_PATTERN.test(value.trim());
}

interface MusicBrainzArtistRecord {
  id?: unknown;
  name?: unknown;
  score?: unknown;
  disambiguation?: unknown;
  aliases?: unknown;
  relations?: unknown;
}

/**
 * Resolves a library artist to a MusicBrainz entity. MusicBrainz is not an image source; it is the
 * disambiguating identity that makes the Wikidata source trustworthy (a namesake can never be
 * mistaken for the artist, because the link comes from the matched entity itself).
 */
export class MusicBrainzArtistIdentityResolver implements ArtistIdentityResolver {
  private readonly throttle: ProviderThrottle;
  constructor(
    config: ArtistImageProviderConfig,
    /** MusicBrainz allows one request per second per client; tests may relax it explicitly. */
    minIntervalMs = 1100
  ) {
    this.throttle = new ProviderThrottle(config.minProviderIntervalMs?.musicbrainz ?? minIntervalMs);
  }

  async resolve(
    query: ArtistImageQuery,
    config: ArtistImageProviderConfig,
    signal?: AbortSignal
  ): Promise<ArtistIdentity | null> {
    if (!query.name.trim()) return null;
    if (isValidMusicBrainzId(query.mbid)) {
      return this.lookupByMbid(query.mbid as string, config, signal);
    }
    if (isUnresolvableArtistName(query.name)) return null;

    await this.throttle.wait();
    const searchUrl =
      `${MUSICBRAINZ_API}/artist/?query=${encodeURIComponent(`artist:"${query.name}"`)}` +
      "&limit=5&fmt=json";
    let outcome: JsonFetchOutcome;
    try {
      outcome = await fetchJson(searchUrl, config, signal);
    } catch {
      return null;
    }
    if (!outcome.ok) return null;

    const artists = asArray<MusicBrainzArtistRecord>(asRecord(outcome.json).artists);
    const ranked = artists
      .map(artist => {
        const id = str(artist.id);
        const name = str(artist.name);
        const aliases = asArray<Record<string, unknown>>(artist.aliases)
          .map(alias => str(alias.name))
          .filter((alias): alias is string => Boolean(alias));
        const nameMatch = Math.max(
          artistNameMatchScore(query.name, name),
          ...aliases.map(alias => artistNameMatchScore(query.name, alias)),
          0
        );
        const searchScore = (num(artist.score) ?? 0) / 100;
        return { artist, id, name, aliases, nameMatch, searchScore };
      })
      .filter(candidate => Boolean(candidate.id) && Boolean(candidate.name))
      .filter(candidate => {
        // Accept an exact name/alias hit at a modest Lucene score, or a near-exact name only when
        // MusicBrainz itself is very confident — never a loose fuzzy match.
        const exact = candidate.nameMatch >= 0.999;
        return exact ? candidate.searchScore >= 0.8 : candidate.nameMatch >= 0.94 && candidate.searchScore >= 0.95;
      })
      .sort((a, b) => b.searchScore - a.searchScore || b.nameMatch - a.nameMatch);

    const best = ranked[0];
    if (!best) return null;
    const identity = await this.lookupByMbid(best.id as string, config, signal);
    if (!identity) {
      return {
        mbid: best.id as string,
        name: best.name as string,
        matchScore: clamp01(0.6 * best.nameMatch + 0.4 * best.searchScore),
        disambiguation: str(asRecord(best.artist).disambiguation),
        aliases: best.aliases,
        wikidataId: null,
        musicBrainzUrl: `https://musicbrainz.org/artist/${best.id as string}`,
      };
    }
    return {
      ...identity,
      matchScore: clamp01(0.6 * best.nameMatch + 0.4 * best.searchScore),
      aliases: best.aliases.length > 0 ? best.aliases : identity.aliases,
    };
  }

  async lookupByMbid(
    mbid: string,
    config: ArtistImageProviderConfig,
    signal?: AbortSignal
  ): Promise<ArtistIdentity | null> {
    if (!isValidMusicBrainzId(mbid)) return null;
    await this.throttle.wait();
    const url = `${MUSICBRAINZ_API}/artist/${encodeURIComponent(mbid.trim())}?inc=url-rels+aliases&fmt=json`;
    let outcome: JsonFetchOutcome;
    try {
      outcome = await fetchJson(url, config, signal);
    } catch {
      return null;
    }
    if (!outcome.ok) return null;
    const artist = asRecord(outcome.json);
    const id = str(artist.id);
    const name = str(artist.name);
    if (!id || !name) return null;

    let wikidataId: string | null = null;
    for (const relation of asArray<Record<string, unknown>>(artist.relations)) {
      const type = str(relation.type)?.toLowerCase();
      const target = str(asRecord(relation.url).resource);
      if (!target) continue;
      const match = /wikidata\.org\/wiki\/(Q\d+)/i.exec(target);
      if (match && (!type || type === "wikidata")) {
        wikidataId = match[1].toUpperCase();
        break;
      }
    }

    return {
      mbid: id,
      name,
      matchScore: 1,
      disambiguation: str(artist.disambiguation),
      aliases: asArray<Record<string, unknown>>(artist.aliases)
        .map(alias => str(alias.name))
        .filter((alias): alias is string => Boolean(alias)),
      wikidataId,
      musicBrainzUrl: `https://musicbrainz.org/artist/${id}`,
    };
  }
}

/* --------------------------------------------------- 4. Wikidata / Commons */

/** Licences Commons content may be reused under, with the credit this UI can actually show. */
const ALLOWED_COMMONS_LICENSES: { pattern: RegExp; label: string }[] = [
  { pattern: /^cc0/i, label: "CC0" },
  { pattern: /^public domain/i, label: "Public domain" },
  { pattern: /^pd\b/i, label: "Public domain" },
  { pattern: /^cc[ -]?by(?:[ -]?sa)?(?:[ -]?\d(?:\.\d)?)?/i, label: "Creative Commons" },
];

function stripHtml(value: string | null): string | null {
  if (!value) return null;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/**
 * Artist portraits from Wikidata (property `P18`), resolved only through a MusicBrainz identity and
 * served from Wikimedia Commons. Every result carries the author, licence and file page its licence
 * requires; results whose licence cannot be reduced to a credit line are rejected outright.
 */
export class WikidataArtistImageProvider implements ArtistImageProvider {
  readonly id = "wikidata" as const;
  readonly name = "Wikidata / Wikimedia Commons";
  readonly requiresCredentials = false;

  private readonly throttle: ProviderThrottle;
  private readonly resolver: ArtistIdentityResolver;

  constructor(config: ArtistImageProviderConfig, resolver?: ArtistIdentityResolver) {
    this.throttle = throttleFor(config, this.id);
    this.resolver = resolver ?? config.identityResolver ?? new MusicBrainzArtistIdentityResolver(config);
  }

  evaluateFeasibility(): ArtistImageProviderFeasibility {
    return {
      provider: this.id,
      name: this.name,
      implemented: true,
      feasible: true,
      requiresCredentials: false,
      attributionRequired: true,
      license: "CC0 / Public domain / CC BY / CC BY-SA (per file)",
      strengths: [
        "Freely licensed images with machine-readable author and licence metadata",
        "Identity anchored to a MusicBrainz entity, so namesakes cannot collide",
        "No API key",
      ],
      limitations: [
        "Only artists with a Wikidata item and a P18 image (patchier for small/regional acts)",
        "Requires an author + licence credit line in the UI",
        "Files without a reducible credit are rejected",
      ],
      statusReason: "Ready: public APIs, no credentials required",
    };
  }

  isAvailable(): boolean {
    return true;
  }

  async lookup(
    query: ArtistImageQuery,
    config: ArtistImageProviderConfig,
    signal?: AbortSignal
  ): Promise<ArtistImageProviderResult> {
    let identity: ArtistIdentity | null;
    try {
      identity = await this.resolver.resolve(query, config, signal);
    } catch (error) {
      return { provider: this.id, status: "error", candidate: null, detail: describeThrown(error) };
    }
    if (!identity) {
      return { provider: this.id, status: "miss", candidate: null, detail: "no-musicbrainz-match" };
    }
    if (!identity.wikidataId) {
      return { provider: this.id, status: "miss", candidate: null, detail: "no-wikidata-entity" };
    }

    await this.throttle.wait();
    const entityUrl =
      `${WIKIDATA_API}?action=wbgetentities&format=json&formatversion=2` +
      `&props=claims|labels&ids=${encodeURIComponent(identity.wikidataId)}`;
    let entityOutcome: JsonFetchOutcome;
    try {
      entityOutcome = await fetchJson(entityUrl, config, signal);
    } catch (error) {
      return { provider: this.id, status: "error", candidate: null, detail: describeThrown(error) };
    }
    if (!entityOutcome.ok) {
      return { provider: this.id, status: "error", candidate: null, detail: `wikidata-http-${entityOutcome.status}` };
    }
    const entity = asRecord(asRecord(asRecord(entityOutcome.json).entities)[identity.wikidataId]);
    const claims = asRecord(entity.claims);
    const p18 = asArray<Record<string, unknown>>(claims.P18)[0];
    const fileName = str(asRecord(asRecord(p18?.mainsnak).datavalue).value);
    if (!fileName) {
      return { provider: this.id, status: "miss", candidate: null, detail: "no-image-claim" };
    }

    await this.throttle.wait();
    const commonsUrl =
      `${COMMONS_API}?action=query&format=json&formatversion=2&prop=imageinfo` +
      `&iiprop=url|size|extmetadata&iiurlwidth=640` +
      `&titles=${encodeURIComponent(`File:${fileName.replace(/^File:/i, "")}`)}`;
    let commonsOutcome: JsonFetchOutcome;
    try {
      commonsOutcome = await fetchJson(commonsUrl, config, signal);
    } catch (error) {
      return { provider: this.id, status: "error", candidate: null, detail: describeThrown(error) };
    }
    if (!commonsOutcome.ok) {
      return { provider: this.id, status: "error", candidate: null, detail: `commons-http-${commonsOutcome.status}` };
    }
    const page = asArray<Record<string, unknown>>(asRecord(asRecord(commonsOutcome.json).query).pages)[0];
    const imageInfo = asArray<Record<string, unknown>>(page?.imageinfo)[0];
    if (!imageInfo) {
      return { provider: this.id, status: "miss", candidate: null, detail: "no-image-info" };
    }

    const metadata = asRecord(imageInfo.extmetadata);
    const licenseShort = stripHtml(str(asRecord(metadata.LicenseShortName).value));
    const licenseUrl = stripHtml(str(asRecord(metadata.LicenseUrl).value));
    const author = stripHtml(str(asRecord(metadata.Artist).value));
    const matchedLicense = ALLOWED_COMMONS_LICENSES.find(
      entry => (licenseShort ? entry.pattern.test(licenseShort) : false)
    );
    if (!licenseShort || !matchedLicense) {
      return { provider: this.id, status: "miss", candidate: null, detail: "license-not-allowed" };
    }
    if (/^cc[ -]?by/i.test(licenseShort) && !author) {
      // CC BY/BY-SA require naming the author; without one the credit would be incomplete.
      return { provider: this.id, status: "miss", candidate: null, detail: "missing-attribution" };
    }

    const imageUrl = str(imageInfo.thumburl) ?? str(imageInfo.url);
    if (!imageUrl) {
      return { provider: this.id, status: "miss", candidate: null, detail: "no-image-url" };
    }
    const pageUrl = str(imageInfo.descriptionurl);
    const width = num(imageInfo.thumbwidth) ?? num(imageInfo.width);
    const height = num(imageInfo.thumbheight) ?? num(imageInfo.height);
    const attribution = author ? `${author} · ${licenseShort}` : licenseShort;
    return {
      provider: this.id,
      status: "hit",
      candidate: {
        provider: this.id,
        imageUrl,
        matchedArtistName: identity.name,
        mbid: identity.mbid,
        width: width ?? null,
        height: height ?? null,
        pageUrl,
        attribution,
        license: licenseShort,
        licenseUrl,
        author,
        // Licensed, identity-anchored imagery is the highest-trust source Cadence can show.
        confidence: clamp01(0.95 * identity.matchScore + 0.05 * (author ? 1 : 0.6)),
      },
    };
  }
}

/* ------------------------------------------------------- 5. Feasibility table */

export const INVESTIGATED_ARTIST_IMAGE_SOURCES: readonly ArtistImageProviderFeasibility[] = [
  {
    provider: "lastfm",
    name: "Last.fm",
    implemented: true,
    feasible: true,
    requiresCredentials: true,
    attributionRequired: false,
    license: null,
    strengths: ["Broad coverage", "Multiple sizes", "Already used for popularity"],
    limitations: ["Needs the user's API key", "No licence metadata", "Placeholder hashes"],
    statusReason: "Supported image source",
  },
  {
    provider: "wikidata",
    name: "Wikidata / Wikimedia Commons",
    implemented: true,
    feasible: true,
    requiresCredentials: false,
    attributionRequired: true,
    license: "CC0 / Public domain / CC BY / CC BY-SA",
    strengths: ["Licensed with author metadata", "Identity anchored through MusicBrainz"],
    limitations: ["Only artists with P18", "Credit line required"],
    statusReason: "Supported image source",
  },
  {
    provider: "deezer",
    name: "Deezer",
    implemented: true,
    feasible: true,
    requiresCredentials: false,
    attributionRequired: false,
    license: null,
    strengths: ["No key", "Editorial portraits up to 1000×1000"],
    limitations: ["~50 requests / 5 s", "Placeholder square for anonymous artists"],
    statusReason: "Supported image source",
  },
  {
    provider: "musicbrainz",
    name: "MusicBrainz",
    implemented: true,
    feasible: false,
    requiresCredentials: false,
    attributionRequired: true,
    license: "CC0 (metadata only)",
    strengths: ["Authoritative artist identity, MBIDs, aliases and disambiguation"],
    limitations: ["Publishes no artist imagery", "1 request/second and a descriptive User-Agent"],
    statusReason: "Used as the identity resolver only; it is not an image source",
  },
  {
    provider: "cover-art-archive",
    name: "Cover Art Archive",
    implemented: false,
    feasible: false,
    requiresCredentials: false,
    attributionRequired: true,
    license: "Per release",
    strengths: ["High-quality release covers"],
    limitations: ["Release/release-group covers only — no artist portraits"],
    statusReason: "Excluded: the archive has no artist imagery, only release covers",
  },
  {
    provider: "itunes",
    name: "Apple iTunes Search",
    implemented: false,
    feasible: false,
    requiresCredentials: false,
    attributionRequired: true,
    license: null,
    strengths: ["Fast public search"],
    limitations: [
      "`entity=musicArtist` returns no artwork at all",
      "Album artwork is release art, not an artist portrait",
      "Undocumented per-IP 403 rate limiting",
    ],
    statusReason: "Excluded: the API returns album artwork only, never an artist photo",
  },
  {
    provider: "fanart-tv",
    name: "fanart.tv",
    implemented: false,
    feasible: true,
    requiresCredentials: true,
    attributionRequired: true,
    license: "Contributor licences, attribution required",
    strengths: ["Artist thumbnails and backgrounds", "MBID-addressable"],
    limitations: ["Personal API key required", "Attribution terms; not implemented in this release"],
    statusReason: "Feasible future provider: implement `ArtistImageProvider` and add it to the order",
  },
];

/* ------------------------------------------------------------------- factory */

/**
 * Builds the provider instances in a caller-supplied order. Unknown ids are ignored, so a settings
 * file from a newer build cannot break an older one.
 */
export function createArtistImageProviders(
  config: ArtistImageProviderConfig,
  order: readonly string[] = config.providerOrder
): ArtistImageProvider[] {
  const resolver = config.identityResolver ?? new MusicBrainzArtistIdentityResolver(config);
  const providers: ArtistImageProvider[] = [];
  for (const id of normalizeArtistImageProviderOrder(order)) {
    if (id === "lastfm") providers.push(new LastFmArtistImageProvider(config));
    else if (id === "wikidata") providers.push(new WikidataArtistImageProvider(config, resolver));
    else if (id === "deezer") providers.push(new DeezerArtistImageProvider(config));
  }
  return providers;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function describeThrown(error: unknown): string {
  const name = (error as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return (error as Error)?.message || "network-error";
}
