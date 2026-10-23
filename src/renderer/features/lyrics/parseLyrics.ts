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
    const romanized = romanizations[index];
    if (!romanized || romanized.trim().length === 0) return line;
    return { ...line, romanization: romanized };
  });
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
