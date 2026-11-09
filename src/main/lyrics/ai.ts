import type { LyricsAiConfig } from "../../shared/types";
import { runtimeFetch } from "./http";
import { analyzeLyrics, type LanguageAnalysis } from "./languageIntelligence";

export interface AiCapabilities { listModels: boolean; testConnection: boolean; structuredText: boolean; nativeLocal: boolean }
export interface AiProfile { protocol: LyricsAiConfig["protocol"]; baseUrl: string; chatPath: string; modelsPath: string; apiKey: string; model: string; timeoutMs: number; customHeaders: string }
export interface AiModel { id: string; name: string }
export class LyricsAiError extends Error {
  constructor(message: string, readonly code: "configuration" | "connection" | "authentication" | "model" | "timeout" | "response" | "unsupported") { super(message); this.name = "LyricsAiError"; }
}
export function getProviderCapabilities(config: AiProfile): AiCapabilities {
  return { listModels: Boolean(config.modelsPath), testConnection: true, structuredText: true, nativeLocal: config.protocol === "ollama-native" };
}
function headers(config: AiProfile): Record<string,string> {
  let custom: Record<string,string> = {};
  try { const value: unknown = JSON.parse(config.customHeaders || "{}"); if (value && typeof value === "object" && !Array.isArray(value)) custom = value as Record<string,string>; }
  catch { throw new LyricsAiError("Custom headers must be a JSON object.", "configuration"); }
  const result: Record<string,string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (config.apiKey.trim()) result.Authorization = `Bearer ${config.apiKey.trim()}`;
  for (const [key,value] of Object.entries(custom)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /^(authorization|host|content-length)$/i.test(key) || typeof value !== "string")
      throw new LyricsAiError("Custom header name/value is invalid or restricted.", "configuration");
    result[key] = value;
  }
  return result;
}
function endpoint(config: AiProfile, path: string): string {
  let base: URL;
  try { base = new URL(config.baseUrl); } catch { throw new LyricsAiError("Enter a valid AI service URL.", "configuration"); }
  if (!["http:","https:"].includes(base.protocol)) throw new LyricsAiError("AI service must use HTTP or HTTPS.", "configuration");
  if (base.username || base.password) throw new LyricsAiError("Do not put credentials in the URL; use the API key field.", "configuration");
  const normalizedPath = path.trim();
  if (!normalizedPath) throw new LyricsAiError("AI endpoint path is required.", "configuration");
  const suffix = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  const basePath = base.pathname.replace(/\/$/, "");
  // Treat the base URL as an origin/prefix. Avoid duplicate /v1 when the path is given in full.
  const joined = suffix.startsWith(`${basePath}/`) || suffix === basePath ? suffix : `${basePath}${suffix}`;
  base.pathname = joined.replace(/\/+/g, "/");
  return base.toString();
}
async function request(config: AiProfile, url: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const timeoutMs = Math.max(500, Math.min(300_000, config.timeoutMs || 60_000));
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  console.log("[Cadence AI] request body", body === undefined ? null : body);
  try {
    response = await runtimeFetch(url, {
      method: body === undefined ? "GET" : "POST", headers: headers(config),
      body: body === undefined ? undefined : JSON.stringify(body), signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted || (error as Error)?.name === "TimeoutError") throw new LyricsAiError("AI request timed out. Increase the request timeout or check whether the model is still loading.", "timeout");
    throw new LyricsAiError("Could not connect to the configured AI service. Check that it is running and the endpoint is reachable.", "connection");
  }
  console.log("[Cadence AI] HTTP", url, response.status, response.statusText);
  if (response.status === 401 || response.status === 403) throw new LyricsAiError("AI service rejected authentication. Check the API key and access permissions.", "authentication");
  if (response.status === 404) throw new LyricsAiError("AI endpoint or model was not found. Verify the model identifier and API path.", "model");
  if (response.status === 400) throw new LyricsAiError("AI service rejected the model or request format (HTTP 400). Check the model identifier, protocol, and supported request options.", "unsupported");
  if (response.status === 429) throw new LyricsAiError("AI service rate limit reached. Wait before retrying.", "connection");
  if (!response.ok) throw new LyricsAiError(`AI service returned HTTP ${response.status}.`, "connection");
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new LyricsAiError("AI service returned invalid JSON.", "response"); }
  console.log("[Cadence AI] response body", data);
  return data;
}
function validateProfile(config: AiProfile): void {
  if (!config.baseUrl.trim()) throw new LyricsAiError("AI service URL is required.", "configuration");
  if (!config.model.trim()) throw new LyricsAiError("Select or enter a model name.", "configuration");
  headers(config);
}
export async function listModels(config: AiProfile): Promise<AiModel[]> {
  if (!config.baseUrl.trim()) throw new LyricsAiError("AI service URL is required.", "configuration");
  headers(config);
  const data = await request(config, endpoint(config, config.modelsPath));
  const list = config.protocol === "ollama-native"
    ? (data as { models?: { name?: string; model?: string }[] })?.models?.map(row => ({ id: row.name ?? row.model ?? "", name: row.name ?? row.model ?? "" }))
    : (data as { data?: { id?: string; name?: string }[] })?.data?.map(row => ({ id: row.id ?? "", name: row.name ?? row.id ?? "" }));
  if (!Array.isArray(list)) throw new LyricsAiError("Model list response did not match the configured API protocol.", "response");
  return list.filter(item => item.id).sort((a,b) => a.id.localeCompare(b.id));
}
async function generate(config: AiProfile, prompt: string, signal?: AbortSignal): Promise<string> {
  validateProfile(config);
  const temperature = Math.max(0, Math.min(2, (config as LyricsAiConfig).temperature ?? .2));
  const maxTokens = Math.max(1, Math.min(32768, (config as LyricsAiConfig).maxOutputTokens ?? 4096));
  console.log("[Cadence AI] generate", { model: config.model, promptChars: prompt.length });
  console.log("[Cadence AI] prompt full", prompt);  const body = config.protocol === "ollama-native"
    ? { model: config.model, stream: false, format: "json", messages: [{ role: "system", content: prompt }, { role: "user", content: "Transform the supplied lyric segments and return only the required JSON object." }], options: { temperature, num_predict: maxTokens } }
    : { model: config.model, stream: false, temperature, max_tokens: maxTokens, response_format: { type: "json_object" }, messages: [{ role: "system", content: prompt }, { role: "user", content: "Transform the supplied lyric segments and return only the required JSON object." }] };
  const data = await request(config, endpoint(config, config.chatPath), body, signal) as Record<string, any>;
  const content = config.protocol === "ollama-native" ? data?.message?.content : data?.choices?.[0]?.message?.content;
  console.log("[Cadence AI] generated content full", content);  if (typeof content !== "string") throw new LyricsAiError("AI response did not contain message text.", "response");
  return content;
}
export async function testConnection(config: AiProfile, signal?: AbortSignal): Promise<string> {
  validateProfile(config);
  if (config.protocol === "ollama-native") {
    const url = endpoint(config, config.modelsPath);
    const data = await request(config, url, undefined, signal) as { models?: {name?:string}[] };
    if (!Array.isArray(data?.models)) throw new LyricsAiError("Ollama returned an unexpected model-list response.", "response");
    if (!data.models.some(model => model.name === config.model)) throw new LyricsAiError(`Ollama is reachable, but model “${config.model}” is not installed.`, "model");
    return `Connected to Ollama; model ${config.model} is installed.`;
  }
  const answer = await generate(config, 'Return exactly {"ok":true}.', signal);
  if (!answer.includes("true")) throw new LyricsAiError("AI service responded, but its chat response was unexpected.", "response");
  return `Connected to ${config.model}.`;
}

