/**
 * Parsing layer for the lyrics renderer.
 *
 * The renderer itself is the upstream `@braccato/core` element; this module only turns raw provider
 * text into the `Lyric[]` shape that element consumes, using the upstream `@braccato/parsers`
 * package (the same parser set Better Lyrics uses). Written for Cadence.
 */

import { detectFormat, detectParser, lrcFixers, type Lyric, type LyricFormat } from "@braccato/parsers";
import type { LyricsSyncType } from "../../../shared/types";
import { detectNonLatinLanguage } from "@braccato/core/text";

export interface ParsedLyrics {
  lyrics: Lyric[];
  syncType: LyricsSyncType;
  songwriters: string[];
  format: LyricFormat;
  language: string | null;
  instrumentalOnly: boolean;
}

/** Mirrors the upstream renderer's own classification: parts make a line rich-synced. */
export function detectSyncType(lyrics: readonly Lyric[]): LyricsSyncType {
  if (lyrics.length === 0) return "none";
  let timed = false;
  for (const line of lyrics) {
    if (Array.isArray(line.parts) && line.parts.length > 0) return "richsync";
    if (line.startTimeMs > 0 || (line.durationMs ?? 0) > 0) timed = true;
  }
  return timed ? "synced" : "none";
}

export function parseLyricsText(text: string, durationMs: number): ParsedLyrics {
  // An empty provider payload must read as "no lyrics", not as a single blank line.
  if (!text || text.trim().length === 0) {
    return { lyrics: [], syncType: "none", songwriters: [], format: "plain", language: null, instrumentalOnly: false };
  }
  const format = detectFormat(text);
  const parser = detectParser(text);
  let lyrics = parser.parse(text, Math.max(0, durationMs));

  // `parse()` runs the fixers for LRC already; other formats are left as written.
  if (format === "lrc" && lyrics.length === 0) {
    lyrics = parser.parse(text, Math.max(0, durationMs));
    lrcFixers(lyrics);
  }

  const songwriters = parser.metadata(text)?.songwriters?.filter(Boolean) ?? [];
  const syncType = detectSyncType(lyrics);
  const instrumentalOnly =
    lyrics.length === 1 && /^\[?instrumental\s*only\]?$/i.test(lyrics[0].words.trim());

  let language: string | null = null;
  if (instrumentalOnly) {
    language = null;
  } else {
    const sample = lyrics
      .map(line => line.words)
      .filter(Boolean)
      .slice(0, 12)
      .join(" ");
    language = detectNonLatinLanguage(sample) || null;
  }

  return { lyrics, syncType, songwriters, format, language, instrumentalOnly };
}

/** The text lines handed to the translation provider. */
export function lyricLines(lyrics: readonly Lyric[]): string[] {
  return lyrics.map(line => normalizeLine(line.words));
}

