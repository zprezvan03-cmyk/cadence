/**
 * Local, offline Japanese romanization engine (Kuroshiro + Kuromoji).
 *
 * This module wraps Kuroshiro/Kuromoji so Cadence can romanize Japanese lyrics
 * deterministically, without network access or API keys. The analyzer is
 * initialized once and reused for every subsequent conversion.
 */
import type { LyricsLanguage } from "./languageIntelligence";

const JAPANESE_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const lineCache = new Map<string, string>();

interface KuromojiToken {
  surface_form: string;
  pos: string;
  pos_detail_1?: string;
  reading?: string;
  pronunciation?: string;
}

interface KuroshiroLike {
  convert: (str: string, options?: Record<string, unknown>) => Promise<string>;
  Util: { kanaToRomaji: (str: string, system?: string) => string };
}

let kuroshiroInstance: KuroshiroLike | null = null;
let kuroshiroClass: any = null;
let initPromise: Promise<KuroshiroLike> | null = null;

async function getKuroshiro(): Promise<KuroshiroLike> {
  if (kuroshiroInstance) return kuroshiroInstance;
  if (!initPromise) {
    initPromise = (async () => {
      const kuroModule: any = await import("kuroshiro" as any);
      const analyzerModule: any = await import("kuroshiro-analyzer-kuromoji" as any);
      const Kuroshiro = (kuroModule as any).default ?? kuroModule;
      const Analyzer = (analyzerModule as any).default ?? analyzerModule;
      kuroshiroClass = Kuroshiro;
      const instance = new Kuroshiro();
      await instance.init(new Analyzer());
      kuroshiroInstance = instance as KuroshiroLike;
      return kuroshiroInstance;
    })();
  }
  return initPromise;
}

/** Tokenize a Japanese string using the shared Kuromoji analyzer. */
async function tokenize(text: string): Promise<KuromojiToken[]> {
  const kuro = await getKuroshiro();
  // Kuroshiro's analyzer is private; reach it through the public instance.
  const analyzer = (kuro as any)._analyzer;
  if (analyzer && typeof analyzer.parse === "function") {
    return analyzer.parse(text) as Promise<KuromojiToken[]>;
  }
  // Fallback: kuroshiro convert is not enough for tokens; build a single pseudo-token.
  return [{ surface_form: text, pos: "名詞", reading: text, pronunciation: text }];
}

export interface JapaneseRomanizationOptions {
  /** Romanization system. Defaults to Hepburn. */
  system?: "hepburn" | "passport" | "nippon";
  /** Whether to keep macrons in the output. Defaults to true for Hepburn. */
  macrons?: boolean;
}

export interface JapaneseRomanizationResult {
  text: string;
  words: string[] | null;
}

function systemName(system?: JapaneseRomanizationOptions["system"]): string {
  if (system === "passport") return "passport";
  if (system === "nippon") return "nippon";
  return "hepburn";
}

function hasJapanese(text: string): boolean {
  return JAPANESE_RE.test(text);
}

function toKanaRomaji(kana: string, system: string): string {
  try {
    return (getKuroshiroSyncUtil()?.kanaToRomaji ?? ((s: string) => s))(kana, system);
  } catch {
    return kana;
  }
}

// Synchronous accessor for the already-initialized util (used only after init).
let cachedUtil: { kanaToRomaji: (str: string, system?: string) => string } | null = null;
function getKuroshiroSyncUtil() {
  if (cachedUtil) return cachedUtil;
  if (kuroshiroInstance) {
    cachedUtil = kuroshiroInstance.Util as any;
    return cachedUtil;
  }
  return null;
}

/** Determine whether a token should attach to the previous word (no space). */
function attachesToPrevious(token: KuromojiToken, previous: KuromojiToken | null): boolean {
  if (!previous) return false;
  if (previous.pos_detail_1 === "接頭辞") return true;
  if (token.pos_detail_1 === "接尾" || token.pos === "助動詞" || token.pos_detail_1 === "非自立") return true;
  // Punctuation / symbols attach to the preceding word.
  if (/^[^\p{L}\p{N}]+$/u.test(token.surface_form.trim())) return true;
  if (token.pos === "記号") return true;
  return false;
}

/** Romanize a single source span, including trailing sokuon handling. */
async function romanizeSpan(span: string, nextSpan: string | undefined, system: string): Promise<string> {
  const trimmed = span.trim();
  if (!trimmed) return "";
  if (!hasJapanese(trimmed)) return trimmed;
  const toks = await tokenize(trimmed);
  const reading = toks.map(t => t.pronunciation || t.reading || t.surface_form).join("");
  let baseReading = reading;
  let sokuon = false;
  if (/[っッ]$/.test(trimmed)) {
    sokuon = true;
    baseReading = reading.slice(0, -1);
  }
  const kanaToRomaji = cachedUtil?.kanaToRomaji ?? ((s: string) => s);
  let rom = baseReading ? kanaToRomaji(baseReading, system) : "";
  if (sokuon) {
    let initial = "";
    if (nextSpan) {
      const nextToks = await tokenize(nextSpan.trim());
      const nextReading = nextToks.map(t => t.pronunciation || t.reading || t.surface_form).join("").replace(/[っッ]$/, "");
      const nextRom = nextReading ? kanaToRomaji(nextReading, system) : "";
      initial = nextRom.charAt(0);
    }
    if (!/[bcdfghjklmnpqrstvwxyz]/i.test(initial)) initial = "t";
    rom = rom + initial;
  }
  return rom;
}

