/**
 * Settings and appearance. Written for Cadence; the shader controls mirror the Better Lyrics
 * Shaders popup (`popup/components/tabs/*`, commit d878877) one-for-one where they exist.
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, FolderMinus, FolderPlus, RotateCcw, Stethoscope, Trash2 } from "lucide-react";
import type { AppInfo, AppSettings, ShaderSettings } from "../../../shared/types";
import { FONT_KINDS, FONT_OPTIONS, resolveFontOption } from "../../../shared/fonts";
import { detectUnavailableFonts } from "../../app/fonts";
import { useLibrary } from "../../state/libraryStore";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import {
  DEFAULT_PROVIDER_ORDER,
  PROVIDER_CONFIGS,
  providerConfig,
  untoggleProvider,
} from "../../../shared/upstream/better-lyrics/constants";
import {
  activeProviderEntries,
  addProviderToOrder,
  moveProviderInOrder,
  removeProviderFromOrder,
} from "../../../shared/providerOrder";
import { THEMES } from "../../upstream/better-lyrics/themes";
import { TRANSLATION_LANGUAGES } from "../lyrics/translationLanguages";

/** Tauri's `invoke` rejects with a plain string; Error instances come from the renderer itself. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = typeof error === "string" ? error : JSON.stringify(error);
  return text && text !== "{}" ? text : "unknown error";
}

/** Human label for a sync-kind badge; keeps syllable/word/line/unsynced variants distinct. */
const SYNC_BADGE: Record<string, string> = {
  syllable: "Syllable",
  word: "Word",
  line: "Line",
  unsynced: "Unsynced",
  mixed: "Mixed",
};

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="setting-row">
      <span>
        <strong>{label}</strong>
        {hint ? <em>{hint}</em> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
    </label>
  );
}

function Range({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="setting-row range-row">
      <span>
        <strong>{label}</strong>
        {hint ? <em>{hint}</em> : null}
      </span>
      <span className="range-control">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={event => onChange(Number(event.target.value))}
        />
        <output>{format ? format(value) : value.toFixed(2)}</output>
      </span>
    </label>
  );
}

