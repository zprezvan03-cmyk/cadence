/**
 * Playback queue drawer. Written for Cadence.
 */

import { useEffect } from "react";
import { ListMusic, Trash2, X } from "lucide-react";
import { useQueueTracks } from "../../app/hooks";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { Artwork } from "../../components/Artwork";
import { formatTime } from "../../player/queue";

export function QueuePanel() {
  const open = useUi(state => state.queueOpen);
  const toggleQueue = useUi(state => state.toggleQueue);
  const tracks = useQueueTracks();
  const order = usePlayer(state => state.order);
  const orderPosition = usePlayer(state => state.orderPosition);
  const queue = usePlayer(state => state.queue);
  const jumpTo = usePlayer(state => state.jumpTo);
  const removeFromQueue = usePlayer(state => state.removeFromQueue);
  const clearQueue = usePlayer(state => state.clearQueue);

  useEffect(() => {
    if (!open) return;
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
  }, [open, toggleQueue]);

  if (!open) return null;

  const ordered = order
    .map((queueIndex, position) => ({ track: tracks[queueIndex], position }))
    .filter(entry => entry.track);

  return (
    <aside className="queue-panel" data-testid="queue-panel">
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
          {ordered.map(({ track, position }) => (
            <li key={`${track.id}-${position}`} className={position === orderPosition ? "current" : undefined}>
              <button type="button" className="queue-track" onClick={() => void jumpTo(position)}>
                <Artwork src={track.artworkUrl} alt={track.album} size="xs" />
                <span>
                  <strong>{track.title}</strong>
                  <em>{track.artist}</em>
                </span>
                <span className="muted">{formatTime(track.duration)}</span>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${track.title} from queue`}
                onClick={() => removeFromQueue(track.id)}
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
