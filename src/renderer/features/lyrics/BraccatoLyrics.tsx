/**
 * React mount for the upstream lyrics renderer.
 *
 * The renderer is the published `@braccato/core` custom element — the same `<braccato-lyrics>`
 * Better Lyrics builds its lyrics view from — with a render-only patch documented in UPSTREAM.md.
 * This file binds it to Cadence's audio element, pushes settings into its public properties, and
 * hangs each line's translation and romanization off its built element with the renderer's own
 * injectors, as upstream does.
 * Written for Cadence.
 */

import { createElement, useEffect, useLayoutEffect, useRef } from "react";
import "@braccato/core/element";
import "@braccato/core/styles/variables.css";
import "@braccato/core/styles/lyrics.css";
import "@braccato/core/styles/instrumental.css";
import { injectRomanization, injectTranslation, type Lyric, type LyricsRenderer } from "@braccato/core";
import type { LyricsSyncType } from "../../../shared/types";
import { audioEngine } from "../../audio/engine";
import { MOTION_DURATION_MS } from "../../app/motion";
import { useReducedMotion } from "../../app/useMotionPreference";
import type { RemotePlaybackClockSource } from "../../player/playbackClock";
import { shouldCrossfadeUpgrade, type LyricsRenderIdentity } from "./upgrade";

export interface BraccatoLyricsProps {
  lyrics: Lyric[] | null;
  /** Identity used only to distinguish a track change from a same-track source upgrade. */
  trackId?: LyricsRenderIdentity["trackId"];
  /** Provider/source identity for the payload, used to time the upgrade crossfade. */
  sourceKey?: string | null;
  themeCss: string;
  offsetMs: number;
  passiveScroll: boolean;
  /** Keep the built lines, but stop rendering/ticking while the lyrics panel is hidden. */
  active?: boolean;
  /** The chosen font, so a change can re-measure line positions taken with the old metrics. */
  fontFamily?: string;
  layout?: "scroll" | "stage";
  songwriters?: readonly string[];
  language?: string | null;
  loaderVisible?: boolean;
  noLyrics?: boolean;
  className?: string;
  /**
   * External clock for a provider player with no HTML media element.
   * When supplied, the local audio element is deliberately not bound and the element's documented
   * manual `currentTime` / `playing` properties are driven from this source instead.
   */
  remoteClockSource?: RemotePlaybackClockSource | null;
  onLoaded?: (detail: { lineCount: number; syncType: LyricsSyncType }) => void;
  onError?: (message: string) => void;
  onScrollState?: (userScrolling: boolean) => void;
  onLineClick?: (timeS: number) => void;
}

/**
 * Hangs the translation and romanization a lyric carries off the line the renderer built for it, the
 * way upstream Better Lyrics does in `applyLyricDecorations` (src/modules/lyrics/lyricDecorations.ts):
 * the renderer never reads the `translation` / `romanization` fields itself, so each one is injected
 * into its line's element as a `.blyrics--romanized` / `.blyrics--translated` block under the original
 * line, and the renderer is then asked to re-measure (`lyricsElementAdded` upstream) so scroll targets
 * follow the taller lines. Romanization is injected first; `injectTranslation` appends and
 * `injectRomanization` inserts before a translation, so romanization sits above translation.
 */
function applyLineDecorations(
  element: BraccatoElement,
  lyrics: readonly Lyric[] | null,
  tick: MotionPolicy
): void {
  const renderer = element.renderer;
  if (!renderer || !lyrics || lyrics.length === 0) return;
  const doc = element.ownerDocument;
  const lines = renderer.lines;
  let decorated = false;
  lyrics.forEach((lyric, index) => {
    // Instrumental and blank lines carry no words to hang secondary text off (upstream skips them too).
    if (lyric.isInstrumental || !lyric.words?.trim()) return;
    const line = lines[index];
    if (!line) return;
    if (lyric.romanization) {
      // Timed romanization comes from the lyrics file alongside the plain text; hand it over so the
      // file's word timing survives instead of being flattened (upstream passes it the same way).
      injectRomanization(doc, line.lyricElement, line, lyric.romanization, lyric.timedRomanization ?? null);
      decorated = true;
    }
    const translation = lyric.translation?.text
      ? lyric.translation
      : Object.entries(lyric.translations ?? {})
          .filter(([, text]) => text?.trim())
          .map(([lang, text]) => ({ text, lang }))[0];
    if (translation?.text) {
      injectTranslation(doc, line.lyricElement, translation.text, translation.lang);
      decorated = true;
    }
  });
  if (!decorated || !tick.active || document.hidden) return;
  // Port of upstream `lyricsElementAdded()` + `retickMainView()`: re-measure on the next frame, then
  // render again against the last player snapshot so lines the decorations moved ease into place.
  renderer.scheduleLyricPositionUpdate(
    () => element.isConnected,
    () => {
      renderer.retickFromPlaybackClock((eventCreationTime, isPlaying) => ({
        ...lyricTick(tick, false), eventCreationTime, isPlaying,
      }));
    }
  );
}

