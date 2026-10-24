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

export type LyricSourceKey =
  | "local-sidecar"
  | "embedded-tag"
  | "blyrics-richsynced"
  | "unison-richsynced"
  | "binimum-richsynced"
  | "blyrics-wordsynced"
  | "unison-wordsynced"
  | "blyrics-synced"
  | "unison-synced"
  | "binimum-synced"
  | "lrclib-synced"
  | "unison-plain"
  | "lrclib-plain"
  | "user-file";

export interface ProviderConfig {
  key: Exclude<LyricSourceKey, "user-file">;
  displayName: string;
  syncType: "syllable" | "word" | "line" | "unsynced";
  priority: number;
  /** Whether this provider can run with no network connection. */
  offline: boolean;
}

/** Upstream order preserved for the network providers; local sources come first. */
export const PROVIDER_CONFIGS: readonly ProviderConfig[] = [
  { key: "local-sidecar", displayName: "Local file", syncType: "syllable", priority: 0, offline: true },
  { key: "embedded-tag", displayName: "Embedded tag", syncType: "syllable", priority: 1, offline: true },
  // Better Lyrics API (https://docs.betterlyrics.org): TTML syllable sync from /getLyrics,
  // QQ word-timed QRC and Kugou line-synced LRC from the provider-specific endpoints.
  { key: "blyrics-richsynced", displayName: "Better Lyrics", syncType: "syllable", priority: 2, offline: false },
  // Unison (https://docs.betterlyrics.org/unison): community TTML/LRC/plain, no video ID required.
  { key: "unison-richsynced", displayName: "Unison", syncType: "syllable", priority: 3, offline: false },
  // BiniLyrics (https://lyrics.binimum.org/developers): fully keyless community TTML, the same
  // native upstream the extension reaches as `binimum-richsynced`/`binimum-synced`.
  { key: "binimum-richsynced", displayName: "BiniLyrics", syncType: "syllable", priority: 4, offline: false },
  { key: "blyrics-wordsynced", displayName: "Better Lyrics (QQ)", syncType: "word", priority: 5, offline: false },
  { key: "unison-wordsynced", displayName: "Unison", syncType: "word", priority: 6, offline: false },
  { key: "blyrics-synced", displayName: "Better Lyrics (Kugou)", syncType: "line", priority: 7, offline: false },
  { key: "unison-synced", displayName: "Unison", syncType: "line", priority: 8, offline: false },
  { key: "binimum-synced", displayName: "BiniLyrics", syncType: "line", priority: 9, offline: false },
  { key: "lrclib-synced", displayName: "LRCLIB (synced)", syncType: "line", priority: 10, offline: false },
  { key: "unison-plain", displayName: "Unison", syncType: "unsynced", priority: 14, offline: false },
  { key: "lrclib-plain", displayName: "LRCLIB (plain)", syncType: "unsynced", priority: 15, offline: false },
] as const;

export const LYRIC_SOURCE_KEYS = PROVIDER_CONFIGS.map(p => p.key);

export const DEFAULT_PROVIDER_ORDER = [...PROVIDER_CONFIGS]
  .sort((a, b) => a.priority - b.priority)
  .map(p => p.key);

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
