import { useState } from "react";
import type { LyricsAiConfig, LyricsSettings } from "../../../shared/types";
import { bridge } from "../../state/bridge";
import { TRANSLATION_LANGUAGES } from "../lyrics/translationLanguages";

type Kind = "translation" | "romanization";
const EMPTY = { status: "" as string, error: false };
export function LyricsAiSettings({ settings, onChange }: { settings: LyricsSettings; onChange: (patch: Partial<LyricsSettings>) => void }) {
  return <>
    <AiPanel kind="translation" title="AI Translation" config={settings.aiTranslation} onChange={config => onChange({ aiTranslation: config })} />
    <AiPanel kind="romanization" title="AI Romanization" config={settings.aiRomanization} onChange={config => onChange({ aiRomanization: config })} />
  </>;
}
function AiPanel({ kind, title, config, onChange }: { kind: Kind; title: string; config: LyricsAiConfig; onChange: (config: LyricsAiConfig) => void }) {
  const [models, setModels] = useState<{id:string;name:string}[]>([]);
  const [status, setStatus] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const patch = (value: Partial<LyricsAiConfig>) => onChange({ ...config, ...value });
  const setProtocol = (protocol: LyricsAiConfig["protocol"]) => patch(protocol === "ollama-native"
    ? { protocol, baseUrl: "http://localhost:11434", chatPath: "/api/chat", modelsPath: "/api/tags", apiKey: "" }
    : { protocol, baseUrl: "http://localhost:11434/v1", chatPath: "/chat/completions", modelsPath: "/models" });
  const invoke = async (action: "models" | "test") => {
    setBusy(true); setStatus({ status: "Connecting…", error: false });
    try {
      const result = action === "models" ? await bridge.lyrics.aiModels(kind) : await bridge.lyrics.aiTestConnection(kind);
      if (action === "models") { setModels(result as {id:string;name:string}[]); setStatus({status:`${(result as unknown[]).length} models found.`, error:false}); }
      else setStatus({status:result as string,error:false});
    } catch (error) {
      // Provider error messages are intentionally sanitized by the main-process adapter; never echo config headers or keys.
      setStatus({status:error instanceof Error ? error.message : String(error),error:true});
    } finally { setBusy(false); }
  };
  return <section className="settings-section lyrics-ai-section">
    <h3>{title}</h3>
    <label className="setting-row"><span><strong>Enable {kind === "translation" ? "AI translation" : "AI romanization"}</strong><em>Uses this feature's own provider and model configuration.</em></span><input type="checkbox" checked={config.enabled} onChange={event => patch({enabled:event.target.checked})}/></label>
    <div className="setting-row"><span><strong>API protocol</strong><em>Native Ollama and OpenAI-compatible services use separate request formats.</em></span><select value={config.protocol} onChange={event => setProtocol(event.target.value as LyricsAiConfig["protocol"])}><option value="ollama-native">Ollama native API</option><option value="openai-compatible">OpenAI-compatible API</option></select></div>
    <label className="setting-row"><span><strong>Base URL</strong></span><input type="url" value={config.baseUrl} onChange={event => patch({baseUrl:event.target.value})} placeholder="http://localhost:11434/v1"/></label>
    <label className="setting-row"><span><strong>Chat endpoint path</strong></span><input value={config.chatPath} onChange={event => patch({chatPath:event.target.value})} placeholder="/chat/completions"/></label>
    <label className="setting-row"><span><strong>Models endpoint path</strong><em>Used for model discovery when supported.</em></span><input value={config.modelsPath} onChange={event => patch({modelsPath:event.target.value})}/></label>
    {config.protocol !== "ollama-native" ? <label className="setting-row"><span><strong>API key</strong><em>Optional for local endpoints; stored in Cadence settings and never logged.</em></span><input type="password" autoComplete="new-password" value={config.apiKey} onChange={event => patch({apiKey:event.target.value})} placeholder="Optional bearer token"/></label> : null}
    <label className="setting-row"><span><strong>Model</strong><em>Discover installed models or enter an identifier.</em></span><span className="ai-model-control"><input list={`ai-models-${kind}`} value={config.model} onChange={event => patch({model:event.target.value})} placeholder="e.g. qwen2.5"/><datalist id={`ai-models-${kind}`}>{models.map(model => <option key={model.id} value={model.id}/>)}</datalist><button type="button" disabled={busy || !config.modelsPath} onClick={() => void invoke("models")}>Models</button></span></label>
    {kind === "translation" ? <div className="setting-row"><span><strong>Target language</strong></span><select value={config.targetLanguage ?? "en"} onChange={event => patch({targetLanguage:event.target.value})}>{TRANSLATION_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}</select></div> : <div className="setting-row"><span><strong>Romanization standard</strong></span><select value={config.romanizationStandard ?? "auto"} onChange={event => patch({romanizationStandard:event.target.value})}><option value="auto">Automatic by language</option><option value="Hepburn romanization">Japanese — Hepburn</option><option value="Revised Romanization of Korean">Korean — Revised Romanization</option><option value="Hanyu Pinyin with tone marks where natural">Chinese — Hanyu Pinyin</option><option value="BGN/PCGN Russian transliteration">Russian — BGN/PCGN</option><option value="DIN 31635 Arabic romanization">Arabic — DIN 31635</option></select></div>}
    <label className="setting-row"><span><strong>Temperature</strong></span><input type="number" min="0" max="2" step="0.05" value={config.temperature} onChange={event => patch({temperature:Number(event.target.value)})}/></label>
    <label className="setting-row"><span><strong>Maximum output tokens</strong></span><input type="number" min="1" max="32768" step="256" value={config.maxOutputTokens} onChange={event => patch({maxOutputTokens:Number(event.target.value)})}/></label>
    <label className="setting-row"><span><strong>Request timeout</strong></span><span className="ai-timeout-control"><input type="number" min="1" max="300" value={Math.round(config.timeoutMs/1000)} onChange={event => patch({timeoutMs:Number(event.target.value)*1000})}/><span>seconds</span></span></label>
    <label className="setting-row"><span><strong>Custom headers</strong><em>Optional JSON object; Authorization/Host are controlled separately.</em></span><input value={config.customHeaders} onChange={event => patch({customHeaders:event.target.value})} placeholder="{}"/></label>
    <div className="setting-row"><span><strong>Connection</strong><em className={status.error ? "error-text" : "muted"}>{status.status || "Test the configured endpoint and model."}</em></span><button type="button" disabled={busy} onClick={() => void invoke("test")}>Test connection</button></div>
  </section>;
}
