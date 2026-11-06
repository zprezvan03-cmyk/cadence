import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { listModels, testConnection, transformLyrics, clearAiCache, initializeAiCache, LyricsAiError } from "../../src/main/lyrics/ai";
import { setRuntimeFetch } from "../../src/main/lyrics/http";
import type { LyricsAiConfig } from "../../src/shared/types";
import { applyRomanization, applyTranslations, parseLyricsText } from "../../src/renderer/features/lyrics/parseLyrics";

const native: LyricsAiConfig = { enabled:true,protocol:"ollama-native",baseUrl:"http://localhost:11434",chatPath:"/api/chat",modelsPath:"/api/tags",apiKey:"",model:"qwen2.5",temperature:.1,maxOutputTokens:1000,timeoutMs:30000,romanizationStandard:"Hepburn",customHeaders:"{}" };
const compatible: LyricsAiConfig = { ...native,protocol:"openai-compatible",baseUrl:"http://127.0.0.1:1234/v1",chatPath:"/chat/completions",modelsPath:"/models" };
const response = (body: unknown) => new Response(JSON.stringify(body), {status:200,headers:{"Content-Type":"application/json"}});
const ollamaContent = (text: string) => response({message:{content:text}});
const LYRIC_LINES = `[1000,1500]First(1000,700) line(1700,800)\n[3000,1800]Second(3000,800) line(3800,1000)`;
const openAiContent = (text: string) => response({choices:[{message:{content:text}}]});

