import { afterEach, describe, expect, it, vi } from "vitest";
import { transformLyrics, clearAiCache } from "../../src/main/lyrics/ai";
import { setRuntimeFetch } from "../../src/main/lyrics/http";
import type { LyricsAiConfig } from "../../src/shared/types";

const config: LyricsAiConfig = {
  enabled: true,
  protocol: "openai-compatible",
  baseUrl: "http://127.0.0.1:1234/v1",
  chatPath: "/chat/completions",
  modelsPath: "/models",
  apiKey: "",
  model: "m",
  temperature: 0.2,
  maxOutputTokens: 100,
  timeoutMs: 1000,
  romanizationStandard: "auto",
  customHeaders: "{}",
};

afterEach(async () => { setRuntimeFetch((...args) => globalThis.fetch(...args)); await clearAiCache(); vi.restoreAllMocks(); });

describe("arabic case", () => {
  it("lowercases", async () => {
    setRuntimeFetch(async () => new Response(JSON.stringify({choices:[{message:{content:'{"results":[{"id":"L0","text":"Abc Def","words":["Abc","Def"]}]}'}}]}), {status:200,headers:{"Content-Type":"application/json"}}));
    const result = await transformLyrics("romanization", config, ["مرحبا"], "", "ar", undefined, false, ["L0"], undefined, ["مرحبا"]);
    console.log("result", JSON.stringify(result));
    expect(result.results[0]).toBe("abc def");
    expect(result.words?.[0]).toEqual(["abc","def"]);
  });
});