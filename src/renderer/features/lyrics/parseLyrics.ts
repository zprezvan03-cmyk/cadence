/**
 * Parsing layer for the lyrics renderer.
 *
 * The renderer itself is the upstream `@braccato/core` element; this module only turns raw provider
 * text into the `Lyric[]` shape that element consumes, using the upstream `@braccato/parsers`
 * package (the same parser set Better Lyrics uses). Written for Cadence.
 */

import {
  detectFormat,
  detectParser,
  lrcFixers,
  parseQRC,
  parseTTMLContent,
  type Lyric,
  type LyricFormat,
  type LyricPart,
} from "@braccato/parsers";
import type { LyricsSyncType } from "../../../shared/types";
import { lineHasSyllableTiming } from "../../../shared/lyricsTiming";
import { detectNonLatinLanguage } from "@braccato/core/text";

export interface ParsedLyrics {
  lyrics: Lyric[];
  syncType: LyricsSyncType;
  songwriters: string[];
  format: LyricFormat;
  language: string | null;
  instrumentalOnly: boolean;
}

export interface ParseLyricsMetadata {
  title?: string;
  artist?: string;
}

/** Normalizes shorthand `<ss.xx>` enhanced-LRC word tags to `<00:ss.xx>` so `@braccato/parsers` parses word parts. */
const SHORTHAND_ENHANCED_LRC_TAG = /<(\d+\.\d+)>/g;

/**
 * Rich sync means the line is subdivided into independently timed parts. The shared
 * {@link lineHasSyllableTiming} rule is used so the badge in the UI agrees with the provider
 * identity the main process assigned: a single part repeating the whole line (common in
 * line-synced TTML) is line sync, not word sync.
 */
export function detectSyncType(lyrics: readonly Lyric[]): LyricsSyncType {
  if (lyrics.length === 0) return "none";
  let timed = false;
  for (const line of lyrics) {
    if (lineHasSyllableTiming(line)) return "richsync";
    if (line.startTimeMs > 0 || (line.durationMs ?? 0) > 0) timed = true;
  }
  return timed ? "synced" : "none";
}