export type TransformKind = "translation" | "romanization";
export interface TransformResult { results: (string|null)[]; analysis: LanguageAnalysis; words?: (string[] | null)[] }
function promptForTranslation(analysis: LanguageAnalysis, target: string, ids: {id:string;text:string}[], contextLines: string[]): string {
  const task = `Translate song lyrics from ${analysis.language} into ${target}. Preserve meaning, idiom, emotion, repeated lines, punctuation and intentional repetitions. Do not add explanations or lyrics.`;
  const perLine = ids.map((item, index) => `${item.id}: ${analysis.lineLanguages[index] ?? analysis.language} | words=${item.text.split(/\s+/).filter(Boolean).length} | ${item.text}`).join("\n");
  return `${task}
Translate EVERY supplied segment into ${target}, including English and other Latin-script segments. Do not echo, skip, or leave any segment in its source language. If a segment is already written in ${target}, return it unchanged; otherwise translate it. Neighboring source lines are context only and must not be returned.
Offline analysis: detected ${analysis.language} in ${analysis.script} script, confidence ${(analysis.confidence * 100).toFixed(0)}%, mixed-language=${analysis.mixed}. Treat low-confidence language as uncertain and use neighboring lyric context.
Per-line source languages:
${perLine}
Use context across the entire song to resolve ambiguity and keep terminology/conventions consistent.
Return exactly one JSON object with key "results", an array containing exactly one {"id":"...","text":"..."} per supplied id. Do not return markdown or other keys. Preserve every id exactly. Each text must be a single line without timestamps, tags, markup or commentary.
CONTEXT=${JSON.stringify(contextLines)}
SEGMENTS=${JSON.stringify(ids)}`;
}

