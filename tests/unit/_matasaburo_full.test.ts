import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { transformLyrics, clearAiCache } from "../../src/main/lyrics/ai";
import { parseLyricsText, lyricLines, buildTimedRomanization } from "../../src/renderer/features/lyrics/parseLyrics";
import type { LyricsAiConfig } from "../../src/shared/types";

const key = readFileSync(String.raw`C:\Users\Tyas\Documents\api-keys\Cerebras API key.txt`, "utf8")
  .split(/\r?\n/)[1].trim();

const config: LyricsAiConfig = {
  enabled: true,
  protocol: "openai-compatible",
  baseUrl: "https://api.cerebras.ai/v1",
  chatPath: "/chat/completions",
  modelsPath: "/models",
  apiKey: key,
  model: "gpt-oss-120b",
  temperature: 0.2,
  maxOutputTokens: 8192,
  timeoutMs: 180000,
  targetLanguage: "en",
  romanizationStandard: "auto",
  customHeaders: "{}",
};

const file = String.raw`C:\Users\Tyas\Music\ALAC-Lossless\Yorushika\Matasaburo - Single\01 Matasaburo.ttml`;

afterEach(async () => { await clearAiCache(); });

describe("matasaburo full", () => {
  it("prints output", async () => {
    const xml = readFileSync(file, "utf8");
    const parsed = parseLyricsText(xml, 240000);
    const allLines = lyricLines(parsed.lyrics);
    // Include the screenshot's L6, whose TTML spans split きっと and 過ぎるから.
    const wordIndexes = [1, 2, 3, 6];
    const subset = wordIndexes.map(index => allLines[index]);
    const spans = wordIndexes.map(index => parsed.lyrics[index].parts!.map(part => part.words));
    const result = await transformLyrics("romanization", config, subset, "", parsed.language || "ja", undefined, false, subset.map((_, i) => `L${i}`), spans, subset);
    const samples = subset.map((line, i) => ({
      source: line,
      text: result.results[i],
      words: result.words?.[i] ?? null,
      timed: buildTimedRomanization(parsed.lyrics[wordIndexes[i]], result.words?.[i] ?? null, result.results[i] ?? null)?.map(p => p.words) ?? null,
    }));
    const payload = { analysis: result.analysis, samples };
    writeFileSync(String.raw`C:\Users\Tyas\AppData\Local\Temp\opencode\matasaburo-full.json`, JSON.stringify(payload, null, 2), "utf8");
    console.log(JSON.stringify(payload, null, 2));
    expect(result.results.length).toBe(subset.length);
    expect(samples.find(sample => sample.source === "何もない生活はきっと退屈過ぎるから")?.timed?.join("")).toBe("nanimonai seikatsu wa kitto taikutsu sugirukara");
  }, 300000);
});
