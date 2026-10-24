/**
 * PORTED FROM UPSTREAM — Better Lyrics
 * Repository: https://github.com/better-lyrics/better-lyrics
 * Commit:     18be32089343ec721fbead38c082117e4d44871f
 * Original:   src/core/constants.ts (provider + translation sections)
 * License:    GPL-3.0
 *
 * Changes for Cadence: only the constants the standalone player needs are kept. YouTube Music
 * endpoints (browse/next, captions, Cubey stream/Turnstile) are intentionally absent; LRCLIB is
 * called directly instead of through the authenticated Cubey stream, because a standalone app has
 * no YouTube page origin to satisfy that challenge from.
 *
 * Cadence additions (same GPL-3.0 terms, new code rather than ported lines): the Better Lyrics API
 * and Unison source keys, base URLs and timeouts. Source-key names and relative priorities mirror
 * the extension's current `PROVIDER_CONFIGS` (bLyrics/Unison first, LRCLIB last), with Cadence's
 * two offline local sources kept ahead of every network source.
 */

import { mergePreferredProviders } from "./providerList";

export type LyricSourceKey =
  // Recommended default order (the 13 entries users see in Settings), in priority order.
  | "local-rich"
  | "blyrics-richsynced"
  | "unison-richsynced"
  | "binimum-richsynced"
  | "blyrics-wordsynced"
  | "local-lrc"
  | "blyrics-line"
  | "unison-synced"
  | "blyrics-synced"
  | "qq-line"
  | "lrclib-synced"
  | "lrclib-plain"
  | "embedded-tag"
  // Implemented variants offered as addable providers outside the recommended 13.
  | "unison-wordsynced"
  | "binimum-synced"
  | "unison-plain"
  // Legacy key from before the local TTML/QRC vs local LRC split; migration-only.
  | "local-sidecar"
  // Ephemeral source for a user-picked file; never part of the persisted order.
  | "user-file";

export type ProviderSyncKind = "syllable" | "word" | "line" | "unsynced" | "mixed";

export interface ProviderConfig {
  key: Exclude<LyricSourceKey, "user-file" | "local-sidecar">;
  displayName: string;
  /** Short badge label, e.g. "Word synced" — distinct variants stay distinguishable. */
  syncType: ProviderSyncKind;
  priority: number;
  /** Whether this provider can run with no network connection. */
  offline: boolean;
  /**
   * False for registry slots whose upstream endpoint does not exist in Cadence's keyless model.
   * They remain visible and reorderable so the user sees why nothing is fetched, and resolution
   * skips them instead of pretending they work.
   */
  available: boolean;
  /** Shown next to an unavailable slot, explaining exactly what is missing. */
  unavailableReason?: string;
}

/**
 * The provider registry. The first 13 entries are the exact recommended default order; entries
 * after them are implemented variants users can add manually. `local-sidecar` is intentionally
 * absent: it is migrated to `local-rich` + `local-lrc` (see {@link migrateProviderOrder}).
 */
