/**
 * Persistent bottom playback bar. Written for Cadence.
 */

import {
  Heart,
  ListMusic,
  Maximize2,
  Mic2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCurrentTrack } from "../../app/hooks";
import { formatTime } from "../../player/queue";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { Artwork } from "../../components/Artwork";

export function PlayerBar() {
  const track = useCurrentTrack();
  const {
    isPlaying,
    position,
    duration,
    buffered,
    volume,
    muted,
    shuffle,
    repeat,
    toggle,
    next,
    previous,
    seek,
    setVolume,
    setMuted,
    toggleShuffle,
    cycleRepeat,
  } = usePlayer();
  const toggleQueue = useUi(state => state.toggleQueue);
  const queueOpen = useUi(state => state.queueOpen);
  const navigate = useUi(state => state.navigate);
  const setFavorite = useLibrary(state => state.setFavorite);
  const toggleNowPlaying = useUi(state => state.toggleNowPlaying);

  const effectiveVolume = muted ? 0 : volume;

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
        <div className="transport">
          <button
            type="button"
            className={`icon-button ${shuffle ? "active" : ""}`}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            onClick={toggleShuffle}
          >
            <Shuffle size={17} />
          </button>
          <button type="button" className="icon-button" aria-label="Previous track" onClick={previous}>
            <SkipBack size={19} />
          </button>
          <button
            type="button"
            className="play-button"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={() => void toggle()}
            data-testid="play-toggle"
          >
            {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <button type="button" className="icon-button" aria-label="Next track" onClick={() => void next(false)}>
            <SkipForward size={19} />
          </button>
          <button
            type="button"
            className={`icon-button ${repeat !== "off" ? "active" : ""}`}
            aria-label={`Repeat: ${repeat}`}
            aria-pressed={repeat !== "off"}
            onClick={cycleRepeat}
          >
            {repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />}
          </button>
        </div>

        <div className="seek-row">
          <span className="time" data-testid="position">
            {formatTime(position)}
          </span>
          <div className="seek-wrapper">
            <div className="seek-buffer" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
            <input
              className="seek"
              type="range"
              min={0}
              max={duration || 0}
              step={0.01}
              value={Math.min(position, duration || 0)}
              aria-label="Seek"
              onChange={event => seek(Number(event.target.value))}
              style={{ ["--progress" as string]: `${duration ? (position / duration) * 100 : 0}%` }}
            />
          </div>
          <span className="time">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="player-right">
        <div className="volume-group">
          <button
            type="button"
            className="icon-button"
            aria-label={muted ? "Unmute" : "Mute"}
            onClick={() => setMuted(!muted)}
          >
            {effectiveVolume === 0 ? <VolumeX size={17} /> : effectiveVolume < 0.5 ? <Volume1 size={17} /> : <Volume2 size={17} />}
          </button>
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={effectiveVolume}
            aria-label="Volume"
            onChange={event => setVolume(Number(event.target.value))}
            style={{ ["--progress" as string]: `${effectiveVolume * 100}%` }}
          />
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Lyrics"
          title="Lyrics (L)"
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
