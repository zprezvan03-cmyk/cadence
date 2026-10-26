/**
 * Format and synchronization-precision inspection for raw provider and local lyric payloads.
 *
 * Runs `@braccato/parsers` against a candidate body without altering the original text so every
 * provider client can:
 *   1. Reject empty, header-only, or unparseable payloads instead of treating them as hits.
 *   2. Determine actual synchronization precision (`richsync` vs `synced` vs `none`) from the
 *      timed tokens present in the payload rather than trusting a server label blindly. The
 *      syllable-vs-line rule lives in {@link hasSyllableTiming} so the renderer applies exactly
 *      the same test (a single part repeating the whole line is line timing, not syllable timing).
 *   3. Extract TTML `xml:lang` and format-specific songwriter credits up front.
 */

import {
  detectFormat,
  LRCParser,
  parseQRC,
  parseTTMLContent,
  PlainParser,
  QRCParser,
  SRTParser,
  TTMLParser,
  type LyricFormat,
} from "@braccato/parsers";
import type { LyricsSyncType } from "../../shared/types";
import { hasSyllableTiming } from "../../shared/lyricsTiming";

/** Matches both standard `<mm:ss.xx>` and shorthand `<ss.xx>` enhanced-LRC word tags. */
const ENHANCED_LRC_WORD_TAG = /<(?:\d+:)?\d+\.\d+>/;

export interface InspectLyricsOptions {
  durationSeconds?: number;
  title?: string;
  artist?: string;
}

export interface InspectedLyricsPayload {
  usable: boolean;
  format: LyricFormat;
  syncType: LyricsSyncType;
  language: string | null;
  songwriters: string[];
  /** Present when a parser threw; callers can report it instead of hiding a malformed payload. */
  error?: string;
}

const UNUSABLE_PAYLOAD: InspectedLyricsPayload = {
  usable: false,
  format: "plain",
  syncType: "none",
  language: null,
  songwriters: [],
};

export function inspectLyricsPayload(
  rawText: string,
  options?: InspectLyricsOptions
): InspectedLyricsPayload {
  if (typeof rawText !== "string") return UNUSABLE_PAYLOAD;
  const trimmed = rawText.trim();
  if (!trimmed) return UNUSABLE_PAYLOAD;

  const durationMs =
    options?.durationSeconds && Number.isFinite(options.durationSeconds) && options.durationSeconds > 0
      ? Math.round(options.durationSeconds * 1000)
      : 0;

  const format = detectFormat(rawText);

  try {
    if (format === "ttml") {
      const parsed = parseTTMLContent(rawText, { songDurationMs: durationMs });
      const sungLines = parsed.lyrics.filter(line => !line.isInstrumental && line.words.trim().length > 0);
      if (sungLines.length === 0) {
        return { usable: false, format: "ttml", syncType: "none", language: parsed.language ?? null, songwriters: [] };
      }
      // `isWordSynced` is true even when every `<p>` holds one span covering the whole line, so
      // the parts themselves decide whether the payload is genuinely syllable timed.
      const hasWordParts = parsed.isWordSynced && hasSyllableTiming(sungLines);
      return {
        usable: true,
        format: "ttml",
        syncType: hasWordParts ? "richsync" : "synced",
        language: parsed.language ?? null,
        songwriters: TTMLParser.metadata(rawText).songwriters,
      };
    }

    if (format === "qrc") {
      const metadata =
        options?.title || options?.artist
          ? { title: options.title, artist: options.artist }
          : undefined;
      const lyrics = parseQRC(rawText, durationMs, metadata);
      const sungLines = lyrics.filter(line => !line.isInstrumental && line.words.trim().length > 0);
      if (sungLines.length === 0) {
        return { usable: false, format: "qrc", syncType: "none", language: null, songwriters: [] };
      }
      const hasWordParts = hasSyllableTiming(sungLines);
      return {
        usable: true,
        format: "qrc",
        syncType: hasWordParts ? "richsync" : "synced",
        language: null,
        songwriters: QRCParser.metadata(rawText).songwriters,
      };
    }

    if (format === "lrc") {
      const lyrics = LRCParser.parse(rawText, durationMs);
      const sungLines = lyrics.filter(line => !line.isInstrumental && line.words.trim().length > 0);
      if (sungLines.length === 0) {
        return { usable: false, format: "lrc", syncType: "none", language: null, songwriters: [] };
      }
      const hasWordParts = hasSyllableTiming(sungLines) || ENHANCED_LRC_WORD_TAG.test(rawText);
      return {
        usable: true,
        format: "lrc",
        syncType: hasWordParts ? "richsync" : "synced",
        language: null,
        songwriters: LRCParser.metadata(rawText).songwriters,
      };
    }

    if (format === "srt") {
      const lyrics = SRTParser.parse(rawText, durationMs);
      const sungLines = lyrics.filter(line => !line.isInstrumental && line.words.trim().length > 0);
      if (sungLines.length === 0) {
        return { usable: false, format: "srt", syncType: "none", language: null, songwriters: [] };
      }
      return {
        usable: true,
        format: "srt",
        syncType: "synced",
        language: null,
        songwriters: [],
      };
    }

    const lyrics = PlainParser.parse(rawText, durationMs);
    const hasWords = lyrics.some(line => line.words.trim().length > 0);
    if (!hasWords) return UNUSABLE_PAYLOAD;
    return {
      usable: true,
      format: "plain",
      syncType: "none",
      language: null,
      songwriters: [],
    };
  } catch (error) {
    return {
      ...UNUSABLE_PAYLOAD,
      format,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