export const PROVIDER_CONFIGS: readonly ProviderConfig[] = [
  // 1 — local rich lyrics (TTML/QRC sidecars and the Lyrics/ folder convention).
  { key: "local-rich", displayName: "Local TTML/QRC", syncType: "syllable", priority: 1, offline: true, available: true },
  // 2 — Better Lyrics API: TTML syllable sync from /getLyrics.
  { key: "blyrics-richsynced", displayName: "Better Lyrics", syncType: "syllable", priority: 2, offline: false, available: true },
  // 3 — Unison community TTML (syllable).
  { key: "unison-richsynced", displayName: "Unison", syncType: "syllable", priority: 3, offline: false, available: true },
  // 4 — BiniLyrics keyless community TTML.
  { key: "binimum-richsynced", displayName: "BiniLyrics", syncType: "syllable", priority: 4, offline: false, available: true },
  // 5 — Better Lyrics QQ endpoint: word-timed QRC.
  { key: "blyrics-wordsynced", displayName: "QQ Word", syncType: "word", priority: 5, offline: false, available: true },
  // 6 — local line-synced LRC sidecars.
  { key: "local-lrc", displayName: "Local LRC", syncType: "line", priority: 6, offline: true, available: true },
  // 7 — no separate generic Better Lyrics line endpoint exists; its line lyrics come from Kugou (9).
  {
    key: "blyrics-line",
    displayName: "Better Lyrics Line",
    syncType: "line",
    priority: 7,
    offline: false,
    available: false,
    unavailableReason: "The Better Lyrics API serves line-synced lyrics only through its Kugou endpoint (see Kugou Line).",
  },
  // 8 — Unison line-synced LRC.
  { key: "unison-synced", displayName: "Unison Line", syncType: "line", priority: 8, offline: false, available: true },
  // 9 — Better Lyrics Kugou endpoint: line-synced LRC.
  { key: "blyrics-synced", displayName: "Kugou Line", syncType: "line", priority: 9, offline: false, available: true },
  // 10 — the keyless QQ endpoint returns word QRC only; it has no line variant upstream.
  {
    key: "qq-line",
    displayName: "QQ Line",
    syncType: "line",
    priority: 10,
    offline: false,
    available: false,
    unavailableReason: "QQ's keyless endpoint returns word-timed QRC only; no line-synced variant is exposed.",
  },
  // 11 — LRCLIB synced LRC.
  { key: "lrclib-synced", displayName: "LRCLIB Line", syncType: "line", priority: 11, offline: false, available: true },
  // 12 — LRCLIB plain/unsynced.
  { key: "lrclib-plain", displayName: "LRCLIB Unsynced", syncType: "unsynced", priority: 12, offline: false, available: true },
  // 13 — lyrics embedded in the audio file's tags (USLT/SYLT).
  { key: "embedded-tag", displayName: "Embedded Tag", syncType: "mixed", priority: 13, offline: true, available: true },
  // Implemented extras, not part of the recommended default 13.
  { key: "unison-wordsynced", displayName: "Unison Word", syncType: "word", priority: 14, offline: false, available: true },
  { key: "binimum-synced", displayName: "BiniLyrics Line", syncType: "line", priority: 15, offline: false, available: true },
  { key: "unison-plain", displayName: "Unison Unsynced", syncType: "unsynced", priority: 16, offline: false, available: true },
] as const;

/** The exact recommended order: the 13 available/unavailable slots, no extras, no duplicates. */
export const DEFAULT_PROVIDER_ORDER: LyricSourceKey[] = PROVIDER_CONFIGS.filter(
  provider => provider.priority <= 13
).map(provider => provider.key);

/** Every key the registry knows about (excludes legacy and ephemeral sources). */
export const LYRIC_SOURCE_KEYS = PROVIDER_CONFIGS.map(provider => provider.key);

const REGISTRY_BY_KEY = new Map<LyricSourceKey, ProviderConfig>(PROVIDER_CONFIGS.map(provider => [provider.key, provider]));

export function providerConfig(key: string): ProviderConfig | undefined {
  return REGISTRY_BY_KEY.get(untoggleProvider(key) as LyricSourceKey);
}

export function isKnownProviderKey(key: string): boolean {
  return REGISTRY_BY_KEY.has(untoggleProvider(key) as LyricSourceKey);
}

/** Disabled providers are stored with a `d_` prefix (upstream convention); strip it for lookup. */
export function untoggleProvider(key: string): string {
  return key.startsWith("d_") ? key.slice(2) : key;
}

/** Registry priority for candidate sorting; unknown/legacy entries sort last instead of first. */
export function providerPriority(key: string): number {
  return providerConfig(key)?.priority ?? 999;
}

/**
 * Migrate any persisted provider order to the current registry:
 *   - malformed / non-array / empty inputs safely yield the default order;
 *   - the legacy combined `local-sidecar` source splits into `local-rich` then `local-lrc`,
 *     preserving a `d_` disabled prefix;
 *   - unknown or removed future keys are dropped, duplicates collapsed;
 *   - newly introduced registry slots in `defaults` are merged in at their canonical positions
 *     while preserving the user's relative ordering of known providers and keeping `d_`-disabled
 *     slots disabled.
 */
