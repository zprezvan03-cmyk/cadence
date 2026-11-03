/**
 * Cadence audio engine.
 *
 * The active HTMLAudioElement remains the playback authority: lyrics bind to that element, so
 * seeking, pausing, rate changes and track changes are read from the same clock the sound comes
 * from. A second, normally silent deck exists only for gapless preloads and crossfades. It is
 * promoted to active at the moment the incoming track genuinely starts; the outgoing deck is then
 * retired without emitting player events. Default cuts still load on the active deck exactly as
 * the original single-deck engine did.
 *
 * Both decks feed per-deck ReplayGain and fade gains, then a shared ten-band EQ and analyser.
 * Chromium decodes FLAC, MP3, AAC/M4A, WAV, Ogg Vorbis and Opus through these elements. For ALAC,
 * the Tauri host creates a lossless PCM WAV source first. Written for Cadence.
 */

import { BeatAnalyser, type AnalysisSettings } from "../upstream/shaders/beatAnalysis";
import type { DynamicMultipliers } from "../../shared/upstream/shaders/gradientSettings";
import type { EqualizerSettings } from "../../shared/types";
import { createEqualizerChain, type EqualizerChain } from "./equalizer";
import { resolvePlaybackSource } from "./playbackSource";

export interface AudioEngineEvents {
  time: { position: number; duration: number; buffered: number };
  state: { playing: boolean; buffering: boolean; ended: boolean };
  error: {
    code: number | null;
    message: string;
    mediaMessage?: string | null;
    src?: string;
    fatal: boolean;
  };
  metadata: { duration: number };
  volume: { volume: number; muted: boolean };
  rate: { rate: number };
  analyser: { analyser: AnalyserNode; context: AudioContext };
  source: { element: HTMLAudioElement };
}

export interface EngineTrack {
  streamUrl: string;
  title: string;
  path?: string;
  codec?: string | null;
}

export interface AudioLoadOptions {
  /** Linear ReplayGain multiplier for this track (1 = unchanged). */
  gain?: number;
}

export interface AudioTransitionOptions extends AudioLoadOptions {
  fadeSeconds?: number;
}

export interface AudioEngineDiagnostics {
  activeDeck: "a" | "b";
  graphBuilt: boolean;
  decks: Array<{
    deck: "a" | "b";
    active: boolean;
    src: string;
    paused: boolean;
    ended: boolean;
    currentTime: number;
    duration: number;
    readyState: number;
    replayGainLinear: number;
    fadeLinear: number;
    preloaded: boolean;
  }>;
  equalizer: ReturnType<EqualizerChain["describe"]> | null;
}

type Listener<K extends keyof AudioEngineEvents> = (payload: AudioEngineEvents[K]) => void;

interface Deck {
  readonly id: "a" | "b";
  readonly element: HTMLAudioElement;
  sourceNode: MediaElementAudioSourceNode | null;
  replayGainNode: GainNode | null;
  fadeNode: GainNode | null;
  replayGainLinear: number;
  fadeLinear: number;
  trackKey: string | null;
  resolvedUrl: string | null;
  retireTimer: number | null;
}

const ERROR_MESSAGES: Record<number, string> = {
  1: "Playback aborted",
  2: "Network error while reading the file",
  3: "The file could not be decoded",
  4: "This audio format is not supported by the built-in decoder",
};

const DEFAULT_EQUALIZER: EqualizerSettings = {
  enabled: false,
  preampDb: 0,
  bandsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  presetId: "flat",
};

function clampGain(value: number | undefined, fallback = 1): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(4, Math.max(0, value))
    : fallback;
}

function trackKey(track: EngineTrack): string {
  return JSON.stringify([track.path ?? "", track.streamUrl, track.codec ?? ""]);
}

