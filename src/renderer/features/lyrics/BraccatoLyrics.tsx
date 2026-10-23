/**
 * React mount for the upstream lyrics renderer.
 *
 * The renderer is the published `@braccato/core` custom element — the same `<braccato-lyrics>`
 * Better Lyrics builds its lyrics view from — used unmodified. This file binds it to Cadence's
 * audio element, pushes settings into its public properties, and hangs each line's translation and
 * romanization off its built element with the renderer's own injectors, as upstream does.
 * Written for Cadence.
 */

import { createElement, useEffect, useRef } from "react";
import "@braccato/core/element";
import "@braccato/core/styles/variables.css";
import "@braccato/core/styles/lyrics.css";
import "@braccato/core/styles/instrumental.css";
import { injectRomanization, injectTranslation, type Lyric, type LyricsRenderer } from "@braccato/core";
import type { LyricsSyncType } from "../../../shared/types";
import { audioEngine } from "../../audio/engine";

export interface BraccatoLyricsProps {
  lyrics: Lyric[] | null;
  themeCss: string;
  offsetMs: number;
  passiveScroll: boolean;
  /** The chosen font, so a change can re-measure line positions taken with the old metrics. */
  fontFamily?: string;
  layout?: "scroll" | "stage";
  songwriters?: readonly string[];
  language?: string | null;
  loaderVisible?: boolean;
  noLyrics?: boolean;
  className?: string;
  onLoaded?: (detail: { lineCount: number; syncType: LyricsSyncType }) => void;
  onError?: (message: string) => void;
  onScrollState?: (userScrolling: boolean) => void;
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
  tick: { offsetMs: number; passiveScroll: boolean }
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
      injectRomanization(doc, line.lyricElement, line, lyric.romanization);
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
  if (!decorated) return;
  // Port of upstream `lyricsElementAdded()` + `retickMainView()`: re-measure on the next frame, then
  // render again against the last player snapshot so lines the decorations moved ease into place.
  renderer.scheduleLyricPositionUpdate(
    () => element.isConnected,
    () => {
      renderer.retickFromPlaybackClock((eventCreationTime, isPlaying) => ({
        eventCreationTime,
        isPlaying,
        smoothScroll: false,
        globalLyricOffset: tick.offsetMs / 1000,
        passiveScrollEnabled: tick.passiveScroll,
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

export function BraccatoLyrics({
  lyrics,
  themeCss,
  offsetMs,
  passiveScroll,
  fontFamily,
  layout = "scroll",
  songwriters,
  language,
  loaderVisible = false,
  noLyrics = false,
  className,
  onLoaded,
  onError,
  onScrollState,
}: BraccatoLyricsProps) {
  const ref = useRef<BraccatoElement | null>(null);
  const measuredFont = useRef(fontFamily);
  const callbacks = useRef({ onLoaded, onError, onScrollState });
  callbacks.current = { onLoaded, onError, onScrollState };
  // The decoration pass reads the latest lyrics and tick settings, so it can run from the element's
  // own build events (which fire while a lyrics assignment is still on the stack) as well as from the
  // effect that assigns them.
  const latest = useRef({ lyrics, offsetMs, passiveScroll });
  latest.current = { lyrics, offsetMs, passiveScroll };
  const decorate = useRef(() => {
    const element = ref.current;
    if (!element) return;
    const { lyrics: current, offsetMs: offset, passiveScroll: passive } = latest.current;
    applyLineDecorations(element, current, { offsetMs: offset, passiveScroll: passive });
  });

  // Bind once: the element, not React, owns the per-frame clock while a media element is bound.
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

    element.addEventListener("braccato:lyrics-loaded", handleLoaded);
    element.addEventListener("braccato:error", handleError);
    element.addEventListener("braccato:scroll-state", handleScroll);

    try {
      element.source = audioEngine.element;
    } catch (error) {
      callbacks.current.onError?.(`source: ${(error as Error).message}`);
    }

    return () => {
      element.removeEventListener("braccato:lyrics-loaded", handleLoaded);
      element.removeEventListener("braccato:error", handleError);
      element.removeEventListener("braccato:scroll-state", handleScroll);
      try {
        element.source = null;
      } catch {
        /* element may already be gone */
      }
    };
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.tickOptions = {
      globalLyricOffset: offsetMs / 1000,
      passiveScrollEnabled: passiveScroll,
    };
  }, [offsetMs, passiveScroll]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.theme !== themeCss) element.theme = themeCss;
  }, [themeCss]);

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

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.lyricsOptions = {
      loaderVisible,
      noLyrics,
      songwriters: songwriters ?? [],
      language: language ?? null,
    };
    // Empty array is the renderer's way to say "cleared"; null says "never given one".
    element.lyrics = lyrics && lyrics.length > 0 ? lyrics : lyrics ? [] : null;
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
    "data-testid": "braccato-lyrics",
  });
}
