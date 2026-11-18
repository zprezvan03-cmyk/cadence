import { create } from "zustand";
import { runtimeFetch } from "../../main/lyrics/http";
import {
  PlaybackTelemetryTracker,
  type TelemetryEndReason,
} from "../../shared/listeningTelemetry";
import { mediaItemFromLocalTrack, trackSourceKey } from "../../shared/media";
import {
  buildSmartShuffleOrder,
  selectAutoPlayTracks,
  type SmartShuffleQueueSlot,
} from "../../shared/smartShuffle";
import type {
  MediaItem,
  PlaybackMechanism,
  PlaybackSettings,
  QueueEntry,
  RepeatMode,
  Track,
  TrackSource,
} from "../../shared/types";
import { audioEngine } from "../audio/engine";
import { computeReplayGain } from "../audio/replayGain";
import {
  advancePosition,
  appendAutoPlayEntries,
  buildOrder,
  buildPartitionedUnshuffledOrder,
  localQueueEntry,
  mediaQueueEntry,
  normalizeQueueEntries,
  pruneQueueOrder,
} from "../player/queue";
import { decideTransition, TransitionGuard } from "../player/transitions";
import { getRegisteredTracks, getTrackById } from "./trackRegistry";
import { useHistory } from "./historyStore";
import { useIntelligence } from "./intelligenceStore";
import { useLibrary } from "./libraryStore";
import { useSettings } from "./settingsStore";

const SESSION_KEY = "cadence.session.v1";
const AUTOPLAY_LOW_WATER_MARK = 2;
const AUTOPLAY_BATCH_SIZE = 5;

