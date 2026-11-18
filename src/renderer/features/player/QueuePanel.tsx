/**
 * Playback queue drawer. Written for Cadence.
 */

import { memo, useEffect, useMemo } from "react";
import { Infinity as InfinityIcon, ListMusic, Trash2, X } from "lucide-react";
import { mediaItemFromLocalTrack } from "../../../shared/media";
import type { QueueEntry, Track } from "../../../shared/types";
import { usePresence } from "../../app/usePresence";
import { useReducedMotion } from "../../app/useMotionPreference";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";
import { formatTime } from "../../player/queue";
import { QueueMotionList } from "./QueueMotionList";

export function QueuePanel() {
  const open = useUi(state => state.queueOpen);
  const toggleQueue = useUi(state => state.toggleQueue);
  // Closing flips `open` immediately; presence keeps the drawer mounted for its fast
  // slide-out (and it keeps owning Escape until it is actually gone).
  const presence = usePresence(open);

  useEffect(() => {
    if (!presence.mounted) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest("dialog[open]"))) return;
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

  return presence.mounted ? <QueueContents open={open} presence={presence} /> : null;
}

function QueueContents({ open, presence }: { open: boolean; presence: ReturnType<typeof usePresence> }) {
  const toggleQueue = useUi(state => state.toggleQueue);
  const reducedMotion = useReducedMotion();
  const order = usePlayer(state => state.order);
  const orderPosition = usePlayer(state => state.orderPosition);
  const queue = usePlayer(state => state.queue);
  const jumpTo = usePlayer(state => state.jumpTo);
  const removeQueueEntry = usePlayer(state => state.removeQueueEntry);
  const clearQueue = usePlayer(state => state.clearQueue);
  const replenishAutoPlay = usePlayer(state => state.replenishAutoPlay);
  const autoPlay = useSettings(state => state.settings?.playback.autoPlay ?? true);
  const patchSettings = useSettings(state => state.patch);
  const tracksById = useLibrary(state => state.tracksById);
  const ordered = useMemo(() => order.flatMap((queueIndex, position) => {
    const entry = queue[queueIndex];
    return entry ? [{ entry, position }] : [];
  }), [order, queue]);
  const occurrences = useMemo(() => ordered.map(({ entry }) => entry.occurrenceId), [ordered]);

  return (
    <aside id="playback-queue" className={`queue-panel ${presence.phaseClass}`} data-presence={presence.phase} data-testid="queue-panel" aria-label="Playback queue" inert={!open}>
      <header className="queue-header">
        <div>
          <h2>Queue</h2>
          <p className="muted">{ordered.length} {ordered.length === 1 ? "song" : "songs"}</p>
        </div>
        <div className="queue-actions">
          <button
            type="button"
            className={`icon-button ${autoPlay ? "active" : ""}`}
            onClick={() => {
              const nextAutoPlay = !autoPlay;
              void patchSettings({ playback: { autoPlay: nextAutoPlay } }).then(() => {
                if (nextAutoPlay) replenishAutoPlay();
              });
            }}
            aria-label={`AutoPlay: ${autoPlay ? "On" : "Off"}`}
            aria-pressed={autoPlay}
            title={`AutoPlay similar songs: ${autoPlay ? "On" : "Off"}`}
            data-testid="queue-autoplay-toggle"
          >
            <InfinityIcon size={16} />
          </button>
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
          <ListMusic size={28} aria-hidden="true" />
          <h3>Nothing queued</h3>
          <p>Play an album or add songs from your library.</p>
        </div>
      ) : null}
      <QueueMotionList occurrences={occurrences} open={open} reducedMotion={reducedMotion}>
        {ordered.map(({ entry, position }) => (
          <QueueRow
            key={entry.occurrenceId}
            entry={entry}
            track={entry.item.source.kind === "local" ? tracksById.get(entry.item.source.trackId) : undefined}
            position={position}
            current={position === orderPosition}
            jumpTo={jumpTo}
            remove={removeQueueEntry}
          />
        ))}
      </QueueMotionList>
    </aside>
  );
}

// Progress/current-row changes do not rebuild every artwork, badge and action in the drawer.
const QueueRow = memo(function QueueRow({ entry, track, position, current, jumpTo, remove }: {
  entry: QueueEntry;
  track?: Track;
  position: number;
  current: boolean;
  jumpTo: (position: number) => Promise<void>;
  remove: (id: string) => void;
}) {
  const item = track ? mediaItemFromLocalTrack(track, entry.item.fetchedAt || Date.now()) : entry.item;
  return (
    <li
      className={current ? "current" : undefined}
      data-testid="queue-entry"
      data-source-kind={item.source.kind}
      data-origin={entry.origin ?? "context"}
      aria-current={current ? "true" : undefined}
      data-occurrence-id={entry.occurrenceId}
    >
      <button type="button" className="queue-track" onClick={() => void jumpTo(position)}>
        <Artwork src={item.artworkUrl} alt={item.albumLabel ?? item.title} size="xs" />
        <span className="queue-track-copy"><strong title={item.title}>{item.title}</strong><em title={item.artistLabel}>{item.artistLabel}</em></span>
        {entry.origin === "autoplay" ? (
          <span className="pill subtle" data-testid="queue-origin-badge">AutoPlay</span>
        ) : entry.origin === "manual" ? (
          <span className="pill subtle" data-testid="queue-origin-badge">Queued</span>
        ) : null}
        <SourceBadge source={item.source} compact />
        <span className="queue-time">{item.durationSeconds ? formatTime(item.durationSeconds) : "--:--"}</span>
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Remove ${item.title} from queue`}
        onClick={() => remove(entry.occurrenceId)}
      >
        <X size={14} />
      </button>
    </li>
  );
});