export function parseLyricsText(
  text: string,
  durationMs: number,
  metadata?: ParseLyricsMetadata
): ParsedLyrics {
  // An empty provider payload must read as "no lyrics", not as a single blank line.
  if (!text || text.trim().length === 0) {
    return {
      lyrics: [],
      syncType: "none",
      songwriters: [],
      format: "plain",
      language: null,
      instrumentalOnly: false,
    };
  }
  const safeDurationMs = Math.max(0, durationMs);
  const format = detectFormat(text);
  const parser = detectParser(text);
  let lyrics: Lyric[];
  let ttmlLanguage: string | null = null;

  if (format === "ttml") {
    const parsedTtml = parseTTMLContent(text);
    lyrics = parsedTtml.lyrics;
    ttmlLanguage = parsedTtml.language ?? null;
  } else if (format === "qrc") {
    const qrcMeta =
      metadata?.title || metadata?.artist
        ? { title: metadata.title, artist: metadata.artist }
        : undefined;
    lyrics = parseQRC(text, safeDurationMs, qrcMeta);
  } else if (format === "lrc") {
    const normalizedLrc = SHORTHAND_ENHANCED_LRC_TAG.test(text)
      ? text.replace(SHORTHAND_ENHANCED_LRC_TAG, "<00:$1>")
      : text;
    lyrics = parser.parse(normalizedLrc, safeDurationMs);
    if (lyrics.length === 0) {
      lyrics = parser.parse(normalizedLrc, safeDurationMs);
      lrcFixers(lyrics);
    }
  } else {
    lyrics = parser.parse(text, safeDurationMs);
  }

  const songwriters = parser.metadata(text)?.songwriters?.filter(Boolean) ?? [];
  const syncType = detectSyncType(lyrics);
  const instrumentalOnly =
    lyrics.length === 1 && /^\[?instrumental\s*only\]?$/i.test(lyrics[0].words.trim());

  let language: string | null = null;
  if (instrumentalOnly) {
    language = null;
  } else if (ttmlLanguage) {
    language = ttmlLanguage;
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

function languageMatches(candidateLang: string, targetLang: string): boolean {
  const left = candidateLang.trim().toLowerCase();
  const right = targetLang.trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  return left.split("-")[0] === right.split("-")[0] && !right.includes("-");
}

/**
 * Extracts embedded file-supplied translations (e.g. TTML `<translations>`) matching `language`
 * so native translations in the source file are preserved instead of overwritten by machine translation.
 */
export function embeddedTranslationsForLanguage(
  lyrics: readonly Lyric[],
  language: string
): (string | null)[] {
  if (!language) return lyrics.map(() => null);
  return lyrics.map(line => {
    if (line.translations) {
      for (const [lang, text] of Object.entries(line.translations)) {
        if (languageMatches(lang, language) && text?.trim()) return text;
      }
    }
    if (line.translation?.lang && languageMatches(line.translation.lang, language) && line.translation.text?.trim()) {
      return line.translation.text;
    }
    return null;
  });
}

/** Sung line indexes lacking an embedded translation for `language`. */
export function translationGaps(lyrics: readonly Lyric[], language: string): number[] {
  const embedded = embeddedTranslationsForLanguage(lyrics, language);
  const gaps: number[] = [];
  lyrics.forEach((line, index) => {
    if (line.isInstrumental || !normalizeLine(line.words)) return;
    if (!embedded[index]) gaps.push(index);
  });
  return gaps;
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

/** Copies the romanization each line's own lyrics file supplied onto `lyrics`, matched by position
 * (the association every decoration pass in this module uses). File romanization carries the
 * file's word timing with it, so a restored line keeps its syllable-level timing instead of
 * flattening to a plain string. Translation decorations on `lyrics` are left untouched. */
export function applyFileRomanization(lyrics: readonly Lyric[], local: readonly Lyric[]): Lyric[] {
  let changed = false;
  const result = lyrics.map((line, index) => {
    const source = local[index];
    const fileRomanization = source?.romanization?.trim() ? source.romanization : undefined;
    if (!fileRomanization) return line;
    const fileTiming = source.timedRomanization;
    if (line.romanization === fileRomanization && (line.timedRomanization ?? undefined) === (fileTiming ?? undefined)) {
      return line;
    }
    changed = true;
    const next: Lyric = { ...line, romanization: fileRomanization };
    if (fileTiming?.length) next.timedRomanization = fileTiming;
    else delete next.timedRomanization;
    return next;
  });
  return changed ? result : (lyrics as Lyric[]);
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

/** Scatters generated word arrays back into a full-length per-line array. */
export function scatterRomanizationWords(
  lineCount: number,
  indexes: readonly number[],
  generated: readonly (string[] | null)[]
): (string[] | null)[] {
  const scattered: (string[] | null)[] = Array.from({ length: lineCount }, () => null);
  indexes.forEach((lineIndex, resultIndex) => {
    if (lineIndex >= 0 && lineIndex < lineCount) scattered[lineIndex] = generated[resultIndex] ?? null;
  });
  return scattered;
}

/** Builds timed romanization from source parts and AI word tokens. Returns null when alignment is impossible. */
export function buildTimedRomanization(line: Lyric, words: readonly string[] | null | undefined): LyricPart[] | null {
  if (!words || !line.parts || line.parts.length === 0) return null;

  // Span-aligned input: words has one token per non-space span. Map spaces back to " ".
  const nonSpaceParts = line.parts.filter(part => part.words.trim().length > 0);
  if (words.length === nonSpaceParts.length) {
    const hasSourceSpaces = nonSpaceParts.length < line.parts.length;
    let wordIndex = 0;
    let nonSpaceIndex = 0;
    return line.parts.map(part => {
      if (part.words.trim().length === 0) {
        // Keep an explicit space when the source had one; otherwise it is already
        // carried by the preceding token.
        return {
          startTimeMs: part.startTimeMs,
          words: hasSourceSpaces ? " " : "",
          durationMs: part.durationMs,
          isBackground: part.isBackground,
          explicit: part.explicit,
        };
      }
      const token = words[wordIndex] ?? "";
      const isLast = nonSpaceIndex === nonSpaceParts.length - 1;
      wordIndex += 1;
      nonSpaceIndex += 1;
      const needsSpace = !hasSourceSpaces && !isLast && !/\s$/.test(token);
      return {
        startTimeMs: part.startTimeMs,
        words: needsSpace ? `${token} ` : token,
        durationMs: part.durationMs,
        isBackground: part.isBackground,
        explicit: part.explicit,
      };
    });
  }

  // Direct old-format alignment: AI returned one token per part, including empty space tokens.
  if (words.length === line.parts.length) {
    return line.parts.map((part, index) => {
      const token = words[index] ?? "";
      return {
        startTimeMs: part.startTimeMs,
        words: token.trim().length === 0 ? " " : token,
        durationMs: part.durationMs,
        isBackground: part.isBackground,
        explicit: part.explicit,
      };
    });
  }

  // Group syllable/space parts into source words. Rich-sync TTML often stores spaces as their own
  // parts, so a straight part count does not equal the word count.
  const groups: LyricPart[][] = [];
  let current: LyricPart[] = [];
  for (const part of line.parts) {
    if (part.words.trim().length === 0) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      continue;
    }
    current.push(part);
  }
  if (current.length > 0) groups.push(current);
  if (groups.length === 0) return null;

  const tokens = words && words.length === groups.length
    ? words.map(word => word.trim()).filter(Boolean)
    : null;
  if (!tokens || tokens.length !== groups.length) return null;

  return groups.map((group, index) => {
    const first = group[0];
    const last = group[group.length - 1];
    const token = tokens[index] ?? "";
    return {
      startTimeMs: first.startTimeMs,
      words: index === groups.length - 1 ? token : `${token} `,
      durationMs: Math.max(1, last.startTimeMs + last.durationMs - first.startTimeMs),
      isBackground: first.isBackground,
      explicit: first.explicit,
    };
  });
}

export function applyRomanization(
  lyrics: readonly Lyric[],
  romanizations: readonly (string | null)[],
  words: readonly (string[] | null)[] = [],
  mode: "line" | "word" = "line"
): Lyric[] {
  return lyrics.map((line, index) => {
    // File-supplied romanization always wins, including its timing.
    if (line.romanization?.trim()) return line;
    const romanized = romanizations[index];
    if (!romanized || romanized.trim().length === 0) return line;
    if (mode === "word") {
      const timed = buildTimedRomanization(line, words[index]);
      if (timed) {
        console.log("[Cadence parser] romanization", { index, mode, romanization: romanized, timedWords: timed.map(part => part.words) });
        return { ...line, romanization: romanized, timedRomanization: timed };
      }
      // Fallback split by whitespace if AI did not provide usable words.
      const fallback = buildTimedRomanization(line, romanized.split(/\s+/));
      if (fallback) {
        console.log("[Cadence parser] romanization fallback", { index, mode, romanization: romanized, timedWords: fallback.map(part => part.words) });
        return { ...line, romanization: romanized, timedRomanization: fallback };
      }
    }
    console.log("[Cadence parser] romanization", { index, mode, romanization: romanized, timedWords: null });
    return { ...line, romanization: romanized };
  });
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

/**
 * Removes every romanization decoration, generated and file-supplied alike, together with the
 * word timing that came with it. The auto-romanize toggle controls whether romanization is shown,
 * so turning it off must hide the file's transliterations too; {@link applyFileRomanization}
 * restores them without another provider request when the toggle comes back on. Same identity
 * contract as {@link stripTranslations}.
 */
export function stripRomanization(lyrics: readonly Lyric[]): Lyric[] {
  if (!lyrics.some(line => line.romanization || line.timedRomanization)) return lyrics as Lyric[];
  return lyrics.map(line => {
    if (!line.romanization && !line.timedRomanization) return line;
    const { romanization: _romanization, timedRomanization: _timedRomanization, ...rest } = line;
    return rest as Lyric;
  });
}

export function lyricsToPlainText(lyrics: readonly Lyric[]): string {
  return lyrics
    .map(line => line.words)
    .filter((line, index, all) => line.trim().length > 0 || index === 0 || index === all.length - 1)
    .join("\n");
}

/** TTML export for "save next to the track". */
export function lyricsToTtml(lyrics: readonly Lyric[], meta: { title?: string; artist?: string; language?: string }): string {
  const escapeXml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  const formatTime = (ms: number) => {
    const total = Math.max(0, ms) / 1000;
    const minutes = Math.floor(total / 60);
    const seconds = Math.floor(total - minutes * 60);
    const millis = Math.round((total - minutes * 60 - seconds) * 1000);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  };
  const lines = lyrics.map((line, index) => {
    const nextStart = lyrics[index + 1]?.startTimeMs ?? line.startTimeMs + (line.durationMs || 2000);
    const endMs = line.startTimeMs + (line.durationMs || Math.max(0, nextStart - line.startTimeMs) || 1000);
    const parts = line.parts?.length
      ? line.parts
          .map(part => {
            const partStart = formatTime(part.startTimeMs || line.startTimeMs);
            const partEnd = formatTime(part.startTimeMs + (part.durationMs || 0) || line.startTimeMs + (line.durationMs || 1000));
            return `<span begin="${partStart}" end="${partEnd}">${escapeXml(part.words)}</span>`;
          })
          .join("")
      : escapeXml(line.words);
    return `      <p begin="${formatTime(line.startTimeMs)}" end="${formatTime(endMs)}">${parts}</p>`;
  });
  const title = meta.title ? `        <ttm:title>${escapeXml(meta.title)}</ttm:title>` : null;
  const artist = meta.artist ? `        <ttm:agent type="person">${escapeXml(meta.artist)}</ttm:agent>` : null;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="${escapeXml(meta.language ?? "en")}">`,
    '  <head>',
    '    <metadata>',
    ...(title ? [title] : []),
    ...(artist ? [artist] : []),
    '    </metadata>',
    '  </head>',
    '  <body>',
    '    <div>',
    ...lines,
    '    </div>',
    '  </body>',
    '</tt>',
  ].join("\n");
}
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
