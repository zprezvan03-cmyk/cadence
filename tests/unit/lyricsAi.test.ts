import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { getThinkingCapabilities, listModels, testConnection, transformLyrics, clearAiCache, initializeAiCache, LyricsAiError } from "../../src/main/lyrics/ai";
import { setRuntimeFetch } from "../../src/main/lyrics/http";
import type { LyricsAiConfig } from "../../src/shared/types";
import { applyRomanization, applyTranslations, parseLyricsText } from "../../src/renderer/features/lyrics/parseLyrics";

const native: LyricsAiConfig = { enabled:true,protocol:"ollama-native",baseUrl:"http://localhost:11434",chatPath:"/api/chat",modelsPath:"/api/tags",apiKey:"",model:"qwen2.5",temperature:.1,maxOutputTokens:1000,timeoutMs:30000,thinkingMode:"auto",romanizationStandard:"Hepburn",customHeaders:"{}" };
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
  it("discovers model thinking modes and sends the selected Ollama think value for every supported mode", async () => {
    const requests: { path: string; body: any }[] = [];
    const server = createServer((req, res) => {
      let text = ""; req.setEncoding("utf8"); req.on("data", chunk => { text += chunk; });
      req.on("end", () => {
        const body = JSON.parse(text); requests.push({ path: req.url ?? "", body });
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/show") res.end(JSON.stringify({ model_info: { thinking: { values: [false, "low", "medium", "high", "xhigh"], default: "medium" } } }));
        else res.end(JSON.stringify({ message: { content: '{"results":[{"id":"L0","text":"result"}]}' } }));
      });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No test server address");
    const config = { ...native, baseUrl: `http://127.0.0.1:${address.port}`, model: "thinking-test" };
    setRuntimeFetch(globalThis.fetch as typeof globalThis.fetch);
    try {
      const capabilities = await getThinkingCapabilities(config, true);
      expect(capabilities).toMatchObject({ modes: ["off", "low", "medium", "high", "maximum", "auto"], defaultMode: "medium", metadataAvailable: true });
      for (const mode of capabilities.modes) {
        await transformLyrics("romanization", { ...config, thinkingMode: mode }, ["君は"], "", "ja");
      }
      await transformLyrics("translation", { ...config, thinkingMode: "low" }, ["愛してる"], "en", "ja");
      const chatRequests = requests.filter(request => request.path === "/api/chat");
      expect(requests.filter(request => request.path === "/api/show")).toHaveLength(1);
      expect(chatRequests.map(request => request.body.think)).toEqual([false, "low", "medium", "high", "xhigh", undefined, "low"]);
      expect(Object.hasOwn(chatRequests[5].body, "think")).toBe(false);
      expect(chatRequests[6].body.think).toBe("low");
    } finally { server.close(); await once(server, "close"); }
  });
  it("keeps unsupported or missing model metadata explicit and never sends stale thinking settings", async () => {
    const calls: { url: string; body: any }[] = [];
    setRuntimeFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body });
      return url.endsWith("/api/show")
        ? response(body.model === "limited" ? { thinking: { values: ["low"], default: "low" } } : { details: "no thinking metadata" })
        : ollamaContent('{"results":[{"id":"L0","text":"result"}]}');
    });
    const limited = { ...native, model: "limited" };
    const capabilities = await getThinkingCapabilities(limited, true);
    expect(capabilities.modes).toEqual(["low", "auto"]);
    await transformLyrics("romanization", { ...limited, thinkingMode: "high" }, ["君"], "", "ja");
    const chat = calls.find(call => call.url.endsWith("/api/chat"));
    expect(chat).toBeDefined();
    expect(Object.hasOwn(chat!.body, "think")).toBe(false);
    const missing = await getThinkingCapabilities({ ...native, model: "no-metadata" }, true);
    expect(missing).toMatchObject({ modes: ["auto"], metadataAvailable: false });
    expect(missing.detail).toContain("did not report");
  });
  it("sends timestamp-free timed span context through Cerebras OpenAI-compatible API and maps shuffled IDs", async () => {
    let systemPrompt = "";
    let requestedUrl = "";
    const cerebras = { ...compatible, baseUrl: "https://api.cerebras.ai/v1", model: "llama3.1-8b" };
    setRuntimeFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      const body = JSON.parse(String(init?.body));
      systemPrompt = body.messages[0].content;
      return openAiContent(JSON.stringify({ results: [
        { id: "line-0-span-1", text: "no hana" },
        { id: "line-0-span-0", text: "sakura" },
      ] }));
    });
    const result = await transformLyrics(
      "romanization",
      cerebras,
      ["桜", "の花"],
      "",
      "ja",
      undefined,
      false,
      ["line-0-span-0", "line-0-span-1"],
      ["桜の花"],
      [{ lineId: "line-0", lineText: "桜の花", spans: [
        { id: "line-0-span-0", text: "桜" },
        { id: "line-0-span-1", text: "の花" },
      ] }],
    );
    expect(requestedUrl).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(systemPrompt).toContain('"lineText":"桜の花"');
    expect(systemPrompt).toContain('"text":"桜"');
    expect(systemPrompt).not.toContain("startTimeMs");
    expect(systemPrompt).not.toContain("durationMs");
    expect(result.results).toEqual(["sakura", "no hana"]);
  });

  it("maps every OpenAI-compatible mode to OpenAI reasoning_effort and verifies outgoing payloads", async () => {
    const config = { ...compatible, baseUrl: "https://api.openai.com/v1", model: "gpt-5.2" };
    const capabilities = await getThinkingCapabilities(config, true);
    expect(capabilities.modes).toEqual(["off", "low", "medium", "high", "maximum", "auto"]);
    const bodies: Record<string, unknown>[] = [];
    setRuntimeFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return openAiContent('{"results":[{"id":"L0","text":"ok"}]}');
    });
    for (const mode of ["auto", "off", "low", "medium", "high", "maximum"] as const) {
      await transformLyrics("translation", { ...config, thinkingMode: mode }, ["愛してる"], "en", "ja");
    }
    expect(bodies.map(body => body.reasoning_effort)).toEqual([undefined, "none", "low", "medium", "high", "xhigh"]);
    expect(bodies.every(body => body.stream === false)).toBe(true);
    expect(Object.hasOwn(bodies[0], "reasoning_effort")).toBe(false);
  });
  it("uses Cerebras model-specific effort values and leaves unknown models in provider Auto mode", async () => {
    const cerebras = { ...compatible, baseUrl: "https://api.cerebras.ai/v1", model: "kimi-k3" };
    const capabilities = await getThinkingCapabilities(cerebras, true);
    expect(capabilities.modes).toEqual(["low", "high", "maximum", "auto"]);
    const bodies: Record<string, unknown>[] = [];
    setRuntimeFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return openAiContent('{"results":[{"id":"L0","text":"ok"}]}');
    });
    for (const mode of ["low", "high", "maximum"] as const)
      await transformLyrics("romanization", { ...cerebras, thinkingMode: mode }, ["君"], "", "ja");
    await transformLyrics("romanization", { ...cerebras, model: "unknown-reasoner", thinkingMode: "maximum" }, ["君"], "", "ja");
    expect(bodies.map(body => body.reasoning_effort)).toEqual(["low", "high", "max", undefined]);
    expect(Object.hasOwn(bodies[3], "reasoning_effort")).toBe(false);
    const qwen = { ...cerebras, model: "qwen-3.8-27b" };
    expect((await getThinkingCapabilities(qwen, true)).modes).toEqual(["off", "low", "medium", "high", "auto"]);
    for (const mode of ["off", "low", "medium", "high"] as const)
      await transformLyrics("romanization", { ...qwen, thinkingMode: mode }, ["君"], "", "ja");
    expect(bodies.slice(4).map(body => body.reasoning_effort)).toEqual(["none", "low", "medium", "high"]);
  });
  it("does not send OpenAI parameters to Ollama's OpenAI-compatible API or unknown compatible services", async () => {
    const ollamaCompatible = { ...compatible, baseUrl: "http://localhost:11434/v1", thinkingMode: "high" as const };
    expect((await getThinkingCapabilities(ollamaCompatible, true)).modes).toEqual(["auto"]);
    const generic = { ...compatible, baseUrl: "https://proxy.example.test/v1", model: "reasoner", thinkingMode: "high" as const };
    expect((await getThinkingCapabilities(generic, true)).modes).toEqual(["auto"]);
    const bodies: Record<string, unknown>[] = [];
    setRuntimeFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return openAiContent('{"results":[{"id":"L0","text":"ok"}]}');
    });
    await transformLyrics("translation", ollamaCompatible, ["hello"], "fr", "en");
    await transformLyrics("translation", generic, ["hello"], "fr", "en");
    expect(bodies.every(body => !Object.hasOwn(body, "reasoning_effort"))).toBe(true);
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
