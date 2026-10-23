/**
 * Persistent bottom playback bar. Written for Cadence.
 */

import { Heart, ListMusic, Maximize2, Mic2 } from "lucide-react";
import { useCurrentTrack } from "../../app/hooks";
import { useLibrary } from "../../state/libraryStore";
import { useUi } from "../../state/uiStore";
import { Artwork } from "../../components/Artwork";
import { SeekRow, TransportButtons, VolumeControl } from "./PlaybackControls";

export function PlayerBar() {
  const track = useCurrentTrack();
  const toggleQueue = useUi(state => state.toggleQueue);
  const queueOpen = useUi(state => state.queueOpen);
  const navigate = useUi(state => state.navigate);
  const setFavorite = useLibrary(state => state.setFavorite);
  const toggleNowPlaying = useUi(state => state.toggleNowPlaying);

  return (
    <footer className={`player-bar ${track ? "" : "is-empty"}`} data-testid="player-bar">
      <div className="player-track">
        <Artwork src={track?.artworkUrl} alt={track?.album ?? "No track"} size="sm" />
        <div className="player-track-meta">
          <div className="player-title" title={track?.title}>
            {track?.title ?? "Nothing playing"}
          </div>
          <div className="player-artist" title={track?.artist}>
            {track?.artist ?? "Choose a song to begin"}
          </div>
        </div>
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

      <div className="player-center">
        <TransportButtons />
        <SeekRow />
      </div>

      <div className="player-right">
        <VolumeControl />
        <button
          type="button"
          className="icon-button"
          aria-label="Now Playing"
          title="Now Playing (L)"
          onClick={() => navigate({ name: "lyrics" })}
        >
          <Mic2 size={18} />
        </button>
        <button
          type="button"
          className={`icon-button ${queueOpen ? "active" : ""}`}
          aria-label="Queue"
          title="Queue (Q)"
          onClick={() => toggleQueue()}
        >
          <ListMusic size={18} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Now playing"
          title="Now playing (N)"
          onClick={() => toggleNowPlaying()}
        >
          <Maximize2 size={17} />
        </button>
      </div>
    </footer>
  );
}
