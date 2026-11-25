/**
 * Settings and appearance. Written for Cadence; the shader controls mirror the Better Lyrics
 * Shaders popup (`popup/components/tabs/*`, commit d878877) one-for-one where they exist.
 */

import { useEffect, useState } from "react";
import { AudioLines, ChevronDown, ChevronUp, Clapperboard, Database, FolderMinus, FolderPlus, Info, Keyboard, Library, Mic2, Palette, RefreshCw, RotateCcw, SlidersHorizontal, Stethoscope, Trash2 } from "lucide-react";
import type { AppInfo, AppSettings, EqualizerSettings, ReplayGainMode, ShaderSettings } from "../../../shared/types";
import { trackSourceKey } from "../../../shared/media";
import { fontOption, fontStack, normalizeFontId } from "../../../shared/fonts";
import { useSystemFonts } from "../../state/fontsStore";
import { MarqueeText } from "../../components/MarqueeText";
import { useLibrary } from "../../state/libraryStore";
import { currentMediaItem, usePlayer } from "../../state/playerStore";
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
import { invalidateLyricsResolution } from "../lyrics/useLyrics";
import { LastFmSettings } from "./LastFmSettings";
import { LyricsCachePanel } from "./LyricsCachePanel";
import { ArtistImagesSettings } from "./ArtistImagesSettings";
import { NowPlayingAppearance } from "./NowPlayingAppearance";
import { useOnboarding } from "../../state/onboardingStore";
import { createRefreshSeed, localDayKey } from "../library/homeSelection";
import {
  EQ_BAND_LABELS,
  EQ_PRESETS,
  matchingEqualizerPresetId,
  normalizeEqBandsDb,
} from "../../audio/equalizer";
import type { LyricsFetchConcurrency } from "../../../shared/types";
import { LyricsAiSettings } from "./LyricsAiSettings";

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
        <MarqueeText as="strong">{label}</MarqueeText>
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
        <MarqueeText as="strong">{label}</MarqueeText>
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
  const tracksById = useLibrary(state => state.tracksById);
  const currentItem = usePlayer(currentMediaItem);
  const addFolder = useLibrary(state => state.addFolder);
  const removeFolder = useLibrary(state => state.removeFolder);
  const rescan = useLibrary(state => state.rescan);
  const scanning = useLibrary(state => state.scanning);
  const [info, setInfo] = useState<AppInfo | null>(null);
  // Remember the category while browsing and allow the lyrics recovery action to select it.
  const section = useUi(state => state.settingsSection);
  const setSection = useUi(state => state.setSettingsSection);
  const [clearingCache, setClearingCache] = useState(false);
  const [resettingSettings, setResettingSettings] = useState(false);
  const [fontQuery, setFontQuery] = useState("");
  const fontFamilies = useSystemFonts(state => state.families);
  const fontsLoaded = useSystemFonts(state => state.loaded);
  const fontsLoading = useSystemFonts(state => state.loading);
  const fontsError = useSystemFonts(state => state.error);
  const loadFonts = useSystemFonts(state => state.load);
  const showToast = useUi(state => state.showToast);
  const setShortcutsHelpOpen = useUi(state => state.setShortcutsHelpOpen);
  const navigate = useUi(state => state.navigate);

  useEffect(() => {
    void window.cadence.info().then(setInfo).catch(() => undefined);
  }, []);

  // Enumerate the platform's installed fonts. The list is refreshed whenever the window regains
  // focus, so a font installed while Cadence is running can be selected without a restart.
  useEffect(() => {
    void loadFonts();
  }, [loadFonts]);

  useEffect(() => {
    // Focus fires on every alt-tab; a scan reads hundreds of files, so reuse a recent one.
    const refresh = () => void loadFonts({ force: true, maxAgeMs: 30_000 });
    const onVisibility = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadFonts]);

  const selectedFontId = normalizeFontId(settings?.appearance.fontFamily);
  const selectedFont = fontOption(selectedFontId, fontFamilies);
  const fontQueryText = fontQuery.trim().toLowerCase();
  const visibleFontFamilies = fontQueryText
    ? fontFamilies.filter(family => family.family.toLowerCase().includes(fontQueryText))
    : fontFamilies;
  // A saved family that is not installed on this machine stays selectable (and keeps its fallback
  // stack) instead of silently snapping the setting to another font.
  const selectedFontMissing =
    fontsLoaded &&
    !selectedFont.preset &&
    !fontFamilies.some(family => family.family.toLowerCase() === selectedFontId.toLowerCase());

  if (!settings) return <div className="view-loading">Loading settings…</div>;

  const patchLyrics = (patch: Partial<AppSettings["lyrics"]>) => void patchSettings({ lyrics: patch });
  const patchShaders = (patch: Partial<ShaderSettings>) => void patchSettings({ shaders: patch });
  const patchMv = (patch: Partial<AppSettings["mvBackground"]>) => void patchSettings({ mvBackground: patch });
  const currentTrackId = currentItem?.source.kind === "local" ? currentItem.source.trackId : null;
  const currentTrack = currentTrackId === null ? null : tracksById.get(currentTrackId) ?? null;
  const mvSourceKey = currentItem ? trackSourceKey(currentItem.source) : null;
  const mvBinding = mvSourceKey ? settings.mvBackground.bindings[mvSourceKey] : undefined;
  const mvStatus = mvBinding
    ? "Manual override"
    : currentTrack?.mvUrl
      ? "Auto-detected sidecar"
      : "No music video found";
  const formatDb = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
  // Patch a complete equalizer object: the settings store's optimistic merge is only shallow
  // below `playback`, so a partial nested object would briefly drop the other EQ fields
  // until the (deep-merging) host response lands.
  const patchEqualizer = (patch: Partial<EqualizerSettings>) =>
    void patchSettings({
      playback: {
        equalizer: {
          ...settings.playback.equalizer,
          ...patch,
          bandsDb: normalizeEqBandsDb(patch.bandsDb ?? settings.playback.equalizer.bandsDb),
        },
      },
    });

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
          <p className="eyebrow">Cadence</p>
          <h1>Settings</h1>
          <p className="muted">Manage your library, playback and listening experience.</p>
        </div>
        <div className="heading-actions">
          <button type="button" data-testid="open-shortcuts-help" onClick={() => setShortcutsHelpOpen(true)}>
            <Keyboard size={16} /> Keyboard shortcuts
          </button>
        </div>
      </header>

      <nav className="settings-tabs" aria-label="Settings categories">
        {([
          ["general", "General", SlidersHorizontal],
          ["appearance", "Appearance", Palette],
          ["lyrics", "Lyrics", Mic2],
          ["library", "Library", Library],
          ["playback", "Playback", AudioLines],
          ["cache", "Cache", Database],
          ["about", "About", Info],
        ] as const).map(([id, label, Icon]) => (
          <button
            type="button"
            key={id}
            className={section === id ? "active" : ""}
            aria-current={section === id ? "location" : undefined}
            onClick={() => setSection(id)}
          >
            <Icon size={16} aria-hidden="true" /> {label}
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
                  Installed fonts are read from this device and can be used by the app and the lyrics
                  view. A font that is removed keeps a system fallback.
                </em>
              </span>
              <select
                value={selectedFontId}
                data-testid="font-select"
                aria-label="Font"
                onChange={event => void patchSettings({ appearance: { fontFamily: event.target.value } })}
              >
                <option value="system">System default</option>
                <option value="monospace">Monospace</option>
                {selectedFontMissing ? (
                  <option value={selectedFontId}>{selectedFontId} (not installed)</option>
                ) : null}
                <optgroup label="Installed fonts">
                  {visibleFontFamilies.map(family => (
                    <option
                      key={family.family}
                      value={family.family}
                      style={{ fontFamily: fontStack(family.family) }}
                    >
                      {family.family}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div className="font-picker-tools">
              <input
                type="search"
                value={fontQuery}
                onChange={event => setFontQuery(event.target.value)}
                placeholder="Search installed fonts…"
                aria-label="Search installed fonts"
                data-testid="font-search"
              />
              <button
                type="button"
                className="ghost-button setting-action"
                data-testid="font-refresh"
                onClick={() => void loadFonts({ force: true })}
                disabled={fontsLoading}
                title="Rescan the system for newly installed fonts"
              >
                <RefreshCw size={14} className={fontsLoading ? "spin" : undefined} /> Refresh
              </button>
              <span className="font-picker-status" data-testid="font-count">
                {fontsLoading
                  ? "Reading fonts…"
                  : fontsLoaded
                    ? `${fontFamilies.length} installed font${fontFamilies.length === 1 ? "" : "s"}`
                    : ""}
              </span>
            </div>
            {fontsError ? (
              <p className="field-hint" data-testid="font-error">
                Could not read system fonts ({fontsError}); using the built-in fallbacks.
              </p>
            ) : null}
            {selectedFontMissing ? (
              <p className="field-hint" data-testid="font-missing">
                “{selectedFontId}” is not installed on this device. Cadence falls back to the system font.
              </p>
            ) : null}
            <p className="font-preview" style={{ fontFamily: selectedFont.stack }} data-testid="font-preview">
              The quick brown fox jumps over the lazy dog · 1, 2, 3
            </p>
            <Toggle label="Reduce motion" checked={settings.appearance.reduceMotion} onChange={value => void patchSettings({ appearance: { reduceMotion: value } })} />
            <Toggle label="Compact sidebar" checked={settings.appearance.compactSidebar} onChange={value => void patchSettings({ appearance: { compactSidebar: value } })} />
            <Toggle label="Expand compact sidebar on hover" checked={settings.appearance.compactSidebarHoverExpand} onChange={value => void patchSettings({ appearance: { compactSidebarHoverExpand: value } })} />
            <Toggle label="Blur artwork behind the player" checked={settings.appearance.blurArtwork} onChange={value => void patchSettings({ appearance: { blurArtwork: value } })} />
            <Toggle label="Verbose shader logs" checked={settings.advanced.showLogs} onChange={value => void patchSettings({ advanced: { showLogs: value } })} />
            <div className="setting-row">
              <span>
                <strong>Replay Onboarding</strong>
                <em>Run the first-launch setup again (library, preferences, ready).</em>
              </span>
              <button
                type="button"
                className="ghost-button setting-action"
                data-testid="replay-onboarding"
                onClick={() => useOnboarding.getState().replay()}
              >
                Replay Onboarding
              </button>
            </div>
          </div>
          <NowPlayingAppearance />
          <div className="settings-subsection" data-testid="settings-shaders">
            <h3>Shader background</h3>
            <p className="muted">
              The Kawarp engine from Better Lyrics Shaders. Album art drives a Kawase-blurred, domain-warped
              background that reacts to the audio analyser.
            </p>
            <Toggle label="Enable shader background" checked={settings.shaders.enabled} onChange={value => patchShaders({ enabled: value })} />
            <Toggle
              label="Shader background across the whole app"
              hint="Runs the same engine behind the library, settings and Now Playing instead of only the player. Off by default; turning it off stops the shader entirely."
              checked={settings.shaders.globalBackground}
              onChange={value => patchShaders({ globalBackground: value })}
            />
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

            <h3>Music video background</h3>
            <p className="muted">
              A muted, full-bleed video behind the fullscreen lyrics. When it is on, the usual artwork
              background is not rendered; audio still comes from the song.
            </p>
            <Toggle
              label="Enable MV background"
              hint="Same toggle as the clapperboard button in the fullscreen dock."
              checked={settings.mvBackground.enabled}
              onChange={value => patchMv({ enabled: value })}
            />
            <Range
              label="Scrim opacity"
              hint="Dark layer over the video; 0 keeps the original colours, 1 is fully black."
              value={settings.mvBackground.scrimOpacity}
              min={0}
              max={1}
              step={0.01}
              onChange={value => patchMv({ scrimOpacity: value })}
            />
            <div className="setting-row">
              <span>
                <strong>MV for the current track</strong>
                <em data-testid="settings-mv-status">{mvStatus}</em>
              </span>
              <span className="heading-actions setting-action">
                <button
                  type="button"
                  title="Choose MV file"
                  aria-label="Choose MV file"
                  data-testid="settings-choose-mv"
                  disabled={currentTrackId === null}
                  onClick={async () => {
                    if (currentTrackId === null || !mvSourceKey) return;
                    try {
                      const picked = await window.cadence.app.chooseMvFile(currentTrackId);
                      if (picked.canceled || !picked.url) return;
                      await patchSettings({
                        mvBackground: {
                          bindings: { ...settings.mvBackground.bindings, [mvSourceKey]: picked.url },
                        },
                      });
                      showToast("Music video set for this track");
                    } catch (error) {
                      showToast(`Could not choose MV file: ${describeError(error)}`);
                    }
                  }}
                >
                  <Clapperboard size={16} /> Choose file
                </button>
                {mvBinding ? (
                  <button
                    type="button"
                    title="Clear MV override"
                    aria-label="Clear MV override"
                    onClick={() => {
                      if (!mvSourceKey) return;
                      const bindings = { ...settings.mvBackground.bindings };
                      delete bindings[mvSourceKey];
                      patchMv({ bindings });
                    }}
                  >
                    <Trash2 size={16} /> Clear
                  </button>
                ) : null}
              </span>
            </div>
          </div>
        </section>
      ) : null}

      {section === "general" ? (
        <section className="settings-section" data-testid="settings-general">
          <h2>General</h2>
          <p className="muted">App-wide actions that do not belong to the library, playback or appearance.</p>
          <div className="heading-actions">
            <button
              type="button"
              data-testid="settings-refresh-featured"
              onClick={async () => {
                try {
                  await patchSettings({
                    home: { featuredSeed: createRefreshSeed(), featuredSeedDay: localDayKey() },
                  });
                  showToast("Featured albums refreshed");
                } catch (error) {
                  showToast(`Could not refresh featured albums: ${describeError(error)}`);
                }
              }}
            >
              <RefreshCw size={16} /> Refresh featured albums
            </button>
          </div>
          <p className="muted">
            Picks a new set of Featured albums and Explore your albums for today. The choice stays put until
            the next day or until you refresh it again.
          </p>
        </section>
      ) : null}

      {section === "lyrics" ? (
        <section className="settings-section" data-testid="settings-lyrics">
          <h2>Lyrics</h2>
          <div className="settings-subsection">
            <Toggle
              label="Fetch lyrics online"
              hint="Autofetch: when on, lyrics are looked up automatically the moment a track starts playing. When off, Cadence only uses sidecar files, embedded tags and the cache. Playback never needs the network."
              checked={settings.lyrics.autoFetch}
              onChange={value => patchLyrics({ autoFetch: value })}
            />
            <Range
              label="Not Found cooldown"
              hint="Days before a track no provider had lyrics for is searched again automatically. Manual retries in Now Playing always search immediately."
              value={settings.lyrics.notFoundCooldownDays}
              min={1}
              max={30}
              step={1}
              onChange={value => patchLyrics({ notFoundCooldownDays: value })}
              format={value => `${Math.round(value)} ${Math.round(value) === 1 ? "day" : "days"}`}
            />
            <div className="setting-row">
              <span>
                <strong>Lyrics Fetch Concurrency</strong>
                <em>
                  One global limit for provider requests across Autofetch and manual search.
                  Lower is gentler on slow connections and low-memory systems.
                </em>
              </span>
              <select
                data-testid="fetch-concurrency-select"
                value={settings.lyrics.fetchConcurrency}
                onChange={event =>
                  patchLyrics({ fetchConcurrency: event.target.value as LyricsFetchConcurrency })
                }
              >
                <option value="low">Low</option>
                <option value="balanced">Balanced</option>
                <option value="high">High</option>
              </select>
            </div>
            <Toggle
              label="Romanize non-Latin lyrics"
              hint={settings.lyrics.aiRomanization.enabled ? "Uses the independent AI Romanization provider configured below." : "Uses the existing non-Latin romanization provider; enable AI Romanization below to use your configured model."}
              checked={settings.lyrics.romanization}
              onChange={value => patchLyrics({ romanization: value })}
            />
            <div className="setting-row">
              <span><strong>Romanization display</strong><em>Line keeps one romanized line; Word aligns romanization to each lyric word when timing is available.</em></span>
              <select value={settings.lyrics.romanizationMode} onChange={event => patchLyrics({ romanizationMode: event.target.value as "line" | "word" })}>
                <option value="line">Line</option>
                <option value="word">Word-by-word</option>
              </select>
            </div>
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

            {!settings.lyrics.aiTranslation.enabled ? (
            <div className="setting-row">
              <span>
                <strong>Translation language</strong>
                <em>{settings.lyrics.aiTranslation.enabled ? "AI translation uses the independent provider configured below." : "Uses Cadence's existing lyrics translation provider; AI can be configured separately below."}</em>
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
            ) : null}

            <LyricsAiSettings settings={settings.lyrics} onChange={patch => patchLyrics(patch)} />

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
                      <MarqueeText title={config?.displayName ?? untoggleProvider(provider)}>
                        {config?.displayName ?? untoggleProvider(provider)}
                      </MarqueeText>
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
        </section>
      ) : null}

      {section === "library" ? (
        <section className="settings-section" data-testid="settings-library">
          <h2>Library</h2>
          <div className="folder-list">
            {snapshot?.folders.length ? (
              snapshot.folders.map(folder => (
                <div className="folder-row" key={folder}>
                  <MarqueeText title={folder}>{folder}</MarqueeText>
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
          <div className="setting-row">
            <span>
              <strong>Shuffle mode</strong>
              <em>Smart Shuffle balances genre compatibility, listening history, completion rates, and catalog popularity.</em>
            </span>
            <select
              data-testid="shuffle-mode-select"
              value={settings.playback.shuffleMode ?? "smart"}
              onChange={event =>
                void patchSettings({
                  playback: {
                    shuffleMode: event.target.value as AppSettings["playback"]["shuffleMode"],
                  },
                })
              }
            >
              <option value="smart">Smart Shuffle (Context &amp; Genre aware)</option>
              <option value="classic">Classic Shuffle (Uniform random)</option>
            </select>
          </div>
          <Toggle
            label="AutoPlay similar songs"
            hint="Automatically queue contextually compatible tracks from your library when the queue runs low and Repeat is off."
            checked={settings.playback.autoPlay ?? true}
            onChange={value => void patchSettings({ playback: { autoPlay: value } })}
          />
          <Toggle
            label="Online popularity intelligence"
            hint="Lazily enrich Smart Shuffle and AutoPlay with multi-provider popularity and genre tags, cached locally in SQLite. Works offline when disabled."
            checked={settings.playback.smartShufflePopularity ?? true}
            onChange={value => void patchSettings({ playback: { smartShufflePopularity: value } })}
          />

          <div className="settings-subsection" data-testid="settings-audio">
            <h3>Audio</h3>
            <Range
              label="Crossfade"
              hint="Overlap the end of one track with the start of the next. Off keeps today's instant cut."
              value={settings.playback.crossfadeSeconds}
              min={0}
              max={12}
              step={0.5}
              format={value => (value === 0 ? "Off" : `${value.toFixed(1)}s`)}
              onChange={value => void patchSettings({ playback: { crossfadeSeconds: value } })}
            />
            <Toggle
              label="Gapless playback"
              hint="Preload the next track so album tracks that run together cut without a silent gap."
              checked={settings.playback.gaplessPlayback}
              onChange={value => void patchSettings({ playback: { gaplessPlayback: value } })}
            />
            <div className="setting-row">
              <span>
                <strong>ReplayGain</strong>
                <em>Level out loud and quiet files using ReplayGain tags read when files are scanned. Untagged files are untouched.</em>
              </span>
              <select
                data-testid="replaygain-mode"
                value={settings.playback.replayGainMode}
                onChange={event => void patchSettings({ playback: { replayGainMode: event.target.value as ReplayGainMode } })}
              >
                <option value="off">Off</option>
                <option value="track">Track gain</option>
                <option value="album">Album gain</option>
              </select>
            </div>
            <Range
              label="ReplayGain preamp"
              hint="Extra level added on top of the ReplayGain adjustment."
              value={settings.playback.replayGainPreampDb}
              min={-12}
              max={12}
              step={0.5}
              format={formatDb}
              onChange={value => void patchSettings({ playback: { replayGainPreampDb: value } })}
            />
            <Toggle
              label="Prevent clipping"
              hint="Use each file's ReplayGain peak tag to cap boosts before they can distort."
              checked={settings.playback.replayGainPreventClipping}
              onChange={value => void patchSettings({ playback: { replayGainPreventClipping: value } })}
            />
          </div>

          <div className="settings-subsection" data-testid="settings-equalizer">
            <h3>Equalizer</h3>
            <Toggle
              label="Enable equalizer"
              hint="Ten-band EQ applied after ReplayGain. Turning it off is instantly transparent."
              checked={settings.playback.equalizer.enabled}
              onChange={value => patchEqualizer({ enabled: value })}
            />
            <div className="setting-row">
              <span>
                <strong>Preset</strong>
                <em>Moving any band switches to Custom.</em>
              </span>
              <select
                data-testid="equalizer-preset"
                value={matchingEqualizerPresetId(settings.playback.equalizer.bandsDb)}
                onChange={event => {
                  const preset = EQ_PRESETS.find(candidate => candidate.id === event.target.value);
                  if (preset) patchEqualizer({ bandsDb: [...preset.bandsDb], presetId: preset.id });
                }}
              >
                {EQ_PRESETS.map(preset => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </div>
            <Range
              label="EQ preamp"
              hint="Overall level trim — lower it if strong boosts make loud tracks clip."
              value={settings.playback.equalizer.preampDb}
              min={-12}
              max={12}
              step={0.5}
              format={formatDb}
              onChange={value => patchEqualizer({ preampDb: value })}
            />
            <div className="equalizer-bands" role="group" aria-label="Equalizer bands">
              {normalizeEqBandsDb(settings.playback.equalizer.bandsDb).map((bandDb, index) => (
                <label className="equalizer-band" key={EQ_BAND_LABELS[index]}>
                  <span>{EQ_BAND_LABELS[index]}</span>
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={bandDb}
                    data-testid={`equalizer-band-${index}`}
                    aria-label={`${EQ_BAND_LABELS[index]} Hz band`}
                    onChange={event => {
                      const bandsDb = normalizeEqBandsDb(settings.playback.equalizer.bandsDb);
                      bandsDb[index] = Number(event.target.value);
                      patchEqualizer({ bandsDb, presetId: matchingEqualizerPresetId(bandsDb) });
                    }}
                  />
                  <output>{formatDb(bandDb)}</output>
                </label>
              ))}
            </div>
            <div className="setting-row">
              <span>
                <strong>Reset equalizer</strong>
                <em>Back to flat with no preamp.</em>
              </span>
              <button
                type="button"
                onClick={() => patchEqualizer({ preampDb: 0, bandsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], presetId: "flat" })}
              >
                <RotateCcw size={14} /> Reset
              </button>
            </div>
          </div>

          <LastFmSettings
            settings={settings.scrobbling}
            patchSettings={patch => patchSettings(patch)}
            showToast={showToast}
          />
        </section>
      ) : null}

      {section === "cache" ? (
        <>
          <LyricsCachePanel />
          <ArtistImagesSettings />
        </>
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
          <div className="setting-row">
            <span>
              <strong>Clear lyrics cache</strong>
              <em>Removes cached lyrics so songs are looked up again. Your audio files, lyrics files and library are not touched.</em>
            </span>
            <button
              type="button"
              className="ghost-button danger setting-action"
              disabled={clearingCache}
              onClick={async () => {
                if (
                  !confirm(
                    "Clear the whole lyrics cache? Songs will be looked up again. Your audio files, lyrics files and library are not touched."
                  )
                )
                  return;
                setClearingCache(true);
                try {
                  // Resolves only once the emptied cache file has been written to disk; a
                  // filesystem error rejects here instead of being reported as a success.
                  const { removedEntries } = await window.cadence.lyrics.clearCache();
                  if (removedEntries > 0) invalidateLyricsResolution();
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
          </div>
          <div className="setting-row">
            <span>
              <strong>Restore default settings</strong>
              <em>Resets preferences and custom Now Playing profiles. Your music and playlists are not changed.</em>
            </span>
            <button
              type="button"
              className="ghost-button danger setting-action"
              data-testid="settings-reset-all"
              disabled={resettingSettings}
              onClick={async () => {
                if (!window.confirm("Reset all settings and remove custom Now Playing profiles? Your music and playlists are not changed.")) return;
                setResettingSettings(true);
                try {
                  await resetSettings();
                  showToast("Settings restored to defaults");
                } catch (error) {
                  showToast(`Could not reset settings: ${describeError(error)}`);
                } finally {
                  setResettingSettings(false);
                }
              }}
            >
              <RotateCcw size={16} /> {resettingSettings ? "Resetting…" : "Reset all"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