function normalizeLine(words: string): string {
  // Instrumental markers are rhythm, not words; translating them wastes a request and can break
  // the provider's line alignment.
  if (/^[♪\s]*$/.test(words) || /^\[?instrumental/i.test(words.trim())) return "";
  return words.replace(/\s+/g, " ").trim();
}

/** Matches the shape `@braccato/core` reads when decorating a built line. */
export function applyTranslations(
  lyrics: readonly Lyric[],
  translations: readonly (string | null)[],
  language: string
): Lyric[] {
  return lyrics.map((line, index) => {
    const translated = translations[index];
    if (!translated || translated.trim().length === 0) return line;
    return {
      ...line,
      translation: { text: translated, lang: language },
      translations: { ...(line.translations ?? {}), [language]: translated },
    };
  });
}

export function applyRomanization(lyrics: readonly Lyric[], romanizations: readonly (string | null)[]): Lyric[] {
  return lyrics.map((line, index) => {
    // Romanization the line already carries came from the lyrics file itself (e.g. a TTML
    // transliteration) and always wins: generated text only fills lines that have none, and an
    // empty generated result never erases a supplied one. Upstream resolves it the same way —
    // `item.romanization` first, batch generation only for lines without one.
    if (line.romanization?.trim()) return line;
    const romanized = romanizations[index];
    if (!romanized || romanized.trim().length === 0) return line;
    return { ...line, romanization: romanized };
  });
}

/**
 * Indexes of lines that still need generated romanization: sung lines whose lyrics file supplied
 * none. Lines are identified by their position in the parsed array — the same association the
 * parser itself used when it attached file transliterations by line key at parse time.
 */
export function romanizationGaps(lyrics: readonly Lyric[]): number[] {
  const gaps: number[] = [];
  lyrics.forEach((line, index) => {
    if (line.isInstrumental || !line.words?.trim()) return;
    if (!line.romanization?.trim()) gaps.push(index);
  });
  return gaps;
}

/** Scatters generated results (aligned to `indexes`, e.g. from {@link romanizationGaps}) back into a full-length per-line array. */
export function scatterRomanizations(
  lineCount: number,
  indexes: readonly number[],
  generated: readonly (string | null)[]
): (string | null)[] {
  const scattered: (string | null)[] = Array.from({ length: lineCount }, () => null);
  indexes.forEach((lineIndex, resultIndex) => {
    if (lineIndex >= 0 && lineIndex < lineCount) scattered[lineIndex] = generated[resultIndex] ?? null;
  });
  return scattered;
}

/**
 * Removes only the translation decoration, leaving romanization, words and timings untouched.
 * Returns the input array itself when no line carries a translation, so callers can bail out on
 * identity instead of rebuilding the rendered lines for nothing.
 */
export function stripTranslations(lyrics: readonly Lyric[]): Lyric[] {
  if (!lyrics.some(line => line.translation || line.translations)) return lyrics as Lyric[];
  return lyrics.map(line => {
    if (!line.translation && !line.translations) return line;
    const { translation: _translation, translations: _translations, ...rest } = line;
    return rest as Lyric;
  });
}

/** Removes only the romanization decoration. Same identity contract as {@link stripTranslations}. */
export function stripRomanization(lyrics: readonly Lyric[]): Lyric[] {
  if (!lyrics.some(line => line.romanization)) return lyrics as Lyric[];
  return lyrics.map(line => {
    if (!line.romanization) return line;
    const { romanization: _romanization, ...rest } = line;
    return rest as Lyric;
  });
}

/**
 * Removes generated romanization while restoring the romanization each line's own lyrics file
 * supplied (`local`, the parsed lines `lyrics` was decorated from). The auto-romanize toggle gates
 * generation only; file-supplied romanization is not the toggle's to remove. Lines are matched by
 * position, the association every decoration pass in this module already uses. Returns the input
 * array itself when every line already matches its local state.
 */
export function stripGeneratedRomanization(lyrics: readonly Lyric[], local: readonly Lyric[]): Lyric[] {
  let changed = false;
  const result = lyrics.map((line, index) => {
    const localRomanization = local[index]?.romanization?.trim() ? local[index].romanization : undefined;
    if ((line.romanization ?? undefined) === localRomanization) return line;
    changed = true;
    if (localRomanization) return { ...line, romanization: localRomanization };
    const { romanization: _romanization, ...rest } = line;
    return rest as Lyric;
  });
  return changed ? result : (lyrics as Lyric[]);
}

export function lyricsToPlainText(lyrics: readonly Lyric[]): string {
  return lyrics
    .map(line => line.words)
    .filter((line, index, all) => line.trim().length > 0 || index === 0 || index === all.length - 1)
    .join("\n");
}

/** LRC export for "save next to the track". */
export function lyricsToLrc(lyrics: readonly Lyric[], meta: { title?: string; artist?: string }): string {
  const header = [
    meta.title ? `[ti:${meta.title}]` : null,
    meta.artist ? `[ar:${meta.artist}]` : null,
  ].filter(Boolean);
  const lines = lyrics.map(line => {
    const totalSeconds = Math.max(0, line.startTimeMs) / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds - minutes * 60;
    const stamp = `[${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}]`;
    return `${stamp}${line.words}`;
  });
  return [...header, ...lines].join("\n");
}

export { detectFormat };
