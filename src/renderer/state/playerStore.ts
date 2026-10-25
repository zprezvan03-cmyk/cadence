import { create } from "zustand";
import type { RepeatMode } from "../../shared/types";
import { audioEngine } from "../audio/engine";
import { advancePosition, buildOrder } from "../player/queue";
import { getTrackById } from "./trackRegistry";
import { useLibrary } from "./libraryStore";

const SESSION_KEY = "cadence.session.v1";

export interface SessionState {
  queue: number[];
  order: number[];
  orderPosition: number;
  position: number;
  volume: number;
  muted: boolean;
  rate: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

interface PlayerState extends SessionState {
  isPlaying: boolean;
  buffering: boolean;
  duration: number;
  buffered: number;
  error: string | null;
  ended: boolean;
  playQueue: (trackIds: number[], startIndex?: number) => Promise<void>;
  playShuffled: (trackIds: number[], startIndex?: number) => Promise<void>;
  playTrack: (trackId: number) => Promise<void>;
  playNext: (trackIds: number[]) => void;
  addToQueue: (trackIds: number[]) => void;
  removeFromQueue: (trackId: number) => void;
  clearQueue: () => void;
  toggle: () => Promise<void>;
  next: (auto?: boolean) => Promise<void>;
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
  restore: (session: SessionState) => Promise<void>;
  handleEnded: () => Promise<void>;
  /** Called by the engine bridge on every tick. */
  syncTime: (position: number, duration: number, buffered: number) => void;
  syncState: (state: { playing: boolean; buffering: boolean; ended: boolean }) => void;
  setError: (message: string | null) => void;
}

export const currentTrackId = (state: PlayerState): number | null => {
  const queueIndex = state.order[state.orderPosition];
  return queueIndex === undefined ? null : state.queue[queueIndex] ?? null;
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
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (!Array.isArray(parsed.queue) || !Array.isArray(parsed.order)) return null;
    return {
      queue: parsed.queue.filter((id): id is number => typeof id === "number"),
      order: parsed.order.filter((index): index is number => typeof index === "number"),
      orderPosition: Number(parsed.orderPosition) || 0,
      position: Number(parsed.position) || 0,
      volume: typeof parsed.volume === "number" ? parsed.volume : 0.85,
      muted: Boolean(parsed.muted),
      rate: typeof parsed.rate === "number" ? parsed.rate : 1,
      shuffle: Boolean(parsed.shuffle),
      repeat: parsed.repeat === "all" || parsed.repeat === "one" ? parsed.repeat : "off",
    };
  } catch {
    return null;
  }
}

let loadToken = 0;
let lastPositionPersistAt = 0;

