import type { Track } from "../../shared/types";
import { useLibrary } from "../state/libraryStore";
import { currentTrackId, usePlayer } from "../state/playerStore";

/** Resolves the queue's current id against the loaded library. */
export function useCurrentTrack(): Track | null {
  const trackId = usePlayer(state => currentTrackId(state));
  const tracksById = useLibrary(state => state.tracksById);
  return trackId === null ? null : tracksById.get(trackId) ?? null;
}

export function useQueueTracks(): Track[] {
  const queue = usePlayer(state => state.queue);
  const tracksById = useLibrary(state => state.tracksById);
  return queue
    .map(id => tracksById.get(id))
    .filter((track): track is Track => Boolean(track));
}