/**
 * Romanize a full Japanese line using Kuromoji tokens, with natural word spacing.
 */
async function romanizeLineText(text: string, system: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (!hasJapanese(trimmed)) return trimmed;
  const cacheKey = `${system}\u0000${trimmed}`;
  const cached = lineCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const tokens = await tokenize(trimmed);
  cachedUtil = kuroshiroClass?.Util as any;
  const kanaToRomaji = cachedUtil?.kanaToRomaji ?? ((s: string) => s);

  interface Group { reading: string; hasJp: boolean; }
  const groups: Group[] = [];
  let current: Group = { reading: "", hasJp: false };
  let prevToken: KuromojiToken | null = null;

  const flush = () => {
    if (current.reading.length > 0 || current.hasJp) {
      groups.push(current);
      current = { reading: "", hasJp: false };
    }
  };

  for (const token of tokens) {
    if (token.surface_form.trim() === "") {
      flush();
      prevToken = null;
      continue;
    }
    const attach = attachesToPrevious(token, prevToken);
    if (!attach && (current.reading.length > 0 || current.hasJp)) {
      flush();
    }
    const reading = token.pronunciation || token.reading || token.surface_form;
    if (hasJapanese(token.surface_form)) {
      current.reading += reading;
      current.hasJp = true;
    } else {
      if (current.reading.length > 0 || current.hasJp) {
        current.reading += token.surface_form;
      } else {
        groups.push({ reading: token.surface_form, hasJp: false });
        current = { reading: "", hasJp: false };
      }
    }
    prevToken = token;
  }
  flush();

  const converted = groups.map(group =>
    group.hasJp ? kanaToRomaji(group.reading, system) : group.reading
  );
  const result = converted.join(" ").replace(/\s+/g, " ").trim();
  lineCache.set(cacheKey, result);
  return result;
}

/**
 * Romanize a Japanese line and optionally align to source spans.
 */
export async function romanizeJapanese(
  input: string | string[],
  spansOrOptions?: string[] | JapaneseRomanizationOptions,
  options?: JapaneseRomanizationOptions
): Promise<string | JapaneseRomanizationResult | string[]>;
export async function romanizeJapanese(...args: any[]): Promise<any> {
  const system = systemName(
    (typeof args[args.length - 1] === "object" && args[args.length - 1] && "system" in args[args.length - 1]
      ? args[args.length - 1].system
      : undefined) as any
  );

  // Array input.
  if (Array.isArray(args[0])) {
    const texts = args[0] as string[];
    const opts = (args[1] ?? {}) as JapaneseRomanizationOptions;
    const sys = systemName(opts.system);
    const results: string[] = [];
    for (const line of texts) {
      results.push(await romanizeLineText(line, sys));
    }
    return results;
  }

  const text = String(args[0] ?? "");
  // Determine if spans provided.
  let spans: string[] | undefined;
  let options: JapaneseRomanizationOptions | undefined;
  if (Array.isArray(args[1])) {
    spans = args[1] as string[];
    options = args[2] as JapaneseRomanizationOptions | undefined;
  } else if (args[1] && typeof args[1] === "object" && !Array.isArray(args[1])) {
    // Could be options or spans? If it has text/words? Treat as options.
    options = args[1] as JapaneseRomanizationOptions;
  }
  const sys = systemName(options?.system ?? (system as any));

  const lineText = await romanizeLineText(text, sys);

  if (!spans) {
    // If called with (text, options) return string.
    if (options || (args[1] && typeof args[1] === "object" && !Array.isArray(args[1]))) {
      return lineText;
    }
    // Default single string call.
    return lineText;
  }

  // Align to spans.
  const nonSpaceSpans = spans.filter(s => s.trim().length > 0);
  const words: string[] = [];
  for (let i = 0; i < nonSpaceSpans.length; i++) {
    words.push(await romanizeSpan(nonSpaceSpans[i], nonSpaceSpans[i + 1], sys));
  }
  return { text: lineText, words: words.length ? words : null };
}

// Convenience aliases.
export const romanizeJapaneseText = romanizeJapanese;
export const toRomaji = romanizeJapanese;
export const japaneseToRomaji = romanizeJapanese;
export const convertToRomaji = romanizeJapanese;
export const romanize = romanizeJapanese;
export const romanizeLine = romanizeJapanese;
export const romanizeJapaneseLine = romanizeJapanese;

export default romanizeJapanese;

// Also expose a batch helper.
export async function romanizeJapaneseBatch(
  lines: string[],
  options?: JapaneseRomanizationOptions
): Promise<string[]> {
  return romanizeJapanese(lines, options ?? {}) as Promise<string[]>;
}
export const batchRomanizeJapanese = romanizeJapaneseBatch;
export const romanizeBatchJapanese = romanizeJapaneseBatch;