export const usePlayer = create<PlayerState>()((set, get) => {
  const after = () => persist(get());

  const loadCurrent = async (autoplay: boolean): Promise<void> => {
    const state = get();
    const queueIndex = state.order[state.orderPosition];
    const trackId = queueIndex === undefined ? undefined : state.queue[queueIndex];
    if (trackId === undefined) return;
    const track = getTrackById(trackId);
    if (!track) return;
    const token = ++loadToken;
    await audioEngine.load(track);
    if (token !== loadToken) return;
    if (state.position > 0) audioEngine.seek(state.position);
    audioEngine.setVolume(state.volume);
    audioEngine.setMuted(state.muted);
    audioEngine.setRate(state.rate);
    if (autoplay) {
      await audioEngine.play();
      if (token !== loadToken) return;
      // The engine reports decoder/play() failures through its own state; only a track that really
      // started belongs in Home → Recently played.
      if (!audioEngine.paused && !audioEngine.element.error) {
        void useLibrary.getState().recordPlay(trackId).catch(() => undefined);
      }
    }
  };

  const goToPosition = async (position: number, autoplay: boolean): Promise<void> => {
    set({ orderPosition: position, position: 0, ended: false });
    await loadCurrent(autoplay);
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

    playQueue: async (trackIds, startIndex = 0) => {
      if (trackIds.length === 0) return;
      const shuffle = get().shuffle;
      const start = Math.max(0, Math.min(startIndex, trackIds.length - 1));
      // buildOrder puts the requested track first when shuffling; otherwise the order is identity
      // and the requested track is addressed by its own position.
      const order = buildOrder(trackIds.length, shuffle, start);
      set({
        queue: [...trackIds],
        order,
        orderPosition: shuffle ? 0 : start,
        position: 0,
        duration: 0,
        error: null,
        ended: false,
      });
      await loadCurrent(true);
      after();
    },

    playShuffled: async (trackIds, startIndex = 0) => {
      if (trackIds.length === 0) return;
      if (!get().shuffle) get().toggleShuffle();
      await get().playQueue(trackIds, startIndex);
    },

    playTrack: async trackId => {
      const state = get();
      const existing = state.queue.indexOf(trackId);
      if (existing !== -1) {
        const position = state.order.indexOf(existing);
        if (position !== -1) {
          if (position === state.orderPosition) {
            get().seek(0);
            await audioEngine.play();
            return;
          }
          await goToPosition(position, true);
          return;
        }
      }
      const queue = [...state.queue, trackId];
      const order = buildOrder(queue.length, state.shuffle, queue.length - 1);
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

    playNext: trackIds => {
      const state = get();
      const currentQueueIndex = state.order[state.orderPosition];
      const currentId = currentQueueIndex === undefined ? null : state.queue[currentQueueIndex] ?? null;
      const requested = [...new Set(trackIds)].filter(id => id !== currentId);
      if (requested.length === 0) return;

      // Keep the original queue indices intact (shuffle and unshuffle depend on them), but move any
      // requested entries out of their old order positions before inserting them after the current
      // track. Previously an existing queue entry made this action a no-op, and a new entry rebuilt
      // a shuffled order as identity and silently changed the displayed current track.
      const queue = [...state.queue];
      for (const id of requested) {
        if (!queue.includes(id)) queue.push(id);
      }
      const inserted = requested.map(id => queue.indexOf(id)).filter(index => index >= 0);
      const insertedSet = new Set(inserted);
      const remainingOrder = state.order.filter(index => !insertedSet.has(index));
      const currentOrderPosition = currentQueueIndex === undefined ? -1 : remainingOrder.indexOf(currentQueueIndex);
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
      after();
    },

    addToQueue: trackIds => {
      const state = get();
      const insertable = trackIds.filter(id => !state.queue.includes(id));
      if (insertable.length === 0) return;
      const queue = [...state.queue, ...insertable];
      const order = state.order.concat(
        insertable.map((_, index) => state.queue.length + index)
      );
      set({ queue, order });
      after();
    },

    removeFromQueue: trackId => {
      const state = get();
      const queueIndex = state.queue.indexOf(trackId);
      if (queueIndex === -1) return;
      const removingCurrent = state.order[state.orderPosition] === queueIndex;
      const queue = state.queue.filter((_, index) => index !== queueIndex);
      const order = state.order
        .filter(index => index !== queueIndex)
        .map(index => (index > queueIndex ? index - 1 : index));
      const removedOrderPosition = state.order.indexOf(queueIndex);
      // Removing an entry before the current one shifts the current entry one position to the left.
      // Keeping the old numeric position made the UI point at the next song while audio continued.
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
          set({ isPlaying: false, position: 0, duration: 0 });
        } else {
          void loadCurrent(!audioEngine.paused);
        }
      }
      after();
    },

    clearQueue: () => {
      audioEngine.pause();
      set({ queue: [], order: [], orderPosition: 0, position: 0, duration: 0, isPlaying: false });
      after();
    },

    toggle: async () => {
      if (get().queue.length === 0) return;
      if (!audioEngine.element.src) {
        await loadCurrent(true);
        return;
      }
      await audioEngine.toggle();
    },

    next: async auto => {
      const state = get();
      if (state.order.length === 0) return;
      const result = advancePosition(state.orderPosition, state.order.length, state.repeat, 1);
      if (result.restart) {
        audioEngine.seek(0);
        await audioEngine.play();
        return;
      }
      if (result.exhausted && auto) {
        set({ isPlaying: false, ended: true, position: state.duration });
        audioEngine.pause();
        return;
      }
      await goToPosition(result.position, true);
    },

    previous: () => {
      const state = get();
      if (state.order.length === 0) return;
      if (state.position > 3) {
        audioEngine.seek(0);
        return;
      }
      const result = advancePosition(state.orderPosition, state.order.length, state.repeat, -1);
      void goToPosition(result.position, !audioEngine.paused);
    },

    seek: seconds => {
      audioEngine.seek(seconds);
      set({ position: Math.max(0, seconds), ended: false });
      after();
    },

    jumpTo: async position => {
      if (position < 0 || position >= get().order.length) return;
      await goToPosition(position, true);
    },

    seekBy: seconds => {
      const state = get();
      state.seek(state.position + seconds);
    },

    setVolume: volume => {
      const clamped = Math.max(0, Math.min(1, volume));
      audioEngine.setVolume(clamped);
      if (clamped > 0) audioEngine.setMuted(false);
      set({ volume: clamped, muted: clamped > 0 ? false : get().muted });
      after();
    },

    setMuted: muted => {
      audioEngine.setMuted(muted);
      set({ muted });
      after();
    },

    setRate: rate => {
      audioEngine.setRate(rate);
      set({ rate });
      after();
    },

    toggleShuffle: () => {
      const state = get();
      const shuffle = !state.shuffle;
      const current = state.order[state.orderPosition] ?? 0;
      const order = buildOrder(state.queue.length, shuffle, current);
      // Shuffled orders put the current queue index first; an unshuffled identity order instead
      // addresses that same entry at its own index.
      set({ shuffle, order, orderPosition: shuffle ? 0 : current });
      after();
    },

    cycleRepeat: () => {
      const order: RepeatMode[] = ["off", "all", "one"];
      const nextMode = order[(order.indexOf(get().repeat) + 1) % order.length];
      set({ repeat: nextMode });
      after();
    },

    setRepeat: repeat => {
      set({ repeat });
      after();
    },

    restore: async session => {
      set({
        queue: session.queue,
        order: session.order,
        orderPosition: Math.min(session.orderPosition, Math.max(0, session.order.length - 1)),
        position: session.position,
        volume: session.volume,
        muted: session.muted,
        rate: session.rate,
        shuffle: session.shuffle,
        repeat: session.repeat,
      });
      const trackId = currentTrackId(get());
      const track = trackId === null ? null : getTrackById(trackId);
      if (!track) return;
      await audioEngine.load(track);
      audioEngine.setVolume(session.volume);
      audioEngine.setMuted(session.muted);
      audioEngine.setRate(session.rate);
      if (session.position > 0) audioEngine.seek(session.position);
      set({ duration: track.duration });
    },

    handleEnded: async () => {
      await get().next(true);
    },

    syncTime: (position, duration, buffered) => {
      set({ position, duration, buffered });
      // Do not write localStorage on every 100 ms clock tick, but do checkpoint progress often
      // enough that Restore last session resumes where the listener actually stopped.
      const now = Date.now();
      if (now - lastPositionPersistAt >= 1000) {
        lastPositionPersistAt = now;
        after();
      }
    },

    syncState: state => {
      set({ isPlaying: state.playing, buffering: state.buffering, ended: state.ended });
      if (!state.playing) after();
    },

    setError: message => set({ error: message }),
  };
});
