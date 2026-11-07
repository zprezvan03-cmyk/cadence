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
  sourceText: string;
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
      sourceText: text,
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

  // Timed romanization is intentionally not part of Cadence's model; keep the parsed line-level
  // transliteration but leave the original lyric parts/timestamps untouched.
  lyrics = lyrics.map(({ timedRomanization: _timedRomanization, ...line }) => line);

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

  return { lyrics, syncType, songwriters, format, language, instrumentalOnly, sourceText: text };
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
export function availableEmbeddedTranslationLanguages(lyrics: readonly Lyric[]): string[] {
  const languages = new Set<string>();
  for (const line of lyrics) {
    for (const [language, text] of Object.entries(line.translations ?? {})) if (text?.trim()) languages.add(language);
    if (line.translation?.lang && line.translation.text?.trim()) languages.add(line.translation.lang);
  }
  return [...languages];
}

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

/** Restores file-supplied line-level romanization by position. Original lyric parts/timestamps and
 * translation decorations on `lyrics` are left untouched. */
export function applyFileRomanization(lyrics: readonly Lyric[], local: readonly Lyric[]): Lyric[] {
  let changed = false;
  const result = lyrics.map((line, index) => {
    const source = local[index];
    const fileRomanization = source?.romanization?.trim() ? source.romanization : undefined;
    if (!fileRomanization) return line;
    if (line.romanization === fileRomanization) return line;
    changed = true;
    return { ...line, romanization: fileRomanization };
  });
  return changed ? result : (lyrics as Lyric[]);
}

