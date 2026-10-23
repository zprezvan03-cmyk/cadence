import { create } from "zustand";
import type { RepeatMode } from "../../shared/types";
import { audioEngine } from "../audio/engine";
import { advancePosition, buildOrder } from "../player/queue";
import { getTrackById } from "./trackRegistry";

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
    if (autoplay) await audioEngine.play();
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
      const insertable = trackIds.filter(id => !state.queue.includes(id));
      if (insertable.length === 0) return;
      const queue = [...state.queue];
      const insertAt = state.order[state.orderPosition] + 1;
      queue.splice(insertAt, 0, ...insertable);
      const order = queue.map((_, index) => index);
      const orderPosition = state.orderPosition;
      set({ queue, order, orderPosition });
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
      const orderPosition = Math.min(
        state.orderPosition,
        Math.max(0, order.length - 1)
      );
      set({ queue, order, orderPosition });
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
      set({ shuffle, order, orderPosition: 0 });
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
    },

    syncState: state => {
      set({ isPlaying: state.playing, buffering: state.buffering, ended: state.ended });
    },

    setError: message => set({ error: message }),
  };
});