export interface SessionState {
  queue: QueueEntry[];
  order: number[];
  orderPosition: number;
  position: number;
  volume: number;
  muted: boolean;
  rate: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

export type RemotePlaybackStatus = "idle" | "unavailable";

interface PlayerState extends SessionState {
  isPlaying: boolean;
  buffering: boolean;
  duration: number;
  buffered: number;
  error: string | null;
  ended: boolean;
  /** Actual mechanism for the current source; remote origin is on the queue item itself. */
  playbackMechanism: PlaybackMechanism;
  remoteStatus: RemotePlaybackStatus;
  remoteError: string | null;
  playQueue: (trackIds: number[], startIndex?: number) => Promise<void>;
  playShuffled: (trackIds: number[], startIndex?: number) => Promise<void>;
  playMediaQueue: (
    items: readonly MediaItem[],
    startIndex?: number,
  ) => Promise<void>;
  playMediaShuffled: (
    items: readonly MediaItem[],
    startIndex?: number,
  ) => Promise<void>;
  playMediaItem: (item: MediaItem) => Promise<void>;
  playTrack: (trackId: number) => Promise<void>;
  playNext: (trackIds: number[]) => void;
  addToQueue: (trackIds: number[]) => void;
  addMediaToQueue: (
    items: readonly MediaItem[],
    placement?: "end" | "next",
  ) => void;
  removeFromQueue: (trackId: number) => void;
  removeQueueEntry: (occurrenceId: string) => void;
  clearQueue: () => void;
  toggle: () => Promise<void>;
  next: (auto?: boolean, fadeSeconds?: number) => Promise<void>;
  previous: () => void;
  seek: (seconds: number) => void;
  jumpTo: (position: number) => Promise<void>;
  seekBy: (seconds: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  setRate: (rate: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setRepeat: (repeat: RepeatMode) => void;
  replenishAutoPlay: () => number;
  restore: (session: SessionState) => Promise<void>;
  handleEnded: () => Promise<void>;
  /** Called by the local engine bridge on every tick. Ignored while a remote item is current. */
  syncTime: (position: number, duration: number, buffered: number) => void;
  syncState: (state: {
    playing: boolean;
    buffering: boolean;
    ended: boolean;
  }) => void;
  setError: (message: string | null) => void;
}

export const currentQueueEntry = (state: PlayerState): QueueEntry | null => {
  const queueIndex = state.order[state.orderPosition];
  return queueIndex === undefined ? null : (state.queue[queueIndex] ?? null);
};

export const currentSource = (state: PlayerState): TrackSource | null =>
  currentQueueEntry(state)?.item.source ?? null;

export const currentMediaItem = (state: PlayerState): MediaItem | null =>
  currentQueueEntry(state)?.item ?? null;

/** Local-only compatibility selector. Remote playback deliberately returns null. */
export const currentTrackId = (state: PlayerState): number | null => {
  const source = currentSource(state);
  return source?.kind === "local" ? source.trackId : null;
};

function persist(state: PlayerState): void {
  const session: SessionState = {
    queue: state.queue,
    order: state.order,
    orderPosition: state.orderPosition,
    position: state.position,
    volume: state.volume,
    muted: state.muted,
    rate: state.rate,
    shuffle: state.shuffle,
    repeat: state.repeat,
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* storage full or disabled: session restore is a convenience, not a requirement */
  }
}

export function readSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionState> & {
      queue?: unknown;
    };
    if (!Array.isArray(parsed.queue) || !Array.isArray(parsed.order))
      return null;
    const queue = normalizeQueueEntries(parsed.queue);
    const rawOrder = parsed.order.filter(
      (index): index is number =>
        typeof index === "number" &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < queue.length,
    );
    const pruned = pruneQueueOrder(
      queue,
      queue.length === parsed.queue.length
        ? rawOrder
        : queue.map((_, index) => index),
      Number(parsed.orderPosition) || 0,
      () => true,
    );
    return {
      queue: pruned.queue,
      order: pruned.order,
      orderPosition: pruned.orderPosition,
      position: Number(parsed.position) || 0,
      volume: typeof parsed.volume === "number" ? parsed.volume : 0.85,
      muted: Boolean(parsed.muted),
      rate: typeof parsed.rate === "number" ? parsed.rate : 1,
      shuffle: Boolean(parsed.shuffle),
      repeat:
        parsed.repeat === "all" || parsed.repeat === "one"
          ? parsed.repeat
          : "off",
    };
  } catch {
    return null;
  }
}

/**
 * Drops restored local entries whose files are gone and legacy non-local entries (this build has
 * no remote provider registered). Order/current position are remapped together, so pruning cannot
 * silently point Cadence at a different queue entry.
 */
export function pruneSessionQueue(
  session: SessionState,
  availableTrackIds: ReadonlySet<number>,
): SessionState {
  const oldCurrentIndex = session.order[session.orderPosition];
  const oldCurrent =
    oldCurrentIndex === undefined
      ? null
      : (session.queue[oldCurrentIndex] ?? null);
  const pruned = pruneQueueOrder(
    session.queue,
    session.order,
    session.orderPosition,
    (entry) => {
      if (entry.item.source.kind === "local")
        return availableTrackIds.has(entry.item.source.trackId);
      return false;
    },
  );
  const newCurrentIndex = pruned.order[pruned.orderPosition];
  const newCurrent =
    newCurrentIndex === undefined
      ? null
      : (pruned.queue[newCurrentIndex] ?? null);
  return {
    ...session,
    ...pruned,
    position:
      oldCurrent && newCurrent?.occurrenceId === oldCurrent.occurrenceId
        ? session.position
        : 0,
  };
}

let loadToken = 0;
let lastPositionPersistAt = 0;
let occurrenceCounter = 0;
const transitionGuard = new TransitionGuard();
const telemetryTracker = new PlaybackTelemetryTracker();
let pendingTelemetryReason: TelemetryEndReason = "context-change";
const recentPlayedTrackIds: number[] = [];

function pushRecentPlayedTrackId(trackId: number): void {
  const existingIdx = recentPlayedTrackIds.indexOf(trackId);
  if (existingIdx >= 0) {
    recentPlayedTrackIds.splice(existingIdx, 1);
  }
  recentPlayedTrackIds.push(trackId);
  if (recentPlayedTrackIds.length > 64) {
    recentPlayedTrackIds.splice(0, recentPlayedTrackIds.length - 64);
  }
}

function getAvailableLibraryTracks(): Track[] {
  const snapshotTracks = useLibrary.getState().snapshot?.tracks;
  if (snapshotTracks && snapshotTracks.length > 0) {
    return snapshotTracks;
  }
  return getRegisteredTracks();
}

function nextOccurrenceId(): string {
  occurrenceCounter += 1;
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `q-${occurrenceCounter}-${random}`;
}

type PlaybackAudioSettings = Pick<
  PlaybackSettings,
  | "crossfadeSeconds"
  | "gaplessPlayback"
  | "replayGainMode"
  | "replayGainPreampDb"
  | "replayGainPreventClipping"
>;

const FALLBACK_PLAYBACK_AUDIO: PlaybackAudioSettings = {
  crossfadeSeconds: 0,
  gaplessPlayback: false,
  replayGainMode: "off",
  replayGainPreampDb: 0,
  replayGainPreventClipping: true,
};

function playbackAudioSettings(): PlaybackAudioSettings {
  return useSettings.getState().settings?.playback ?? FALLBACK_PLAYBACK_AUDIO;
}

function replayGainForTrack(track: Track): number {
  return computeReplayGain(track, playbackAudioSettings()).linear;
}

export const usePlayer = create<PlayerState>()((set, get) => {
  const after = () => persist(get());

  const finalizeCurrentTelemetry = (reason: TelemetryEndReason): void => {
    const ev = telemetryTracker.finalizeCurrent(reason);
    if (ev) {
      useIntelligence.getState().applyTelemetryEvent(ev);
    }
  };

  const triggerHorizonPopularityPrefetch = (): void => {
    const settings = useSettings.getState().settings;
    const enabled = settings?.playback?.smartShufflePopularity ?? true;
    if (!enabled) return;

    const state = get();
    const horizonTracks: Track[] = [];
    for (
      let pos = state.orderPosition;
      pos < Math.min(state.order.length, state.orderPosition + 7);
      pos++
    ) {
      const resolved = trackAtPosition(state, pos);
      if (resolved) horizonTracks.push(resolved.track);
    }
    if (horizonTracks.length === 0) return;

    useIntelligence.getState().prefetchHorizonPopularity(
      horizonTracks,
      {
        enabled: true,
        lastFmApiKey: settings?.scrobbling?.apiKey || undefined,
        fetchFn: runtimeFetch,
      },
      6,
    );
  };

  const buildActiveOrder = (
    queue: readonly QueueEntry[],
    shuffle: boolean,
    currentQueueIndex: number,
    existingOrder?: readonly number[],
  ): number[] => {
    if (!shuffle || queue.length <= 1) {
      return buildOrder(queue.length, false, currentQueueIndex);
    }
    const shuffleMode =
      useSettings.getState().settings?.playback?.shuffleMode ?? "smart";
    if (shuffleMode === "classic") {
      return buildOrder(queue.length, true, currentQueueIndex);
    }
    const availableTracks = getAvailableLibraryTracks();
    if (availableTracks.length === 0) {
      return buildOrder(queue.length, true, currentQueueIndex);
    }
    const historyEntries = useHistory.getState().entries;
    const intelState = useIntelligence.getState();
    const cachedIndex = intelState.getCachedIndex(
      availableTracks,
      historyEntries,
    );
    const slots: SmartShuffleQueueSlot[] = queue.map((entry, queueIndex) => ({
      queueIndex,
      trackId:
        entry.item.source.kind === "local" ? entry.item.source.trackId : null,
      origin: entry.origin ?? "context",
    }));
    return buildSmartShuffleOrder(slots, currentQueueIndex, availableTracks, {
      libraryIndex: cachedIndex,
      intelligenceByKey: intelState.byRecordingKey,
      historyEntries,
      recentPlayedTrackIds,
      existingOrder,
    });
  };

  const replenishAutoPlayIfNeeded = (): number => {
    const state = get();
    if (state.repeat !== "off") return 0;
    const autoPlayEnabled =
      useSettings.getState().settings?.playback?.autoPlay ?? true;
    if (!autoPlayEnabled) return 0;
    if (state.queue.length === 0 || state.order.length === 0) return 0;

    const remainingUpcoming = state.order.length - 1 - state.orderPosition;
    if (remainingUpcoming >= AUTOPLAY_LOW_WATER_MARK) return 0;

    const availableTracks = getAvailableLibraryTracks();
    if (availableTracks.length === 0) return 0;

    // The genre anchor is the user's queue, taken as a whole.
    //
    // Every entry the listener put there — the `"manual"` ones they queued explicitly plus the
    // `"context"` entries that came from the album/playlist they started — contributes one unit of
    // weight; `selectAutoPlayTracks` folds them into a single mean cluster distribution. AutoPlay's
    // own `"autoplay"` entries are skipped, so a batch can never re-anchor on the previous batch's
    // output (the feedback loop that used to let an Electronic/Phonk recommendation become the
    // context for the next round). Playback history never enters the anchor either: it still
    // contributes to artist/album spacing and cooldowns through `recentPlayedTrackIds` below, but
    // not to the genre profile.
    //
    // The list is rebuilt from the live queue on every replenishment, so adding or removing queue
    // entries immediately changes the profile while reordering has no effect (the anchor is a mean,
    // not a sequence).
    const anchorTrackIds: number[] = [];
    for (const entry of state.queue) {
      if (entry.origin === "autoplay") continue;
      if (entry.item.source.kind !== "local") continue;
      anchorTrackIds.push(entry.item.source.trackId);
    }

    // `seedTrackIds` keeps only its non-genre jobs (recency marks for artist/album spacing and the
    // duplicate-recording guard); the genre profile comes from `anchorTrackIds` alone.
    const seedTrackIds: number[] = [];
    const currentEntry = entryAtPosition(state, state.orderPosition);
    if (currentEntry?.item.source.kind === "local") {
      seedTrackIds.push(currentEntry.item.source.trackId);
    }

    // Exclude all tracks already in the queue so AutoPlay doesn't duplicate queued songs
    const queueTrackIds = new Set<number>();
    for (const entry of state.queue) {
      if (entry.item.source.kind === "local") {
        queueTrackIds.add(entry.item.source.trackId);
      }
    }

    // If the library has more tracks than the queue, exclude the entire queue;
    // for tiny libraries where every track is already in the queue, exclude only current + upcoming
    let excludeIds: Set<number>;
    if (availableTracks.length > queueTrackIds.size) {
      excludeIds = queueTrackIds;
    } else {
      excludeIds = new Set<number>();
      for (let pos = state.orderPosition; pos < state.order.length; pos++) {
        const entry = entryAtPosition(state, pos);
        if (entry?.item.source.kind === "local") {
          excludeIds.add(entry.item.source.trackId);
        }
      }
    }

    const historyEntries = useHistory.getState().entries;
    const intelState = useIntelligence.getState();
    const cachedIndex = intelState.getCachedIndex(
      availableTracks,
      historyEntries,
    );

    const selectedTrackIds = selectAutoPlayTracks(availableTracks, {
      count: AUTOPLAY_BATCH_SIZE,
      seedTrackIds,
      anchorTrackIds,
      excludeTrackIds: excludeIds,
      libraryIndex: cachedIndex,
      intelligenceByKey: intelState.byRecordingKey,
      historyEntries,
      recentPlayedTrackIds,
      onDiagnostics: (report) => {
        intelState.recordDiagnostics(report);
        if (useSettings.getState().settings?.advanced?.showLogs) {
          if (report.noCompatibleCandidatesReason) {
            console.info(
              `[Cadence AutoPlay] ${report.noCompatibleCandidatesReason}`,
            );
          } else {
            console.info(
              `[Cadence AutoPlay] Selected ${report.selectedTrackIds.length} track(s) at stage='${report.relaxationStage}' (threshold=${report.activeThresholdUsed.toFixed(2)}, compatible=${report.compatibleCandidateCount}, rejectedIncompatible=${report.rejectedIncompatibleCount})`,
            );
          }
        }
      },
    });

    if (selectedTrackIds.length === 0) return 0;

    const autoEntries = selectedTrackIds.map((trackId) =>
      localQueueEntry(
        trackId,
        nextOccurrenceId(),
        getTrackById(trackId),
        "autoplay",
      ),
    );
    const appended = appendAutoPlayEntries(
      state.queue,
      state.order,
      autoEntries,
    );
    if (appended.addedCount === 0) return 0;

    set({
      queue: appended.queue,
      order: appended.order,
    });
    after();
    return appended.addedCount;
  };

  const recordStartedTrack = (
    trackId: number,
    track: Track,
    occurrenceId?: string,
  ): void => {
    pushRecentPlayedTrackId(trackId);
    const prevEvent = telemetryTracker.startSession(
      `${occurrenceId ?? trackId}:${loadToken}`,
      {
        trackId,
        title: track.title,
        artist: track.artist,
        durationSeconds: track.duration,
      },
      get().position,
      Date.now(),
      pendingTelemetryReason,
    );
    pendingTelemetryReason = "context-change";
    if (prevEvent) {
      useIntelligence.getState().applyTelemetryEvent(prevEvent);
    }

    void useLibrary
      .getState()
      .recordPlay(trackId)
      .catch(() => undefined);
    void useHistory
      .getState()
      .add(track)
      .catch(() => undefined);
    replenishAutoPlayIfNeeded();
    triggerHorizonPopularityPrefetch();
    // Prepare the successor while this track is running instead of at the transition boundary.
    prewarmNext();
  };

  const entryAtPosition = (
    state: PlayerState,
    position: number,
  ): QueueEntry | null => {
    const queueIndex = state.order[position];
    return queueIndex === undefined ? null : (state.queue[queueIndex] ?? null);
  };

  const resolvedItem = (entry: QueueEntry): MediaItem => {
    if (entry.item.source.kind === "local") {
      const track = getTrackById(entry.item.source.trackId);
      return track
        ? mediaItemFromLocalTrack(track, entry.item.fetchedAt || Date.now())
        : entry.item;
    }
    return entry.item;
  };

  const trackAtPosition = (
    state: PlayerState,
    position: number,
  ): { entry: QueueEntry; trackId: number; track: Track } | null => {
    const entry = entryAtPosition(state, position);
    if (!entry || entry.item.source.kind !== "local") return null;
    const trackId = entry.item.source.trackId;
    const track = getTrackById(trackId);
    return track ? { entry, trackId, track } : null;
  };

  const loadCurrent = async (autoplay: boolean): Promise<void> => {
    const state = get();
    const entry = entryAtPosition(state, state.orderPosition);
    if (!entry) return;

    if (entry.item.source.kind !== "local") {
      const item = resolvedItem(entry);
      loadToken += 1;
      transitionGuard.reset();
      audioEngine.pause();
      const message = "Remote playback is not available in this build.";
      set({
        playbackMechanism: "unavailable",
        duration: item.durationSeconds ?? 0,
        buffered: 0,
        isPlaying: false,
        buffering: false,
        ended: false,
        error: message,
        remoteStatus: "unavailable",
        remoteError: message,
      });
      return;
    }

    const trackId = entry.item.source.trackId;
    const track = getTrackById(trackId);
    if (!track) return;
    const token = ++loadToken;
    transitionGuard.reset();
    set({
      playbackMechanism: "local-file",
      duration: track.duration,
      remoteStatus: "idle",
      remoteError: null,
    });
    const loaded = await audioEngine.load(track, {
      gain: replayGainForTrack(track),
    });
    if (!loaded || token !== loadToken) return;
    if (state.position > 0) audioEngine.seek(state.position);
    audioEngine.setVolume(state.volume);
    audioEngine.setMuted(state.muted);
    audioEngine.setRate(state.rate);
    if (autoplay) {
      await audioEngine.play();
      if (token !== loadToken) return;
      // The engine reports decoder/play() failures through its own state; only a track that really
      // started belongs in Home → Recently played and in listening history.
      if (!audioEngine.paused && !audioEngine.element.error) {
        recordStartedTrack(trackId, track, entry.occurrenceId);
      }
    }
  };

  /**
   * Prepares the next queue entry in the background. ALAC always gets its native PCM decode;
   * the standby media deck is loaded only when gapless playback or crossfade is enabled.
   * Skipped for repeat-one, where the next track is the one already playing.
   */
  const prewarmNext = (): void => {
    const state = get();
    if (state.order.length === 0) return;
    const result = advancePosition(
      state.orderPosition,
      state.order.length,
      state.repeat,
      1,
    );
    if (result.exhausted || result.restart) return;
    const next = trackAtPosition(state, result.position);
    if (!next) return;
    audioEngine.prewarm(next.track);
    const audio = playbackAudioSettings();
    if (audio.crossfadeSeconds > 0 || audio.gaplessPlayback) {
      void audioEngine.preloadNext(next.track).catch(() => undefined);
    }
  };

  /**
   * Promotes the standby deck only after the engine confirms the target really started. Queue
   * state deliberately flips at that point, so a failed automatic transition leaves the outgoing
   * track current and able to reach its natural `ended` fallback.
   */
  const transitionToPosition = async (
    position: number,
    fadeSeconds: number,
  ): Promise<boolean> => {
    const target = trackAtPosition(get(), position);
    if (!target) return false;
    const token = ++loadToken;
    const started = await audioEngine.transitionTo(target.track, {
      fadeSeconds,
      gain: replayGainForTrack(target.track),
    });
    if (!started || token !== loadToken) return false;

    const current = get();
    set({
      orderPosition: position,
      position: 0,
      duration: target.track.duration,
      error: null,
      ended: false,
      playbackMechanism: "local-file",
      remoteStatus: "idle",
      remoteError: null,
    });
    audioEngine.setVolume(current.volume);
    audioEngine.setMuted(current.muted);
    audioEngine.setRate(current.rate);
    if (!audioEngine.paused && !audioEngine.element.error) {
      recordStartedTrack(
        target.trackId,
        target.track,
        target.entry.occurrenceId,
      );
    }
    after();
    return true;
  };

  const goToPosition = async (
    position: number,
    autoplay: boolean,
  ): Promise<void> => {
    set({ orderPosition: position, position: 0, ended: false });
    await loadCurrent(autoplay);
    after();
  };

  const playEntries = async (
    entries: QueueEntry[],
    startIndex = 0,
  ): Promise<void> => {
    if (entries.length === 0) return;
    pendingTelemetryReason = "context-change";
    const shuffle = get().shuffle;
    const start = Math.max(0, Math.min(startIndex, entries.length - 1));
    const taggedEntries = entries.map((e) => ({
      ...e,
      origin: e.origin ?? "context",
    }));
    const order = buildActiveOrder(taggedEntries, shuffle, start);
    set({
      queue: taggedEntries,
      order,
      orderPosition: shuffle ? 0 : start,
      position: 0,
      duration: 0,
      buffered: 0,
      error: null,
      ended: false,
    });
    await loadCurrent(true);
    after();
  };

  const playableEntriesFromItems = (
    items: readonly MediaItem[],
    startIndex: number,
  ): { entries: QueueEntry[]; start: number } => {
    const requestedStart = Math.max(
      0,
      Math.min(startIndex, Math.max(0, items.length - 1)),
    );
    const mapped = items.map((item, index) => ({ item, index }));
    const playable = mapped.filter(
      ({ item }) => item.availability !== "unavailable",
    );
    const entries = playable.map(({ item }) =>
      mediaQueueEntry(item, nextOccurrenceId()),
    );
    const startOffset = playable.findIndex(
      ({ index }) => index === requestedStart,
    );
    const followingOffset = playable.findIndex(
      ({ index }) => index > requestedStart,
    );
    return {
      entries,
      start: startOffset >= 0 ? startOffset : Math.max(0, followingOffset),
    };
  };

  const findQueueIndexBySource = (
    state: PlayerState,
    source: TrackSource,
  ): number => {
    const key = trackSourceKey(source);
    return state.queue.findIndex(
      (entry) => trackSourceKey(entry.item.source) === key,
    );
  };

  const insertEntriesNext = (requestedEntries: QueueEntry[]): void => {
    const state = get();
    const currentQueueIndex = state.order[state.orderPosition];
    const currentEntry =
      currentQueueIndex === undefined
        ? null
        : (state.queue[currentQueueIndex] ?? null);
    const currentKey = currentEntry
      ? trackSourceKey(currentEntry.item.source)
      : null;
    const seen = new Set<string>();
    const requested = requestedEntries.filter((entry) => {
      const key = trackSourceKey(entry.item.source);
      if (key === currentKey || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (requested.length === 0) return;

    const queue = [...state.queue];
    const inserted: number[] = [];
    for (const entry of requested) {
      const existing = findQueueIndexBySource(
        { ...state, queue },
        entry.item.source,
      );
      if (existing >= 0) {
        queue[existing] = {
          ...queue[existing],
          item: entry.item,
          origin: "manual",
        };
        inserted.push(existing);
      } else {
        queue.push({ ...entry, origin: "manual" });
        inserted.push(queue.length - 1);
      }
    }
    const insertedSet = new Set(inserted);
    const remainingOrder = state.order.filter(
      (index) => !insertedSet.has(index),
    );
    const currentOrderPosition =
      currentQueueIndex === undefined
        ? -1
        : remainingOrder.indexOf(currentQueueIndex);
    const insertAt = currentOrderPosition >= 0 ? currentOrderPosition + 1 : 0;
    const order = [
      ...remainingOrder.slice(0, insertAt),
      ...inserted,
      ...remainingOrder.slice(insertAt),
    ];
    set({
      queue,
      order,
      orderPosition: currentOrderPosition >= 0 ? currentOrderPosition : 0,
    });
    prewarmNext();
    after();
  };

  const appendEntries = (requestedEntries: QueueEntry[]): void => {
    const state = get();
    if (requestedEntries.length === 0) return;
    const currentQueueIndex = state.order[state.orderPosition];
    const currentEntry =
      currentQueueIndex === undefined
        ? null
        : (state.queue[currentQueueIndex] ?? null);
    const currentKey = currentEntry
      ? trackSourceKey(currentEntry.item.source)
      : null;
    const seen = new Set<string>();
    const requested = requestedEntries.filter((entry) => {
      const key = trackSourceKey(entry.item.source);
      if (key === currentKey || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (requested.length === 0) return;

    const queue = [...state.queue];
    const manualOrderSlots: number[] = [];
    const upgradedSet = new Set<number>();

    for (const entry of requested) {
      const existing = findQueueIndexBySource(
        { ...state, queue },
        entry.item.source,
      );
      if (existing >= 0) {
        const existingPos = state.order.indexOf(existing);
        const existingOrigin = queue[existing]?.origin ?? "context";
        queue[existing] = {
          ...queue[existing],
          item: entry.item,
          origin: "manual",
        };
        // If this track was sitting in an upcoming AutoPlay or Context slot, move it into the Manual priority block
        if (
          existingPos > state.orderPosition ||
          existingOrigin === "autoplay"
        ) {
          manualOrderSlots.push(existing);
          upgradedSet.add(existing);
        }
        continue;
      }
      queue.push({ ...entry, origin: "manual" });
      manualOrderSlots.push(queue.length - 1);
    }

    if (manualOrderSlots.length === 0 && queue === state.queue) return;

    const baseOrder =
      upgradedSet.size > 0
        ? state.order.filter((idx) => !upgradedSet.has(idx))
        : [...state.order];
    const currentOrderPosition =
      currentQueueIndex === undefined
        ? -1
        : baseOrder.indexOf(currentQueueIndex);

    // Insert at the end of the contiguous upcoming "manual" block (strictly before all upcoming "context" and "autoplay" entries)
    let insertAt =
      currentOrderPosition >= 0 ? currentOrderPosition + 1 : baseOrder.length;
    while (insertAt < baseOrder.length) {
      const slotEntry = queue[baseOrder[insertAt]];
      if (slotEntry?.origin === "manual") {
        insertAt += 1;
      } else {
        break;
      }
    }

    const nextOrder = [
      ...baseOrder.slice(0, insertAt),
      ...manualOrderSlots,
      ...baseOrder.slice(insertAt),
    ];

    set({
      queue,
      order: nextOrder,
      orderPosition: currentOrderPosition >= 0 ? currentOrderPosition : 0,
    });
    prewarmNext();
    after();
  };

  const removeEntryAtQueueIndex = (queueIndex: number): void => {
    const state = get();
    if (queueIndex < 0 || queueIndex >= state.queue.length) return;
    const removingCurrent = state.order[state.orderPosition] === queueIndex;
    const wasPlaying = state.isPlaying;
    const queue = state.queue.filter((_, index) => index !== queueIndex);
    const order = state.order
      .filter((index) => index !== queueIndex)
      .map((index) => (index > queueIndex ? index - 1 : index));
    const removedOrderPosition = state.order.indexOf(queueIndex);
    const orderPosition = removingCurrent
      ? Math.min(state.orderPosition, Math.max(0, order.length - 1))
      : removedOrderPosition >= 0 && removedOrderPosition < state.orderPosition
        ? state.orderPosition - 1
        : state.orderPosition;
    set({
      queue,
      order,
      orderPosition,
      ...(removingCurrent ? { position: 0, duration: 0, ended: false } : {}),
    });
    if (removingCurrent) {
      if (queue.length === 0) {
        audioEngine.pause();
        set({
          isPlaying: false,
          buffering: false,
          position: 0,
          duration: 0,
          playbackMechanism: "unavailable",
          remoteStatus: "idle",
          remoteError: null,
        });
      } else {
        void loadCurrent(wasPlaying);
      }
    }
    after();
  };

  return {
    queue: [],
    order: [],
    orderPosition: 0,
    position: 0,
    duration: 0,
    buffered: 0,
    volume: 0.85,
    muted: false,
    rate: 1,
    shuffle: false,
    repeat: "off",
    isPlaying: false,
    buffering: false,
    error: null,
    ended: false,
    playbackMechanism: "unavailable",
    remoteStatus: "idle",
    remoteError: null,

    playQueue: async (trackIds, startIndex = 0) => {
      if (trackIds.length === 0) return;
      const entries = trackIds.map((trackId) =>
        localQueueEntry(trackId, nextOccurrenceId(), getTrackById(trackId)),
      );
      await playEntries(entries, startIndex);
    },

    playShuffled: async (trackIds, startIndex = 0) => {
      if (trackIds.length === 0) return;
      if (!get().shuffle) get().toggleShuffle();
      await get().playQueue(trackIds, startIndex);
    },

    playMediaQueue: async (items, startIndex = 0) => {
      if (items.length === 0) return;
      const { entries, start } = playableEntriesFromItems(items, startIndex);
      await playEntries(entries, start);
    },

    playMediaShuffled: async (items, startIndex = 0) => {
      if (items.length === 0) return;
      if (!get().shuffle) get().toggleShuffle();
      await get().playMediaQueue(items, startIndex);
    },

    playMediaItem: async (item) => {
      if (item.source.kind === "local") {
        await get().playTrack(item.source.trackId);
        return;
      }
      const state = get();
      const existing = findQueueIndexBySource(state, item.source);
      if (existing >= 0) {
        const queue = [...state.queue];
        queue[existing] = {
          ...queue[existing],
          item: { ...queue[existing].item, ...item },
        };
        set({ queue });
        const position = state.order.indexOf(existing);
        if (position >= 0) {
          await goToPosition(position, true);
          return;
        }
      }
      const entry = mediaQueueEntry(item, nextOccurrenceId());
      set({
        queue: state.queue.concat(entry),
        order: state.order.concat(state.queue.length),
      });
      await goToPosition(get().order.length - 1, true);
    },

    playTrack: async (trackId) => {
      const state = get();
      const existing = findQueueIndexBySource(state, {
        kind: "local",
        trackId,
      });
      if (existing !== -1) {
        const position = state.order.indexOf(existing);
        if (position !== -1) {
          if (position === state.orderPosition) {
            if (state.buffering && !audioEngine.element.src) return;
            get().seek(0);
            await audioEngine.play();
            // Restarting the current track is a genuine replay: a new listening session.
            if (!audioEngine.paused && !audioEngine.element.error) {
              const track = getTrackById(trackId);
              if (track)
                void useHistory
                  .getState()
                  .add(track)
                  .catch(() => undefined);
            }
            return;
          }
          await goToPosition(position, true);
          return;
        }
      }
      const entry = localQueueEntry(
        trackId,
        nextOccurrenceId(),
        getTrackById(trackId),
        "context",
      );
      const queue = [...state.queue, entry];
      const order = buildActiveOrder(queue, state.shuffle, queue.length - 1);
      pendingTelemetryReason = "manual-skip";
      set({
        queue,
        order,
        orderPosition: state.shuffle ? 0 : queue.length - 1,
        position: 0,
        duration: 0,
        error: null,
        ended: false,
      });
      await loadCurrent(true);
      after();
    },

    playNext: (trackIds) => {
      insertEntriesNext(
        trackIds.map((trackId) =>
          localQueueEntry(
            trackId,
            nextOccurrenceId(),
            getTrackById(trackId),
            "manual",
          ),
        ),
      );
    },

    addToQueue: (trackIds) => {
      appendEntries(
        trackIds.map((trackId) =>
          localQueueEntry(
            trackId,
            nextOccurrenceId(),
            getTrackById(trackId),
            "manual",
          ),
        ),
      );
    },

    addMediaToQueue: (items, placement = "end") => {
      const { entries } = playableEntriesFromItems(items, 0);
      if (placement === "next") insertEntriesNext(entries);
      else appendEntries(entries);
    },

    removeFromQueue: (trackId) => {
      const state = get();
      removeEntryAtQueueIndex(
        findQueueIndexBySource(state, { kind: "local", trackId }),
      );
    },

    removeQueueEntry: (occurrenceId) => {
      const state = get();
      removeEntryAtQueueIndex(
        state.queue.findIndex((entry) => entry.occurrenceId === occurrenceId),
      );
    },

    clearQueue: () => {
      finalizeCurrentTelemetry("stop");
      audioEngine.pause();
      set({
        queue: [],
        order: [],
        orderPosition: 0,
        position: 0,
        duration: 0,
        buffered: 0,
        isPlaying: false,
        buffering: false,
        ended: false,
        error: null,
        playbackMechanism: "unavailable",
        remoteStatus: "idle",
        remoteError: null,
      });
      after();
    },

    toggle: async () => {
      const state = get();
      if (state.queue.length === 0) return;
      const current = currentQueueEntry(state);
      if (current && current.item.source.kind !== "local") {
        const message = "Remote playback is not available in this build.";
        set({
          isPlaying: false,
          buffering: false,
          remoteStatus: "unavailable",
          remoteError: message,
          error: message,
        });
        after();
        return;
      }
      if (!audioEngine.element.src) {
        // A metadata-identified ALAC source may still be decoding to the disposable PCM cache.
        // Avoid starting a duplicate native decode while that load is in flight.
        if (state.buffering) return;
        await loadCurrent(true);
        return;
      }
      await audioEngine.toggle();
    },

    next: async (auto, fadeSeconds) => {
      let state = get();
      if (state.order.length === 0) return;
      pendingTelemetryReason = auto ? "natural-end" : "manual-skip";

      // If we are at the tail of the queue with repeat === "off", attempt AutoPlay replenishment before advancing
      if (
        state.repeat === "off" &&
        state.orderPosition + 1 >= state.order.length
      ) {
        replenishAutoPlayIfNeeded();
        state = get();
      }

      const result = advancePosition(
        state.orderPosition,
        state.order.length,
        state.repeat,
        1,
      );
      if (result.restart) {
        transitionGuard.reset();
        const current = currentQueueEntry(state);
        if (current && current.item.source.kind !== "local") {
          set({ position: 0, ended: false });
          await loadCurrent(true);
          after();
          return;
        }
        audioEngine.seek(0);
        await audioEngine.play();
        return;
      }
      if (result.exhausted && auto) {
        finalizeCurrentTelemetry("natural-end");
        set({ isPlaying: false, ended: true, position: state.duration });
        audioEngine.pause();
        return;
      }

      const current = entryAtPosition(state, state.orderPosition);
      const target = entryAtPosition(state, result.position);
      const crossesMechanism =
        !current ||
        !target ||
        (current.item.source.kind === "local") !==
          (target.item.source.kind === "local");
      if (crossesMechanism) {
        await goToPosition(result.position, true);
        return;
      }

      const audio = playbackAudioSettings();
      const manualCrossfade =
        !auto &&
        !audioEngine.paused &&
        audio.crossfadeSeconds > 0 &&
        result.position !== state.orderPosition;
      if (fadeSeconds !== undefined || manualCrossfade) {
        const started = await transitionToPosition(
          result.position,
          fadeSeconds ?? audio.crossfadeSeconds,
        );
        // An automatic failure leaves the outgoing track to finish naturally. A manual request
        // falls back to the proven cut, unless another action has already changed the queue head.
        if (started || auto || get().orderPosition !== state.orderPosition)
          return;
      }
      await goToPosition(result.position, true);
    },

    previous: () => {
      const state = get();
      if (state.order.length === 0) return;
      if (state.position > 3) {
        get().seek(0);
        return;
      }
      pendingTelemetryReason = "manual-skip";
      const result = advancePosition(
        state.orderPosition,
        state.order.length,
        state.repeat,
        -1,
      );
      const current = entryAtPosition(state, state.orderPosition);
      const target = entryAtPosition(state, result.position);
      const crossesMechanism =
        !current ||
        !target ||
        (current.item.source.kind === "local") !==
          (target.item.source.kind === "local");
      const shouldAutoplay =
        current?.item.source.kind === "local"
          ? !audioEngine.paused
          : state.isPlaying || state.buffering;
      if (crossesMechanism) {
        void goToPosition(result.position, shouldAutoplay);
        return;
      }
      const audio = playbackAudioSettings();
      if (
        !audioEngine.paused &&
        audio.crossfadeSeconds > 0 &&
        result.position !== state.orderPosition
      ) {
        void (async () => {
          const started = await transitionToPosition(
            result.position,
            audio.crossfadeSeconds,
          );
          if (!started && get().orderPosition === state.orderPosition) {
            await goToPosition(result.position, true);
          }
        })();
        return;
      }
      void goToPosition(result.position, shouldAutoplay);
    },

    seek: (seconds) => {
      transitionGuard.reset();
      const state = get();
      const current = currentQueueEntry(state);
      const target = Math.max(
        0,
        state.duration > 0 ? Math.min(seconds, state.duration) : seconds,
      );
      telemetryTracker.observeSeek(target, state.duration);
      if (current && current.item.source.kind !== "local") {
        set({ position: target, ended: false });
        after();
        return;
      }
      audioEngine.seek(target);
      set({ position: target, ended: false });
      after();
    },

    jumpTo: async (position) => {
      if (position < 0 || position >= get().order.length) return;
      pendingTelemetryReason = "manual-skip";
      await goToPosition(position, true);
    },

    seekBy: (seconds) => {
      const state = get();
      state.seek(state.position + seconds);
    },

    setVolume: (volume) => {
      const clamped = Math.max(0, Math.min(1, volume));
      audioEngine.setVolume(clamped);
      if (clamped > 0) audioEngine.setMuted(false);
      set({ volume: clamped, muted: clamped > 0 ? false : get().muted });
      after();
    },

    setMuted: (muted) => {
      audioEngine.setMuted(muted);
      set({ muted });
      after();
    },

    setRate: (rate) => {
      audioEngine.setRate(rate);
      set({ rate });
      after();
    },

    toggleShuffle: () => {
      const state = get();
      const shuffle = !state.shuffle;
      const current = state.order[state.orderPosition] ?? 0;
      if (shuffle) {
        const order = buildActiveOrder(state.queue, true, current, state.order);
        set({ shuffle: true, order, orderPosition: 0 });
      } else {
        const unshuffled = buildPartitionedUnshuffledOrder(
          state.queue,
          state.order,
          state.orderPosition,
        );
        set({
          shuffle: false,
          order: unshuffled.order,
          orderPosition: unshuffled.orderPosition,
        });
      }
      prewarmNext();
      after();
    },

    cycleRepeat: () => {
      const order: RepeatMode[] = ["off", "all", "one"];
      const nextMode = order[(order.indexOf(get().repeat) + 1) % order.length];
      set({ repeat: nextMode });
      if (nextMode === "off") {
        replenishAutoPlayIfNeeded();
      }
      prewarmNext();
      after();
    },

    setRepeat: (repeat) => {
      set({ repeat });
      if (repeat === "off") {
        replenishAutoPlayIfNeeded();
      }
      prewarmNext();
      after();
    },

    replenishAutoPlay: () => replenishAutoPlayIfNeeded(),

    restore: async (session) => {
      set({
        queue: session.queue,
        order: session.order,
        orderPosition: Math.min(
          session.orderPosition,
          Math.max(0, session.order.length - 1),
        ),
        position: session.position,
        volume: session.volume,
        muted: session.muted,
        rate: session.rate,
        shuffle: session.shuffle,
        repeat: session.repeat,
        isPlaying: false,
        buffering: false,
        ended: false,
        error: null,
      });
      if (session.queue.length === 0) return;
      await loadCurrent(false);
    },

    handleEnded: async () => {
      const current = currentQueueEntry(get());
      if (!current || current.item.source.kind !== "local") return;
      await get().next(true);
    },

    syncTime: (position, duration, buffered) => {
      const current = currentQueueEntry(get());
      if (current && current.item.source.kind !== "local") return;
      set({ position, duration, buffered });
      transitionGuard.observe(position);

      const state = get();
      const telemetryEvent = telemetryTracker.observeTick(
        position,
        duration,
        state.isPlaying && !audioEngine.paused,
      );
      if (telemetryEvent) {
        useIntelligence.getState().applyTelemetryEvent(telemetryEvent);
      }
      const audio = playbackAudioSettings();
      if (
        (audio.crossfadeSeconds > 0 || audio.gaplessPlayback) &&
        state.order.length > 0
      ) {
        const advance = advancePosition(
          state.orderPosition,
          state.order.length,
          state.repeat,
          1,
        );
        const decision = decideTransition({
          isPlaying: state.isPlaying && !audioEngine.paused,
          position,
          duration,
          crossfadeSeconds: audio.crossfadeSeconds,
          gaplessPlayback: audio.gaplessPlayback,
          repeat: state.repeat,
          hasNext:
            !advance.exhausted &&
            !advance.restart &&
            trackAtPosition(state, advance.position) !== null,
        });
        if (decision.kind !== "none") {
          const key = `${state.orderPosition}:${currentTrackId(state) ?? "none"}`;
          if (transitionGuard.tryArm(key)) {
            if (decision.kind === "repeat-one-loop") {
              void get().next(true);
            } else {
              void get().next(
                true,
                decision.kind === "crossfade" ? decision.fadeSeconds : 0,
              );
            }
          }
        }
      }

      // Do not write localStorage on every 100 ms clock tick, but do checkpoint progress often
      // enough that Restore last session resumes where the listener actually stopped.
      const now = Date.now();
      if (now - lastPositionPersistAt >= 1000) {
        lastPositionPersistAt = now;
        after();
      }
    },

    syncState: (state) => {
      const current = currentQueueEntry(get());
      if (current && current.item.source.kind !== "local") return;
      set({
        isPlaying: state.playing,
        buffering: state.buffering,
        ended: state.ended,
      });
      if (!state.playing) after();
    },

    setError: (message) => {
      if (message) {
        telemetryTracker.markPlaybackError();
      }
      set({ error: message });
    },
  };
});