export class AudioEngine {
  private readonly decks: [Deck, Deck];
  private activeDeckIndex: 0 | 1 = 0;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private equalizer: EqualizerChain | null = null;
  private equalizerSettings: EqualizerSettings = DEFAULT_EQUALIZER;
  private listeners = new Map<keyof AudioEngineEvents, Set<(payload: never) => void>>();
  private frameHandle: number | null = null;
  private lastEmit = 0;
  private beatAnalyser: BeatAnalyser;
  private buffering = false;
  private loadGeneration = 0;
  private preloadGeneration = 0;
  private volume = 1;
  private muted = false;
  private rate = 1;

  constructor() {
    this.decks = [this.createDeck("a"), this.createDeck("b")];
    for (const deck of this.decks) this.bindDeckEvents(deck);

    this.beatAnalyser = new BeatAnalyser({
      getAnalyser: () => this.analyser,
      getVolume: () => this.element.volume,
      requestFrame: callback => requestAnimationFrame(callback),
      cancelFrame: handle => cancelAnimationFrame(handle),
    });
  }

  /** The element cloned clocks/lyrics should follow right now. Its identity changes on a deck swap. */
  get element(): HTMLAudioElement {
    return this.activeDeck.element;
  }

  private get activeDeck(): Deck {
    return this.decks[this.activeDeckIndex];
  }

  private get standbyDeck(): Deck {
    return this.decks[this.activeDeckIndex === 0 ? 1 : 0];
  }

  private createDeck(id: "a" | "b"): Deck {
    const element = document.createElement("audio");
    element.id = id === "a" ? "cadence-audio-element" : "cadence-audio-element-standby";
    element.className = "cadence-audio-deck";
    element.dataset.deck = id;
    element.preload = "auto";
    // The media protocol answers with `Access-Control-Allow-Origin: *`; without this flag Chromium
    // treats the stream as opaque and Web Audio would see silence.
    element.crossOrigin = "anonymous";
    element.style.display = "none";
    document.body.appendChild(element);
    return {
      id,
      element,
      sourceNode: null,
      replayGainNode: null,
      fadeNode: null,
      replayGainLinear: 1,
      fadeLinear: id === "a" ? 1 : 0,
      trackKey: null,
      resolvedUrl: null,
      retireTimer: null,
    };
  }

