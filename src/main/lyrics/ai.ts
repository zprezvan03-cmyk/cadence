import type { LyricsAiConfig, LyricsAiThinkingCapabilities, LyricsAiThinkingMode } from "../../shared/types";
import { runtimeFetch } from "./http";
import { analyzeLyrics, type LanguageAnalysis } from "./languageIntelligence";

export interface AiCapabilities { listModels: boolean; testConnection: boolean; structuredText: boolean; nativeLocal: boolean }
export interface AiProfile { protocol: LyricsAiConfig["protocol"]; baseUrl: string; chatPath: string; modelsPath: string; apiKey: string; model: string; timeoutMs: number; customHeaders: string; thinkingMode?: LyricsAiThinkingMode }
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
  if (response.status === 401 || response.status === 403) throw new LyricsAiError("AI service rejected authentication. Check the API key and access permissions.", "authentication");
  if (response.status === 404) throw new LyricsAiError("AI endpoint or model was not found. Verify the model identifier and API path.", "model");
  if (response.status === 400) throw new LyricsAiError("AI service rejected the model or request format (HTTP 400). Check the model identifier, protocol, and supported request options.", "unsupported");
  if (response.status === 429) throw new LyricsAiError("AI service rate limit reached. Wait before retrying.", "connection");
  if (!response.ok) throw new LyricsAiError(`AI service returned HTTP ${response.status}.`, "connection");
  try { return await response.json(); }
  catch { throw new LyricsAiError("AI service returned invalid JSON.", "response"); }
}
const ollamaThinkingCache = new Map<string, { expiresAt: number; capabilities: LyricsAiThinkingCapabilities }>();
const thinkingOrder: LyricsAiThinkingMode[] = ["off", "low", "medium", "high", "auto"];
const modeFromWire = (value: unknown): LyricsAiThinkingMode | null => {
  if (value === false || value === "off" || value === "false") return "off";
  return value === "low" || value === "medium" || value === "high" || value === "auto" ? value : null;
};
function findThinkingMetadata(value: unknown, depth = 0): { values?: unknown; defaultValue?: unknown } | null {
  if (!value || typeof value !== "object" || depth > 12) return null;
  const record = value as Record<string, unknown>;
  const thinking = record.thinking;
  if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
    const metadata = thinking as Record<string, unknown>;
    if (Array.isArray(metadata.values) || Object.hasOwn(metadata, "default"))
      return { values: metadata.values, defaultValue: metadata.default };
  }
  for (const child of Object.values(record)) {
    const found = findThinkingMetadata(child, depth + 1);
    if (found) return found;
  }
  return null;
}
export async function getOllamaThinkingCapabilities(
  config: AiProfile,
  refresh = false,
  signal?: AbortSignal
): Promise<LyricsAiThinkingCapabilities> {
  if (config.protocol !== "ollama-native") {
    return { modes: ["auto"], defaultMode: null, metadataAvailable: false, detail: "Thinking controls are available only with Ollama native API." };
  }
  if (!config.model.trim()) return { modes: ["auto"], defaultMode: null, metadataAvailable: false, detail: "Select an Ollama model to inspect its thinking modes." };
  const cacheKey = `${config.baseUrl.trim().replace(/\/$/, "")}/${config.model.trim()}`;
  const cached = ollamaThinkingCache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.capabilities;
  try {
    const showUrl = endpoint(config, "/api/show");
    const data = await request(config, showUrl, { model: config.model.trim() }, signal);
    const metadata = findThinkingMetadata(data);
    if (!metadata) {
      const result: LyricsAiThinkingCapabilities = {
        modes: ["auto"], defaultMode: null, metadataAvailable: false,
        detail: "This model did not report thinking controls; Auto is the only confirmed mode.",
      };
      ollamaThinkingCache.set(cacheKey, { expiresAt: Date.now() + 300_000, capabilities: result });
      return result;
    }
    const values = Array.isArray(metadata.values) ? metadata.values : [];
    const supported = new Set<LyricsAiThinkingMode>();
    for (const value of values) {
      const mode = modeFromWire(value);
      if (mode && mode !== "auto") supported.add(mode);
    }
    const defaultMode = modeFromWire(metadata.defaultValue);
    if (defaultMode && defaultMode !== "auto") supported.add(defaultMode);
    const modes: LyricsAiThinkingMode[] = [...thinkingOrder.filter(mode => supported.has(mode)), "auto"];
    const result: LyricsAiThinkingCapabilities = {
      modes, defaultMode, metadataAvailable: true,
      detail: defaultMode ? `Model default: ${defaultMode === "off" ? "Off" : defaultMode[0].toUpperCase() + defaultMode.slice(1)}.` : "Thinking controls reported by this model.",
    };
    ollamaThinkingCache.set(cacheKey, { expiresAt: Date.now() + 300_000, capabilities: result });
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    const result: LyricsAiThinkingCapabilities = {
      modes: ["auto"], defaultMode: null, metadataAvailable: false,
      detail: error instanceof LyricsAiError ? `Thinking metadata unavailable: ${error.message}` : "Thinking metadata unavailable; using Auto only.",
    };
    ollamaThinkingCache.set(cacheKey, { expiresAt: Date.now() + 30_000, capabilities: result });
    return result;
  }
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
  const body: Record<string, unknown> = config.protocol === "ollama-native"
    ? { model: config.model, stream: false, format: "json", messages: [{ role: "system", content: prompt }, { role: "user", content: "Transform the supplied lyric segments and return only the required JSON object." }], options: { temperature, num_predict: maxTokens } }
    : { model: config.model, stream: false, temperature, max_tokens: maxTokens, response_format: { type: "json_object" }, messages: [{ role: "system", content: prompt }, { role: "user", content: "Transform the supplied lyric segments and return only the required JSON object." }] };
  if (config.protocol === "ollama-native") {
    const thinkingMode = config.thinkingMode ?? "auto";
    if (thinkingMode !== "auto") {
      const capabilities = await getOllamaThinkingCapabilities(config, false, signal);
      if (!capabilities.modes.includes(thinkingMode)) {
        throw new LyricsAiError(
          capabilities.metadataAvailable
            ? `The selected model does not support Thinking Mode ${thinkingMode}. Choose Auto or a supported mode.`
            : "The selected model's thinking capabilities could not be confirmed. Choose Auto or refresh model capabilities.",
          "unsupported"
        );
      }
      body.think = thinkingMode === "off" ? false : thinkingMode;
    }
  }
  const data = await request(config, endpoint(config, config.chatPath), body, signal) as Record<string, any>;
  const content = config.protocol === "ollama-native" ? data?.message?.content : data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new LyricsAiError("AI response did not contain message text.", "response");
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
export interface TransformResult { results: (string|null)[]; analysis: LanguageAnalysis }
function promptFor(kind: TransformKind, analysis: LanguageAnalysis, target: string, standard: string, ids: {id:string;text:string}[], contextLines: string[]): string {
  const task = kind === "translation"
    ? `Translate song lyrics from ${analysis.language} into ${target}. Preserve meaning, idiom, emotion, repeated lines, punctuation and intentional repetitions. Do not add explanations or lyrics.`
    : `Romanize ${analysis.language} lyrics from ${analysis.script} into Latin characters. Do not translate, paraphrase, rewrite meaning, add or omit lyrics. Preserve punctuation and repetitions. Use ${standard}. If a segment is already Latin/romanized, copy it unchanged.`;
  return `${task}\nOffline analysis: detected ${analysis.language} in ${analysis.script} script, confidence ${(analysis.confidence * 100).toFixed(0)}%, mixed-language=${analysis.mixed}. Treat low-confidence language as uncertain and use neighboring lyric context; do not transform an already-Latin segment.\nUse context across the entire song to resolve ambiguity and keep terminology/conventions consistent.\nReturn exactly one JSON object with key "results", an array containing exactly one {"id":"...","text":"..."} per supplied id. Do not return markdown or other keys. Preserve every id exactly. Each text must be a single line without timestamps, tags, markup or commentary. Neighboring source lines are context only and must not be returned.\nCONTEXT=${JSON.stringify(contextLines)}\nSEGMENTS=${JSON.stringify(ids)}`;
}
const derivedCache = new Map<string, { kind: TransformKind; results: (string|null)[] }>();
let persistAiCache: ((json: string) => void | Promise<void>) | undefined;
let persistQueue: Promise<void> = Promise.resolve();
function persistDerivedCache(): void {
  if (!persistAiCache) return;
  let entries = [...derivedCache].map(([key,value]) => [key,{kind:value.kind,results:value.results}] as const);
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
    const file = JSON.parse(initialJson ?? "null") as {version?:number;entries?:[string,{kind:TransformKind;results:(string|null)[]}][]}|null;
    if (file?.version !== 1 || !Array.isArray(file.entries)) return;
    for (const [key,value] of file.entries.slice(-512)) {
      if (typeof key === "string" && value && ["translation","romanization"].includes(value.kind) && Array.isArray(value.results) && value.results.every(text => text === null || typeof text === "string"))
        derivedCache.set(key,{kind:value.kind,results:value.results});
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
export async function transformLyrics(kind: TransformKind, config: LyricsAiConfig, lines: string[], target: string, sourceHint?: string|null, signal?: AbortSignal, forceRegenerate = false, segmentIds?: string[], contextLines: string[] = lines): Promise<TransformResult> {
  const analysis = analyzeLyrics(contextLines.length ? contextLines : lines);
  if (!forceRegenerate && kind === "translation" && analysis.language !== "und" && target && target.split("-")[0].toLowerCase() === analysis.language.split("-")[0].toLowerCase())
    return { results: lines.map(() => null), analysis };
  const context = (analysis.language === "und" || analysis.confidence < .65) && sourceHint && sourceHint !== "und"
    ? { ...analysis, language: sourceHint as LanguageAnalysis["language"] }
    : analysis;
  const cacheKey = digest(JSON.stringify({ v: 1, kind, lines, contextLines, segmentIds, language: context.language, script: context.script, confidence: context.confidence, mixed: context.mixed,
    target, protocol: config.protocol, baseUrl: config.baseUrl, chatPath: config.chatPath, model: config.model,
    keyFingerprint: digest(config.apiKey), headersFingerprint: digest(config.customHeaders), standard: config.romanizationStandard ?? "",
    thinkingMode: config.thinkingMode ?? "auto", temperature: config.temperature, maxOutputTokens: config.maxOutputTokens,
  }));
  const cached = derivedCache.get(cacheKey);
  if (!forceRegenerate && cached) return { analysis, results: [...cached.results] };
  const ids = lines.map((text,index) => ({ id: segmentIds?.[index] ?? `L${index}`, text }));
  if (new Set(ids.map(row => row.id)).size !== ids.length) throw new LyricsAiError("Lyric segment IDs must be unique.", "configuration");
  const standards: Record<string,string> = { ja: "Hepburn romanization", ko: "Revised Romanization of Korean", zh: "Hanyu Pinyin with tone marks where natural", ru: "BGN/PCGN Russian transliteration", ar: "DIN 31635 Arabic romanization" };
  const configuredStandard = config.romanizationStandard ?? "auto";
  const standard = configuredStandard === "auto" ? (standards[context.language] ?? `a consistent standard for ${context.language}`) : configuredStandard;
  const raw = await generate(config, promptFor(kind, context, target || config.targetLanguage || "English", standard, ids, contextLines), signal);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new LyricsAiError("AI returned malformed structured lyrics. No results were applied.", "response"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed as object).some(key => key !== "results"))
    throw new LyricsAiError("AI response contained unexpected fields or commentary. No results were applied.", "response");
  const rows = (parsed as {results?:unknown})?.results;
  if (!Array.isArray(rows) || rows.length !== ids.length) throw new LyricsAiError("AI response is incomplete or contains unexpected lyric segments.", "response");
  const mapped = new Map<string,string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof (row as any).id !== "string" || typeof (row as any).text !== "string") throw new LyricsAiError("AI response contains an invalid segment.", "response");
    const {id,text} = row as {id:string;text:string};
    if (!ids.some(item => item.id === id) || mapped.has(id)) throw new LyricsAiError("AI response has duplicate or unknown segment IDs.", "response");
    const value = text.trim();
    const original = ids.find(item => item.id === id)!.text;
    const nonLatin = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Thai}]/u;
    if (!value || value.includes("\n") || /\[(?:\d{1,2}:)?\d{2}[.:]\d{2}\]|<\/?[\w:.-]+\b[^>]*>/u.test(value) || /```/.test(value) || /^(?:translation|romanization|here(?:'s| is) (?:the )?(?:translation|romanization)\s*:)/i.test(value) ||
        kind === "romanization" && nonLatin.test(original) && nonLatin.test(value))
      throw new LyricsAiError("AI output failed lyric text validation. No results were applied.", "response");
    mapped.set(id,value);
  }
  if (mapped.size !== ids.length) throw new LyricsAiError("AI response omitted required lyric segments.", "response");
  const result = { results: ids.map(({id}) => mapped.get(id) ?? null), analysis };
  if (derivedCache.size >= 512) {
    const oldest = derivedCache.keys().next().value;
    if (oldest !== undefined) derivedCache.delete(oldest);
  }
  derivedCache.set(cacheKey, { kind, results: [...result.results] });
  persistDerivedCache();
  return { analysis, results: [...result.results] };
}
