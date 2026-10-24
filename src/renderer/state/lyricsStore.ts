/**
 * Application-level lyrics session store.
 *
 * Why this exists: the Now Playing view unmounts whenever the user opens another tab (see
 * `App.tsx` route switching). All lyrics state used to live in component-local hooks, so leaving
 * and returning to Now Playing destroyed the loaded lyrics, the selected provider and every manual
 * search — even though the main-process lyrics cache still held the data, the UI had to rebuild
 * everything and flash through a loading state.
 *
 * This Zustand store (same family as player/ui/settings stores) owns that state for the whole
 * application lifetime, so route changes neither clear lyrics nor cancel any in-flight work:
 * promises started before unmount resolve into the store, guarded by generation tokens, and main-
 * process cache writes are unaffected. Nothing here starts network requests — `useLyrics` keeps
 * owning the pipeline and calls these actions.
 *
 * Durability split:
 *  - In memory (this store): parsed lyrics, decorated lines, candidates and manual-search result
 *    rows (they contain full lyric text). These are re-creatable from the main-process disk cache.
 *  - `localStorage` (same pattern as the player session): the per-track search drafts, resolved
 *    YouTube metadata and the user's chosen provider identity, so a restart restores the query and
 *    selection while lyric text itself comes from the existing `LyricsCache` policy — no second
 *    cache system.
 */

import { create } from "zustand";
import type { Lyric, LyricSyncType } from "@braccato/types";
import type { LyricsCandidate, Track, YouTubeMetadata } from "../../shared/types";
import type { ParsedLyrics } from "../features/lyrics/parseLyrics";

export type LyricsStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface ManualSearchState {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  results: LyricsCandidate[];
  error: string | null;
}

export interface YouTubeResolveState {
  status: "idle" | "resolving" | "ready" | "invalid" | "unavailable" | "error";
  videoId: string | null;
  metadata: YouTubeMetadata | null;
  detail: string | null;
}

export interface SearchDraft {
  title: string;
  artist: string;
  album: string;
  youtubeUrl: string;
}

interface SearchSession {
  draft: SearchDraft;
  manual: ManualSearchState;
  youtube: YouTubeResolveState;
}

export interface ProviderStatusEntry {
  provider: string;
  status: string;
  detail?: string;
}

interface PersistedSession {
  drafts: Record<number, SearchDraft>;
  youtube: Record<number, YouTubeResolveState>;
  selectedSources: Record<number, string>;
}

interface LyricsStoreState {
  // Active lyrics for the current/last-played track.
  trackId: number | null;
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

  // Manual search lives per track so switching songs never overwrites another song's results.
  sessions: Record<number, SearchSession>;
  // Explicitly chosen provider per track; distinct from temporary search results.
  selectedSources: Record<number, string>;

  setActive: (trackId: number, patch: Partial<Omit<LyricsStoreState, "sessions" | "selectedSources">>) => void;
  resetActive: (trackId: number) => void;
  ensureSession: (track: Track) => SearchSession;
  getSession: (trackId: number) => SearchSession | undefined;
  patchDraft: (trackId: number, patch: Partial<SearchDraft>) => void;
  setManual: (trackId: number, manual: ManualSearchState) => void;
  setYoutube: (trackId: number, youtube: YouTubeResolveState) => void;
  clearSearch: (trackId: number, track: Track) => void;
  setSelectedSource: (trackId: number, source: string) => void;
}

const EMPTY_MANUAL: ManualSearchState = { status: "idle", results: [], error: null };
const IDLE_YOUTUBE: YouTubeResolveState = { status: "idle", videoId: null, metadata: null, detail: null };
const STORAGE_KEY = "cadence.lyrics.session.v1";

function draftFromTrack(track: Track): SearchDraft {
  return { title: track.title ?? "", artist: track.artist ?? "", album: track.album ?? "", youtubeUrl: "" };
}

function loadPersisted(): PersistedSession {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { drafts: {}, youtube: {}, selectedSources: {} };
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    return {
      drafts: parsed.drafts && typeof parsed.drafts === "object" ? parsed.drafts : {},
      youtube: parsed.youtube && typeof parsed.youtube === "object" ? parsed.youtube : {},
      selectedSources: parsed.selectedSources && typeof parsed.selectedSources === "object" ? parsed.selectedSources : {},
    };
  } catch {
    return { drafts: {}, youtube: {}, selectedSources: {} };
  }
}

function persistSession(state: LyricsStoreState): void {
  try {
    const payload: PersistedSession = {
      drafts: Object.fromEntries(Object.entries(state.sessions).map(([id, session]) => [id, session.draft])),
      // Only the small metadata card is durable; full result rows stay in memory.
      youtube: Object.fromEntries(Object.entries(state.sessions).map(([id, session]) => [id, session.youtube])),
      selectedSources: state.selectedSources,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage full or disabled: in-memory state still works for the session */
  }
}

const persisted = typeof localStorage !== "undefined" ? loadPersisted() : { drafts: {}, youtube: {}, selectedSources: {} };

export const useLyricsStore = create<LyricsStoreState>()((set, get) => ({
  trackId: null,
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
  sessions: {},
  selectedSources: persisted.selectedSources,

  setActive: (trackId, patch) => {
    set(state => ({ ...patch, trackId }));
  },

  resetActive: trackId => {
    set({
      trackId,
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
    });
  },

  ensureSession: track => {
    const existing = get().sessions[track.id];
    if (existing) return existing;
    const session: SearchSession = {
      draft: persisted.drafts[track.id] ?? draftFromTrack(track),
      manual: EMPTY_MANUAL,
      youtube: persisted.youtube[track.id] ?? IDLE_YOUTUBE,
    };
    set(state => ({ sessions: { ...state.sessions, [track.id]: session } }));
    return session;
  },

  getSession: trackId => get().sessions[trackId],

  patchDraft: (trackId, patch) => {
    set(state => {
      const current = state.sessions[trackId];
      if (!current) return state;
      const next: LyricsStoreState = {
        ...state,
        sessions: { ...state.sessions, [trackId]: { ...current, draft: { ...current.draft, ...patch } } },
      };
      persistSession(next);
      return next;
    });
  },

  setManual: (trackId, manual) => {
    set(state => {
      const current = state.sessions[trackId];
      if (!current) return state;
      return { ...state, sessions: { ...state.sessions, [trackId]: { ...current, manual } } };
    });
  },

  setYoutube: (trackId, youtube) => {
    set(state => {
      const current = state.sessions[trackId];
      if (!current) return state;
      const next: LyricsStoreState = {
        ...state,
        sessions: { ...state.sessions, [trackId]: { ...current, youtube } },
      };
      persistSession(next);
      return next;
    });
  },

  clearSearch: (trackId, track) => {
    const session: SearchSession = { draft: draftFromTrack(track), manual: EMPTY_MANUAL, youtube: IDLE_YOUTUBE };
    set(state => {
      const next: LyricsStoreState = { ...state, sessions: { ...state.sessions, [trackId]: session } };
      persistSession(next);
      return next;
    });
  },

  setSelectedSource: (trackId, source) => {
    set(state => {
      const next: LyricsStoreState = {
        ...state,
        selectedSources: { ...state.selectedSources, [trackId]: source },
        activeSource: state.trackId === trackId ? source : state.activeSource,
      };
      persistSession(next);
      return next;
    });
  },
}));

/** Non-reactive accessor for hooks and one-off reads. */
export const lyricsStore = useLyricsStore.getState;
