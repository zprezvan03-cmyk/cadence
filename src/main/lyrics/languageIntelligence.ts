/** Deterministic, offline lyrics language/script heuristics. Script is never treated as language. */
export type LyricsScript = "Japanese" | "Latin" | "Han" | "Hiragana" | "Katakana" | "Hangul" | "Cyrillic" | "Arabic" | "Devanagari" | "Greek" | "Hebrew" | "Thai" | "Other" | "Unknown";
export type LyricsLanguage = string;
export interface LanguageAnalysis {
  language: LyricsLanguage;
  script: LyricsScript;
  confidence: number;
  mixed: boolean;
  romanizationLikelyNeeded: boolean;
  lineLanguages: LyricsLanguage[];
}

import { detectNonLatinLanguage } from "@braccato/core/text";

const scriptMatchers: [LyricsScript, RegExp][] = [
  ["Greek", /\p{Script=Greek}/u], ["Hebrew", /\p{Script=Hebrew}/u], ["Thai", /\p{Script=Thai}/u],
  ["Hiragana", /\p{Script=Hiragana}/u], ["Katakana", /\p{Script=Katakana}/u],
  ["Hangul", /\p{Script=Hangul}/u], ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Arabic", /\p{Script=Arabic}/u], ["Devanagari", /\p{Script=Devanagari}/u],
  ["Han", /\p{Script=Han}/u], ["Latin", /\p{Script=Latin}/u],
];
const englishWords = new Set("the and you your are was were with this that for not love my me we i to of in on it is be have do will can no yes oh yeah baby heart night day when what where how if but so all one never ever like know want feel got get here there".split(" "));
const japaneseRomaji = new Set("watashi anata kimi boku sore kore yume kokoro ai arigatou sayonara kimi wa ga no ni wo desu masu da yo ne hana hikari sekai namida kaze tsuki hoshi".split(" "));
const markers = /^(?:\s*[♪♫♬]+\s*|\s*\[(?:instrumental|music|intro|outro|chorus|verse)\]\s*)$/i;

export function scriptOf(text: string): LyricsScript {
  const counts = new Map<LyricsScript, number>();
  for (const ch of text) {
    if (/\p{Letter}/u.test(ch)) {
      const found = scriptMatchers.find(([, re]) => re.test(ch))?.[0] ?? "Other";
      counts.set(found, (counts.get(found) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Unknown";
}
function latinLanguage(text: string): { language: LyricsLanguage; confidence: number } {
  const words = text.toLocaleLowerCase().match(/[a-z]+/g) ?? [];
  if (!words.length) return { language: "und", confidence: 0 };
  const ja = words.filter(word => japaneseRomaji.has(word)).length;
  const en = words.filter(word => englishWords.has(word)).length;
  if (ja >= 2 && ja >= en * 1.4) return { language: "ja-Latn", confidence: Math.min(.96, .62 + ja / words.length * .34) };
  if (words.length >= 2 && en >= 2)
    return { language: "en", confidence: Math.min(.96, .55 + en / words.length * .4) };
  return { language: "und", confidence: .25 };
}
export function analyzeLyrics(textOrLines: string | readonly string[]): LanguageAnalysis {
  const lines = (typeof textOrLines === "string" ? textOrLines.split(/\r?\n/) : [...textOrLines])
    .map(s => s.trim()).filter(s => s && !markers.test(s));
  const lineLanguages: LyricsLanguage[] = [];
  const weights = new Map<LyricsLanguage, number>();
  const scripts = new Map<LyricsScript, number>();
  let confidenceWeighted = 0, totalWeight = 0;
  for (const line of lines) {
    const script = scriptOf(line);
    if (script === "Unknown") continue;
    const letters = [...line].filter(ch => /\p{Letter}/u.test(ch)).length;
    scripts.set(script, (scripts.get(script) ?? 0) + letters);
    let language: LyricsLanguage = "und", confidence = .4;
    const localNonLatinLanguage = script !== "Latin" && script !== "Han" ? detectNonLatinLanguage(line) : null;
    if (script === "Hiragana" || script === "Katakana") { language = "ja"; confidence = .99; }
    else if (script === "Hangul") { language = "ko"; confidence = .99; }
    else if (["Cyrillic","Arabic","Devanagari","Greek","Hebrew","Thai","Other"].includes(script)) {
      language = localNonLatinLanguage || "und"; confidence = localNonLatinLanguage ? .82 : .35;
    }
    else if (script === "Han") {
      const hasJapaneseContext = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(textOrLines instanceof Array ? textOrLines.join(" ") : textOrLines);
      language = hasJapaneseContext ? "ja" : "zh";
      confidence = hasJapaneseContext ? .9 : .55; // Han alone is genuinely ambiguous.
    } else if (script === "Latin") ({ language, confidence } = latinLanguage(line));
    lineLanguages.push(language);
    const weight = Math.sqrt(Math.max(1, letters));
    weights.set(language, (weights.get(language) ?? 0) + weight * confidence);
    confidenceWeighted += weight * confidence;
    totalWeight += weight;
  }
  const ranked = [...weights].filter(([lang]) => lang !== "und").sort((a,b) => b[1]-a[1]);
  const language = ranked[0]?.[0] ?? "und";
  const different = ranked.filter(([, score]) => score >= ranked[0]?.[1] * .22).length;
  const allText = typeof textOrLines === "string" ? textOrLines : textOrLines.join(" ");
  const hasJapaneseKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(allText);
  const dominantScript = hasJapaneseKana ? "Japanese" : ([...scripts].sort((a,b) => b[1]-a[1])[0]?.[0] ?? "Unknown");
  const confidence = totalWeight ? Math.min(.99, (confidenceWeighted / totalWeight) * (ranked[0]?.[1] ? Math.min(1, ranked[0][1] / (ranked[1]?.[1] ?? ranked[0][1])) : .5)) : 0;
  const needs = ["ja","ko","zh","ru","ar"].includes(language) && dominantScript !== "Latin";
  return { language, script: dominantScript, confidence: Math.round(confidence * 100) / 100, mixed: different > 1, romanizationLikelyNeeded: needs, lineLanguages };
}
