/**
 * Playback queue drawer. Written for Cadence.
 */

import { useEffect } from "react";
import { ListMusic, Trash2, X } from "lucide-react";
import { mediaItemFromLocalTrack, trackSourceKey } from "../../../shared/media";
import type { MediaItem, QueueEntry } from "../../../shared/types";
import { usePresence } from "../../app/usePresence";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useRemoteMedia } from "../../state/remoteMediaStore";
import { useUi } from "../../state/uiStore";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";
import { formatTime } from "../../player/queue";

export function QueuePanel() {
  const open = useUi(state => state.queueOpen);
  const toggleQueue = useUi(state => state.toggleQueue);
  const navigate = useUi(state => state.navigate);
  const order = usePlayer(state => state.order);
  const orderPosition = usePlayer(state => state.orderPosition);
  const queue = usePlayer(state => state.queue);
  const jumpTo = usePlayer(state => state.jumpTo);
  const removeQueueEntry = usePlayer(state => state.removeQueueEntry);
  const clearQueue = usePlayer(state => state.clearQueue);
  const tracksById = useLibrary(state => state.tracksById);
  const videosByKey = useRemoteMedia(state => state.videosByKey);
  // Closing flips `open` immediately; presence keeps the drawer mounted for its fast
  // slide-out (and it keeps owning Escape until it is actually gone).
  const presence = usePresence(open);

  useEffect(() => {
    if (!presence.mounted) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // This overlay owns Escape. Do not let the immersive-view shortcut also handle the same key.
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleQueue(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presence.mounted, toggleQueue]);

  if (!presence.mounted) return null;

  const resolveItem = (entry: QueueEntry): MediaItem => {
    if (entry.item.source.kind === "local") {
      const track = tracksById.get(entry.item.source.trackId);
      return track ? mediaItemFromLocalTrack(track, entry.item.fetchedAt || Date.now()) : entry.item;
    }
    return videosByKey[trackSourceKey(entry.item.source)] ?? entry.item;
  };

  const ordered = order.flatMap((queueIndex, position) => {
    const entry = queue[queueIndex];
    return entry ? [{ entry, item: resolveItem(entry), position }] : [];
  });

  const handleJump = (entry: QueueEntry, position: number) => {
    void jumpTo(position);
    if (entry.item.source.kind !== "local") {
      toggleQueue(false);
      navigate({ name: "lyrics" });
    }
  };

  return (
    <aside className={`queue-panel ${presence.phaseClass}`} data-presence={presence.phase} data-testid="queue-panel">
      <header className="queue-header">
        <div>
          <h2>Queue</h2>
          <p className="muted">{queue.length} songs</p>
        </div>
        <div className="queue-actions">
          <button type="button" className="icon-button" onClick={clearQueue} aria-label="Clear queue" title="Clear queue">
            <Trash2 size={16} />
          </button>
          <button type="button" className="icon-button" onClick={() => toggleQueue(false)} aria-label="Close queue">
            <X size={18} />
          </button>
        </div>
      </header>

      {ordered.length === 0 ? (
        <div className="empty-state">
          <ListMusic size={28} />
          The queue is empty. Play an album or add songs from your library.
        </div>
      ) : (
        <ol className="queue-list">
          {ordered.map(({ entry, item, position }) => (
            <li
              key={entry.occurrenceId}
              className={position === orderPosition ? "current" : undefined}
              data-testid="queue-entry"
              data-source-kind={item.source.kind}
              data-occurrence-id={entry.occurrenceId}
            >
              <button type="button" className="queue-track" onClick={() => handleJump(entry, position)}>
                <Artwork src={item.artworkUrl} alt={item.albumLabel ?? item.title} size="xs" />
                <span>
                  <strong>{item.title}</strong>
                  <em>{item.artistLabel}</em>
                </span>
                <SourceBadge source={item.source} compact />
                <span className="muted">{item.durationSeconds ? formatTime(item.durationSeconds) : "--:--"}</span>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${item.title} from queue`}
                onClick={() => removeQueueEntry(entry.occurrenceId)}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
