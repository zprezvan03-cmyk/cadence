import { useMemo } from "react";
import { mediaItemFromLocalTrack } from "../../shared/media";
import type { MediaItem, Track } from "../../shared/types";
import { useLibrary } from "../state/libraryStore";
import { currentQueueEntry, currentTrackId, usePlayer } from "../state/playerStore";

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
  const track = entry?.item.source.kind === "local" ? tracksById.get(entry.item.source.trackId) : undefined;
  return useMemo(
    () => track && entry ? mediaItemFromLocalTrack(track, entry.item.fetchedAt || Date.now()) : entry?.item ?? null,
    [entry, track]
  );
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