  private bindDeckEvents(deck: Deck): void {
    const element = deck.element;
    const isActive = () => deck === this.activeDeck;

    element.addEventListener("timeupdate", () => {
      if (isActive()) this.emitTime();
    });
    element.addEventListener("durationchange", () => {
      if (!isActive()) return;
      this.emit("metadata", { duration: Number.isFinite(element.duration) ? element.duration : 0 });
      this.emitTime();
    });
    element.addEventListener("loadedmetadata", () => {
      if (!isActive()) return;
      this.emit("metadata", { duration: Number.isFinite(element.duration) ? element.duration : 0 });
      this.emitTime();
    });
    element.addEventListener("play", () => {
      if (!isActive()) return;
      this.ensureGraph();
      this.emit("state", { playing: true, buffering: this.buffering, ended: false });
      this.startFrameLoop();
    });
    element.addEventListener("playing", () => {
      if (!isActive()) return;
      this.buffering = false;
      this.emit("state", { playing: true, buffering: false, ended: false });
    });
    element.addEventListener("pause", () => {
      if (!isActive()) return;
      this.emit("state", { playing: false, buffering: this.buffering, ended: element.ended });
      this.stopFrameLoop();
      this.emitTime();
    });
    element.addEventListener("waiting", () => {
      if (!isActive()) return;
      this.buffering = true;
      this.emit("state", { playing: !element.paused, buffering: true, ended: false });
    });
    element.addEventListener("ended", () => {
      if (!isActive()) {
        this.retireDeck(deck);
        return;
      }
      this.emit("state", { playing: false, buffering: false, ended: true });
      this.stopFrameLoop();
      this.emitTime();
    });
    element.addEventListener("error", () => {
      if (!isActive()) {
        // A failed standby preload is not a playback failure yet; a later load/transition will
        // retry and surface the error if the user actually asks for that track.
        if (element.paused) {
          deck.trackKey = null;
          deck.resolvedUrl = null;
        }
        return;
      }
      const code = element.error?.code ?? null;
      const mediaMessage = element.error?.message || null;
      const src = element.currentSrc || element.getAttribute("src") || "";
      const message = code ? ERROR_MESSAGES[code] ?? "Unknown playback error" : "Playback failed";
      this.emit("error", { code, message, mediaMessage, src, fatal: true });
      this.emit("state", { playing: false, buffering: false, ended: false });
      this.stopFrameLoop();
    });
    element.addEventListener("volumechange", () => {
      if (isActive()) this.emit("volume", { volume: element.volume, muted: element.muted });
    });
    element.addEventListener("ratechange", () => {
      if (isActive()) this.emit("rate", { rate: element.playbackRate });
    });
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
   * Builds the Web Audio graph lazily, on the first successful play, so the AudioContext is
   * created from a user gesture and starts running rather than suspended.
   */
  ensureGraph(): void {
    if (this.context) {
      if (this.context.state === "suspended") void this.context.resume();
      return;
    }
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      const equalizer = createEqualizerChain(context);

      for (const deck of this.decks) {
        const source = context.createMediaElementSource(deck.element);
        const replayGain = context.createGain();
        const fade = context.createGain();
        replayGain.gain.value = deck.replayGainLinear;
        fade.gain.value = deck.fadeLinear;
        source.connect(replayGain);
        replayGain.connect(fade);
        fade.connect(equalizer.input);
        deck.sourceNode = source;
        deck.replayGainNode = replayGain;
        deck.fadeNode = fade;
      }
      equalizer.output.connect(analyser);
      analyser.connect(context.destination);

      this.context = context;
      this.analyser = analyser;
      this.equalizer = equalizer;
      equalizer.apply(this.equalizerSettings);
      void context.resume();
      this.emit("analyser", { analyser, context });
    } catch (error) {
      // Analysis/EQ are enhancements: direct media-element playback keeps working without them.
      console.warn("[Cadence] Could not build the Web Audio graph:", error);
    }
  }

  applyEqualizer(settings: EqualizerSettings): void {
    this.equalizerSettings = settings;
    this.equalizer?.apply(settings);
  }

  /** Sets ReplayGain on the currently active deck; a retiring deck keeps its own track's gain. */
  setTrackGain(linear: number): void {
    this.setDeckReplayGain(this.activeDeck, linear);
  }

  private setDeckReplayGain(deck: Deck, linear: number | undefined): void {
    deck.replayGainLinear = clampGain(linear, deck.replayGainLinear);
    if (deck.replayGainNode && this.context) {
      deck.replayGainNode.gain.setTargetAtTime(deck.replayGainLinear, this.context.currentTime, 0.03);
    }
  }

