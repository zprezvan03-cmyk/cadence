/**
 * PORTED FROM UPSTREAM — Better Lyrics
 * Repository: https://github.com/better-lyrics/better-lyrics
 * Commit:     18be32089343ec721fbead38c082117e4d44871f
 * Original:   src/modules/lyrics/translation.ts
 * License:    GPL-3.0
 *
 * Changes for Cadence:
 *  - Runs in the Electron main process instead of a content script, so `fetch` is Node's and the
 *    requests are not subject to YouTube Music's page CSP. The Google Translate URL builders and
 *    the batching / splitting algorithm are unchanged.
 *  - The `enrichViaUnison` branch is omitted: the Unison endpoint requires the Better Lyrics web
 *    app's signed session, which a standalone player does not have. Its results were only ever an
 *    extra cache-fill ahead of Google Translate, so falling straight through to the ported Google
 *    path keeps behaviour without that dependency (see UPSTREAM.md).
 *  - Cache is exposed per-request rather than module-global so the main process can persist it.
 */

import {
  ROMANIZATION_LANGUAGES,
  TRANSLATE_IN_ROMAJI,
  TRANSLATE_LYRICS_URL,
} from "../../shared/upstream/better-lyrics/constants";
import { createScriptClassifier, type ScriptClassifier } from "../../shared/upstream/better-lyrics/nonLatinScript";
import { languageMatchesAny } from "../../shared/upstream/better-lyrics/utils";

export interface TranslationResult {
  originalLanguage: string;
  translatedText: string;
}

export interface TranslationCache {
  romanization: Map<string, string>;
  translation: Map<string, TranslationResult>;
}