type BraccatoElement = HTMLElement & {
  lyrics: Lyric[] | null;
  lyricsOptions: Record<string, unknown>;
  theme: string;
  layout: "scroll" | "stage";
  source: HTMLMediaElement | string | null;
  mediaElement: HTMLMediaElement | null;
  currentTime: number;
  playing: boolean;
  tickOptions: Record<string, unknown>;
  renderer: LyricsRenderer | null;
  status: string;
};

interface MotionPolicy {
  offsetMs: number;
  passiveScroll: boolean;
  reduced: boolean;
  active: boolean;
}

function lyricTick(policy: MotionPolicy, smooth = true, active = policy.active) {
  return {
    globalLyricOffset: policy.offsetMs / 1000,
    passiveScrollEnabled: active && policy.passiveScroll && !policy.reduced,
    smoothScroll: active && smooth && !policy.reduced,
  };
}

/** Suspend only rendering when there is nothing to paint; on reveal the same media element
 * supplies the current position. This never changes playback or the lyric timestamps. */
function bindLyricMedia(element: BraccatoElement, policy: () => MotionPolicy, onError: (message: string) => void) {
  const bind = (source: HTMLAudioElement | null) => {
    if (element.source === source) return;
    try {
      element.tickOptions = lyricTick(policy(), false, Boolean(source));
      element.source = source;
      if (source) element.tickOptions = lyricTick(policy());
      else if (element.isConnected) element.playing = false;
    } catch (error) {
      onError(`source: ${(error as Error).message}`);
    }
  };
  const onVisibility = () => bind(document.hidden ? null : audioEngine.element);
  const unsubscribe = audioEngine.on("source", ({ element: source }) => { if (!document.hidden) bind(source); });
  onVisibility();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisibility);
    bind(null);
  };
}

/** Shared identity so a cleared panel never re-triggers the assignment effect on every render. */
const CLEARED_LYRICS: Lyric[] = [];

