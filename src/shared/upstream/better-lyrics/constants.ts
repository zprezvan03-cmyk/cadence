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
 */

export type LyricSourceKey =
  | "local-sidecar"
  | "embedded-tag"
  | "lrclib-synced"
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
  { key: "lrclib-synced", displayName: "LRCLIB (synced)", syncType: "line", priority: 10, offline: false },
  { key: "lrclib-plain", displayName: "LRCLIB (plain)", syncType: "unsynced", priority: 15, offline: false },
] as const;

export const LYRIC_SOURCE_KEYS = PROVIDER_CONFIGS.map(p => p.key);

export const DEFAULT_PROVIDER_ORDER = [...PROVIDER_CONFIGS]
  .sort((a, b) => a.priority - b.priority)
  .map(p => p.key);

export const LRCLIB_BASE_URL = "https://lrclib.net/api" as const;

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
