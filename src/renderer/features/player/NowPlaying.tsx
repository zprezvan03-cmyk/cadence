/**
 * Full-window Now Playing view: large artwork over the shader background, transport, queue and a
 * jump into the lyrics tab. Written for Cadence.
 */

import { useEffect } from "react";
import {
  ChevronDown,
  Heart,
  ListMusic,
  Mic2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import { useCurrentTrack } from "../../app/hooks";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import { formatTime } from "../../player/queue";
import { Artwork } from "../../components/Artwork";
import { KawarpBackground } from "../shaders/KawarpBackground";

export function NowPlaying() {
  const open = useUi(state => state.nowPlayingOpen);
  const toggleNowPlaying = useUi(state => state.toggleNowPlaying);
  const navigate = useUi(state => state.navigate);
  const track = useCurrentTrack();
  const settings = useSettings(state => state.settings);
  const setFavorite = useLibrary(state => state.setFavorite);
  const {
    isPlaying,
    position,
    duration,
    toggle,
    next,
    previous,
    seek,
    shuffle,
    repeat,
    toggleShuffle,
    cycleRepeat,
    volume,
    setVolume,
  } = usePlayer();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") toggleNowPlaying(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, toggleNowPlaying]);

  if (!open) return null;

  return (
    <div className="now-playing" data-testid="now-playing">
      {settings ? (
        <KawarpBackground
          artworkUrl={track?.artworkUrl ?? null}
          animatedArtUrl={track?.animatedArtUrl ?? null}
          settings={settings.shaders}
          playing={isPlaying}
          className="now-playing-bg"
        />
      ) : (
        <div className="now-playing-bg static" />
      )}

      <header className="now-playing-header">
        <button type="button" className="icon-button" onClick={() => toggleNowPlaying(false)} aria-label="Close now playing">
          <ChevronDown size={22} />
        </button>
        <span className="eyebrow">Now playing</span>
        <button type="button" className="icon-button" onClick={() => navigate({ name: "lyrics" })} aria-label="Now Playing">
          <Mic2 size={18} />
        </button>
      </header>

      <div className="now-playing-body">
        <div className="now-playing-art">
          <Artwork src={track?.artworkUrl} alt={track?.album ?? "Artwork"} size="hero" />
        </div>

        <div className="now-playing-info">
          <div className="np-text">
            <h1>{track?.title ?? "Nothing playing"}</h1>
            <p>{track?.artist ?? ""}</p>
            <p className="muted">{track?.album ?? ""}</p>
          </div>

          <div className="np-seek">
            <input
              type="range"
              className="seek"
              min={0}
              max={duration || 0}
              step={0.01}
              value={Math.min(position, duration || 0)}
              aria-label="Seek"
              onChange={event => seek(Number(event.target.value))}
              style={{ ["--progress" as string]: `${duration ? (position / duration) * 100 : 0}%` }}
            />
            <div className="np-times">
              <span>{formatTime(position)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          <div className="np-controls">
            <button type="button" className={`icon-button ${shuffle ? "active" : ""}`} onClick={toggleShuffle} aria-label="Shuffle">
              <Shuffle size={20} />
            </button>
            <button type="button" className="icon-button" onClick={previous} aria-label="Previous">
              <SkipBack size={26} />
            </button>
            <button type="button" className="play-button large" onClick={() => void toggle()} aria-label={isPlaying ? "Pause" : "Play"}>
              {isPlaying ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}
            </button>
            <button type="button" className="icon-button" onClick={() => void next(false)} aria-label="Next">
              <SkipForward size={26} />
            </button>
            <button type="button" className={`icon-button ${repeat !== "off" ? "active" : ""}`} onClick={cycleRepeat} aria-label="Repeat">
              {repeat === "one" ? <Repeat1 size={20} /> : <Repeat size={20} />}
            </button>
          </div>

          <div className="np-secondary">
            {track ? (
              <button
                type="button"
                className={`icon-button ${track.favorite ? "active" : ""}`}
                onClick={() => void setFavorite(track.id, !track.favorite)}
                aria-label="Favourite"
              >
                <Heart size={20} fill={track.favorite ? "currentColor" : "none"} />
              </button>
            ) : null}
            <div className="np-volume">
              <Volume2 size={17} />
              <input
                type="range"
                className="volume"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={event => setVolume(Number(event.target.value))}
                aria-label="Volume"
                style={{ ["--progress" as string]: `${volume * 100}%` }}
              />
            </div>
            <button type="button" className="icon-button" onClick={() => useUi.getState().toggleQueue(true)} aria-label="Queue">
              <ListMusic size={19} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
