/**
 * Audio controls for the fullscreen Now Playing view: the same transport, seek, volume, favourite
 * and queue controls as the player bar, plus the lyrics on/off toggle. Written for Cadence.
 */

import { Heart, ListMusic, Mic2 } from "lucide-react";
import type { Track } from "../../../shared/types";
import { SeekRow, TransportButtons, VolumeControl } from "../player/PlaybackControls";
import { useLibrary } from "../../state/libraryStore";
import { useUi } from "../../state/uiStore";

export interface FullscreenControlsProps {
  track: Track | null;
  showLyrics: boolean;
  onToggleLyrics: () => void;
  /** Hover visibility: faded out and non-interactive while true. */
  concealed?: boolean;
}

export function FullscreenControls({ track, showLyrics, onToggleLyrics, concealed = false }: FullscreenControlsProps) {
  const setFavorite = useLibrary(state => state.setFavorite);
  const queueOpen = useUi(state => state.queueOpen);
  const toggleQueue = useUi(state => state.toggleQueue);

  return (
    <div className={`fs-controls ${concealed ? "is-concealed" : ""}`} data-testid="fullscreen-controls">
      <SeekRow />
      <div className="fs-controls-row">
        <div className="fs-group">
          {track ? (
            <button
              type="button"
              className={`icon-button heart ${track.favorite ? "active" : ""}`}
              aria-label={track.favorite ? "Remove from favourites" : "Add to favourites"}
              onClick={() => void setFavorite(track.id, !track.favorite)}
            >
              <Heart size={17} fill={track.favorite ? "currentColor" : "none"} />
            </button>
          ) : null}
        </div>

        <TransportButtons />

        <div className="fs-group fs-group-end">
          <button
            type="button"
            className={`fs-lyrics-toggle ${showLyrics ? "active" : ""}`}
            aria-label="Lyrics"
            aria-pressed={showLyrics}
            title={showLyrics ? "Hide lyrics" : "Show lyrics"}
            data-testid="fullscreen-lyrics-toggle"
            onClick={onToggleLyrics}
          >
            <Mic2 size={16} />
            <span>{showLyrics ? "On" : "Off"}</span>
          </button>
          <VolumeControl />
          <button
            type="button"
            className={`icon-button ${queueOpen ? "active" : ""}`}
            aria-label="Queue"
            title="Queue (Q)"
            onClick={() => toggleQueue()}
          >
            <ListMusic size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