  private setDeckFade(deck: Deck, linear: number): void {
    deck.fadeLinear = Math.min(1, Math.max(0, linear));
    if (!deck.fadeNode || !this.context) return;
    const now = this.context.currentTime;
    deck.fadeNode.gain.cancelScheduledValues(now);
    deck.fadeNode.gain.setValueAtTime(deck.fadeLinear, now);
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

  /** Small read-only snapshot for browser diagnostics and regression harnesses. */
  describeGraph(): AudioEngineDiagnostics {
    return {
      activeDeck: this.activeDeck.id,
      graphBuilt: this.context !== null,
      decks: this.decks.map(deck => ({
        deck: deck.id,
        active: deck === this.activeDeck,
        src: deck.element.currentSrc || deck.element.getAttribute("src") || "",
        paused: deck.element.paused,
        ended: deck.element.ended,
        currentTime: deck.element.currentTime,
        duration: Number.isFinite(deck.element.duration) ? deck.element.duration : 0,
        readyState: deck.element.readyState,
        replayGainLinear: deck.replayGainNode?.gain.value ?? deck.replayGainLinear,
        fadeLinear: deck.fadeNode?.gain.value ?? deck.fadeLinear,
        preloaded: deck.trackKey !== null && deck.element.readyState >= 2,
      })),
      equalizer: this.equalizer?.describe() ?? null,
    };
  }

  // -------------------------------------------------------------- playback

  private applyDeckControls(deck: Deck): void {
    deck.element.volume = this.volume;
    deck.element.muted = this.muted;
    deck.element.playbackRate = this.rate;
  }

  private unloadDeck(deck: Deck): void {
    if (deck.retireTimer !== null) {
      window.clearTimeout(deck.retireTimer);
      deck.retireTimer = null;
    }
    deck.element.pause();
    deck.element.removeAttribute("src");
    deck.element.load();
    deck.trackKey = null;
    deck.resolvedUrl = null;
    this.setDeckFade(deck, 0);
  }

  private retireDeck(deck: Deck): void {
    if (deck === this.activeDeck) return;
    this.unloadDeck(deck);
  }

  async load(track: EngineTrack, options: AudioLoadOptions = {}): Promise<boolean> {
    const generation = ++this.loadGeneration;
    this.preloadGeneration++;
    const deck = this.activeDeck;
    const standby = this.standbyDeck;
    // A still-playing retiring deck belongs to the previous cut; legacy loads stop old audio now.
    // A paused standby preload is harmless and may still be the next queue entry, so keep it.
    if (!standby.element.paused) this.retireDeck(standby);

    this.buffering = true;
    this.emit("state", { playing: false, buffering: true, ended: false });
    this.setDeckReplayGain(deck, options.gain);
    this.setDeckFade(deck, 1);
    deck.trackKey = null;
    deck.resolvedUrl = null;
    deck.element.pause();
    deck.element.removeAttribute("src");
    deck.element.load();
    this.emitTime();

    try {
      const streamUrl = await resolvePlaybackSource(track);
      if (generation !== this.loadGeneration) return false;
      deck.element.src = streamUrl;
      deck.trackKey = trackKey(track);
      deck.resolvedUrl = streamUrl;
      this.applyDeckControls(deck);
      deck.element.load();
      this.emitTime();
      return true;
    } catch (error) {
      if (generation !== this.loadGeneration) return false;
      this.buffering = false;
      const reason = error instanceof Error ? error.message : String(error);
      this.emit("error", {
        code: null,
        message: `Could not prepare Apple Lossless audio: ${reason}`,
        mediaMessage: null,
        src: track.streamUrl,
        fatal: true,
      });
      this.emit("state", { playing: false, buffering: false, ended: false });
      this.emitTime();
      return false;
    }
  }

  /**
   * Starts the native decode for a track that is very likely to be played next, without touching
   * the current playback: the result lands in the on-disk WAV cache, so the actual `load()` is a
   * cache hit instead of another full decode. Non-ALAC tracks cost nothing — `resolvePlaybackSource`
   * returns the stream URL without calling the bridge.
   */
  prewarm(track: EngineTrack): void {
    void resolvePlaybackSource(track).catch(() => undefined);
  }

  private waitForCanPlay(deck: Deck, timeoutMs: number): Promise<boolean> {
    if (deck.element.error) return Promise.resolve(false);
    if (deck.element.readyState >= 3) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        deck.element.removeEventListener("canplay", onReady);
        deck.element.removeEventListener("loadeddata", onReady);
        deck.element.removeEventListener("error", onError);
        resolve(ready);
      };
      const onReady = () => finish(true);
      const onError = () => finish(false);
      const timer = window.setTimeout(() => finish(deck.element.readyState >= 2), timeoutMs);
      deck.element.addEventListener("canplay", onReady);
      deck.element.addEventListener("loadeddata", onReady);
      deck.element.addEventListener("error", onError);
    });
  }

  /**
   * Loads (but does not play) the likely next track on the standby deck. Used only when gapless
   * playback or crossfade is enabled; with both off, no second file is opened.
   */
  async preloadNext(track: EngineTrack): Promise<boolean> {
    const generation = ++this.preloadGeneration;
    const deck = this.standbyDeck;
    const key = trackKey(track);
    if (this.activeDeck.trackKey === key) return false;
    if (!deck.element.paused) return false; // a retiring deck is still audible; never hijack it
    if (deck.trackKey === key && deck.element.getAttribute("src")) {
      return this.waitForCanPlay(deck, 1500);
    }

    try {
      const streamUrl = await resolvePlaybackSource(track);
      if (generation !== this.preloadGeneration || deck !== this.standbyDeck || !deck.element.paused) {
        return false;
      }
      deck.element.src = streamUrl;
      deck.trackKey = key;
      deck.resolvedUrl = streamUrl;
      this.setDeckFade(deck, 0);
      this.applyDeckControls(deck);
      deck.element.load();
      return await this.waitForCanPlay(deck, 4000);
    } catch {
      return false;
    }
  }

  private async playDeck(deck: Deck, emitPublicError: boolean): Promise<boolean> {
    try {
      await deck.element.play();
      return !deck.element.paused && !deck.element.error;
    } catch (error) {
      const name = (error as Error).name;
      if (name === "AbortError") return false; // superseded by a newer transport action
      if (emitPublicError && deck === this.activeDeck) {
        const mediaCode = deck.element.error?.code ?? null;
        const mediaMessage = deck.element.error?.message || null;
        const src = deck.element.currentSrc || deck.element.getAttribute("src") || "";
        this.emit("error", {
          code: mediaCode,
          message: (error as Error).message || "Playback was blocked",
          mediaMessage,
          src,
          fatal: mediaCode !== null && mediaCode >= 3,
        });
      }
      return false;
    }
  }

  private scheduleCrossfade(incoming: Deck, outgoing: Deck, fadeSeconds: number): void {
    if (!this.context || !incoming.fadeNode || !outgoing.fadeNode) {
      this.setDeckFade(incoming, 1);
      this.retireDeck(outgoing);
      return;
    }

    const rate = Math.max(0.25, outgoing.element.playbackRate || this.rate || 1);
    const duration = Math.max(0.05, fadeSeconds / rate);
    const now = this.context.currentTime;
    const points = 33;
    const incomingCurve = new Float32Array(points);
    const outgoingCurve = new Float32Array(points);
    const outgoingStart = outgoing.fadeNode.gain.value;
    for (let index = 0; index < points; index++) {
      const progress = index / (points - 1);
      incomingCurve[index] = Math.sin((progress * Math.PI) / 2);
      outgoingCurve[index] = outgoingStart * Math.cos((progress * Math.PI) / 2);
    }

    incoming.fadeNode.gain.cancelScheduledValues(now);
    outgoing.fadeNode.gain.cancelScheduledValues(now);
    incoming.fadeNode.gain.setValueCurveAtTime(incomingCurve, now, duration);
    outgoing.fadeNode.gain.setValueCurveAtTime(outgoingCurve, now, duration);
    incoming.fadeLinear = 1;
    outgoing.fadeLinear = 0;

    if (outgoing.retireTimer !== null) window.clearTimeout(outgoing.retireTimer);
    outgoing.retireTimer = window.setTimeout(() => this.retireDeck(outgoing), (duration + 0.15) * 1000);
  }

  /**
   * Starts `track` on the standby deck and promotes it only after playback has genuinely begun.
   * Returns false without disturbing a still-playing outgoing track when preparation fails, so an
   * automatic end-of-track transition can fall back to the natural `ended` path.
   */
  async transitionTo(track: EngineTrack, options: AudioTransitionOptions = {}): Promise<boolean> {
    this.ensureGraph();
    if (!this.context) {
      const loaded = await this.load(track, options);
      if (!loaded) return false;
      await this.play();
      return !this.paused && !this.element.error;
    }

    const generation = ++this.loadGeneration;
    const outgoing = this.activeDeck;
    const incoming = this.standbyDeck;
    const key = trackKey(track);
    const fadeSeconds = Math.min(12, Math.max(0, options.fadeSeconds ?? 0));

    // Rapid skips can arrive while the standby deck is still fading out a previous track. Settle
    // that already-superseded audio immediately so the deck is available for the new request.
    if (!incoming.element.paused) this.retireDeck(incoming);

    this.setDeckReplayGain(incoming, options.gain);
    this.setDeckFade(incoming, fadeSeconds > 0 ? 0 : 1);

    try {
      if (incoming.trackKey !== key || !incoming.element.getAttribute("src")) {
        incoming.element.pause();
        incoming.element.removeAttribute("src");
        incoming.element.load();
        incoming.trackKey = null;
        incoming.resolvedUrl = null;
        const streamUrl = await resolvePlaybackSource(track);
        if (generation !== this.loadGeneration) return false;
        incoming.element.src = streamUrl;
        incoming.trackKey = key;
        incoming.resolvedUrl = streamUrl;
        this.applyDeckControls(incoming);
        incoming.element.load();
      } else {
        this.applyDeckControls(incoming);
      }

      const ready = await this.waitForCanPlay(incoming, fadeSeconds > 0 ? fadeSeconds * 1000 + 500 : 1500);
      if (generation !== this.loadGeneration) return false;
      if (!ready || incoming.element.error) return false;

      try {
        incoming.element.currentTime = 0;
      } catch {
        // A not-yet-seekable standby is already at its start; play() below is the real check.
      }
      const started = await this.playDeck(incoming, false);
      if (generation !== this.loadGeneration) {
        incoming.element.pause();
        return false;
      }
      if (!started) return false;

      const outgoingAudible = !outgoing.element.paused && !outgoing.element.ended;
      this.activeDeckIndex = this.decks.indexOf(incoming) as 0 | 1;
      this.buffering = false;
      this.emit("source", { element: incoming.element });
      this.emit("metadata", {
        duration: Number.isFinite(incoming.element.duration) ? incoming.element.duration : 0,
      });
      this.emit("state", { playing: true, buffering: false, ended: false });
      this.emitTime();
      this.startFrameLoop();

      if (fadeSeconds > 0 && outgoingAudible) {
        this.scheduleCrossfade(incoming, outgoing, fadeSeconds);
      } else {
        this.setDeckFade(incoming, 1);
        this.retireDeck(outgoing);
      }
      return true;
    } catch (error) {
      if (generation === this.loadGeneration && incoming !== this.activeDeck) {
        console.warn("[Cadence] Could not prepare a gapless/crossfade transition:", error);
        incoming.element.pause();
      }
      return false;
    }
  }

  async play(): Promise<void> {
    this.ensureGraph();
    await this.playDeck(this.activeDeck, true);
  }

  pause(): void {
    // Invalidate pending native ALAC preparation/preloads so a user pause, queue clear or shutdown
    // cannot attach a superseded result and unexpectedly start that track.
    this.loadGeneration++;
    this.preloadGeneration++;
    this.buffering = false;
    const standbyWasPlaying = !this.standbyDeck.element.paused;
    for (const deck of this.decks) deck.element.pause();
    // Pausing settles any in-flight crossfade: the promoted track stays current at full gain and
    // the already-superseded outgoing deck is discarded instead of resuming underneath it later.
    this.setDeckFade(this.activeDeck, 1);
    if (standbyWasPlaying) this.retireDeck(this.standbyDeck);
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
    this.volume = Math.max(0, Math.min(1, volume));
    for (const deck of this.decks) deck.element.volume = this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const deck of this.decks) deck.element.muted = muted;
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.25, Math.min(4, rate));
    for (const deck of this.decks) deck.element.playbackRate = this.rate;
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
    this.loadGeneration++;
    this.preloadGeneration++;
    this.buffering = false;
    this.stopFrameLoop();
    this.stopAnalysis();
    for (const deck of this.decks) this.unloadDeck(deck);
    void this.context?.close();
  }
}

/** One engine for the whole renderer: each media element may only ever get one source node. */
export const audioEngine = new AudioEngine();