function promptForRomanization(analysis: LanguageAnalysis, standard: string, ids: {id:string;text:string}[], contextLines: string[], segmentSpans?: Array<string[] | undefined>): string {
  const hasSpans = Array.isArray(segmentSpans) && segmentSpans.some(spans => Array.isArray(spans) && spans.length > 0);
  const spanInstruction = hasSpans
    ? `Some segments include "spans": an array of source spans in order. For those segments, "words" MUST contain one unspaced token per non-space span, in the same order, and all tokens must concatenate to "text" with all spaces removed. The token count must exactly equal the non-space span count. Do not merge adjacent spans into fewer tokens and do not split one span into more tokens. Do not add separate tokens for empty or space-only spans. Adjacent source spans may be syllables of one word, so consecutive token pieces and text pieces may have no space; only genuine word boundaries receive spaces in "text".`
    : `If no spans are provided, "words" may be omitted or contain natural word tokens.`;
  const task = `Romanize ${analysis.language} lyrics from ${analysis.script} into Latin characters. Do not translate, paraphrase, rewrite meaning, add or omit lyrics. Preserve punctuation and repetitions. Use ${standard}. If a segment is already Latin/romanized, copy it unchanged. For characters from non-Latin scripts, lowercase the entire romanized result; lowercase all non-Latin-derived text. Return each result as an object with "text" (the full romanized line, with natural spaces between words) and "words" (an array of romanized tokens without spaces). When spans are provided, "words" must contain exactly one token per non-space span, in the same order, and concatenating all word tokens after removing all spaces must equal "text" with all spaces removed. Do not add spaces to any word token. The parser will align spaces from "text". Several adjacent spans may be syllables/parts of the same word: in that case their romanized tokens are adjacent in "words" and the corresponding pieces are adjacent in "text" without spaces. Do not insert a space into "text" solely because two source spans are adjacent. Add spaces to "text" only at genuine word boundaries. Most importantly, never merge or drop spans into fewer tokens: the number of unspaced word tokens must exactly equal the number of non-space source spans. Example for spans ["natsu","kashi","i","tsuu","ga","kuro"]: text "natsukashii tsuugakuro", words ["natsu","kashi","i","tsuu","ga","kuro"]. Additional example for spans ["a","na","ta","wa"]: text "anata wa", words ["a","na","ta","wa"]. Strict count example for spans ["水溜りに","足を","突っ込ん","で"]: text "mizutamarini ashio tsukkomun de", words ["mizutamarini","ashio","tsukkomun","de"]. Do not add separate tokens for empty or space-only spans.`;
  const promptIds = ids.map((item, index) => ({ id: item.id, text: item.text, spans: segmentSpans?.[index] }));
  return `${task}
Spacing instruction for spans: ${spanInstruction}
Offline analysis: detected ${analysis.language} in ${analysis.script} script, confidence ${(analysis.confidence * 100).toFixed(0)}%, mixed-language=${analysis.mixed}. Treat low-confidence language as uncertain and use neighboring lyric context. Do not transform an already-Latin segment.
Use context across the entire song to resolve ambiguity and keep terminology/conventions consistent.
Return exactly one JSON object with key "results", an array containing exactly one {"id":"...","text":"...","words":["..."]} per supplied id. Do not return markdown or other keys. Preserve every id exactly. "text" must be a single line without timestamps, tags, markup or commentary and must contain natural word spaces only. "words" must contain exactly one unspaced token per non-space source span, in order; never merge or omit spans. Concatenating all word tokens after removing all spaces must equal "text" with all spaces removed. Adjacent source spans can be parts of the same word, so text may have no space between their corresponding pieces; do not add spaces per token. Neighboring source lines are context only and must not be returned.
CONTEXT=${JSON.stringify(contextLines)}
SEGMENTS=${JSON.stringify(promptIds)}`;
}
const derivedCache = new Map<string, { kind: TransformKind; results: (string|null)[]; words?: (string[] | null)[] }>();
let persistAiCache: ((json: string) => void | Promise<void>) | undefined;
let persistQueue: Promise<void> = Promise.resolve();
function persistDerivedCache(): void {
  if (!persistAiCache) return;
  let entries = [...derivedCache].map(([key,value]) => [key,{kind:value.kind,results:value.results,words:value.words}] as const);
  let json = JSON.stringify({ version: 1, entries });
  while (json.length > 4_000_000 && entries.length) {
    entries = entries.slice(1); json = JSON.stringify({version:1,entries});
  }
  persistQueue = persistQueue.then(() => Promise.resolve(persistAiCache?.(json))).then(() => undefined).catch(() => undefined);
}
export function initializeAiCache(initialJson: string | null | undefined, persist?: (json: string) => void | Promise<void>): void {
  derivedCache.clear(); persistAiCache = persist;
  try {
    if ((initialJson?.length ?? 0) > 4_000_000) return;
    const file = JSON.parse(initialJson ?? "null") as {version?:number;entries?:[string,{kind:TransformKind;results:(string|null)[];words?:(string[]|null)[]}][]}|null;
    if (file?.version !== 1 || !Array.isArray(file.entries)) return;
    for (const [key,value] of file.entries.slice(-512)) {
      const validWords = value?.words === undefined || (Array.isArray(value.words) && value.words.every(word => word === null || (Array.isArray(word) && word.every(item => typeof item === "string"))));
      if (typeof key === "string" && value && ["translation","romanization"].includes(value.kind) && Array.isArray(value.results) && value.results.every(text => text === null || typeof text === "string") && validWords)
        derivedCache.set(key,{kind:value.kind,results:value.results,words:value.words});
    }
  } catch { /* malformed/old cache is ignored; original provider lyrics are unaffected */ }
}
function digest(value: string): string {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}
export async function clearAiCache(kind?: TransformKind): Promise<void> {
  if (!kind) derivedCache.clear();
  else for (const [key, value] of derivedCache) if (value.kind === kind) derivedCache.delete(key);
  persistDerivedCache();
  await persistQueue;
}
function aiLogPreview(value: string): string { return value.length > 500 ? `${value.slice(0, 500)}…` : value; }
export async function transformLyrics(kind: TransformKind, config: LyricsAiConfig, lines: string[], target: string, sourceHint?: string|null, signal?: AbortSignal, forceRegenerate = false, segmentIds?: string[], segmentSpans?: Array<string[] | undefined>, contextLines: string[] = lines): Promise<TransformResult> {
  const analysis = analyzeLyrics(contextLines.length ? contextLines : lines);
  if (!forceRegenerate && kind === "translation" && analysis.language !== "und" && target && target.split("-")[0].toLowerCase() === analysis.language.split("-")[0].toLowerCase())
    return { results: lines.map(() => null), analysis };
  const context = (analysis.language === "und" || analysis.confidence < .65) && sourceHint && sourceHint !== "und"
    ? { ...analysis, language: sourceHint as LanguageAnalysis["language"] }
    : analysis;
  console.log("[Cadence AI] transform start", kind, { language: context.language, lines: lines.length, forceRegenerate, target });
const cacheKey = digest(JSON.stringify({ v: 19, kind, lines, contextLines, segmentIds, segmentSpans, language: context.language, script: context.script, confidence: context.confidence, mixed: context.mixed,
    target, protocol: config.protocol, baseUrl: config.baseUrl, chatPath: config.chatPath, model: config.model,
    keyFingerprint: digest(config.apiKey), headersFingerprint: digest(config.customHeaders), standard: config.romanizationStandard ?? "",
    temperature: config.temperature, maxOutputTokens: config.maxOutputTokens,
  }));
  const cached = derivedCache.get(cacheKey);
  console.log("[Cadence AI] cache", kind, cached ? "hit" : "miss", cacheKey.slice(0, 12));
  if (!forceRegenerate && cached) return { analysis, results: [...cached.results], words: cached.words ? [...cached.words] : undefined };
  const ids = lines.map((text,index) => ({ id: segmentIds?.[index] ?? `L${index}`, text }));
  if (new Set(ids.map(row => row.id)).size !== ids.length) throw new LyricsAiError("Lyric segment IDs must be unique.", "configuration");
  const standards: Record<string,string> = { ja: "Hepburn romanization", ko: "Revised Romanization of Korean", zh: "Hanyu Pinyin with tone marks where natural", ru: "BGN/PCGN Russian transliteration", ar: "DIN 31635 Arabic romanization" };
  const configuredStandard = config.romanizationStandard ?? "auto";
  const standard = configuredStandard === "auto" ? (standards[context.language] ?? `a consistent standard for ${context.language}`) : configuredStandard;
  const prompt = kind === "translation"
    ? promptForTranslation(context, target || config.targetLanguage || "English", ids, contextLines)
    : promptForRomanization(context, standard, ids, contextLines, segmentSpans);
  console.log("[Cadence AI] prompt", aiLogPreview(prompt));
  const raw = await generate(config, prompt, signal);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new LyricsAiError("AI returned malformed structured lyrics. No results were applied.", "response"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed as object).some(key => key !== "results"))
    throw new LyricsAiError("AI response contained unexpected fields or commentary. No results were applied.", "response");
  const rows = (parsed as {results?:unknown})?.results;
  console.log("[Cadence AI] parsed response", { rows: Array.isArray(rows) ? rows.length : rows });
  if (!Array.isArray(rows) || rows.length !== ids.length) throw new LyricsAiError("AI response is incomplete or contains unexpected lyric segments.", "response");
  const mapped = new Map<string,string>();
  const mappedWords = new Map<string, string[] | null>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof (row as any).id !== "string") {
      console.log("[Cadence AI] invalid row shape", row);
      throw new LyricsAiError("AI response contains an invalid segment.", "response");
    }
    const id = (row as { id: string }).id;
    let words: string[] | null = null;
    const original = ids.find(item => item.id === id)!.text;
    const nonLatin = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Thai}]/u;

    let value = "";
    if (kind === "romanization") {
      if (typeof (row as any).text === "string") {
        value = ((row as any).text as string).trim();
      }
      const rawWords = (row as any).words;
      if (rawWords !== undefined) {
        if (!Array.isArray(rawWords) || !rawWords.every(item => typeof item === "string")) {
          console.log("[Cadence AI] invalid words array", { id, rawWords });
          throw new LyricsAiError("AI response contains an invalid word array.", "response");
        }
        const normalizedWords = (rawWords as string[]).map(item => String(item));
        const rowSpans = segmentSpans?.[ids.findIndex(item => item.id === id)];
        const spanCount = Array.isArray(rowSpans) ? rowSpans.length : 0;
        const nonSpaceSpanCount = Array.isArray(rowSpans) ? rowSpans.filter(span => span.trim().length > 0).length : 0;
        if (spanCount > 0 && normalizedWords.length !== spanCount && normalizedWords.length !== nonSpaceSpanCount) {
          console.log("[Cadence AI] words/span count mismatch", { id, expected: `${spanCount} or ${nonSpaceSpanCount}`, got: normalizedWords.length, words: normalizedWords });
          words = null;
        } else {
          words = normalizedWords.length > 0 ? normalizedWords : null;
        }
      }
      if (!value && words && words.length > 0) value = words.filter(Boolean).join(" ");
      if (nonLatin.test(original)) {
        value = value.toLowerCase();
        if (words) words = words.map(word => word.toLowerCase());
      }
      const textLooksBad = !value || value.includes("\n") || /\[(?:\d{1,2}:)?\d{2}[.:]\d{2}\]|<\/?[\w:.-]+\b[^>]*>/u.test(value) || /```/.test(value) || /^(?:translation|romanization|here(?:'s| is) (?:the )?(?:translation|romanization)\s*:)/i.test(value);
      if (textLooksBad) {
        console.log("[Cadence AI] validation rejected", { id, original, value });
        throw new LyricsAiError("AI output failed lyric text validation. No results were applied.", "response");
      }
    } else {
      if (typeof (row as any).text !== "string") {
        console.log("[Cadence AI] invalid row shape", row);
        throw new LyricsAiError("AI response contains an invalid segment.", "response");
      }
      value = ((row as any).text as string).trim();
      if (!value || value.includes("\n") || /\[(?:\d{1,2}:)?\d{2}[.:]\d{2}\]|<\/?[\w:.-]+\b[^>]*>/u.test(value) || /```/.test(value) || /^(?:translation|romanization|here(?:'s| is) (?:the )?(?:translation|romanization)\s*:)/i.test(value)) {
        console.log("[Cadence AI] validation rejected", { id, original, value });
        throw new LyricsAiError("AI output failed lyric text validation. No results were applied.", "response");
      }
    }

    if (ids.some(item => item.id === id) === false || mapped.has(id)) {
      console.log("[Cadence AI] duplicate/unknown id", id);
      throw new LyricsAiError("AI response has duplicate or unknown segment IDs.", "response");
    }
    mapped.set(id, value);
    mappedWords.set(id, words);
  }
  if (mapped.size !== ids.length) throw new LyricsAiError("AI response omitted required lyric segments.", "response");
  const resultWords = kind === "romanization" ? ids.map(({id}) => mappedWords.get(id) ?? null) : undefined;
  const result = { results: ids.map(({id}) => mapped.get(id) ?? null), analysis, words: resultWords };
console.log("[Cadence AI] validated results full", result.results);  if (derivedCache.size >= 512) {
    const oldest = derivedCache.keys().next().value;
    if (oldest !== undefined) derivedCache.delete(oldest);
  }
  derivedCache.set(cacheKey, { kind, results: [...result.results], words: result.words ? [...result.words] : undefined });
  persistDerivedCache();
  return { analysis, results: [...result.results], words: result.words ? [...result.words] : undefined };
}
