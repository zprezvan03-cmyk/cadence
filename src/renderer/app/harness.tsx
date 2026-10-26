/**
 * Browser test harness hook.
 *
 * Loaded only when the renderer URL carries `?harness=1`. It exposes the *production* modules
 * (audio engine, player store, Braccato lyrics renderer, Kawarp shader background) to
 * `tests/browser/run-harness.mjs` so the real code paths can be exercised in headless Chromium
 * where the Electron binary is unavailable. Nothing here is used by the shipped application.
 */

import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { audioEngine } from "../audio/engine";
import { usePlayer } from "../state/playerStore";
import {
  applyRomanization,
  applyTranslations,
  parseLyricsText,
  romanizationGaps,
  scatterRomanizations,
  stripRomanization,
} from "../features/lyrics/parseLyrics";
import { BraccatoLyrics } from "../features/lyrics/BraccatoLyrics";
import { LyricsView } from "../features/lyrics/LyricsView";
import { KawarpBackground } from "../features/shaders/KawarpBackground";
import { useSettings } from "../state/settingsStore";
import { useLyricsStore } from "../state/lyricsStore";
import { DEFAULT_PROVIDER_ORDER } from "../../shared/upstream/better-lyrics/constants";
import type {
  AppSettings,
  CadenceApi,
  LyricsCandidate,
  LyricsSettings,
  ShaderSettings,
  Track,
} from "../../shared/types";

const shaderErrors: string[] = [];

const shaderSettings: ShaderSettings = {
  enabled: true,
  kawarpOpacity: 0.9,
  kawarpWarpIntensity: 1,
  kawarpBlurPasses: 8,
  kawarpAnimationSpeed: 1,
  kawarpTransitionDuration: 1000,
  kawarpSaturation: 1.5,
  kawarpDithering: 0.008,
  kawarpAudioScaleBoost: 2,
  videoEnabled: false,
  videoOpacity: 1,
  videoWarpIntensity: 1,
  videoBlurPasses: 4,
  videoAnimationSpeed: 1,
  videoSaturation: 1.5,
  videoDithering: 0.008,
  videoHdrDitheringScale: 1,
  videoDimStrength: 0.5,
  videoBrightnessTransition: 300,
  videoAudioResponsive: false,
  videoBeatSpeedMultiplier: 2,
  videoBeatZoom: 1.05,
  videoZoomAttack: 0.2,
  videoZoomRelease: 0.4,
  videoSampleWidth: 128,
  videoSampleHeight: 128,
  videoFrameRate: 30,
  videoColorResponse: 0.5,
  videoBrightnessSampleSize: 64,
  videoBrightnessInterval: 500,
  videoDownsampleFactor: 2,
  autoDimBrightArtwork: true,
  autoDimStrength: 0.5,
  audioResponsive: true,
  audioSpeedMultiplier: 4,
  audioBeatThreshold: 0.75,
  pauseOnInactive: true,
  showLogs: false,
  showOnBrowsePages: false,
  enableAnimatedArt: false,
  performanceMode: "balanced",
};
let lyricsRoot: ReturnType<typeof createRoot> | null = null;
let shaderRoot: ReturnType<typeof createRoot> | null = null;

function container(id: string, className: string): HTMLElement {
  let node = document.getElementById(id);
  if (!node) {
    node = document.createElement("div");
    node.id = id;
    node.className = className;
    document.body.appendChild(node);
  }
  return node;
}

/* ------------------------------------------------------------------ lyrics view */

/**
 * The Now Playing lyrics page mounted on its own, for `tests/browser/lyrics-decorations.mjs`.
 * It is the production `LyricsView` (dock, `useLyrics`, store and Braccato renderer) over a stub
 * bridge whose lyrics providers are configurable, so the real translation / romanization
 * pipeline can be driven through the real controls in headless Chromium.
 */
interface HarnessTrackSpec extends Partial<Track> {
  id: number;
  title: string;
  duration: number;
}

interface HarnessLyricsOptions {
  track: HarnessTrackSpec;
  candidates?: LyricsCandidate[];
  settings?: Partial<LyricsSettings>;
}

function makeHarnessTrack(spec: HarnessTrackSpec): Track {
  return {
    path: "/harness/lyrics-fixture.flac",
    streamUrl: "/audio/harness-tone.wav",
    artist: "Harness Artist",
    albumArtist: "Harness Artist",
    album: "Lyrics Bench",
    genre: "",
    year: null,
    trackNo: null,
    discNo: null,
    bitrate: null,
    sampleRate: null,
    channels: null,
    codec: "FLAC",
    container: "FLAC",
    fileSize: 0,
    mtimeMs: 0,
    artworkUrl: null,
    animatedArtUrl: null,
    accentColor: null,
    hasEmbeddedLyrics: false,
    favorite: false,
    addedAt: 0,
    lastPlayedAt: null,
    playCount: 0,
    hasSidecarLyrics: true,
    playable: true,
    ...spec,
  };
}