afterEach(async () => { setRuntimeFetch((...args) => globalThis.fetch(...args)); await clearAiCache(); vi.restoreAllMocks(); });
describe("central lyrics AI adapters", () => {
  it("speaks native Ollama API, enforces mapped segment JSON and caches validated output", async () => {
    const fetch = vi.fn(async (input: RequestInfo|URL, init?:RequestInit) => {
      expect(String(input)).toBe("http://localhost:11434/api/chat");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("qwen2.5"); expect(body.stream).toBe(false); expect(body.format).toBe("json");
      expect(body.options.temperature).toBe(.1);
      return ollamaContent('{"results":[{"id":"L0","text":"kimiwa"}]}');
    });
    setRuntimeFetch(fetch as typeof globalThis.fetch);
    const first = await transformLyrics("romanization",native,["君は"],"", "ja");
    const cached = await transformLyrics("romanization",native,["君は"],"", "ja");
    expect(first.results).toEqual(["kimiwa"]); expect(cached.results).toEqual(first.results); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("persists validated derived results and restores them without a request", async () => {
    let saved = "";
    initializeAiCache(null, json => { saved = json; });
    setRuntimeFetch(async () => ollamaContent('{"results":[{"id":"line-4","text":"kimi"}]}'));
    await transformLyrics("romanization",native,["君"],"","ja",undefined,false,["line-4"],["君","が好き"]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(saved).version).toBe(1);
    initializeAiCache(saved);
    const fetch = vi.fn(); setRuntimeFetch(fetch as typeof globalThis.fetch);
    const cached = await transformLyrics("romanization",native,["君"],"","ja",undefined,false,["line-4"],["君","が好き"]);
    expect(cached.results).toEqual(["kimi"]); expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the OpenAI-compatible request/response schema and API key header", async () => {
    const config = {...compatible,apiKey:"secret-test-key"};
    const fetch = vi.fn(async (_input:RequestInfo|URL, init?:RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-test-key");
      const body = JSON.parse(String(init?.body)); expect(body.response_format.type).toBe("json_object");
      return openAiContent('{"results":[{"id":"L0","text":"Hello, my love"}]}');
    });
    setRuntimeFetch(fetch as typeof globalThis.fetch);
    const result = await transformLyrics("translation",config,["愛しい人"],"en","ja");
    expect(result.results).toEqual(["Hello, my love"]);
  });
  it("keeps translation and romanization caches isolated across model changes", async () => {
    let calls = 0;
    setRuntimeFetch(async (_input:RequestInfo|URL, init?:RequestInit) => {
      calls += 1; const body = JSON.parse(String(init?.body));
      return openAiContent(JSON.stringify({results:[{id:"L0",text:body.messages[0].content.includes("Romanize") ? "aishiteru" : "I love you"}]}));
    });
    const romanizer = {...compatible,model:"roman-model"};
    const translator = {...compatible,model:"translate-model"};
    await transformLyrics("romanization",romanizer,["愛してる"],"","ja");
    await transformLyrics("translation",translator,["愛してる"],"en","ja");
    await transformLyrics("romanization",romanizer,["愛してる"],"","ja");
    await transformLyrics("translation",{...translator,model:"translate-model-2"},["愛してる"],"en","ja");
    expect(calls).toBe(3);
  });
  it("supports Ollama OpenAI-compatible base URL and chat completion path", async () => {
    const ollamaCompatible = {...compatible,baseUrl:"http://localhost:11434/v1"};
    const fetch = vi.fn(async (input:RequestInfo|URL) => {
      expect(String(input)).toBe("http://localhost:11434/v1/chat/completions");
      return openAiContent('{"results":[{"id":"L0","text":"Hello"}]}');
    });
    setRuntimeFetch(fetch as typeof globalThis.fetch);
    expect((await transformLyrics("translation",ollamaCompatible,["こんにちは"],"en","ja")).results).toEqual(["Hello"]);
  });
  it("supports Ollama and OpenAI-compatible model discovery formats", async () => {
    const fetch = vi.fn(async (input:RequestInfo|URL) => String(input).endsWith("/api/tags")
      ? response({models:[{name:"qwen:latest"}]})
      : response({data:[{id:"local-model"}]}));
    setRuntimeFetch(fetch as typeof globalThis.fetch);
    expect((await listModels(native))[0].id).toBe("qwen:latest");
    expect((await listModels(compatible))[0].id).toBe("local-model");
    expect(fetch.mock.calls.map(call => String(call[0]))).toEqual(["http://localhost:11434/api/tags","http://127.0.0.1:1234/v1/models"]);
  });
  it("classifies connection and timeout failures with actionable messages", async () => {
    setRuntimeFetch(async () => { throw new TypeError("offline"); });
    await expect(listModels(native)).rejects.toMatchObject({code:"connection"});
    setRuntimeFetch(async () => { throw new DOMException("timed out","TimeoutError"); });
    await expect(listModels(native)).rejects.toMatchObject({code:"timeout"});
  });
  it("tests a native Ollama connection without requiring an API key", async () => {
    setRuntimeFetch(async () => response({models:[{name:"qwen2.5"}]}));
    expect(await testConnection(native)).toContain("installed");
  });
  it("reports auth, missing models, malformed structure and duplicate IDs without applying partial text", async () => {
    setRuntimeFetch(async () => new Response("Unauthorized",{status:401}));
    await expect(listModels(compatible)).rejects.toMatchObject({code:"authentication"});
    setRuntimeFetch(async () => ollamaContent('{"results":[{"id":"L0","text":"x"},{"id":"L0","text":"y"}]}'));
    await expect(transformLyrics("translation",native,["hello world","where are you"],"fr","en")).rejects.toBeInstanceOf(LyricsAiError);
    setRuntimeFetch(async () => ollamaContent("not json"));
    await expect(transformLyrics("translation",native,["hello world","where are you"],"fr","en")).rejects.toMatchObject({code:"response"});
  });
  it("does not call any AI provider when source and target languages already match", async () => {
    const fetch = vi.fn(); setRuntimeFetch(fetch as typeof globalThis.fetch);
    const result = await transformLyrics("translation",compatible,["Hello my love"],"en","en");
    expect(result.results).toEqual([null]); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects endpoints containing embedded credentials and invalid custom-header JSON", async () => {
    await expect(listModels({...native,baseUrl:"http://user:pass@localhost:11434"})).rejects.toMatchObject({code:"configuration"});
    await expect(listModels({...native,customHeaders:"not json"})).rejects.toMatchObject({code:"configuration"});
  });
  it("round-trips both wire protocols against a real local HTTP endpoint", async () => {
    const requests: {path:string;body:any;authorization:string|null}[] = [];
    const server = createServer((req,res) => {
      let text = ""; req.setEncoding("utf8"); req.on("data",chunk => { text += chunk; });
      req.on("end",() => {
        const body = JSON.parse(text); requests.push({path:req.url ?? "",body,authorization:req.headers.authorization ?? null});
        res.setHeader("Content-Type","application/json");
        if (req.url === "/api/chat") res.end(JSON.stringify({message:{content:'{"results":[{"id":"line-2","text":"kimiwa"}]}'}}));
        else res.end(JSON.stringify({choices:[{message:{content:'{"results":[{"id":"line-3","text":"You are my love"}]}'}}]}));
      });
    });
    server.listen(0,"127.0.0.1"); await once(server,"listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No test server address");
    setRuntimeFetch(globalThis.fetch as typeof globalThis.fetch);
    try {
      await transformLyrics("romanization",{...native,baseUrl:`http://127.0.0.1:${address.port}`},["君は"],"","ja",undefined,false,["line-2"],["君は","愛している"]);
      await transformLyrics("translation",{...compatible,baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:"local-secret"},["愛してる"],"en","ja",undefined,false,["line-3"],["愛してる"]);
      expect(requests.map(item => item.path)).toEqual(["/api/chat","/v1/chat/completions"]);
      expect(requests[0].body.options.num_predict).toBe(1000);
      expect(requests[1].body.model).toBe("qwen2.5");
      expect(requests[1].authorization).toBe("Bearer local-secret");
    } finally { server.close(); await once(server,"close"); }
  });
  it("merges only derived text and leaves rich word timings and source payload untouched", async () => {
    const parsed = parseLyricsText(LYRIC_LINES, 6000);
    const original = structuredClone(parsed.lyrics);
    const parts = parsed.lyrics.map(line => line.parts?.map(part => part.startTimeMs));
    const decorated = applyTranslations(parsed.lyrics, ["Translated first", "Translated second"], "en");
    const withRomanization = applyRomanization(decorated, ["First", "Second"]);
    expect(parsed.lyrics).toEqual(original);
    expect(withRomanization.map(line => line.startTimeMs)).toEqual(original.map(line => line.startTimeMs));
    expect(withRomanization.map(line => line.parts?.map(part => part.startTimeMs))).toEqual(parts);
    expect(withRomanization.map(line => line.translation?.text)).toEqual(["Translated first", "Translated second"]);
  });
});
