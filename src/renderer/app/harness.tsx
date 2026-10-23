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
  stripGeneratedRomanization,
} from "../features/lyrics/parseLyrics";
import { BraccatoLyrics } from "../features/lyrics/BraccatoLyrics";
import { KawarpBackground } from "../features/shaders/KawarpBackground";
import type { ShaderSettings } from "../../shared/types";

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
   * way useLyrics resolves it: generation fills only the lines the file left bare, and with
   * generation off the file's romanization still stands.
   */
  mountLocalRomanizedLyrics(ttml: string, generated: (string | null)[], autoEnabled: boolean) {
    const durationMs = Math.max(1, audioEngine.duration) * 1000 || 12_000;
    const parsed = parseLyricsText(ttml, durationMs);
    const gaps = romanizationGaps(parsed.lyrics);
    const withGenerated = applyRomanization(
      parsed.lyrics,
      scatterRomanizations(parsed.lyrics.length, gaps, gaps.map(index => generated[index] ?? null))
    );
    const lyrics = autoEnabled ? withGenerated : stripGeneratedRomanization(withGenerated, parsed.lyrics);
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