const defaultLyricsSettings: LyricsSettings = {
  providerOrder: [...DEFAULT_PROVIDER_ORDER],
  autoFetch: true,
  offsetMs: 0,
  translationLanguage: "",
  romanization: false,
  themeId: "default",
  customThemeCss: "",
  fontSizeRem: 3,
  fontWeight: 700,
  lineHeight: 1.333,
  translationFontSizePx: 32,
  romanizationFontSizePx: 26,
  activeOpacity: 1,
  inactiveOpacity: 0.3,
  targetScrollRatio: 0.5,
  showCredits: false,
  hideInstrumentalOnly: false,
  passiveScroll: true,
  fullscreenOnOpen: false,
  showLyricsInFullscreen: true,
};

function harnessAppSettings(lyrics?: Partial<LyricsSettings>): AppSettings {
  return {
    version: 1,
    playback: { volume: 0.85, muted: false, shuffle: false, repeat: "off", playbackRate: 1, resumeOnLaunch: false },
    appearance: { accent: "#ff3d71", reduceMotion: false, compactSidebar: false, blurArtwork: true, fontFamily: "inter" },
    lyrics: { ...defaultLyricsSettings, ...lyrics },
    shaders: { ...shaderSettings, enabled: false },
    advanced: { showLogs: false },
  };
}

function mergeHarnessSettings(base: AppSettings, patch: unknown): AppSettings {
  const source = (patch ?? {}) as Record<string, unknown>;
  const result = { ...base } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    const current = result[key];
    result[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object"
        ? { ...(current as object), ...(value as object) }
        : value;
  }
  return result as unknown as AppSettings;
}

const lyricsHarness = {
  candidates: [] as LyricsCandidate[],
  settings: harnessAppSettings(),
  resolveCalls: 0,
  translateCalls: [] as { lines: string[]; targetLanguage: string }[],
  romanizeCalls: [] as { lines: string[] }[],
  translationDelayMs: 0,
  romanizationDelayMs: 0,
  translationFailure: false,
  romanizationFailure: false,
  chosenFile: null as string | null,
};

let lyricsViewRoot: ReturnType<typeof createRoot> | null = null;
let lyricsViewTrack: Track | null = null;

function installLyricsHarnessBridge(): void {
  const existing = (globalThis.window?.cadence ?? {}) as unknown as Record<string, unknown>;
  const bridge = {
    ...existing,
    settings: {
      get: async () => structuredClone(lyricsHarness.settings),
      patch: async (patch: unknown) => {
        lyricsHarness.settings = mergeHarnessSettings(lyricsHarness.settings, patch);
        return structuredClone(lyricsHarness.settings);
      },
      reset: async () => {
        lyricsHarness.settings = harnessAppSettings();
        return structuredClone(lyricsHarness.settings);
      },
    },
    lyrics: {
      resolve: async () => {
        lyricsHarness.resolveCalls += 1;
        return {
          candidates: structuredClone(lyricsHarness.candidates),
          providerStatus: lyricsHarness.candidates.map(candidate => ({
            provider: candidate.source,
            status: "hit",
            detail: candidate.provider,
          })),
        };
      },
      search: async () => ({ results: [], providerStatus: [], cached: false }),
      youtubeMetadata: async () => ({ ok: false, reason: "error", detail: "unavailable in harness" }),
      translate: async (request: { lines: string[]; targetLanguage: string }) => {
        lyricsHarness.translateCalls.push({ lines: [...request.lines], targetLanguage: request.targetLanguage });
        if (lyricsHarness.translationDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, lyricsHarness.translationDelayMs));
        }
        if (lyricsHarness.translationFailure) throw new Error("harness translation failure");
        return {
          translations: request.lines.map(line => `[${request.targetLanguage}] ${line}`),
          targetLanguage: request.targetLanguage,
          provider: "harness",
        };
      },
      romanize: async (request: { lines: string[] }) => {
        lyricsHarness.romanizeCalls.push({ lines: [...request.lines] });
        if (lyricsHarness.romanizationDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, lyricsHarness.romanizationDelayMs));
        }
        if (lyricsHarness.romanizationFailure) throw new Error("harness romanization failure");
        return { romanizations: request.lines.map(line => `[rom] ${line}`), provider: "harness" };
      },
      saveSidecar: async () => "/harness/lyrics.lrc",
      clearCache: async () => ({ removedEntries: 0 }),
    },
    app: {
      ...(existing.app as object | undefined),
      chooseLyricsFile: async () => {
        const text = lyricsHarness.chosenFile;
        lyricsHarness.chosenFile = null;
        return text ? { canceled: false, text, path: "/harness/chosen.ttml" } : { canceled: true };
      },
    },
  };
  window.cadence = bridge as unknown as CadenceApi;
}

