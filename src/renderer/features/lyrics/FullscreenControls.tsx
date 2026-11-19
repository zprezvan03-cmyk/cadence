/**
 * Audio controls for the fullscreen Now Playing view: the same transport, seek, volume, favourite
 * and queue controls as the player bar. The bar sits under the lyrics; the panel sits beside the
 * artwork when lyrics are off. Written for Cadence.
 */

import { Heart, ListMusic } from "lucide-react";
import type { Track } from "../../../shared/types";
import { SeekRow, TransportButtons, VolumeControl } from "../player/PlaybackControls";
import { useLibrary } from "../../state/libraryStore";
import { useUi } from "../../state/uiStore";

export interface FullscreenControlsProps {
  track: Track | null;
  /** Hover visibility: faded out and non-interactive while true. */
  concealed?: boolean;
  /** "bar" along the bottom (default); "panel" beside the artwork. */
  variant?: "bar" | "panel";
}

export function FullscreenControls({
  track,
  concealed = false,
  variant = "bar",
}: FullscreenControlsProps) {
  const setFavorite = useLibrary(state => state.setFavorite);
  const queueOpen = useUi(state => state.queueOpen);
  const toggleQueue = useUi(state => state.toggleQueue);

  const favourite = track ? (
    <button
      type="button"
      className={`icon-button heart ${track.favorite ? "active" : ""}`}
      aria-label={track.favorite ? "Remove from favourites" : "Add to favourites"}
      onClick={() => void setFavorite(track.id, !track.favorite)}
    >
      <Heart size={17} fill={track.favorite ? "currentColor" : "none"} />
    </button>
  ) : null;

  const queue = (
    <button
      type="button"
      className={`icon-button ${queueOpen ? "active" : ""}`}
      aria-label="Queue"
      title="Queue (Q)"
      onClick={() => toggleQueue()}
    >
      <ListMusic size={18} />
    </button>
  );

  if (variant === "panel") {
    return (
      <div className="fs-controls is-panel" data-testid="fullscreen-controls">
        <SeekRow />
        <div className="fs-panel-transport">
          <TransportButtons />
        </div>
        <div className="fs-panel-secondary">
          <div className="fs-group">{favourite}</div>
          <VolumeControl />
          <div className="fs-group fs-group-end">{queue}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`fs-controls ${concealed ? "is-concealed" : ""}`} data-testid="fullscreen-controls">
      <SeekRow />
      <div className="fs-controls-row">
        <div className="fs-group">{favourite}</div>

        <TransportButtons />

        <div className="fs-group fs-group-end">
          <VolumeControl />
          {queue}
        </div>
      </div>
    </div>
  );
}