export interface BatchRequest {
  lines: string[];
  targetLanguage: string;
  sourceLanguage?: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface BatchTranslationResponse {
  results: (TranslationResult | null)[];
  detectedLanguage: string;
}

export interface BatchRomanizationResponse {
  results: (string | null)[];
  detectedLanguage: string;
}

const BATCH_SEPARATOR = "\n\n;\n\n";
const ROMANIZATION_SEPARATOR_BASE = "0000";
const MAX_URL_LENGTH = 15000;

export const createTranslationCache = (): TranslationCache => ({
  romanization: new Map(),
  translation: new Map(),
});

const classifierCache = new Map<string, ScriptClassifier>();

export function classifierFor(lines: readonly string[]): ScriptClassifier {
  const key = lines.length ? lines[0] + "\u0000" + lines.length : "";
  let classifier = classifierCache.get(key);
  if (!classifier) {
    classifier = createScriptClassifier(lines);
    if (classifierCache.size > 32) classifierCache.clear();
    classifierCache.set(key, classifier);
  }
  return classifier;
}

/**
 * Translates a batch of lyric lines in a single request, chunked if necessary.
 */
export async function translateBatch(
  request: BatchRequest,
  cache: TranslationCache = createTranslationCache()
): Promise<BatchTranslationResponse> {
  const { lines, targetLanguage, signal } = request;
  const doFetch = request.fetchImpl ?? fetch;
  const scripts = classifierFor(lines);

  if (!targetLanguage || lines.length === 0) {
    return { results: lines.map(() => null), detectedLanguage: "" };
  }

  const results: (TranslationResult | null)[] = new Array(lines.length).fill(null);
  const toTranslate: { index: number; text: string }[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "♪") return;

    const cacheKey = `${targetLanguage}_${trimmed}`;
    const cached = cache.translation.get(cacheKey);
    if (cached) {
      results[index] = cached;
    } else {
      toTranslate.push({ index, text: trimmed });
    }
  });

  if (toTranslate.length === 0) {
    return {
      results,
      detectedLanguage: results.find(result => result !== null)?.originalLanguage || "",
    };
  }

  let detectedLanguage = "";
  const chunks: { index: number; text: string }[][] = [];
  let currentChunk: { index: number; text: string }[] = [];
  let currentEncodedLength = 0;

  const baseUrl = TRANSLATE_LYRICS_URL(targetLanguage, "");
  const separatorEncoded = encodeURIComponent(BATCH_SEPARATOR);

  const scriptGroups = [
    toTranslate.filter(item => scripts.hasNonLatinScript(item.text)),
    toTranslate.filter(item => !scripts.hasNonLatinScript(item.text)),
  ].sort((a, b) => b.length - a.length);

  for (const group of scriptGroups) {
    for (const item of group) {
      const itemEncoded = encodeURIComponent(item.text);
      const addedLength = (currentChunk.length > 0 ? separatorEncoded.length : 0) + itemEncoded.length;

      if (currentChunk.length > 0 && baseUrl.length + currentEncodedLength + addedLength > MAX_URL_LENGTH) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentEncodedLength = 0;
      }

      currentChunk.push(item);
      currentEncodedLength += (currentChunk.length > 1 ? separatorEncoded.length : 0) + itemEncoded.length;
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentEncodedLength = 0;
    }
  }

  for (const chunk of chunks) {
    try {
      const combinedText = chunk.map(item => item.text).join(BATCH_SEPARATOR);
      const url = TRANSLATE_LYRICS_URL(targetLanguage, combinedText);
      const response = await doFetch(url, { signal });
      if (!response.ok) continue;
      const data = (await response.json()) as [string, unknown, string];
      if (!Array.isArray(data?.[0])) continue;

      const chunkLanguage: string = data[2] || "";
      if (!detectedLanguage) detectedLanguage = chunkLanguage;

      let fullTranslatedText = "";
      for (const part of data[0]) {
        if (Array.isArray(part) && typeof part[0] === "string") fullTranslatedText += part[0];
      }

      let translatedLines = fullTranslatedText.split(BATCH_SEPARATOR);

      if (translatedLines.length < chunk.length) {
        const semicolonSplit = fullTranslatedText.split(";").filter(line => line.trim().length > 0);
        if (semicolonSplit.length === chunk.length) {
          translatedLines = semicolonSplit;
        } else {
          const singleNewlineSplit = fullTranslatedText.split(/\r?\n/).filter(line => line.trim().length > 0);
          if (singleNewlineSplit.length === chunk.length) {
            translatedLines = singleNewlineSplit;
          } else if (translatedLines.length === 1 && chunk.length > 1) {
            console.warn(`[Cadence] Batch translation failed to split: expected ${chunk.length} lines, got 1.`);
            translatedLines = [];
          }
        }
      }

      chunk.forEach((item, i) => {
        const translatedText = translatedLines[i]?.trim();
        if (translatedText && translatedText.toLowerCase() !== item.text.toLowerCase()) {
          const result = {
            originalLanguage: scripts.detectScriptLanguage(item.text) || chunkLanguage,
            translatedText,
          };
          cache.translation.set(`${targetLanguage}_${item.text}`, result);
          results[item.index] = result;
        }
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.warn("[Cadence] Translation batch failed:", error);
      }
    }
  }

  return { results, detectedLanguage };
}

function resolveRomanizationLanguage(
  sourceLanguage: string | undefined,
  lines: string[],
  scripts: ScriptClassifier
): string {
  if (sourceLanguage && languageMatchesAny(sourceLanguage, ROMANIZATION_LANGUAGES)) {
    return sourceLanguage;
  }

  const tally = new Map<string, number>();
  for (const line of lines) {
    const detected = scripts.detectScriptLanguage(line);
    if (detected) tally.set(detected, (tally.get(detected) ?? 0) + 1);
  }

  let dominant = "auto";
  let max = 0;
  for (const [lang, count] of tally) {
    if (count > max) {
      max = count;
      dominant = lang;
    }
  }
  return dominant;
}

function chooseRomanizationSeparator(texts: string[]): string {
  let separator = ROMANIZATION_SEPARATOR_BASE;
  while (texts.some(text => text.includes(separator))) separator += "0";
  return separator;
}

