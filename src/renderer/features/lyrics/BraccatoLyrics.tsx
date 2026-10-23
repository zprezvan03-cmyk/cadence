/**
 * React mount for the upstream lyrics renderer.
 *
 * The renderer is the published `@braccato/core` custom element — the same `<braccato-lyrics>`
 * Better Lyrics builds its lyrics view from — used unmodified. This file only binds it to Cadence's
 * audio element and pushes settings into its public properties.
 * Written for Cadence.
 */

import { createElement, useEffect, useRef } from "react";
import "@braccato/core/element";
import "@braccato/core/styles/variables.css";
import "@braccato/core/styles/lyrics.css";
import "@braccato/core/styles/instrumental.css";
import type { Lyric, LyricsRenderer } from "@braccato/core";
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

  // Bind once: the element, not React, owns the per-frame clock while a media element is bound.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const handleLoaded = (event: Event) => {
      const detail = (event as CustomEvent<{ lineCount: number; syncType: LyricsSyncType }>).detail;
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
  }, [lyrics, loaderVisible, noLyrics, songwriters, language]);

  return createElement("braccato-lyrics", {
    ref: (node: HTMLElement | null) => {
      ref.current = node as BraccatoElement | null;
    },
    class: className,
    "data-testid": "braccato-lyrics",
  });
}
