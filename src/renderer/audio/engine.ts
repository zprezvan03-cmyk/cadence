/**
 * Cadence audio engine.
 *
 * One HTMLAudioElement is the playback authority: the lyrics renderer binds to it directly, so
 * seeking, pausing, rate changes and track changes are read from the same clock the sound comes
 * from. A Web Audio analyser sits on the same element (through a MediaElementAudioSourceNode) and
 * drives the ported Better Lyrics Shaders beat analysis.
 *
 * Decoding is Chromium's: FLAC, MP3, AAC/M4A, WAV, Ogg Vorbis and Opus all play through the same
 * element with no native codec dependency. Written for Cadence.
 */

import { BeatAnalyser, type AnalysisSettings } from "../upstream/shaders/beatAnalysis";
import type { DynamicMultipliers } from "../../shared/upstream/shaders/gradientSettings";

export interface AudioEngineEvents {
  time: { position: number; duration: number; buffered: number };
  state: { playing: boolean; buffering: boolean; ended: boolean };
  error: { code: number | null; message: string; fatal: boolean };
  metadata: { duration: number };
  volume: { volume: number; muted: boolean };
  rate: { rate: number };
  analyser: { analyser: AnalyserNode; context: AudioContext };
}

type Listener<K extends keyof AudioEngineEvents> = (payload: AudioEngineEvents[K]) => void;

const ERROR_MESSAGES: Record<number, string> = {
  1: "Playback aborted",
  2: "Network error while reading the file",
  3: "The file could not be decoded",
  4: "This audio format is not supported by the built-in decoder",
};

export class AudioEngine {
  readonly element: HTMLAudioElement;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private listeners = new Map<keyof AudioEngineEvents, Set<(payload: never) => void>>();
  private frameHandle: number | null = null;
  private lastEmit = 0;
  private beatAnalyser: BeatAnalyser;
  private buffering = false;

  constructor() {
    const element = document.createElement("audio");
    element.id = "cadence-audio-element";
    element.preload = "auto";
    // The media protocol answers with `Access-Control-Allow-Origin: *`; without this flag Chromium
    // treats the stream as opaque and Web Audio would see silence.
    element.crossOrigin = "anonymous";
    element.style.display = "none";
    document.body.appendChild(element);
    this.element = element;

    this.beatAnalyser = new BeatAnalyser({
      getAnalyser: () => this.analyser,
      getVolume: () => this.element.volume,
      requestFrame: callback => requestAnimationFrame(callback),
      cancelFrame: handle => cancelAnimationFrame(handle),
    });

    element.addEventListener("timeupdate", () => this.emitTime());
    element.addEventListener("durationchange", () => {
      this.emit("metadata", { duration: Number.isFinite(element.duration) ? element.duration : 0 });
      this.emitTime();
    });
    element.addEventListener("loadedmetadata", () => {
      this.emit("metadata", { duration: Number.isFinite(element.duration) ? element.duration : 0 });
      this.emitTime();
    });
    element.addEventListener("play", () => {
      this.ensureGraph();
      this.emit("state", { playing: true, buffering: this.buffering, ended: false });
      this.startFrameLoop();
    });
    element.addEventListener("playing", () => {
      this.buffering = false;
      this.emit("state", { playing: true, buffering: false, ended: false });
    });
    element.addEventListener("pause", () => {
      this.emit("state", { playing: false, buffering: false, ended: element.ended });
      this.stopFrameLoop();
      this.emitTime();
    });
    element.addEventListener("waiting", () => {
      this.buffering = true;
      this.emit("state", { playing: !element.paused, buffering: true, ended: false });
    });
    element.addEventListener("ended", () => {
      this.emit("state", { playing: false, buffering: false, ended: true });
      this.stopFrameLoop();
      this.emitTime();
    });
    element.addEventListener("error", () => {
      const code = element.error?.code ?? null;
      const message = code ? ERROR_MESSAGES[code] ?? "Unknown playback error" : "Playback failed";
      this.emit("error", { code, message, fatal: true });
      this.emit("state", { playing: false, buffering: false, ended: false });
      this.stopFrameLoop();
    });
    element.addEventListener("volumechange", () => {
      this.emit("volume", { volume: element.volume, muted: element.muted });
    });
    element.addEventListener("ratechange", () => this.emit("rate", { rate: element.playbackRate }));
  }

  // ----------------------------------------------------------------- events