const harness = {
  audioEngine,
  player: usePlayer,
  shaderErrors,

  async play(streamUrl: string, duration: number) {
    await audioEngine.load({ streamUrl, title: "Harness" });
    await audioEngine.play();
    return { duration };
  },

  mountLyrics(text: string) {
    const durationMs = Math.max(1, audioEngine.duration) * 1000 || 12_000;
    const parsed = parseLyricsText(text, durationMs);
    const node = container("harness-lyrics", "");
    if (!lyricsRoot) lyricsRoot = createRoot(node);
    lyricsRoot.render(
      createElement(BraccatoLyrics, {
        lyrics: parsed.lyrics,
        themeCss: ":host { --blyrics-font-size: 26px; }",
        offsetMs: 0,
        passiveScroll: false,
        songwriters: parsed.songwriters,
        language: parsed.language,
      })
    );
    return { syncType: parsed.syncType, lines: parsed.lyrics.length };
  },

  /** Mounts lyrics carrying per-line translations and/or romanizations, as useLyrics hands them over. */
  mountDecoratedLyrics(
    text: string,
    decorations: { translations?: (string | null)[]; romanizations?: (string | null)[] }
  ) {
    const durationMs = Math.max(1, audioEngine.duration) * 1000 || 12_000;
    const parsed = parseLyricsText(text, durationMs);
    let lyrics = parsed.lyrics;
    if (decorations.translations) lyrics = applyTranslations(lyrics, decorations.translations, "en");
    if (decorations.romanizations) lyrics = applyRomanization(lyrics, decorations.romanizations);
    const node = container("harness-lyrics", "");
    if (!lyricsRoot) lyricsRoot = createRoot(node);
    lyricsRoot.render(
      createElement(BraccatoLyrics, {
        lyrics,
        themeCss: ":host { --blyrics-font-size: 26px; --blyrics-translated-font-size: 17px; }",
        offsetMs: 0,
        passiveScroll: false,
        songwriters: parsed.songwriters,
        language: parsed.language,
      })
    );
    return { syncType: parsed.syncType, lines: parsed.lyrics.length };
  },

  /**
   * Mounts a TTML file carrying its own transliterations, resolved against a generated batch the
   * way useLyrics resolves it: generation fills only the lines the file left bare, and the
   * romanization toggle hides every romanized line when it is off.
   */
  mountLocalRomanizedLyrics(ttml: string, generated: (string | null)[], autoEnabled: boolean) {
    const durationMs = Math.max(1, audioEngine.duration) * 1000 || 12_000;
    const parsed = parseLyricsText(ttml, durationMs);
    const gaps = romanizationGaps(parsed.lyrics);
    const withGenerated = applyRomanization(
      parsed.lyrics,
      scatterRomanizations(parsed.lyrics.length, gaps, gaps.map(index => generated[index] ?? null))
    );
    const lyrics = autoEnabled ? withGenerated : stripRomanization(withGenerated);
    const node = container("harness-lyrics", "");
    if (!lyricsRoot) lyricsRoot = createRoot(node);
    lyricsRoot.render(
      createElement(BraccatoLyrics, {
        lyrics,
        themeCss: ":host { --blyrics-font-size: 26px; --blyrics-translated-font-size: 17px; }",
        offsetMs: 0,
        passiveScroll: false,
        songwriters: parsed.songwriters,
        language: parsed.language,
      })
    );
    return { syncType: parsed.syncType, lines: parsed.lyrics.length, gaps };
  },

  /** Mounts the production Now Playing lyrics page over the stub bridge. */
  mountLyricsView(options: HarnessLyricsOptions) {
    installLyricsHarnessBridge();
    if (options.candidates) lyricsHarness.candidates = options.candidates;
    if (options.settings) {
      lyricsHarness.settings = {
        ...lyricsHarness.settings,
        lyrics: { ...lyricsHarness.settings.lyrics, ...options.settings },
      };
      useSettings.setState({ settings: structuredClone(lyricsHarness.settings), loaded: true, error: null });
    } else if (!useSettings.getState().settings) {
      useSettings.setState({ settings: structuredClone(lyricsHarness.settings), loaded: true, error: null });
    }
    const track = makeHarnessTrack(options.track);
    lyricsViewTrack = track;
    const node = container("harness-lyrics-view", "harness-lyrics-view");
    if (!lyricsViewRoot) lyricsViewRoot = createRoot(node);
    lyricsViewRoot.render(
      createElement(LyricsView, {
        track,
        playing: false,
        fullscreen: false,
        onToggleFullscreen: () => undefined,
      })
    );
    return { trackId: track.id };
  },

  /**
   * Loads the harness tone into the shared audio element and parks the clock at `seconds`, so the
   * renderer highlights the line being sung instead of showing every word as upcoming (headless
   * Chromium cannot autoplay, and a paused element at 0 keeps the active-line styling off).
   */
  async seekLyricsPreview(seconds: number) {
    const element = audioEngine.element;
    if (!element.getAttribute("src")) {
      await audioEngine.load({ streamUrl: "/audio/tone.wav", title: "Harness tone" });
      await new Promise(resolve => {
        if (element.readyState >= 1) return resolve(null);
        element.addEventListener("loadedmetadata", () => resolve(null), { once: true });
        setTimeout(() => resolve(null), 2000);
      });
    }
    element.currentTime = seconds;
    element.dispatchEvent(new Event("timeupdate"));
    await new Promise(resolve => setTimeout(resolve, 250));
    return { position: element.currentTime, duration: element.duration };
  },

  /** Unmounts the page exactly as navigating to another tab does; the lyrics store survives. */
  unmountLyricsView() {
    lyricsViewRoot?.unmount();
    lyricsViewRoot = null;
    document.getElementById("harness-lyrics-view")?.remove();
    return { trackId: lyricsViewTrack?.id ?? null };
  },

  /** Reconfigures the stub providers between steps (delays, failures, chosen file, candidates). */
  configureLyrics(options: {
    candidates?: LyricsCandidate[];
    translationDelayMs?: number;
    romanizationDelayMs?: number;
    translationFailure?: boolean;
    romanizationFailure?: boolean;
    chosenFile?: string | null;
  }) {
    if (options.candidates) lyricsHarness.candidates = options.candidates;
    if (options.translationDelayMs !== undefined) lyricsHarness.translationDelayMs = options.translationDelayMs;
    if (options.romanizationDelayMs !== undefined) lyricsHarness.romanizationDelayMs = options.romanizationDelayMs;
    if (options.translationFailure !== undefined) lyricsHarness.translationFailure = options.translationFailure;
    if (options.romanizationFailure !== undefined) lyricsHarness.romanizationFailure = options.romanizationFailure;
    if (options.chosenFile !== undefined) lyricsHarness.chosenFile = options.chosenFile;
    return this.lyricsState();
  },

  /** Changes lyrics settings through the production settings store, as the Settings page does. */
  async patchLyricsSettings(patch: Partial<LyricsSettings>) {
    await useSettings.getState().patch({ lyrics: patch });
    return structuredClone(useSettings.getState().settings?.lyrics ?? lyricsHarness.settings.lyrics);
  },

  /** The store and provider call counters, for assertions about what the pipeline actually did. */
  lyricsState() {
    const state = useLyricsStore.getState();
    return {
      status: state.status,
      activeSource: state.activeSource,
      translating: state.translating,
      romanizing: state.romanizing,
      translatedLanguage: state.translatedLanguage,
      error: state.error,
      lineCount: state.lyrics?.length ?? 0,
      lines:
        state.lyrics?.map(line => ({
          words: line.words,
          romanization: line.romanization ?? null,
          timedRomanization: line.timedRomanization?.map(part => part.words) ?? null,
          translation: line.translation?.text ?? null,
        })) ?? [],
      parsedLanguage: state.parsed?.language ?? null,
      settings: structuredClone(useSettings.getState().settings?.lyrics ?? lyricsHarness.settings.lyrics),
      calls: {
        resolve: lyricsHarness.resolveCalls,
        translate: structuredClone(lyricsHarness.translateCalls),
        romanize: structuredClone(lyricsHarness.romanizeCalls),
      },
    };
  },

  async mountShaders() {
    const node = container("harness-shaders", "kawarp-bg");
    if (!shaderRoot) shaderRoot = createRoot(node);
    shaderRoot.render(
      createElement(KawarpBackground, {
        artworkUrl: "/fixture/cover.png",
        settings: shaderSettings,
        playing: !audioEngine.paused,
        onError: (message: string) => shaderErrors.push(message),
      })
    );
    return true;
  },
};

declare global {
  interface Window {
    __cadenceHarness?: typeof harness;
  }
}

window.__cadenceHarness = harness;