export function migrateProviderOrder(
  stored: unknown,
  defaults: readonly string[] = DEFAULT_PROVIDER_ORDER
): string[] {
  if (!Array.isArray(stored) || stored.length === 0) return [...defaults];

  const defaultKnownKeys = new Set(defaults.map(untoggleProvider));
  const isRecognized = (key: string): boolean => isKnownProviderKey(key) || defaultKnownKeys.has(key);

  const migrated: string[] = [];
  const remember = (entry: string) => {
    const bare = untoggleProvider(entry);
    if (!migrated.some(existing => untoggleProvider(existing) === bare)) {
      migrated.push(entry);
    }
  };

  for (const raw of stored) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let disabled = false;
    let key = trimmed;
    while (key.startsWith("d_")) {
      disabled = true;
      key = key.slice(2).trim();
    }
    if (!key) continue;

    if (key === "local-sidecar") {
      remember(disabled ? "d_local-rich" : "local-rich");
      remember(disabled ? "d_local-lrc" : "local-lrc");
      continue;
    }
    if (isRecognized(key)) {
      remember(disabled ? `d_${key}` : key);
    }
  }

  // mergePreferredProviders only inserts keys that are missing (neither active nor d_-prefixed),
  // so custom relative order and explicitly disabled default slots both survive.
  const merged = mergePreferredProviders(migrated, defaults).filter(entry =>
    isRecognized(untoggleProvider(entry))
  );
  return merged.length > 0 ? merged : [...defaults];
}

export const LRCLIB_BASE_URL = "https://lrclib.net/api" as const;

/**
 * Public Better Lyrics API (Go backend, better-lyrics/api). Documented at
 * https://docs.betterlyrics.org. Keyless reads serve cached songs; an uncached miss answers 401
 * because fresh-fetch API keys are not issued to third parties. Cadence never sends a key.
 */
export const BETTER_LYRICS_API_BASE_URL = "https://api.betterlyrics.org" as const;

/**
 * Unison crowdsourced lyrics API. The extension calls the same host (its `UNISON_API_URL`);
 * https://docs.betterlyrics.org/unison also documents the unison.boidu.dev mirror. Reads need no
 * key and no video ID — song/artist/album/duration metadata lookups are supported.
 */
export const UNISON_BASE_URL = "https://unison.betterlyrics.org" as const;

/**
 * BiniLyrics: the keyless community TTML catalogue the extension consumes as its native
 * `binimum` provider (https://lyrics.binimum.org/developers). Lookup is metadata based and each
 * result points at a TTML file fetched in a second request.
 */
export const BINIMUM_BASE_URL = "https://lyrics-api.binimum.org" as const;

/** Per-request network timeouts, matching the extension's 10 s Unison timeout. */
export const UNISON_REQUEST_TIMEOUT_MS = 10_000;
export const BETTER_LYRICS_REQUEST_TIMEOUT_MS = 12_000;
export const BINIMUM_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Upstream translate endpoints (src/core/constants.ts). Kept byte-for-byte so translation and
 * romanization behave the same as in the extension.
 */
export const TRANSLATE_LYRICS_URL = function (lang: string, text: string): string {
  return `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`;
};
export const TRANSLATE_IN_ROMAJI = function (lang: string, text: string): string {
  return `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=${lang}-Latn&dt=t&dt=rm&q=${encodeURIComponent(text)}`;
};

// Supported Romanization Languages (upstream list, unchanged)
export const ROMANIZATION_LANGUAGES: Record<string, string> = {
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  ru: "Russian",
  hi: "Hindi",
  ar: "Arabic",
  th: "Thai",
  el: "Greek",
  he: "Hebrew",
  bn: "Bengali",
  ta: "Tamil",
  te: "Telugu",
  ml: "Malayalam",
  kn: "Kannada",
  gu: "Gujarati",
  pa: "Punjabi",
  mr: "Marathi",
  ur: "Urdu",
  si: "Sinhala",
  my: "Burmese",
  ka: "Georgian",
  km: "Khmer",
  lo: "Lao",
  fa: "Persian",
};

export const LOG_PREFIX = "[Cadence]" as const;

export const LYRICS_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
export const LYRICS_NEGATIVE_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
