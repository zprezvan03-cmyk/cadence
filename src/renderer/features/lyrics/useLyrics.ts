/**
 * Lyrics orchestration for the renderer: resolve a track's lyrics, parse them with the upstream
 * parser set, then decorate them with the ported translation / romanization passes.
 *
 * Lifecycle: the Now Playing view unmounts on tab changes, so all durable state lives in the
 * application-level {@link useLyricsStore} (Zustand) rather than component state. The module-level
 * refs below also outlive any single mount: returning to Now Playing skips every redundant request
 * and restores lyrics, the selected provider and manual searches instantly, while in-flight
 * requests started before unmount keep running and land safely through generation guards.
 * Written for Cadence.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Lyric, LyricSyncType } from "@braccato/types";
import type {
  LyricsCandidate,
  LyricsSettings,
  Track,
  YouTubeMetadataResult,
} from "../../../shared/types";
import { parseYouTubeVideoId, resolveSearchFields, type ManualSearchInput } from "../../../shared/youtube";
import { bridge } from "../../state/bridge";
import {
  lyricsStore,
  useLyricsStore,
  type LyricsStatus,
  type ManualSearchState,
  type ProviderStatusEntry,
  type SearchDraft,
  type YouTubeResolveState,
} from "../../state/lyricsStore";
import {
  applyFileRomanization,
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
} from "./parseLyrics";

// Re-exported so existing consumers can keep importing the state types from the hook.
export type { ManualSearchState, YouTubeResolveState } from "../../state/lyricsStore";

const IDLE_YOUTUBE: YouTubeResolveState = { status: "idle", videoId: null, metadata: null, detail: null };
const EMPTY_SEARCH: ManualSearchState = { status: "idle", results: [], error: null };

// Module singletons: shared across every mount of the hook for the application's lifetime.
const generations = { resolve: 0, search: 0, youtube: 0 };
const parsedCache = new Map<string, ParsedLyrics>();
const parsedIds = new Map<ParsedLyrics, string>();
let parsedSequence = 0;
/** Last automatic-resolution request actually issued; remounts with the same key do nothing. */
let resolvedForKey: string | null = null;
/** Parse + language combinations already decorated, so remounts don't re-request translation. */
let appliedTranslationKey: string | null = null;
let appliedRomanizationKey: string | null = null;
let reloadToken = 0;

export interface UseLyricsResult {
  status: LyricsStatus;
  candidates: LyricsCandidate[];
  activeSource: string | null;
  parsed: ParsedLyrics | null;
  lyrics: Lyric[] | null;
  syncType: LyricSyncType;
  providerStatus: ProviderStatusEntry[];
  error: string | null;
  translating: boolean;
  romanizing: boolean;
  translatedLanguage: string | null;
  detectedLanguage: string | null;
  selectSource: (source: string) => void;
  reload: () => void;
  saveSidecar: () => Promise<string | null>;
  chooseFile: () => Promise<void>;
  /** Manual-search state for the Lyrics Selector; never alters active lyrics on its own. */
  manualSearchState: ManualSearchState;
  manualSearch: (input: ManualSearchInput) => Promise<void>;
  selectSearchResult: (candidate: LyricsCandidate) => void;
  /** State of the optional YouTube-link lookup, including any resolved metadata. */
  youtubeState: YouTubeResolveState;
  resolveYouTube: (url: string) => Promise<YouTubeMetadataResult | null>;
  /** The persisted search form draft (title/artist/album/YouTube URL) for this track. */
  searchDraft: SearchDraft;
  patchDraft: (patch: Partial<SearchDraft>) => void;
  /** Explicit reset: back to the track's tag defaults and an empty search session. */
  clearSearch: () => void;
  hasLyrics: boolean;
}

/**
 * Restores file-supplied romanization (and its word timing) onto the lines currently in the store,
 * matched by position. Used by the romanization pass so a toggle-off / toggle-on round trip, or a
 * late-arriving generation batch, never loses the file's own transliteration.
 */