export function BraccatoLyrics({
  lyrics,
  trackId = null,
  sourceKey = null,
  themeCss,
  offsetMs,
  passiveScroll,
  active = true,
  fontFamily,
  layout = "scroll",
  songwriters,
  language,
  loaderVisible = false,
  noLyrics = false,
  className,
  remoteClockSource = null,
  onLoaded,
  onError,
  onScrollState,
  onLineClick,
}: BraccatoLyricsProps) {
  const ref = useRef<BraccatoElement | null>(null);
  const reduced = useReducedMotion();
  const measuredFont = useRef(fontFamily);
  const callbacks = useRef({ onLoaded, onError, onScrollState, onLineClick });
  callbacks.current = { onLoaded, onError, onScrollState, onLineClick };
  // The decoration pass reads the latest lyrics and tick settings, so it can run from the element's
  // own build events (which fire while a lyrics assignment is still on the stack) as well as from the
  // effect that assigns them.
  const latest = useRef({ lyrics, offsetMs, passiveScroll, reduced, active });
  latest.current = { lyrics, offsetMs, passiveScroll, reduced, active };
  const decorate = useRef(() => {
    const element = ref.current;
    if (!element) return;
    applyLineDecorations(element, latest.current.lyrics, latest.current);
  });
  const renderedIdentity = useRef<LyricsRenderIdentity | null>(null);
  const renderedLyrics = useRef<Lyric[] | null>(null);
  const upgradeTimer = useRef<number | undefined>(undefined);

  // Same-track source upgrades get one short opacity dip. This must be a layout effect: it
  // runs after React commits the new props but before the passive effect below assigns the
  // new payload to the upstream element, so the old lines start the dip and the replacement
  // lands inside it. Neither the renderer's clock nor its scroll state is touched.
  useLayoutEffect(() => {
    const next: LyricsRenderIdentity = {
      trackId,
      source: sourceKey,
      hasLyrics: Boolean(lyrics?.length),
    };
    const element = ref.current;
    const payloadChanged = renderedLyrics.current !== lyrics;
    if (element && active && !reduced && !document.hidden && payloadChanged && shouldCrossfadeUpgrade(renderedIdentity.current, next)) {
      if (upgradeTimer.current !== undefined) window.clearTimeout(upgradeTimer.current);
      delete element.dataset.upgrading;
      void element.offsetWidth;
      element.dataset.upgrading = "true";
      upgradeTimer.current = window.setTimeout(() => {
        delete element.dataset.upgrading;
        upgradeTimer.current = undefined;
      }, MOTION_DURATION_MS.surface);
    }
    renderedIdentity.current = next;
    renderedLyrics.current = lyrics;
  }, [lyrics, sourceKey, trackId, reduced, active]);

  useEffect(
    () => () => {
      if (upgradeTimer.current !== undefined) window.clearTimeout(upgradeTimer.current);
    },
    []
  );

  // The Braccato element, not React, owns the per-frame clock while a media element is bound.
  // With gapless/crossfade decks the active media element can be promoted, so rebind on that
  // explicit engine event; ordinary cuts keep the same element and do not rebind. A remote
  // clock source is the one exception: it means "no media element exists", so nothing local is
  // bound and the manual-clock effect below is authoritative.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const handleLoaded = (event: Event) => {
      const detail = (event as CustomEvent<{ lineCount: number; syncType: LyricsSyncType }>).detail;
      // The lines were just (re)built — a fresh song, a theme rebuild — so any decorations the old
      // elements carried are gone and must be hung on the new ones.
      decorate.current();
      callbacks.current.onLoaded?.(detail);
    };
    const handleError = (event: Event) => {
      const detail = (event as CustomEvent<{ phase: string; error: Error }>).detail;
      callbacks.current.onError?.(`${detail?.phase ?? "lyrics"}: ${detail?.error?.message ?? "unknown error"}`);
    };
    const handleScroll = (event: Event) => {
      const detail = (event as CustomEvent<{ userScrolling: boolean }>).detail;
      callbacks.current.onScrollState?.(Boolean(detail?.userScrolling));
    };
    const handleLineClick = (event: Event) => {
      const detail = (event as CustomEvent<{ timeS: number }>).detail;
      if (Number.isFinite(detail?.timeS)) callbacks.current.onLineClick?.(Math.max(0, detail.timeS));
    };

    element.addEventListener("braccato:lyrics-loaded", handleLoaded);
    element.addEventListener("braccato:error", handleError);
    element.addEventListener("braccato:scroll-state", handleScroll);
    element.addEventListener("braccato:line-click", handleLineClick);

    const unbind = active && !remoteClockSource
      ? bindLyricMedia(element, () => latest.current, message => callbacks.current.onError?.(message))
      : undefined;

    return () => {
      unbind?.();
      element.removeEventListener("braccato:lyrics-loaded", handleLoaded);
      element.removeEventListener("braccato:error", handleError);
      element.removeEventListener("braccato:scroll-state", handleScroll);
      element.removeEventListener("braccato:line-click", handleLineClick);
    };
  }, [remoteClockSource, active]);

  // Manual clock adapter for an external provider clock. The provider is sampled by its
  // owner; between samples this effect projects the last sample at the provider playback rate
  // and writes the custom element's documented clock properties directly (no React state and
  // no fabricated HTMLAudioElement). Paused/ended samples write once and stop the frame loop.
  useEffect(() => {
    const element = ref.current;
    if (!element || !remoteClockSource || !active) return;

    let frame: number | undefined;
    let stopped = false;

    const writeClock = () => {
      const projected = remoteClockSource.projectedAt();
      element.tickOptions = { ...lyricTick(latest.current), playbackRate: projected.playbackRate };
      element.currentTime = projected.currentTime;
      if (element.playing !== projected.isPlaying) element.playing = projected.isPlaying;
    };

    const schedule = () => {
      if (stopped || document.hidden || frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        if (stopped || document.hidden || !element.isConnected) return;
        writeClock();
        if (remoteClockSource.getSnapshot().isPlaying) schedule();
      });
    };

    const update = () => {
      if (document.hidden) {
        if (frame !== undefined) window.cancelAnimationFrame(frame);
        frame = undefined;
        element.tickOptions = lyricTick(latest.current, false, false);
        element.playing = false;
        return;
      }
      writeClock();
      if (remoteClockSource.getSnapshot().isPlaying) {
        schedule();
      } else if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
        frame = undefined;
      }
    };
    const unsubscribe = remoteClockSource.subscribe(update);
    document.addEventListener("visibilitychange", update);
    update();

    return () => {
      stopped = true;
      unsubscribe();
      document.removeEventListener("visibilitychange", update);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      try {
        element.tickOptions = lyricTick(latest.current, false, false);
        element.playing = false;
      } catch {
        /* The element may already be disconnected. */
      }
    };
  }, [remoteClockSource, active]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.tickOptions = lyricTick(latest.current);
  }, [offsetMs, passiveScroll, reduced]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const theme = `${themeCss}\n/* cadence-reduced: ${reduced} */`;
    if (element.theme !== theme) element.theme = theme;
  }, [themeCss, reduced]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.layout !== layout) element.layout = layout;
  }, [layout]);

  // Line positions, and every scroll target derived from them, were measured with the previous
  // font's metrics. The renderer re-measures by itself only when the container changes size, which
  // a font whose lines swap height without changing the total does not do, so ask it directly.
  useEffect(() => {
    if (measuredFont.current === fontFamily) return;
    measuredFont.current = fontFamily;
    ref.current?.renderer?.relayout();
  }, [fontFamily]);

  // A resize re-measures the renderer and arms a rescroll, but its media frame loop is
  // stopped while paused. Without a tick, the active line can therefore keep the old
  // size's scroll position until playback or a seek happens. Ask for the renderer's
  // existing position update after the scrollport settles on a new size; this neither
  // moves the audio clock nor replaces the renderer's own scroll calculation.
  useEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof ResizeObserver === "undefined") return;
    const scrollport = element.parentElement ?? element;
    let lastSize: { width: number; height: number } | null = null;
    let frame: number | undefined;

    const observer = new ResizeObserver(entries => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      if (
        lastSize &&
        Math.abs(rect.width - lastSize.width) < 1 &&
        Math.abs(rect.height - lastSize.height) < 1
      ) {
        return;
      }
      const firstObservation = lastSize === null;
      lastSize = { width: rect.width, height: rect.height };
      if (firstObservation) return;

      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        const renderer = element.renderer;
        if (!renderer || !element.isConnected || document.hidden) return;
        renderer.scheduleLyricPositionUpdate(
          () => element.isConnected,
          () => {
            renderer.retickFromPlaybackClock((eventCreationTime, isPlaying) => ({
              ...lyricTick(latest.current, false), eventCreationTime, isPlaying,
            }));
          }
        );
      });
    });
    observer.observe(scrollport);
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [active]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.lyricsOptions = {
      loaderVisible,
      noLyrics,
      songwriters: songwriters ?? [],
      language: language ?? null,
    };
    // Empty array is the renderer's way to say "cleared"; null says "never given one", which the
    // renderer answers by keeping what it already shows. A finished resolve that found nothing must
    // clear, or the previous track's lines stay on screen behind the "No lyrics found" panel.
    element.lyrics = lyrics && lyrics.length > 0 ? lyrics : lyrics || noLyrics ? CLEARED_LYRICS : null;
    // The build above is synchronous and already fired the loaded handler, which decorated the new
    // lines; this second pass covers an assignment the element took without rebuilding (it keeps the
    // injectors' own duplicate guards from ever running twice on one element).
    decorate.current();
  }, [lyrics, loaderVisible, noLyrics, songwriters, language]);

  return createElement("braccato-lyrics", {
    ref: (node: HTMLElement | null) => {
      ref.current = node as BraccatoElement | null;
    },
    class: className,
    "data-lyrics-reduced": reduced || undefined,
    "data-testid": "braccato-lyrics",
  });
}
