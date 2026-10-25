/**
 * PORTED FROM UPSTREAM — Better Lyrics Shaders
 * Repository: https://github.com/better-lyrics/shaders
 * Commit:     d878877cb225e1bcfef205c2937141a26112ebec
 * Original:   contents/lib/audioGraph.ts (analysis loop) + contents/lib/audioBridge.ts (clamping)
 * License:    GPL-3.0
 *
 * Changes for Cadence:
 *  - The extension runs this in a page-world script that talks to the isolated content script over
 *    `window.postMessage`, because YouTube's media element lives in another world. Cadence owns the
 *    media element, so the same graph is built directly and the message bridge is gone.
 *  - The analyser is created against Cadence's audio element (see audio/engine.ts) instead of
 *    querying YouTube Music's player DOM.
 *  - Signal path is unchanged: fftSize 1024, smoothing 0.8, peak of the time-domain buffer with
 *    volume compensation, sampled every 100 ms, and the same clamp ranges for the multipliers.
 */

import {
  DEFAULT_DYNAMIC_MULTIPLIERS,
  type DynamicMultipliers,
} from "../../../shared/upstream/shaders/gradientSettings";

export interface AnalysisSettings {
  audioResponsive: boolean;
  audioBeatThreshold: number;
  audioSpeedMultiplier: number;
  kawarpAudioScaleBoost: number;
}

const ANALYSIS_INTERVAL = 100;
const MIN_VOLUME_FOR_ANALYSIS = 0.005;
const ANALYSER_FFT_SIZE = 1024;
const ANALYSER_SMOOTHING = 0.8;

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  audioResponsive: true,
  audioBeatThreshold: 0.75,
  audioSpeedMultiplier: 4,
  kawarpAudioScaleBoost: 2,
};

const clampToAuthorizedRange = (value: number, ceiling: number): number =>
  Math.min(Math.max(value, 1), Math.max(ceiling, 1));

/** Ported clamp used before a beat reaches the renderer. */
export function clampBeatMultipliers(
  beat: DynamicMultipliers,
  settings: AnalysisSettings | null
): DynamicMultipliers {
  if (!settings) return DEFAULT_DYNAMIC_MULTIPLIERS;
  return {
    isBeat: settings.audioResponsive && beat.isBeat,
    speedMultiplier: clampToAuthorizedRange(beat.speedMultiplier, settings.audioSpeedMultiplier),
    scaleMultiplier: clampToAuthorizedRange(beat.scaleMultiplier, 1 + settings.kawarpAudioScaleBoost / 100),
  };
}

/**
 * Reads a time-domain buffer and reports the frame's peak amplitude, compensating for the media
 * element's own volume so the effect reacts to the song rather than to the volume slider.
 */
export function peakAmplitude(
  data: Uint8Array<ArrayBuffer>,
  volume: number,
  threshold: number
): { peak: number; isBeat: boolean } {
  const volumeMultiplier = volume > MIN_VOLUME_FOR_ANALYSIS ? 1 / volume : 1;
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const amplitude = (Math.abs(data[i] - 128) / 128) * volumeMultiplier;
    if (amplitude > peak) {
      peak = amplitude;
      if (peak > threshold) break;
    }
  }
  return { peak, isBeat: peak > threshold };
}

export interface BeatAnalyserDeps {
  getAnalyser: () => AnalyserNode | null;
  getVolume: () => number;
  requestFrame: (callback: (timestamp: number) => void) => number;
  cancelFrame: (handle: number) => void;
}

export class BeatAnalyser {
  private settings: AnalysisSettings = { ...DEFAULT_ANALYSIS_SETTINGS };
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private rafId: number | null = null;
  private analysisRequested = false;
  private lastAnalysisTime = 0;
  private listeners = new Set<(multipliers: DynamicMultipliers) => void>();
  private readonly multipliers: DynamicMultipliers = { ...DEFAULT_DYNAMIC_MULTIPLIERS };

  constructor(private readonly deps: BeatAnalyserDeps) {}

  subscribe(listener: (multipliers: DynamicMultipliers) => void): () => void {
    this.listeners.add(listener);
    if (this.analysisRequested && this.rafId === null) {
      this.lastAnalysisTime = 0;
      this.rafId = this.deps.requestFrame(this.frame);
    }
    return () => {
      this.listeners.delete(listener);
      // Browsing pages have no shader subscribers; do not sample audio in the background there.
      if (this.listeners.size === 0 && this.rafId !== null) {
        this.deps.cancelFrame(this.rafId);
        this.rafId = null;
      }
    };
  }

  configure(settings: AnalysisSettings): void {
    this.settings = { ...settings };
  }

  getSettings(): AnalysisSettings {
    return this.settings;
  }

  start(): void {
    this.analysisRequested = true;
    if (this.rafId !== null || this.listeners.size === 0) return;
    this.lastAnalysisTime = 0;
    this.rafId = this.deps.requestFrame(this.frame);
  }

  stop(): void {
    this.analysisRequested = false;
    if (this.rafId === null) return;
    this.deps.cancelFrame(this.rafId);
    this.rafId = null;
  }

  private frame = (timestamp: number): void => {
    if (this.listeners.size === 0) {
      this.rafId = null;
      return;
    }
    const analyser = this.deps.getAnalyser();
    if (!analyser) {
      this.rafId = null;
      return;
    }

    if (!this.dataArray || this.dataArray.length !== analyser.frequencyBinCount) {
      this.dataArray = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    }

    if (timestamp - this.lastAnalysisTime >= ANALYSIS_INTERVAL) {
      analyser.getByteTimeDomainData(this.dataArray);
      const { isBeat } = peakAmplitude(this.dataArray, this.deps.getVolume(), this.settings.audioBeatThreshold);
      const scaleBoost = this.settings.kawarpAudioScaleBoost;

      const next = {
        isBeat: this.settings.audioResponsive && isBeat,
        speedMultiplier: this.settings.audioResponsive && isBeat ? this.settings.audioSpeedMultiplier : 1,
        scaleMultiplier: this.settings.audioResponsive && isBeat ? 1 + scaleBoost / 100 : 1,
      };
      this.multipliers.isBeat = next.isBeat;
      this.multipliers.speedMultiplier = next.speedMultiplier;
      this.multipliers.scaleMultiplier = next.scaleMultiplier;

      const clamped = clampBeatMultipliers(this.multipliers, this.settings);
      for (const listener of this.listeners) listener(clamped);
      this.lastAnalysisTime = timestamp;
    }

    this.rafId = this.deps.requestFrame(this.frame);
  };
}