function applyFileRomanizationToStore(parsed: ParsedLyrics): void {
  useLyricsStore.setState(previous => {
    if (previous.parsed !== parsed) return previous;
    const base = previous.lyrics ?? parsed.lyrics;
    const next = applyFileRomanization(base, parsed.lyrics);
    return next === base && previous.lyrics === base && !previous.romanizing
      ? previous
      : { ...previous, lyrics: next, romanizing: false };
  });
}

function textHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function useLyrics(track: Track | null, settings: LyricsSettings): UseLyricsResult {
  const store = useLyricsStore();
  const [reloadTick, setReloadTick] = useState(reloadToken);

  // Ensure this track owns a search session (drafts may be rehydrated from localStorage).
  useEffect(() => {
    if (!track) return;
    useLyricsStore.getState().ensureSession(track);
    // A newer track invalidates in-flight manual/YouTube responses from the previous one.
    generations.search += 1;
    generations.youtube += 1;
  }, [track?.id]);

  const session = track ? store.sessions[track.id] : undefined;

  const parseCandidate = useCallback(
    (candidate: LyricsCandidate, durationSeconds: number): ParsedLyrics => {
      const key = `${track?.id ?? 0}:${candidate.source}:${durationSeconds.toFixed(0)}:${candidate.text.length}:${textHash(candidate.text)}`;
      const cached = parsedCache.get(key);
      if (cached) return cached;
      const parsed = parseLyricsText(candidate.text, durationSeconds * 1000, {
        title: track?.title,
        artist: track?.artist,
      });
      if (parsedCache.size > 24) {
        parsedCache.clear();
        parsedIds.clear();
      }
      parsedCache.set(key, parsed);
      parsedIds.set(parsed, `p${parsedSequence++}`);
      return parsed;
    },
    [track?.id, track?.title, track?.artist]
  );

  // Resolve candidates whenever the track or the provider configuration changes. On remount with
  // the same request key this returns immediately: the store already holds everything (or is
  // already resolving that exact request).
  useEffect(() => {
    if (!track) {
      generations.resolve += 1;
      resolvedForKey = null;
      return;
    }
    const requestKey = `${track.id}:${settings.autoFetch ? "online" : "local"}:${settings.providerOrder.join(",")}:${reloadTick}`;
    const current = lyricsStore();
    if (
      resolvedForKey === requestKey &&
      current.trackId === track.id &&
      (current.status === "loading" || current.candidates.length > 0 || current.status === "empty")
    ) {
      return;
    }
    const token = ++generations.resolve;
    resolvedForKey = requestKey;

    // Clears the previous track's candidates/provider identity when the track changed, so a
    // fallback to another provider never renders under the old provider's name.
    useLyricsStore.getState().beginResolve(track.id);
    // `beginResolve` drops the decorated line array, so the "already decorated this parse" guards
    // no longer describe what is in the store. Leaving them set would skip the decoration passes
    // for the lyrics that land next (e.g. A → B → A reuses A's cached parse, whose id still
    // matched the guard) and show the new lines without their translation/romanization.
    appliedTranslationKey = null;
    appliedRomanizationKey = null;

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
        if (token !== generations.resolve) return;

        if (result.candidates.length === 0) {
          useLyricsStore.getState().setActive(track.id, {
            status: "empty",
            candidates: [],
            activeSource: null,
            parsed: null,
            lyrics: null,
            syncType: "none",
            providerStatus: result.providerStatus,
            error: null,
          });
          return;
        }

        // Restore the user's explicit choice for this track (persisted across restarts), else default.
        const chosenSource = useLyricsStore.getState().selectedSources[track.id];
        const preferred =
          result.candidates.find(candidate => candidate.source === chosenSource) ?? result.candidates[0];
        const parsed = parseCandidate(preferred, track.duration);
        const previous = useLyricsStore.getState();
        // A re-resolve can hand back the same cached parse (provider order / auto-fetch changed).
        // Its line objects are still the ones carrying the translation and generated romanization,
        // so keep them instead of rebuilding undecorated lines.
        const sameParse = previous.parsed === parsed;
        useLyricsStore.getState().setActive(track.id, {
          status: "ready",
          candidates: result.candidates,
          activeSource: preferred.source,
          parsed,
          lyrics: sameParse && previous.lyrics ? previous.lyrics : parsed.lyrics,
          syncType: parsed.syncType,
          providerStatus: result.providerStatus,
          error: null,
        });
      } catch (error) {
        if (token !== generations.resolve) return;
        if (
          (error as Error)?.name === "AbortError" ||
          (error as { kind?: string })?.kind === "aborted"
        ) {
          return;
        }
        resolvedForKey = null;
        useLyricsStore.getState().setActive(track.id, {
          status: "error",
          error: (error as Error).message,
          lyrics: null,
        });
      }
    })();
    // parseCandidate is stable per track; reloadTick mirrors the module token that survives remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, track?.duration, settings.autoFetch, settings.providerOrder, reloadTick, parseCandidate]);

  // Translation pass (ported Better Lyrics batching lives in the main process).
  useEffect(() => {
    const parsed = store.parsed;
    if (!parsed || store.status !== "ready") return;
    if (!settings.translationLanguage) {
      // Switching translation off removes only the translation decoration; a romanization already
      // hanging off the same lines stays.
      useLyricsStore.setState(current => {
        const stripped = current.lyrics ? stripTranslations(current.lyrics) : current.lyrics;
        appliedTranslationKey = null;
        return stripped === current.lyrics && !current.translating && current.translatedLanguage === null
          ? current
          : { ...current, lyrics: stripped, translating: false, translatedLanguage: null };
      });
      return;
    }

    const parsedId = parsedIds.get(parsed);
    const applyKey = `${parsedId}:${settings.translationLanguage}`;
    // Decorated before a remount: the store still holds those lines. Every path that resets them
    // (re-resolve, source switch, chosen file) either keeps them, registers a fresh parse id or
    // clears this key, so a matching key means there is nothing left to do.
    if (applyKey === appliedTranslationKey) return;

    const embedded = embeddedTranslationsForLanguage(parsed.lyrics, settings.translationLanguage);
    const gaps = translationGaps(parsed.lyrics, settings.translationLanguage);
    if (gaps.length === 0) {
      // Every sung line already carries an embedded translation in the requested language.
      appliedTranslationKey = applyKey;
      const embeddedCount = embedded.filter(Boolean).length;
      useLyricsStore.setState(previous => {
        if (previous.parsed !== parsed) return previous;
        const base = previous.lyrics ?? parsed.lyrics;
        return {
          ...previous,
          translating: false,
          error: null,
          translatedLanguage: embeddedCount > 0 ? settings.translationLanguage : null,
          lyrics:
            embeddedCount > 0
              ? applyTranslations(stripTranslations(base), embedded, settings.translationLanguage)
              : stripTranslations(base),
        };
      });
      return;
    }

    let cancelled = false;
    useLyricsStore.setState(current => ({ ...current, translating: true }));
    void (async () => {
      try {
        const lines = lyricLines(parsed.lyrics);
        const result = await bridge.lyrics.translate({
          lines: gaps.map(index => lines[index]),
          targetLanguage: settings.translationLanguage,
          sourceLanguage: parsed.language,
        });
        if (cancelled) return;
        appliedTranslationKey = applyKey;
        const generated = scatterRomanizations(parsed.lyrics.length, gaps, result.translations);
        const merged = embedded.map((localText, idx) => localText ?? generated[idx] ?? null);
        const translatedCount = merged.filter(Boolean).length;
        useLyricsStore.setState(previous => {
          // The parse changed under the request (track/provider switch): its result belongs to
          // lyrics that are no longer on screen and must not overwrite them.
          if (previous.parsed !== parsed) return previous;
          // Decorate the lines as they currently stand rather than rebuilding from
          // `parsed.lyrics`, so a romanization that landed first survives this pass.
          const base = previous.lyrics ?? parsed.lyrics;
          return {
            ...previous,
            translating: false,
            error: null,
            translatedLanguage: translatedCount > 0 ? settings.translationLanguage : null,
            detectedLanguage: result.detectedLanguage || parsed.language,
            lyrics:
              translatedCount > 0
                ? applyTranslations(stripTranslations(base), merged, settings.translationLanguage)
                : stripTranslations(base),
          };
        });
      } catch (error) {
        if (cancelled) return;
        useLyricsStore.setState(previous =>
          previous.parsed === parsed
            ? {
                ...previous,
                translating: false,
                error: `Translation failed: ${(error as Error).message}`,
              }
            : previous
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store.parsed, store.status, settings.translationLanguage]);

  // Romanization pass. The toggle decides whether romanization is shown at all. Romanization the
  // lyrics file itself supplied is preferred over generated text (it keeps the file's word timing);
  // generation only fills the lines the file left bare, so a fully transliterated TTML never calls
  // the provider, and an empty/failed batch never hides or overwrites the file's text.
  useEffect(() => {
    const parsed = store.parsed;
    if (!parsed || store.status !== "ready") return;
    if (!settings.romanization) {
      useLyricsStore.setState(previous => {
        const stripped = previous.lyrics ? stripRomanization(previous.lyrics) : previous.lyrics;
        appliedRomanizationKey = null;
        return stripped === previous.lyrics && !previous.romanizing
          ? previous
          : { ...previous, lyrics: stripped, romanizing: false };
      });
      return;
    }
    const parsedId = parsedIds.get(parsed);
    if (parsedId && appliedRomanizationKey === parsedId) return; // decorated before a remount

    const gaps = romanizationGaps(parsed.lyrics);
    if (gaps.length === 0) {
      // Every sung line already carries the file's romanization; only make sure the current lines
      // show it (the toggle may have hidden it since they were parsed) and never generate.
      applyFileRomanizationToStore(parsed);
      appliedRomanizationKey = parsedId ?? null;
      return;
    }

    // File transliterations show immediately, even while the gaps are being generated or if the
    // request fails; generation only ever adds to those lines.
    applyFileRomanizationToStore(parsed);
    let cancelled = false;
    useLyricsStore.setState(previous => ({ ...previous, romanizing: true }));
    void (async () => {
      try {
        const lines = lyricLines(parsed.lyrics);
        const result = await bridge.lyrics.romanize({
          lines: gaps.map(index => lines[index]),
          targetLanguage: "en",
          sourceLanguage: parsed.language,
        });
        if (cancelled) return;
        appliedRomanizationKey = parsedId ?? null;
        const romanizations = scatterRomanizations(parsed.lyrics.length, gaps, result.romanizations);
        const count = romanizations.filter(Boolean).length;
        useLyricsStore.setState(previous => {
          // The parse changed under the request (track/provider switch): its result belongs to
          // lyrics that are no longer on screen.
          if (previous.parsed !== parsed) return previous;
          return {
            ...previous,
            romanizing: false,
            detectedLanguage: result.detectedLanguage || parsed.language,
            lyrics:
              count > 0
                ? applyRomanization(previous.lyrics ?? parsed.lyrics, romanizations)
                : previous.lyrics ?? parsed.lyrics,
          };
        });
      } catch {
        if (cancelled) return;
        useLyricsStore.setState(previous => (previous.parsed === parsed ? { ...previous, romanizing: false } : previous));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store.parsed, store.status, settings.romanization]);

  const selectSource = useCallback(
    (source: string) => {
      if (!track) return;
      const candidate = lyricsStore().candidates.find(entry => entry.source === source);
      const parsed = candidate?.text ? parseCandidate(candidate, track.duration) : null;
      if (!parsed) return;
      useLyricsStore.getState().setSelectedSource(track.id, source);
      useLyricsStore.setState(previous => ({
        ...previous,
        parsed,
        // Re-selecting the provider that is already showing must not throw away the decorations
        // hanging off its lines (clicking the active row used to reset them to the raw parse).
        lyrics: previous.parsed === parsed ? previous.lyrics ?? parsed.lyrics : parsed.lyrics,
        syncType: parsed.syncType,
        status: "ready",
      }));
    },
    [track, parseCandidate]
  );

  const reload = useCallback(() => {
    resolvedForKey = null;
    parsedCache.clear();
    parsedIds.clear();
    reloadToken += 1;
    setReloadTick(reloadToken);
  }, []);

  const saveSidecar = useCallback(async () => {
    if (!track) return null;
    const parsed = lyricsStore().parsed;
    if (!parsed) return null;
    const { lyricsToLrc } = await import("./parseLyrics");
    const lrc = lyricsToLrc(parsed.lyrics, { title: track.title, artist: track.artist });
    const result = await bridge.lyrics.saveSidecar(track.id, lrc);
    return result.path;
  }, [track]);

  const chooseFile = useCallback(async () => {
    if (!track) return;
    const result = await bridge.app.chooseLyricsFile(track.id);
    if (result.canceled || !result.text) return;
    const parsed = parseLyricsText(result.text, track.duration * 1000, {
      title: track.title,
      artist: track.artist,
    });
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
    // Parsed outside `parseCandidate`, so give it the identity the decoration guards key on;
    // without one, every chosen file would share the same guard key and later files could be
    // skipped by the translation / romanization passes.
    parsedIds.set(parsed, `p${parsedSequence++}`);
    useLyricsStore.setState(previous => ({
      ...previous,
      status: "ready",
      candidates: [candidate, ...previous.candidates.filter(entry => entry.source !== "user-file")],
      activeSource: "user-file",
      parsed,
      lyrics: parsed.lyrics,
      syncType: parsed.syncType,
      error: null,
    }));
    // Ephemeral source: kept in memory only, not in the per-track persisted selection map.
  }, [track]);

  // Resolve the optional YouTube link through the keyless main-process lookup. Plain malformed
  // links are caught locally (no IPC round trip); a stale response (newer paste or track change)
  // is dropped via a generation token.
  const resolveYouTube = useCallback(
    async (url: string): Promise<YouTubeMetadataResult | null> => {
      if (!track) return null;
      const trimmed = url.trim();
      const videoId = parseYouTubeVideoId(trimmed);
      const { setYoutube } = useLyricsStore.getState();
      if (!videoId) {
        setYoutube(track.id, trimmed ? { status: "invalid", videoId: null, metadata: null, detail: null } : IDLE_YOUTUBE);
        return null;
      }
      const token = ++generations.youtube;
      setYoutube(track.id, { status: "resolving", videoId, metadata: null, detail: null });
      try {
        const result = await bridge.lyrics.youtubeMetadata({ url: trimmed });
        if (token !== generations.youtube) return result;
        if (result.ok) {
          setYoutube(track.id, { status: "ready", videoId, metadata: result.metadata, detail: null });
        } else {
          setYoutube(track.id, {
            status: result.reason === "invalid" ? "invalid" : result.reason,
            videoId,
            metadata: null,
            detail: result.detail,
          });
        }
        return result;
      } catch (error) {
        if (token !== generations.youtube) return null;
        setYoutube(track.id, {
          status: "error",
          videoId,
          metadata: null,
          detail: (error as Error).message || "Metadata lookup failed",
        });
        return null;
      }
    },
    [track]
  );

  // Explicit manual search from the Lyrics Selector. It never changes the active lyrics — only an
  // explicit result selection does — and a stale response (newer submit or track change) is dropped.
  // YouTube metadata only fills blank fields; everything the user typed takes precedence.
  const manualSearch = useCallback(
    async (input: ManualSearchInput) => {
      if (!track) return;
      const youtube = useLyricsStore.getState().sessions[track.id]?.youtube ?? IDLE_YOUTUBE;
      const effective = resolveSearchFields(input, youtube.status === "ready" ? youtube.metadata : null, track.duration);
      if (!effective.title) return;
      const token = ++generations.search;
      useLyricsStore.getState().setManual(track.id, { status: "loading", results: [], error: null });
      try {
        const response = await bridge.lyrics.search({
          title: effective.title,
          artist: effective.artist,
          album: effective.album,
          duration: effective.duration ?? undefined,
        });
        if (token !== generations.search) return;
        useLyricsStore
          .getState()
          .setManual(
            track.id,
            response.results.length
              ? { status: "ready", results: response.results, error: null }
              : { status: "empty", results: [], error: null }
          );
      } catch (error) {
        if (token !== generations.search) return;
        useLyricsStore.getState().setManual(track.id, {
          status: "error",
          results: [],
          error: (error as Error).message,
        });
      }
    },
    [track]
  );

  // Promote a manually selected search result into the active candidate list, mirroring the
  // "chosen file" flow: parsed once and remembered as this track's selected provider.
  const selectSearchResult = useCallback(
    (candidate: LyricsCandidate) => {
      if (!track) return;
      const parsed = parseCandidate(candidate, track.duration);
      useLyricsStore.getState().setSelectedSource(track.id, candidate.source);
      useLyricsStore.setState(previous => ({
        ...previous,
        status: "ready",
        candidates: [candidate, ...previous.candidates.filter(entry => entry.source !== candidate.source)],
        activeSource: candidate.source,
        parsed,
        lyrics: previous.parsed === parsed ? previous.lyrics ?? parsed.lyrics : parsed.lyrics,
        syncType: parsed.syncType,
        error: null,
      }));
    },
    [track, parseCandidate]
  );

  const patchDraft = useCallback(
    (patch: Partial<SearchDraft>) => {
      if (track) useLyricsStore.getState().patchDraft(track.id, patch);
    },
    [track]
  );

  const clearSearch = useCallback(() => {
    if (!track) return;
    // Clearing is a new search session, not merely a form edit: a response submitted before the
    // clear must not repopulate the freshly reset panel.
    generations.search += 1;
    generations.youtube += 1;
    useLyricsStore.getState().clearSearch(track.id, track);
  }, [track]);

  return useMemo<UseLyricsResult>(
    () => ({
      status: store.status,
      candidates: store.candidates,
      activeSource: store.activeSource,
      parsed: store.parsed,
      lyrics: store.lyrics,
      syncType: store.syncType,
      providerStatus: store.providerStatus,
      error: store.error,
      translating: store.translating,
      romanizing: store.romanizing,
      translatedLanguage: store.translatedLanguage,
      detectedLanguage: store.detectedLanguage,
      selectSource,
      reload,
      saveSidecar,
      chooseFile,
      manualSearchState: session?.manual ?? EMPTY_SEARCH,
      manualSearch,
      selectSearchResult,
      youtubeState: session?.youtube ?? IDLE_YOUTUBE,
      resolveYouTube,
      searchDraft: session?.draft ?? { title: "", artist: "", album: "", youtubeUrl: "" },
      patchDraft,
      clearSearch,
      hasLyrics: Boolean(store.lyrics && store.lyrics.length > 0),
    }),
    [
      store,
      session,
      selectSource,
      reload,
      saveSidecar,
      chooseFile,
      manualSearch,
      selectSearchResult,
      resolveYouTube,
      patchDraft,
      clearSearch,
    ]
  );
}