/**
 * Romanizes a batch of lyric lines in a single request, chunked if necessary.
 */
export async function romanizeBatch(
  request: BatchRequest,
  cache: TranslationCache = createTranslationCache()
): Promise<BatchRomanizationResponse> {
  const { lines, sourceLanguage, signal } = request;
  const doFetch = request.fetchImpl ?? fetch;
  const scripts = classifierFor(lines);

  if (lines.length === 0) {
    return { results: lines.map(() => null), detectedLanguage: "" };
  }

  const results: (string | null)[] = new Array(lines.length).fill(null);
  const toRomanize: { index: number; text: string }[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "♪" || !scripts.hasNonLatinScript(trimmed)) return;

    const cached = cache.romanization.get(trimmed);
    if (cached) {
      results[index] = cached;
    } else {
      toRomanize.push({ index, text: trimmed });
    }
  });

  if (toRomanize.length === 0) {
    return { results, detectedLanguage: sourceLanguage || "auto" };
  }

  let detectedLanguage = sourceLanguage || "auto";

  const chunks: { index: number; text: string }[][] = [];
  let currentChunk: { index: number; text: string }[] = [];
  let currentEncodedLength = 0;

  const lang = resolveRomanizationLanguage(
    sourceLanguage ?? undefined,
    toRomanize.map(item => item.text),
    scripts
  );
  detectedLanguage = lang;
  const separator = chooseRomanizationSeparator(toRomanize.map(item => item.text));
  const separatorPattern = new RegExp(`\\s*${separator}\\s*`);
  const joinedSeparator = ` ${separator} `;
  const baseUrl = TRANSLATE_IN_ROMAJI(lang, "");
  const separatorEncoded = encodeURIComponent(joinedSeparator);

  for (const item of toRomanize) {
    const itemEncoded = encodeURIComponent(item.text);
    const addedLength = (currentChunk.length > 0 ? separatorEncoded.length : 0) + itemEncoded.length;

    if (currentChunk.length > 0 && baseUrl.length + currentEncodedLength + addedLength > MAX_URL_LENGTH) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentEncodedLength = 0;
    }

    currentChunk.push(item);
    currentEncodedLength += (currentChunk.length > 1 ? separatorEncoded.length : 0) + itemEncoded.length;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  for (const chunk of chunks) {
    try {
      const combinedText = chunk.map(item => item.text).join(joinedSeparator);
      const url = TRANSLATE_IN_ROMAJI(lang, combinedText);
      const response = await doFetch(url, { signal });
      if (!response.ok) continue;
      const data = (await response.json()) as [unknown[], unknown, string];
      if (!Array.isArray(data?.[0])) continue;

      detectedLanguage = data[2] || detectedLanguage;

      let fullRomanizedText = "";
      for (const part of data[0]) {
        if (!Array.isArray(part)) continue;
        const romanized = part[3] || part[2];
        if (typeof romanized === "string" && romanized) fullRomanizedText += romanized;
      }

      const romanizedLines = fullRomanizedText.split(separatorPattern).map(part => part.trim());

      if (romanizedLines.length !== chunk.length) {
        console.warn(
          `[Cadence] Batch romanization failed to split: expected ${chunk.length} lines, got ${romanizedLines.length}.`
        );
        continue;
      }

      chunk.forEach((item, i) => {
        const romanizedText = romanizedLines[i]?.trim();
        if (romanizedText && romanizedText.toLowerCase() !== item.text.toLowerCase()) {
          cache.romanization.set(item.text, romanizedText);
          results[item.index] = romanizedText;
        }
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.warn("[Cadence] Romanization batch failed:", error);
      }
    }
  }

  return { results, detectedLanguage };
}

export function clearCache(cache: TranslationCache): void {
  cache.romanization.clear();
  cache.translation.clear();
}
