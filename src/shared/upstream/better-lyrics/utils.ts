/**
 * PORTED FROM UPSTREAM — Better Lyrics
 * Repository: https://github.com/better-lyrics/better-lyrics
 * Commit:     18be32089343ec721fbead38c082117e4d44871f
 * Original:   src/core/utils.ts (language helpers only)
 * License:    GPL-3.0
 *
 * Changes for Cadence: only `languageMatchesAny` is kept, because it is the helper the ported
 * romanization path uses. Unrelated extension utilities (log truncation) were left behind.
 */

/**
 * Checks if a language code (or its base language) exists in a collection.
 * Handles variants like "ja-JP" matching "ja", "zh-Hans" matching "zh".
 */
export function languageMatchesAny(lang: string, collection: string[] | Record<string, unknown>): boolean {
  const check = Array.isArray(collection) ? (l: string) => collection.includes(l) : (l: string) => l in collection;

  if (check(lang)) return true;
  const baseLang = lang.split("-")[0];
  return baseLang !== lang && check(baseLang);
}
