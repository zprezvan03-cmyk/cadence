import { mediaItemFromLocalTrack, trackSourceKey } from "../../shared/media";
import type { MediaItem, Track } from "../../shared/types";
import { useLibrary } from "../state/libraryStore";
import { currentQueueEntry, currentTrackId, usePlayer } from "../state/playerStore";
import { useRemoteMedia } from "../state/remoteMediaStore";

/** Resolves the current queue occurrence when—and only when—it is a local library track. */
export function useCurrentTrack(): Track | null {
  const trackId = usePlayer(state => currentTrackId(state));
  const tracksById = useLibrary(state => state.tracksById);
  return trackId === null ? null : tracksById.get(trackId) ?? null;
}

/** Resolves the one current queue occurrence to display metadata for either source. */
export function useCurrentMediaItem(): MediaItem | null {
  const entry = usePlayer(currentQueueEntry);
  const tracksById = useLibrary(state => state.tracksById);
  const sourceKey = entry ? trackSourceKey(entry.item.source) : null;
  const registeredRemoteItem = useRemoteMedia(state =>
    sourceKey ? state.videosByKey[sourceKey] ?? null : null
  );
  if (!entry) return null;
  if (entry.item.source.kind !== "local") return registeredRemoteItem ?? entry.item;
  const track = tracksById.get(entry.item.source.trackId);
  return track
    ? mediaItemFromLocalTrack(track, entry.item.fetchedAt || Date.now())
    : entry.item;
}

/** Local tracks in queue order, for callers that genuinely operate on library files. */
export function useQueueTracks(): Track[] {
  const queue = usePlayer(state => state.queue);
  const tracksById = useLibrary(state => state.tracksById);
  return queue.flatMap(entry => {
    if (entry.item.source.kind !== "local") return [];
    const track = tracksById.get(entry.item.source.trackId);
    return track ? [track] : [];
  });
}