  on<K extends keyof AudioEngineEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => set?.delete(listener as (payload: never) => void);
  }

  private emit<K extends keyof AudioEngineEvents>(event: K, payload: AudioEngineEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) (listener as (payload: AudioEngineEvents[K]) => void)(payload);
  }

  private emitTime(): void {
    const duration = Number.isFinite(this.element.duration) ? this.element.duration : 0;
    let buffered = 0;
    try {
      if (this.element.buffered.length > 0) {
        buffered = this.element.buffered.end(this.element.buffered.length - 1);
      }
    } catch {
      buffered = 0;
    }
    this.emit("time", { position: this.element.currentTime, duration, buffered });
  }

  private startFrameLoop(): void {
    if (this.frameHandle !== null) return;
    const tick = (timestamp: number) => {
      if (timestamp - this.lastEmit > 100) {
        this.lastEmit = timestamp;
        this.emitTime();
      }
      if (this.element.paused) {
        this.frameHandle = null;
        return;
      }
      this.frameHandle = requestAnimationFrame(tick);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  private stopFrameLoop(): void {
    if (this.frameHandle === null) return;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  // ------------------------------------------------------------ audio graph

  /**
   * Builds the analyser lazily, on the first successful play, so the AudioContext is created from a
   * user gesture and starts running rather than suspended.
   */
  ensureGraph(): void {
    if (this.context) {
      if (this.context.state === "suspended") void this.context.resume();
      return;
    }
    try {
      const context = new AudioContext();
      const source = context.createMediaElementSource(this.element);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyser.connect(context.destination);
      this.context = context;
      this.sourceNode = source;
      this.analyser = analyser;
      void context.resume();
      this.emit("analyser", { analyser, context });
    } catch (error) {
      // Analysis is an enhancement: playback keeps working without it.
      console.warn("[Cadence] Could not build the audio analyser:", error);
    }
  }

  getAnalyserContext(): AudioContext | null {
    return this.context;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  configureAnalysis(settings: AnalysisSettings): void {
    this.beatAnalyser.configure(settings);
  }

  startAnalysis(): void {
    this.beatAnalyser.start();
  }

  stopAnalysis(): void {
    this.beatAnalyser.stop();
  }

  subscribeBeat(listener: (multipliers: DynamicMultipliers) => void): () => void {
    return this.beatAnalyser.subscribe(listener);
  }

  /** Cheap RMS level, used by the Now Playing visualiser. */
  getLevel(): number {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const value = (data[i] - 128) / 128;
      sum += value * value;
    }
    return Math.sqrt(sum / data.length);
  }

  // -------------------------------------------------------------- playback

  async load(track: { streamUrl: string; title: string }): Promise<void> {
    this.buffering = true;
    this.emit("state", { playing: false, buffering: true, ended: false });
    this.element.src = track.streamUrl;
    this.element.load();
    this.emitTime();
  }

  async play(): Promise<void> {
    this.ensureGraph();
    try {
      await this.element.play();
    } catch (error) {
      const name = (error as Error).name;
      if (name === "AbortError") return; // superseded by a newer play() call
      // A rejected play() carries the element's own media error code when the source is at fault
      // (NotSupportedError for an undecodable file); keep it so callers can explain the failure.
      const mediaCode = this.element.error?.code ?? null;
      this.emit("error", {
        code: mediaCode,
        message: (error as Error).message || "Playback was blocked",
        fatal: mediaCode !== null && mediaCode >= 3,
      });
    }
  }

  pause(): void {
    this.element.pause();
  }

  async toggle(): Promise<void> {
    if (this.element.paused) await this.play();
    else this.pause();
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    const duration = Number.isFinite(this.element.duration) ? this.element.duration : seconds;
    this.element.currentTime = Math.max(0, Math.min(seconds, Math.max(0, duration - 0.05)));
    this.emitTime();
  }

  seekBy(delta: number): void {
    this.seek(this.element.currentTime + delta);
  }

  setVolume(volume: number): void {
    this.element.volume = Math.max(0, Math.min(1, volume));
  }

  setMuted(muted: boolean): void {
    this.element.muted = muted;
  }

  setRate(rate: number): void {
    this.element.playbackRate = Math.max(0.25, Math.min(4, rate));
  }

  get position(): number {
    return this.element.currentTime;
  }

  get duration(): number {
    return Number.isFinite(this.element.duration) ? this.element.duration : 0;
  }

  get paused(): boolean {
    return this.element.paused;
  }

  dispose(): void {
    this.stopFrameLoop();
    this.stopAnalysis();
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    void this.context?.close();
  }
}

/** One element for the whole renderer: a media element may only ever get one source node. */
export const audioEngine = new AudioEngine();