export function SettingsView() {
  const settings = useSettings(state => state.settings);
  const patchSettings = useSettings(state => state.patch);
  const resetSettings = useSettings(state => state.reset);
  const snapshot = useLibrary(state => state.snapshot);
  const addFolder = useLibrary(state => state.addFolder);
  const removeFolder = useLibrary(state => state.removeFolder);
  const rescan = useLibrary(state => state.rescan);
  const scanning = useLibrary(state => state.scanning);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [section, setSection] = useState<"library" | "playback" | "appearance" | "about">("appearance");
  const [unavailableFonts, setUnavailableFonts] = useState<ReadonlySet<string>>(() => new Set());
  const [clearingCache, setClearingCache] = useState(false);
  const showToast = useUi(state => state.showToast);
  const navigate = useUi(state => state.navigate);

  useEffect(() => {
    void window.cadence.info().then(setInfo).catch(() => undefined);
  }, []);

  // Probe once the document's faces are settled, so the picker can mark fonts this machine lacks.
  useEffect(() => {
    const probe = () => setUnavailableFonts(detectUnavailableFonts());
    probe();
    void document.fonts?.ready.then(probe).catch(() => undefined);
  }, []);

  const fontOption = resolveFontOption(settings?.appearance.fontFamily);

  if (!settings) return <div className="view-loading">Loading settings…</div>;

  const patchLyrics = (patch: Partial<AppSettings["lyrics"]>) => void patchSettings({ lyrics: patch });
  const patchShaders = (patch: Partial<ShaderSettings>) => void patchSettings({ shaders: patch });

  // Provider-order edits go through the shared helpers so a removal is persisted as an upstream
  // `d_` entry instead of being spliced out: migrateProviderOrder re-inserts missing defaults, so a
  // spliced-out provider used to come back (enabled) on the next load.
  const moveProvider = (key: string, direction: -1 | 1) =>
    patchLyrics({ providerOrder: moveProviderInOrder(settings.lyrics.providerOrder, key, direction) });
  const removeProvider = (key: string) =>
    patchLyrics({ providerOrder: removeProviderFromOrder(settings.lyrics.providerOrder, key) });
  const addProvider = (key: string) =>
    patchLyrics({ providerOrder: addProviderToOrder(settings.lyrics.providerOrder, key) });
  const restoreProviderOrder = () => patchLyrics({ providerOrder: [...DEFAULT_PROVIDER_ORDER] });
  const activeProviders = activeProviderEntries(settings.lyrics.providerOrder);
  const activeProviderKeys = new Set(activeProviders.map(untoggleProvider));
  const providerPool = PROVIDER_CONFIGS.filter(config => !activeProviderKeys.has(config.key));

  return (
    <div className="view settings-view" data-testid="settings-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Make it yours</h1>
        </div>
        <button
          type="button"
          onClick={async () => {
            await resetSettings();
            showToast("Settings restored to defaults");
          }}
        >
          <RotateCcw size={16} /> Reset all
        </button>
      </header>

      <nav className="settings-tabs">
        {([
          ["appearance", "Appearance"],
          ["library", "Library"],
          ["playback", "Playback"],
          ["about", "About"],
        ] as const).map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={section === id ? "active" : ""}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {section === "appearance" ? (
        <section className="settings-section" data-testid="settings-appearance">
          <h2>Appearance</h2>
          <div className="settings-subsection" data-testid="settings-general-appearance">
            <h3>General Appearance</h3>
            <div className="setting-row">
              <span>
                <strong>Accent colour</strong>
              </span>
              <input
                type="color"
                value={settings.appearance.accent}
                onChange={event => void patchSettings({ appearance: { accent: event.target.value } })}
              />
            </div>
            <div className="setting-row">
              <span>
                <strong>Font</strong>
                <em>
                  Used by the app and the lyrics view. Every choice falls back to a similar system font when it
                  is not installed.
                </em>
              </span>
              <select
                value={fontOption.id}
                data-testid="font-select"
                onChange={event => void patchSettings({ appearance: { fontFamily: event.target.value } })}
              >
                {FONT_KINDS.map(kind => (
                  <optgroup key={kind} label={kind}>
                    {FONT_OPTIONS.filter(option => option.kind === kind).map(option => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                        {option.probe && unavailableFonts.has(option.probe) ? " (not installed)" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <p className="font-preview" style={{ fontFamily: fontOption.stack }} data-testid="font-preview">
              The quick brown fox jumps over the lazy dog · 1, 2, 3
            </p>
            <Toggle label="Reduce motion" checked={settings.appearance.reduceMotion} onChange={value => void patchSettings({ appearance: { reduceMotion: value } })} />
            <Toggle label="Compact sidebar" checked={settings.appearance.compactSidebar} onChange={value => void patchSettings({ appearance: { compactSidebar: value } })} />
            <Toggle label="Blur artwork behind the player" checked={settings.appearance.blurArtwork} onChange={value => void patchSettings({ appearance: { blurArtwork: value } })} />
            <Toggle label="Verbose shader logs" checked={settings.advanced.showLogs} onChange={value => void patchSettings({ advanced: { showLogs: value } })} />
          </div>
          <div className="settings-subsection" data-testid="settings-lyrics">
            <h3>Lyrics</h3>
            <Toggle
              label="Fetch lyrics online"
              hint="When off, Cadence only uses sidecar files and embedded tags. Playback never needs the network."
              checked={settings.lyrics.autoFetch}
              onChange={value => patchLyrics({ autoFetch: value })}
            />
            <Toggle
              label="Romanize non-Latin lyrics"
              hint="Uses the same Google romanization path as Better Lyrics."
              checked={settings.lyrics.romanization}
              onChange={value => patchLyrics({ romanization: value })}
            />
            <Toggle
              label="Show songwriters"
              hint="Renders the credits line after the last lyric."
              checked={settings.lyrics.showCredits}
              onChange={value => patchLyrics({ showCredits: value })}
            />
            <Toggle
              label="Auto-scroll unsynced lyrics"
              checked={settings.lyrics.passiveScroll}
              onChange={value => patchLyrics({ passiveScroll: value })}
            />
            <Toggle
              label="Hide instrumental-only placeholders"
              checked={settings.lyrics.hideInstrumentalOnly}
              onChange={value => patchLyrics({ hideInstrumentalOnly: value })}
            />

            <div className="setting-row">
              <span>
                <strong>Translation language</strong>
                <em>Translated lines appear under each lyric, using the upstream batching logic.</em>
              </span>
              <select
                value={settings.lyrics.translationLanguage}
                onChange={event => patchLyrics({ translationLanguage: event.target.value })}
              >
                <option value="">Off</option>
                {TRANSLATION_LANGUAGES.map(language => (
                  <option key={language.code} value={language.code}>
                    {language.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="setting-row">
              <span>
                <strong>Theme</strong>
                <em>Default and HDR are the upstream Better Lyrics stylesheets.</em>
              </span>
              <select value={settings.lyrics.themeId} onChange={event => patchLyrics({ themeId: event.target.value })}>
                {THEMES.map(theme => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name} — {theme.author}
                  </option>
                ))}
              </select>
            </div>

            {settings.lyrics.themeId === "custom" ? (
              <label className="setting-row stacked">
                <span>
                  <strong>Custom theme CSS</strong>
                  <em>Applied to the lyrics renderer as-is. Supports the upstream `blyrics-*` settings.</em>
                </span>
                <textarea
                  rows={8}
                  spellCheck={false}
                  value={settings.lyrics.customThemeCss}
                  onChange={event => patchLyrics({ customThemeCss: event.target.value })}
                />
              </label>
            ) : null}

            <Range label="Font size" value={settings.lyrics.fontSizeRem} min={1.5} max={5.5} step={0.1} onChange={value => patchLyrics({ fontSizeRem: value })} format={value => `${value.toFixed(1)}rem`} />
            <Range label="Translation Font Size" hint="Size of the translated line beneath each lyric." value={settings.lyrics.translationFontSizePx} min={10} max={48} step={1} onChange={value => patchLyrics({ translationFontSizePx: value })} format={value => `${value} px`} />
            <Range label="Romanization Font Size" hint="Size of the romanized line beneath each lyric." value={settings.lyrics.romanizationFontSizePx} min={10} max={48} step={1} onChange={value => patchLyrics({ romanizationFontSizePx: value })} format={value => `${value} px`} />
            <Range label="Font weight" value={settings.lyrics.fontWeight} min={300} max={900} step={50} onChange={value => patchLyrics({ fontWeight: value })} format={value => String(value)} />
            <Range label="Line height" value={settings.lyrics.lineHeight} min={1} max={2} step={0.05} onChange={value => patchLyrics({ lineHeight: value })} />
            <Range label="Active line opacity" value={settings.lyrics.activeOpacity} min={0.4} max={1} step={0.02} onChange={value => patchLyrics({ activeOpacity: value })} format={value => `${Math.round(value * 100)}%`} />
            <Range label="Inactive line opacity" value={settings.lyrics.inactiveOpacity} min={0.05} max={0.9} step={0.02} onChange={value => patchLyrics({ inactiveOpacity: value })} format={value => `${Math.round(value * 100)}%`} />
            <Range label="Scroll target" hint="Where the active line sits vertically." value={settings.lyrics.targetScrollRatio} min={0.15} max={0.85} step={0.01} onChange={value => patchLyrics({ targetScrollRatio: value })} format={value => `${Math.round(value * 100)}%`} />
            <Range label="Timing offset" hint="Positive values make lyrics appear later." value={settings.lyrics.offsetMs} min={-3000} max={3000} step={50} onChange={value => patchLyrics({ offsetMs: value })} format={value => `${(value / 1000).toFixed(2)}s`} />

            <h3>Lyrics Provider Order</h3>
            <p className="muted">
              Cadence tries providers in this order and uses the first one with suitable lyrics; the order also
              drives automatic fallback. Local sources work offline. Disabled or unavailable slots are skipped
              without blocking the next provider.
            </p>
            <div className="provider-order-head">
              <span className="muted">{activeProviders.length} active</span>
              <button type="button" className="provider-restore" onClick={restoreProviderOrder}>
                <RotateCcw size={14} /> Restore default order
              </button>
            </div>
            <ol className="provider-order" data-testid="provider-order">
              {activeProviders.map((provider, index) => {
                const key = untoggleProvider(provider);
                const config = providerConfig(key);
                return (
                  <li
                    key={provider}
                    className={!config?.available ? "is-unavailable" : undefined}
                    title={!config?.available ? config?.unavailableReason : undefined}
                  >
                    <span className="provider-index">{index + 1}</span>
                    <span className="provider-name">
                      {config?.displayName ?? untoggleProvider(provider)}
                      <span className="provider-badges">
                        <span className="provider-badge">{SYNC_BADGE[config?.syncType ?? "line"] ?? config?.syncType}</span>
                        {config?.offline ? <span className="provider-badge offline">offline</span> : null}
                        {!config?.available ? (
                          <span className="provider-badge unavailable" title={config?.unavailableReason}>
                            unavailable
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="provider-buttons">
                      <button type="button" className="icon-button" onClick={() => moveProvider(key, -1)} aria-label="Move up">
                        <ChevronUp size={15} />
                      </button>
                      <button type="button" className="icon-button" onClick={() => moveProvider(key, 1)} aria-label="Move down">
                        <ChevronDown size={15} />
                      </button>
                      <button type="button" className="icon-button" onClick={() => removeProvider(key)} aria-label="Remove from order">
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
            {providerPool.length ? (
              <div className="provider-pool" data-testid="provider-pool">
                <span className="muted">Available providers not in the order — add to include them:</span>
                <div className="provider-pool-row">
                  {providerPool.map(config => (
                    <button type="button" key={config.key} className="provider-pool-chip" onClick={() => addProvider(config.key)}>
                      <FolderPlus size={13} /> {config.displayName}
                      {!config.available ? <em className="chip-unavailable">unavailable</em> : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <div className="settings-subsection" data-testid="settings-shaders">
            <h3>Shader background</h3>
            <p className="muted">
              The Kawarp engine from Better Lyrics Shaders. Album art drives a Kawase-blurred, domain-warped
              background that reacts to the audio analyser.
            </p>
            <Toggle label="Enable shader background" checked={settings.shaders.enabled} onChange={value => patchShaders({ enabled: value })} />
            <div className="setting-row">
              <span>
                <strong>Performance mode</strong>
                <em>Lower modes reduce render resolution and blur passes, not the effect itself. “Off” uses a static artwork background.</em>
              </span>
              <select
                value={settings.shaders.performanceMode}
                onChange={event => patchShaders({ performanceMode: event.target.value as ShaderSettings["performanceMode"] })}
              >
                <option value="high">High (Retina)</option>
                <option value="balanced">Balanced</option>
                <option value="low">Low (integrated GPUs)</option>
                <option value="off">Off (static)</option>
              </select>
            </div>
            <Range label="Opacity" value={settings.shaders.kawarpOpacity} min={0} max={1} step={0.01} onChange={value => patchShaders({ kawarpOpacity: value })} />
            <Range label="Warp intensity" value={settings.shaders.kawarpWarpIntensity} min={0} max={2} step={0.05} onChange={value => patchShaders({ kawarpWarpIntensity: value })} />
            <Range label="Blur passes" value={settings.shaders.kawarpBlurPasses} min={0} max={40} step={1} onChange={value => patchShaders({ kawarpBlurPasses: value })} format={value => String(Math.round(value))} />
            <Range label="Animation speed" value={settings.shaders.kawarpAnimationSpeed} min={0} max={4} step={0.05} onChange={value => patchShaders({ kawarpAnimationSpeed: value })} />
            <Range label="Transition duration" value={settings.shaders.kawarpTransitionDuration} min={0} max={3000} step={50} onChange={value => patchShaders({ kawarpTransitionDuration: value })} format={value => `${Math.round(value)}ms`} />
            <Range label="Saturation" value={settings.shaders.kawarpSaturation} min={0} max={3} step={0.05} onChange={value => patchShaders({ kawarpSaturation: value })} />
            <Range label="Dithering" value={settings.shaders.kawarpDithering} min={0} max={0.05} step={0.001} onChange={value => patchShaders({ kawarpDithering: value })} format={value => value.toFixed(3)} />

            <h3>Audio reaction</h3>
            <Toggle label="React to the audio" checked={settings.shaders.audioResponsive} onChange={value => patchShaders({ audioResponsive: value })} />
            <Range label="Beat threshold" value={settings.shaders.audioBeatThreshold} min={0.3} max={0.99} step={0.01} onChange={value => patchShaders({ audioBeatThreshold: value })} />
            <Range label="Beat speed multiplier" value={settings.shaders.audioSpeedMultiplier} min={1} max={12} step={0.5} onChange={value => patchShaders({ audioSpeedMultiplier: value })} />
            <Range label="Beat zoom boost (%)" value={settings.shaders.kawarpAudioScaleBoost} min={0} max={10} step={0.5} onChange={value => patchShaders({ kawarpAudioScaleBoost: value })} />
            <Toggle label="Pause when playback stops" checked={settings.shaders.pauseOnInactive} onChange={value => patchShaders({ pauseOnInactive: value })} />
            <Toggle label="Dim bright artwork" checked={settings.shaders.autoDimBrightArtwork} onChange={value => patchShaders({ autoDimBrightArtwork: value })} />
            <Range label="Dim strength" value={settings.shaders.autoDimStrength} min={0} max={1} step={0.02} onChange={value => patchShaders({ autoDimStrength: value })} />
            <Toggle label="Animated artwork" hint="Plays a cover.mp4/cover.webm next to the track through the Kawarp video path." checked={settings.shaders.enableAnimatedArt} onChange={value => patchShaders({ enableAnimatedArt: value })} />
          </div>
        </section>
      ) : null}

      {section === "library" ? (
        <section className="settings-section" data-testid="settings-library">
          <h2>Library</h2>
          <div className="folder-list">
            {snapshot?.folders.length ? (
              snapshot.folders.map(folder => (
                <div className="folder-row" key={folder}>
                  <span title={folder}>{folder}</span>
                  <button type="button" className="icon-button" onClick={() => void removeFolder(folder)} aria-label="Remove folder">
                    <FolderMinus size={16} />
                  </button>
                </div>
              ))
            ) : (
              <p className="muted">No folders yet. Add the folder that holds your music.</p>
            )}
          </div>
          <div className="heading-actions">
            <button type="button" className="primary" onClick={() => void addFolder()} disabled={scanning}>
              <FolderPlus size={16} /> Add folder
            </button>
            <button type="button" onClick={() => void rescan()} disabled={scanning}>
              {scanning ? "Scanning…" : "Rescan now"}
            </button>
            <button type="button" onClick={() => navigate({ name: "decode-tester" })}>
              <Stethoscope size={16} /> Open Decode Tester
            </button>
          </div>
          <p className="muted">
            The Decode Tester goes beyond tags: it decodes the start, middle and end of every file with
            the playback decoder and lists corrupt, truncated or unsupported files so you can keep,
            export or delete them.
          </p>
          <p className="muted">
            Last scan: {snapshot?.scan.finishedAt ? new Date(snapshot.scan.finishedAt).toLocaleString() : "never"} ·{" "}
            {snapshot?.scan.filesSeen ?? 0} files seen · {snapshot?.scan.errors.length ?? 0} unreadable
          </p>
          {snapshot?.scan.errors.length ? (
            <details className="scan-errors">
              <summary>Files that could not be read</summary>
              <ul>
                {snapshot.scan.errors.slice(0, 30).map(error => (
                  <li key={error.path}>
                    <strong>{error.path}</strong> — {error.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <p className="muted">
            Database engine: <strong>{info?.dbEngine ?? "…"}</strong> · supported: FLAC, MP3, AAC/M4A, WAV, Ogg
            Vorbis, Opus.
          </p>
        </section>
      ) : null}

      {section === "playback" ? (
        <section className="settings-section" data-testid="settings-playback">
          <h2>Playback</h2>
          <Toggle label="Restore the last session on launch" checked={settings.playback.resumeOnLaunch} onChange={value => void patchSettings({ playback: { resumeOnLaunch: value } })} />
          <div className="setting-row">
            <span>
              <strong>Playback speed</strong>
              <em>The lyrics renderer follows the media element's rate automatically.</em>
            </span>
            <select value={settings.playback.playbackRate} onChange={event => void patchSettings({ playback: { playbackRate: Number(event.target.value) } })}>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <span>
              <strong>Repeat</strong>
            </span>
            <select value={settings.playback.repeat} onChange={event => void patchSettings({ playback: { repeat: event.target.value as AppSettings["playback"]["repeat"] } })}>
              <option value="off">Off</option>
              <option value="all">Repeat all</option>
              <option value="one">Repeat one</option>
            </select>
          </div>
          <Toggle label="Shuffle by default" checked={settings.playback.shuffle} onChange={value => void patchSettings({ playback: { shuffle: value } })} />
        </section>
      ) : null}

      {section === "about" ? (
        <section className="settings-section about" data-testid="settings-about">
          <h2>About Cadence</h2>
          <p>
            Cadence is a standalone desktop music player for local files. Its lyrics view is built on the
            actual <strong>Better Lyrics</strong> rendering engine (<code>@braccato/core</code>) and its
            background is the actual <strong>Better Lyrics Shaders</strong> engine (<code>@kawarp/core</code>).
          </p>
          <dl className="about-grid">
            <dt>Cadence</dt>
            <dd>{info?.version ?? "–"}</dd>
            <dt>Tauri</dt>
            <dd>{info?.tauri || "2.x"}</dd>
            <dt>WebView2 / Chromium</dt>
            <dd>{info?.chrome || "–"}</dd>
            <dt>Media protocol</dt>
            <dd>{info?.mediaProtocol ?? "cadence-media"}</dd>
            <dt>Platform</dt>
            <dd>{info?.platform ?? "–"}</dd>
            <dt>Library database</dt>
            <dd>{info?.dbEngine ?? "–"}</dd>
          </dl>
          <div className="about-links">
            <button type="button" onClick={() => void window.cadence.app.openExternal("https://github.com/better-lyrics/better-lyrics")}>
              Better Lyrics on GitHub
            </button>
            <button type="button" onClick={() => void window.cadence.app.openExternal("https://github.com/better-lyrics/shaders")}>
              Better Lyrics Shaders on GitHub
            </button>
          </div>
          <p className="muted">
            Better Lyrics and Better Lyrics Shaders are GPL-3.0; Cadence is distributed under the same license.
            Upstream commit hashes and the file mapping are recorded in <code>UPSTREAM.md</code>.
          </p>
          <button
            type="button"
            className="danger"
            disabled={clearingCache}
            onClick={async () => {
              if (!confirm("Clear cached remote lyrics?")) return;
              setClearingCache(true);
              try {
                // Resolves only once the emptied cache file has been written to disk; a
                // filesystem error rejects here instead of being reported as a success.
                const { removedEntries } = await window.cadence.lyrics.clearCache();
                showToast(
                  removedEntries > 0
                    ? `Lyrics cache cleared (${removedEntries} cached ${removedEntries === 1 ? "song" : "songs"} removed)`
                    : "Lyrics cache was already empty"
                );
              } catch (error) {
                showToast(`Could not clear the lyrics cache: ${describeError(error)}`);
              } finally {
                setClearingCache(false);
              }
            }}
          >
            <Trash2 size={16} /> {clearingCache ? "Clearing lyrics cache…" : "Clear lyrics cache"}
          </button>
        </section>
      ) : null}
    </div>
  );
}
