/**
 * Lyrics orchestration for the renderer: resolve a track's lyrics, parse them with the upstream
 * parser set, then decorate them with the ported translation / romanization passes.
 * Written for Cadence.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Lyric, LyricSyncType } from "@braccato/types";
import type { LyricsCandidate, LyricsSettings, Track } from "../../../shared/types";
import { bridge } from "../../state/bridge";
import {
  applyRomanization,
  applyTranslations,
  lyricLines,
  parseLyricsText,
  stripRomanization,
  stripTranslations,
  type ParsedLyrics,
} from "./parseLyrics";

export interface LyricsState {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  candidates: LyricsCandidate[];
  activeSource: string | null;
  parsed: ParsedLyrics | null;
  lyrics: Lyric[] | null;
  syncType: LyricSyncType;
  providerStatus: { provider: string; status: string; detail?: string }[];
  error: string | null;
  translating: boolean;
  romanizing: boolean;
  translatedLanguage: string | null;
  detectedLanguage: string | null;
}

const EMPTY: LyricsState = {
  status: "idle",
  candidates: [],
  activeSource: null,
  parsed: null,
  lyrics: null,
  syncType: "none",
  providerStatus: [],
  error: null,
  translating: false,
  romanizing: false,
  translatedLanguage: null,
  detectedLanguage: null,
};

export interface UseLyricsResult extends LyricsState {
  selectSource: (source: string) => void;
  reload: () => void;
  saveSidecar: () => Promise<string | null>;
  chooseFile: () => Promise<void>;
  hasLyrics: boolean;
}

export function useLyrics(track: Track | null, settings: LyricsSettings): UseLyricsResult {
  const [state, setState] = useState<LyricsState>(EMPTY);
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);
  const parsedCache = useRef(new Map<string, ParsedLyrics>());
  const manualSource = useRef<string | null>(null);
  const resolvedFor = useRef<string | null>(null);
  const parsedRef = useRef<ParsedLyrics | null>(null);

  const parseCandidate = useCallback((candidate: LyricsCandidate, durationSeconds: number): ParsedLyrics => {
    const key = `${candidate.source}:${durationSeconds.toFixed(0)}:${candidate.text.length}`;
    const cached = parsedCache.current.get(key);
    if (cached) return cached;
    const parsed = parseLyricsText(candidate.text, durationSeconds * 1000);
    if (parsedCache.current.size > 24) parsedCache.current.clear();
    parsedCache.current.set(key, parsed);
    return parsed;
  }, []);

  // Resolve candidates whenever the track or the provider configuration changes.
  useEffect(() => {
    if (!track) {
      setState(EMPTY);
      return;
    }
    const token = ++generation.current;
    const requestKey = `${track.id}:${settings.autoFetch ? "online" : "local"}:${settings.providerOrder.join(",")}:${reloadToken}`;
    if (resolvedFor.current === requestKey && state.candidates.length > 0) return;
    resolvedFor.current = requestKey;

    setState(previous => ({ ...previous, status: "loading", error: null, lyrics: null }));

    void (async () => {
      try {
        const result = await bridge.lyrics.resolve({
          trackId: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
          localOnly: !settings.autoFetch,
        });
        if (token !== generation.current) return;

        if (result.candidates.length === 0) {
          setState(previous => ({
            ...previous,
            status: "empty",
            candidates: [],
            activeSource: null,
            parsed: null,
            lyrics: null,
            syncType: "none",
            providerStatus: result.providerStatus,
            error: null,
          }));
          return;
        }

        const preferred =
          result.candidates.find(candidate => candidate.source === manualSource.current) ?? result.candidates[0];
        const parsed = parseCandidate(preferred, track.duration);
        parsedRef.current = parsed;
        setState(previous => ({
          ...previous,
          status: "ready",
          candidates: result.candidates,
          activeSource: preferred.source,
          parsed,
          lyrics: parsed.lyrics,
          syncType: parsed.syncType,
          providerStatus: result.providerStatus,
          error: null,
        }));
      } catch (error) {
        if (token !== generation.current) return;
        setState(previous => ({
          ...previous,
          status: "error",
          error: (error as Error).message,
          lyrics: null,
        }));
      }
    })();
    // `state.candidates` is intentionally not a dependency: it is a result, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, track?.duration, settings.autoFetch, settings.providerOrder, reloadToken, parseCandidate]);

  // Translation pass (ported Better Lyrics batching lives in the main process).
  useEffect(() => {
    const parsed = state.parsed;
    if (!parsed || state.status !== "ready") return;
    if (!settings.translationLanguage) {
      // Switching translation off removes only the translation decoration; a romanization already
      // hanging off the same lines stays.
      setState(previous => {
        const stripped = previous.lyrics ? stripTranslations(previous.lyrics) : previous.lyrics;
        return stripped === previous.lyrics && !previous.translating && previous.translatedLanguage === null
          ? previous
          : { ...previous, lyrics: stripped, translating: false, translatedLanguage: null };
      });
      return;
    }

    let cancelled = false;
    setState(previous => ({ ...previous, translating: true }));
    void (async () => {
      try {
        const lines = lyricLines(parsed.lyrics);
        const result = await bridge.lyrics.translate({
          lines,
          targetLanguage: settings.translationLanguage,
          sourceLanguage: parsed.language,
        });
        if (cancelled) return;
        const translatedCount = result.translations.filter(Boolean).length;
        setState(previous => {
          // Decorate the lines as they currently stand (same parsed set) rather than rebuilding
          // from `parsed.lyrics`, so a romanization that landed first survives this pass; the
          // spread in applyTranslations keeps each line's romanization field.
          const base =
            previous.parsed === parsed ? previous.lyrics ?? parsed.lyrics : parsed.lyrics;
          return {
            ...previous,
            translating: false,
            translatedLanguage: translatedCount > 0 ? settings.translationLanguage : null,
            detectedLanguage: result.detectedLanguage || parsed.language,
            lyrics:
              translatedCount > 0
                ? applyTranslations(base, result.translations, settings.translationLanguage)
                : stripTranslations(base),
          };
        });
      } catch (error) {
        if (cancelled) return;
        setState(previous => ({
          ...previous,
          translating: false,
          error: `Translation failed: ${(error as Error).message}`,
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.parsed, state.status, settings.translationLanguage]);

  // Romanization pass.
  useEffect(() => {
    const parsed = state.parsed;
    if (!parsed || state.status !== "ready") return;
    if (!settings.romanization) {
      // Switching romanization off removes only the romanization decoration; translations stay.
      setState(previous => {
        const stripped = previous.lyrics ? stripRomanization(previous.lyrics) : previous.lyrics;
        return stripped === previous.lyrics && !previous.romanizing
          ? previous
          : { ...previous, lyrics: stripped, romanizing: false };
      });
      return;
    }
    let cancelled = false;
    setState(previous => ({ ...previous, romanizing: true }));
    void (async () => {
      try {
        const lines = lyricLines(parsed.lyrics);
        const result = await bridge.lyrics.romanize({
          lines,
          targetLanguage: "en",
          sourceLanguage: parsed.language,
        });
        if (cancelled) return;
        const count = result.romanizations.filter(Boolean).length;
        setState(previous => ({
          ...previous,
          romanizing: false,
          detectedLanguage: result.detectedLanguage || parsed.language,
          lyrics: count > 0 ? applyRomanization(previous.lyrics ?? parsed.lyrics, result.romanizations) : previous.lyrics,
        }));
      } catch {
        if (!cancelled) setState(previous => ({ ...previous, romanizing: false }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.parsed, state.status, settings.romanization]);

  const selectSource = useCallback(
    (source: string) => {
      const candidate = state.candidates.find(entry => entry.source === source);
      const parsed = candidate?.text ? parseCandidate(candidate, track?.duration ?? 0) : null;
      if (!parsed) return;
      manualSource.current = source;
      parsedRef.current = parsed;
      setState(previous => ({
        ...previous,
        activeSource: source,
        parsed,
        lyrics: parsed.lyrics,
        syncType: parsed.syncType,
        status: "ready",
      }));
    },
    [state.candidates, track?.duration, parseCandidate]
  );

  const reload = useCallback(() => {
    resolvedFor.current = null;
    parsedCache.current.clear();
    setReloadToken(token => token + 1);
  }, []);

  const saveSidecar = useCallback(async () => {
    if (!track || !parsedRef.current) return null;
    const { lyricsToLrc } = await import("./parseLyrics");
    const lrc = lyricsToLrc(parsedRef.current.lyrics, { title: track.title, artist: track.artist });
    const result = await bridge.lyrics.saveSidecar(track.id, lrc);
    return result.path;
  }, [track]);

  const chooseFile = useCallback(async () => {
    if (!track) return;
    const result = await bridge.app.chooseLyricsFile(track.id);
    if (result.canceled || !result.text) return;
    const parsed = parseLyricsText(result.text, track.duration * 1000);
    const candidate: LyricsCandidate = {
      source: "user-file",
      provider: "Chosen file",
      text: result.text,
      syncHint: parsed.syncType,
      language: parsed.language,
      songwriters: parsed.songwriters,
      sourceHref: result.path ?? null,
      cached: true,
    };
    parsedRef.current = parsed;
    setState(previous => ({
      ...previous,
      status: "ready",
      candidates: [candidate, ...previous.candidates.filter(entry => entry.source !== "user-file")],
      activeSource: "user-file",
      parsed,
      lyrics: parsed.lyrics,
      syncType: parsed.syncType,
      error: null,
    }));
  }, [track]);

  return {
    ...state,
    selectSource,
    reload,
    saveSidecar,
    chooseFile,
    hasLyrics: Boolean(state.lyrics && state.lyrics.length > 0),
  };
}
