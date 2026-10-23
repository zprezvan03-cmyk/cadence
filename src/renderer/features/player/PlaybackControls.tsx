/**
 * Transport, seek and volume controls shared by the bottom player bar and the fullscreen Now
 * Playing view. Each piece reads the player store directly, so both places drive the same state.
 * Written for Cadence.
 */

import type { ReactNode } from "react";
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { formatTime } from "../../player/queue";
import { usePlayer } from "../../state/playerStore";

/** `trailing` is placed after the repeat button, in the same row (used by the fullscreen panel). */
export function TransportButtons({ trailing }: { trailing?: ReactNode } = {}) {
  const { isPlaying, shuffle, repeat, toggle, next, previous, toggleShuffle, cycleRepeat } = usePlayer();

  return (
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
      {trailing}
    </div>
  );
}

export function SeekRow() {
  const { position, duration, buffered, seek } = usePlayer();

  return (
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
  );
}

export function VolumeControl() {
  const { volume, muted, setVolume, setMuted } = usePlayer();
  const effectiveVolume = muted ? 0 : volume;

  return (
    <div className="volume-group">
      <button type="button" className="icon-button" aria-label={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)}>
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
  );
}