export function applyRomanization(lyrics: readonly Lyric[], romanizations: readonly (string | null)[]): Lyric[] {
  return lyrics.map((line, index) => {
    // File-supplied line-level romanization always wins; generated output only fills gaps.
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

/** Hides line-level romanization without changing original words, parts or timestamps. */
export function stripRomanization(lyrics: readonly Lyric[]): Lyric[] {
  if (!lyrics.some(line => line.romanization)) return lyrics as Lyric[];
  return lyrics.map(line => {
    if (!line.romanization) return line;
    const { romanization: _romanization, ...rest } = line;
    return rest as Lyric;
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


export interface TtmlExportMetadata {
  title?: string;
  artist?: string;
  language?: string | null;
  songwriters?: readonly string[];
  durationMs?: number;
  sourceText?: string;
}
const escapeXml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
const ttmlTime = (ms: number): string => {
  const value = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = (value % 60_000) / 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${seconds.toFixed(3).padStart(6, "0")}`;
};
function ttmlSpan(part: { startTimeMs: number; durationMs: number; words: string; isBackground?: boolean; explicit?: boolean }): string {
  const timing = `${part.startTimeMs > 0 || part.durationMs > 0 ? ` begin="${ttmlTime(part.startTimeMs)}"` : ""}${part.durationMs > 0 ? ` end="${ttmlTime(part.startTimeMs + part.durationMs)}"` : ""}`;
  const content = `<span${timing}${part.explicit ? ' itunes:explicit="true"' : ""}>${escapeXml(part.words)}</span>`;
  return part.isBackground ? `<span ttm:role="x-bg">${content}</span>` : content;
}
/** Canonical TTML export using only existing lyric timing; secondary text reuses those same times. */
export function lyricsToTtml(lyrics: readonly Lyric[], meta: TtmlExportMetadata = {}): string {
  const keys = lyrics.map((line, index) => line.key?.trim() || `L${index + 1}`);
  const used = new Set<string>();
  const uniqueKeys = keys.map((key, index) => {
    let candidate = key;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${key}_${suffix++}`;
    used.add(candidate);
    return candidate;
  });
  const languages = new Map<string, Map<string, string>>();
  const romanizationLanguage = meta.language ? `${meta.language.split("-")[0]}-Latn` : "und-Latn";
  const romanizations = new Map<string, string>();
  lyrics.forEach((line, index) => {
    for (const [language, text] of Object.entries(line.translations ?? {})) {
      if (!text?.trim()) continue;
      const byKey = languages.get(language) ?? new Map<string, string>();
      byKey.set(uniqueKeys[index], text);
      languages.set(language, byKey);
    }
    if (line.translation?.lang && line.translation.text?.trim()) {
      const byKey = languages.get(line.translation.lang) ?? new Map<string, string>();
      byKey.set(uniqueKeys[index], line.translation.text);
      languages.set(line.translation.lang, byKey);
    }
    if (line.romanization?.trim()) romanizations.set(uniqueKeys[index], line.romanization);
  });
  const metadata: string[] = [];
  if (meta.songwriters?.some(name => name.trim())) {
    metadata.push(`<songwriters>${meta.songwriters.filter(name => name.trim()).map(name => `<songwriter>${escapeXml(name)}</songwriter>`).join("")}</songwriters>`);
  }
  if (languages.size) {
    metadata.push(`<translations>${[...languages].map(([language, values]) => `<translation xml:lang="${escapeXml(language)}">${[...values].map(([key, text]) => `<text for="${escapeXml(key)}">${escapeXml(text)}</text>`).join("")}</translation>`).join("")}</translations>`);
  }
  if (romanizations.size) {
    metadata.push(`<transliterations><transliteration xml:lang="${escapeXml(romanizationLanguage)}">${lyrics.map((line, index) => {
      const text = romanizations.get(uniqueKeys[index]);
      if (!text) return "";
      return `<text for="${escapeXml(uniqueKeys[index])}">${escapeXml(text)}</text>`;
    }).join("")}</transliteration></transliterations>`);
  }
  const duration = Math.max(meta.durationMs ?? 0, ...lyrics.map(line => line.startTimeMs + line.durationMs), 0);
  const bodyDuration = duration > 0 ? ` dur="${ttmlTime(duration)}"` : "";
  const originalPAttributes = new Map<string, string>();
  if (meta.sourceText) {
    const sourcePs = [...meta.sourceText.matchAll(/<p\b([^>]*)>/gi)];
    for (const match of sourcePs) {
      const key = match[1].match(/itunes:key=["']([^"']+)["']/i)?.[1];
      const style = match[1].match(/\bstyle=["']([^"']+)["']/i)?.[1];
      if (key && style) originalPAttributes.set(key, ` style="${escapeXml(style)}"`);
    }
  }
  const body = lyrics.map((line, index) => {
    const key = uniqueKeys[index];
    const parts = line.parts?.length ? line.parts.map(ttmlSpan).join("") : escapeXml(line.words);
    const timing = `${line.startTimeMs > 0 || line.durationMs > 0 ? ` begin="${ttmlTime(line.startTimeMs)}"` : ""}${line.durationMs > 0 ? ` end="${ttmlTime(line.startTimeMs + line.durationMs)}"` : ""}`;
    return `<p${timing} itunes:key="${escapeXml(key)}"${line.agent ? ' ttm:agent="v1"' : ""}${originalPAttributes.get(key) ?? ""}>${parts}</p>`;
  }).join("\n      ");
  const rootTag = meta.sourceText?.match(/<tt\b([^>]*)>/i)?.[1] ?? "";
  const preservedNamespaces = [...rootTag.matchAll(/\s(xmlns(?::[\w.-]+)?=["'][^"']+["'])/g)]
    .map(match => match[1])
    .filter(attribute => !/^xmlns(?:=|:ttm=|:itunes=)/.test(attribute))
    .join(" ");
  const preservedHead = [...(meta.sourceText ?? "").matchAll(/<(styling|layout)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)].map(match => match[0]).join("");
  const lang = meta.language ? ` xml:lang="${escapeXml(meta.language)}"` : "";
  const titleMeta = meta.title ? `<meta name="title" content="${escapeXml(meta.title)}"/>` : "";
  const artistMeta = meta.artist ? `<meta name="artist" content="${escapeXml(meta.artist)}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"${preservedNamespaces ? ` ${preservedNamespaces}` : ""}${lang}>\n  <head><metadata>${titleMeta}${artistMeta}<ttm:agent type="person" xml:id="v1"/><itunes:metadata>${metadata.join("")}</itunes:metadata></metadata>${preservedHead}</head>\n  <body${bodyDuration}><div>\n      ${body}\n  </div></body>\n</tt>`;
}

export { detectFormat };
