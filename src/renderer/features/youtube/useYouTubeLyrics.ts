/**
 * Lyrics lookup for the isolated YouTube prototype.
 *
 * It intentionally does not reuse the local-track `useLyrics` store: that store is keyed by a
 * numeric library ID and would require inventing one for a remote video. Instead, remote metadata
 * goes through Cadence's existing metadata-only lyrics search bridge, which already applies the
 * user's provider order. The returned text is parsed and decorated with the same TTML/QRC/LRC,
 * translation, and romanization helpers as local playback.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Lyric } from "@braccato/types";
import type {
  LyricsCandidate,
  LyricsSearchResponse,
  LyricsSettings,
} from "../../../shared/types";
import { bridge, hasBridge } from "../../state/bridge";
import type { YouTubeRemoteMetadata } from "../../state/youtubeStore";
import {
  applyRomanization,
  applyTranslations,
  embeddedTranslationsForLanguage,
  lyricLines,
  parseLyricsText,
  romanizationGaps,
  scatterRomanizations,
  stripRomanization,
  stripTranslations,
  translationGaps,
  type ParsedLyrics,
} from "../lyrics/parseLyrics";

export type YouTubeLyricsStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface YouTubeLyricsResult {
  status: YouTubeLyricsStatus;
  candidates: LyricsCandidate[];
  activeCandidate: LyricsCandidate | null;
  activeIndex: number;
  parsed: ParsedLyrics | null;
  lyrics: Lyric[] | null;
  syncType: ParsedLyrics["syncType"];
  providerStatus: LyricsSearchResponse["providerStatus"];
  error: string | null;
  decorationError: string | null;
  translating: boolean;
  romanizing: boolean;
  selectCandidate: (index: number) => void;
  reload: () => void;
}

interface SearchState {
  sourceId: string | null;
  status: YouTubeLyricsStatus;
  candidates: LyricsCandidate[];
  providerStatus: LyricsSearchResponse["providerStatus"];
  error: string | null;
}

interface DecorationState {
  key: string;
  values: (string | null)[];
}

const IDLE_SEARCH: SearchState = {
  sourceId: null,
  status: "idle",
  candidates: [],
  providerStatus: [],
  error: null,
};

function textHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function candidateKey(candidate: LyricsCandidate): string {
  return [
    candidate.source,
    candidate.provider,
    candidate.matchTitle ?? "",
    candidate.matchArtist ?? "",
    candidate.text.length,
    textHash(candidate.text),
  ].join(":");
}

export function useYouTubeLyrics(
  metadata: YouTubeRemoteMetadata | null,
  settings: LyricsSettings
): YouTubeLyricsResult {
  const [search, setSearch] = useState<SearchState>(IDLE_SEARCH);
  const [activeIndex, setActiveIndex] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const [translationValues, setTranslationValues] = useState<DecorationState | null>(null);
  const [romanizationValues, setRomanizationValues] = useState<DecorationState | null>(null);
  const [translating, setTranslating] = useState(false);
  const [romanizing, setRomanizing] = useState(false);
  const [decorationError, setDecorationError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const selectedCandidateKeyRef = useRef<string | null>(null);

  const providerOrderKey = settings.providerOrder.join(",");
  const metadataReady = Boolean(
    metadata?.videoId && metadata.title && !metadata.title.startsWith("Loading YouTube video")
  );

  useEffect(() => {
    selectedCandidateKeyRef.current = null;
    setActiveIndex(0);
  }, [metadata?.sourceId]);

  useEffect(() => {
    if (!metadata || !metadataReady) {
      setSearch(IDLE_SEARCH);
      return;
    }

    if (!settings.autoFetch) {
      setSearch({
        sourceId: metadata.sourceId,
        status: "empty",
        candidates: [],
        providerStatus: [],
        error: null,
      });
      return;
    }

    if (!hasBridge()) {
      setSearch({
        sourceId: metadata.sourceId,
        status: "error",
        candidates: [],
        providerStatus: [],
        error: "Cadence's desktop lyrics bridge is unavailable in this runtime.",
      });
      return;
    }

    const generation = ++generationRef.current;
    let cancelled = false;
    setSearch({
      sourceId: metadata.sourceId,
      status: "loading",
      candidates: [],
      providerStatus: [],
      error: null,
    });
    setDecorationError(null);

    void bridge.lyrics
      .search({
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album || undefined,
        ...(metadata.duration > 0 ? { duration: metadata.duration } : {}),
      })
      .then(result => {
        if (cancelled || generation !== generationRef.current) return;
        setSearch({
          sourceId: metadata.sourceId,
          status: result.results.length > 0 ? "ready" : "empty",
          candidates: result.results,
          providerStatus: result.providerStatus,
          error: null,
        });
        const selectedKey = selectedCandidateKeyRef.current;
        const selectedIndex = selectedKey
          ? result.results.findIndex(candidate => candidateKey(candidate) === selectedKey)
          : -1;
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
      })
      .catch(error => {
        if (cancelled || generation !== generationRef.current) return;
        if ((error as Error)?.name === "AbortError") return;
        setSearch({
          sourceId: metadata.sourceId,
          status: "error",
          candidates: [],
          providerStatus: [],
          error: (error as Error).message || "Lyrics search failed.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    metadata?.album,
    metadata?.artist,
    metadata?.duration,
    metadata?.sourceId,
    metadata?.title,
    metadata?.videoId,
    metadataReady,
    providerOrderKey,
    reloadTick,
    settings.autoFetch,
  ]);

  const candidates = search.sourceId === metadata?.sourceId ? search.candidates : [];
  const activeCandidate = candidates[activeIndex] ?? candidates[0] ?? null;

  const parsedResult = useMemo<{ parsed: ParsedLyrics | null; error: string | null }>(() => {
    if (!activeCandidate || !metadata) return { parsed: null, error: null };
    try {
      const durationSeconds =
        metadata.duration > 0 ? metadata.duration : activeCandidate.matchDuration ?? 0;
      return {
        parsed: parseLyricsText(activeCandidate.text, durationSeconds * 1000, {
          title: activeCandidate.matchTitle ?? metadata.title,
          artist: activeCandidate.matchArtist ?? metadata.artist,
        }),
        error: null,
      };
    } catch (error) {
      return {
        parsed: null,
        error: `Could not parse lyrics from ${activeCandidate.provider}: ${(error as Error).message}`,
      };
    }
  }, [activeCandidate, metadata]);

  const parsed = parsedResult.parsed;
  const parsedKey = useMemo(() => {
    if (!parsed || !activeCandidate || !metadata) return null;
    return `${metadata.sourceId}:${activeCandidate.source}:${activeCandidate.text.length}:${textHash(activeCandidate.text)}`;
  }, [activeCandidate, metadata, parsed]);

  useEffect(() => {
    if (!parsed || !parsedKey || search.status !== "ready") return;
    if (!settings.translationLanguage) {
      setTranslationValues(null);
      setTranslating(false);
      return;
    }

    const embedded = embeddedTranslationsForLanguage(parsed.lyrics, settings.translationLanguage);
    const gaps = translationGaps(parsed.lyrics, settings.translationLanguage);
    if (gaps.length === 0) {
      setTranslationValues({
        key: parsedKey,
        values: Array.from({ length: parsed.lyrics.length }, () => null),
      });
      setTranslating(false);
      return;
    }
    if (!hasBridge()) return;

    let cancelled = false;
    setTranslating(true);
    void bridge.lyrics
      .translate({
        lines: gaps.map(index => lyricLines(parsed.lyrics)[index] ?? ""),
        targetLanguage: settings.translationLanguage,
        sourceLanguage: parsed.language,
      })
      .then(result => {
        if (cancelled) return;
        setTranslationValues({
          key: parsedKey,
          values: scatterRomanizations(parsed.lyrics.length, gaps, result.translations),
        });
        // `embedded` is merged again during decoration, so native file translations win over gaps.
        void embedded;
      })
      .catch(error => {
        if (cancelled) return;
        setDecorationError(`Translation failed: ${(error as Error).message || "unknown error"}`);
      })
      .finally(() => {
        if (!cancelled) setTranslating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [parsed, parsedKey, search.status, settings.translationLanguage]);

  useEffect(() => {
    if (!parsed || !parsedKey || search.status !== "ready") return;
    if (!settings.romanization) {
      setRomanizationValues(null);
      setRomanizing(false);
      return;
    }

    const gaps = romanizationGaps(parsed.lyrics);
    if (gaps.length === 0) {
      setRomanizationValues({
        key: parsedKey,
        values: Array.from({ length: parsed.lyrics.length }, () => null),
      });
      setRomanizing(false);
      return;
    }
    if (!hasBridge()) return;

    let cancelled = false;
    setRomanizing(true);
    void bridge.lyrics
      .romanize({
        lines: gaps.map(index => lyricLines(parsed.lyrics)[index] ?? ""),
        targetLanguage: "en",
        sourceLanguage: parsed.language,
      })
      .then(result => {
        if (cancelled) return;
        setRomanizationValues({
          key: parsedKey,
          values: scatterRomanizations(parsed.lyrics.length, gaps, result.romanizations),
        });
      })
      .catch(error => {
        if (cancelled) return;
        setDecorationError(`Romanization failed: ${(error as Error).message || "unknown error"}`);
      })
      .finally(() => {
        if (!cancelled) setRomanizing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [parsed, parsedKey, search.status, settings.romanization]);

  const decoratedLyrics = useMemo<Lyric[] | null>(() => {
    if (!parsed) return null;
    let result: Lyric[] = parsed.lyrics;

    if (settings.translationLanguage) {
      const embedded = embeddedTranslationsForLanguage(parsed.lyrics, settings.translationLanguage);
      const generated =
        translationValues?.key === parsedKey
          ? translationValues.values
          : Array.from({ length: parsed.lyrics.length }, () => null);
      const merged = embedded.map((embeddedLine, index) => embeddedLine ?? generated[index] ?? null);
      result = merged.some(Boolean)
        ? applyTranslations(stripTranslations(result), merged, settings.translationLanguage)
        : stripTranslations(result);
    } else {
      result = stripTranslations(result);
    }

    if (settings.romanization) {
      const generated =
        romanizationValues?.key === parsedKey
          ? romanizationValues.values
          : Array.from({ length: parsed.lyrics.length }, () => null);
      result = applyRomanization(result, generated);
    } else {
      result = stripRomanization(result);
    }

    return result;
  }, [
    parsed,
    parsedKey,
    romanizationValues,
    settings.romanization,
    settings.translationLanguage,
    translationValues,
  ]);

  const selectCandidate = useCallback(
    (index: number) => {
      const candidate = candidates[index];
      if (!candidate || !Number.isInteger(index)) return;
      selectedCandidateKeyRef.current = candidateKey(candidate);
      setActiveIndex(index);
    },
    [candidates]
  );

  const reload = useCallback(() => {
    generationRef.current += 1;
    setReloadTick(value => value + 1);
  }, []);

  const status: YouTubeLyricsStatus = parsedResult.error
    ? "error"
    : search.sourceId === metadata?.sourceId
      ? search.status
      : metadata
        ? "loading"
        : "idle";

  return {
    status,
    candidates,
    activeCandidate,
    activeIndex: Math.min(activeIndex, Math.max(0, candidates.length - 1)),
    parsed,
    lyrics: decoratedLyrics,
    syncType: parsed?.syncType ?? "none",
    providerStatus: search.sourceId === metadata?.sourceId ? search.providerStatus : [],
    error: parsedResult.error ?? search.error,
    decorationError,
    translating,
    romanizing,
    selectCandidate,
    reload,
  };
}
