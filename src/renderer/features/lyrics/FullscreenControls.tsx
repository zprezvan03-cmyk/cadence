/**
 * Audio controls for the fullscreen Now Playing view, laid out the way Better Lyrics' fullscreen
 * player page is (see `fullscreenControls.ts`, `volumeControl.ts` and `ratingButton.ts` upstream):
 *
 * - a column under the artwork (`FullscreenColumnControls`): the progress bar with its times, then
 *   a transport row of 52px discs around a solid white 68px play button — shuffle and repeat sit
 *   where the reference puts like/dislike, since Cadence's transport owns those;
 * - the actions at the end of the song-info row (`FullscreenInfoActions`): favourite, the
 *   hover-expanding volume slider, queue and the mini player, all 28px discs with 18px glyphs;
 * - the bottom bar (`FullscreenControls`), which stands in for YouTube Music's own player bar that
 *   Better Lyrics keeps in fullscreen: track identity on the left, transport above the seek row in
 *   the middle, volume and view tools on the right.
 *
 * Every control carries the reference's click feedback: a pop on the disc, an icon nudge and a
 * ripple on the skip buttons, and the layered iris fill + ray burst on a newly-liked song.
 * Written for Cadence.
 */

import { useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type WheelEvent } from "react";
import { Heart, ListMusic, Pause, PictureInPicture2, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { MediaItem, RepeatMode, Track } from "../../../shared/types";
import type { Dissolve } from "../../app/useDissolve";
import { MarqueeText } from "../../components/MarqueeText";
import { SourceBadge } from "../../components/SourceBadge";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { SeekRow } from "../player/PlaybackControls";
import { PlaybackArtwork, PlaybackText } from "../player/PlaybackVisuals";
import { ProgressBar } from "../player/ProgressBar";
import type { Cover } from "../player/usePlaybackPresentation";

export interface FullscreenControlsProps {
  track: Track | null;
  /** Live dissolve layers from the view, used by the decorative footer thumbnail and title. */
  cover: Dissolve<Cover>;
  text: Dissolve<MediaItem | null>;
  /** Chrome visibility: faded out and non-interactive while true. */
  concealed?: boolean;
}

type TransportKind = "previous" | "next" | "play-pause";

const POP_MS = 320;
const NUDGE_MS = 320;
const RIPPLE_MS = 520;

/** `Pop`, `nudge` and `ripple` run on every click; `nudge` and `ripple` only on the skip buttons. */
function useTransportFeedback(kind: TransportKind) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    const button = buttonRef.current;
    if (!button) return;
    const win = button.ownerDocument.defaultView;
    const skip = kind !== "play-pause";
    const svg = button.querySelector("svg");
    if (skip) {
      const rect = button.getBoundingClientRect();
      const size = rect.width;
      const ripple = button.ownerDocument.createElement("span");
      ripple.className = "fs-control-ripple";
      ripple.style.width = `${size}px`;
      ripple.style.height = `${size}px`;
      const x = event.clientX > 0 ? event.clientX - rect.left : size / 2;
      const y = event.clientY > 0 ? event.clientY - rect.top : size / 2;
      ripple.style.left = `${x - size / 2}px`;
      ripple.style.top = `${y - size / 2}px`;
      button.querySelector(".fs-control-ripple-layer")?.appendChild(ripple);
      win?.requestAnimationFrame(() => ripple.classList.add("is-go"));
      win?.setTimeout(() => ripple.remove(), RIPPLE_MS);
      if (svg) {
        svg.classList.remove("fs-control-nudge-prev", "fs-control-nudge-next");
        void button.offsetWidth;
        svg.classList.add(kind === "previous" ? "fs-control-nudge-prev" : "fs-control-nudge-next");
        win?.setTimeout(() => svg.classList.remove("fs-control-nudge-prev", "fs-control-nudge-next"), NUDGE_MS);
      }
    }
    button.classList.remove("fs-control-pop");
    void button.offsetWidth;
    button.classList.add("fs-control-pop");
    win?.setTimeout(() => button.classList.remove("fs-control-pop"), POP_MS);
  };
  return { buttonRef, onClick };
}

interface TransportState {
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  toggle: () => Promise<void>;
  next: (auto?: boolean) => Promise<void>;
  previous: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
}

/**
 * The transport slice of the player store, shared by both transport rows. The store's own actions are
 * selected directly — they keep their identity across renders, so `useShallow` (which reads the
 * selection synchronously) settles instead of seeing fresh closures every time.
 */
function useTransportState(): TransportState {
  return usePlayer(
    useShallow((state): TransportState => ({
      isPlaying: state.isPlaying,
      shuffle: state.shuffle,
      repeat: state.repeat,
      toggle: state.toggle,
      next: state.next,
      previous: state.previous,
      toggleShuffle: state.toggleShuffle,
      cycleRepeat: state.cycleRepeat,
    }))
  );
}

/** One round transport disc. `skip` buttons also get the ripple layer the feedback spawns into. */
function TransportDisc({
  kind,
  label,
  className = "",
  active = false,
  pressed,
  testId,
  onClick,
  children,
}: {
  kind: TransportKind;
  label: string;
  className?: string;
  active?: boolean;
  pressed?: boolean;
  testId?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const feedback = useTransportFeedback(kind);
  return (
    <button
      ref={feedback.buttonRef}
      type="button"
      className={`fs-disc ${className} ${active ? "is-active" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-testid={testId}
      onClick={event => {
        feedback.onClick(event);
        onClick();
      }}
    >
      {kind !== "play-pause" ? <span className="fs-control-ripple-layer" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** The row of shuffle · previous / play / next · repeat, as wide as the artwork column. */
export function FullscreenColumnTransport() {
  const { isPlaying, shuffle, repeat, toggle, next, previous, toggleShuffle, cycleRepeat } = useTransportState();
  return (
    <div className="fs-col-transport">
      <TransportDisc
        kind="previous"
        label="Shuffle"
        className="fs-col-shuffle"
        active={shuffle}
        pressed={shuffle}
        onClick={() => toggleShuffle()}
      >
        <Shuffle size={18} />
      </TransportDisc>
      <div className="fs-col-transport-mid">
        <TransportDisc kind="previous" label="Previous track" onClick={previous}>
          <SkipBack size={22} fill="currentColor" />
        </TransportDisc>
        <TransportDisc
          kind="play-pause"
          label={isPlaying ? "Pause" : "Play"}
          className="fs-disc-play"
          testId="column-play-toggle"
          onClick={() => void toggle()}
        >
          <span className="play-icon" key={isPlaying ? "pause" : "play"} aria-hidden="true">
            {isPlaying ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
          </span>
        </TransportDisc>
        <TransportDisc kind="next" label="Next track" onClick={() => void next(false)}>
          <SkipForward size={22} fill="currentColor" />
        </TransportDisc>
      </div>
      <TransportDisc
        kind="previous"
        label={`Repeat: ${repeat}`}
        className="fs-col-repeat"
        active={repeat !== "off"}
        pressed={repeat !== "off"}
        onClick={() => cycleRepeat()}
      >
        {repeat === "one" ? <Repeat1 size={18} /> : <Repeat size={18} />}
      </TransportDisc>
    </div>
  );
}

/** Progress bar + transport, the column that sits under the song-info row. */
export function FullscreenColumnControls({ concealed = false }: { concealed?: boolean }) {
  return (
    <div
      className={`fs-col-controls ${concealed ? "is-concealed" : ""}`}
      data-testid="fullscreen-column-controls"
    >
      <ProgressBar />
      <FullscreenColumnTransport />
    </div>
  );
}

/**
 * The favourite button: an outline heart with a filled copy clipped away; liking runs the
 * reference's pop + iris reveal, and a one-shot burst of rays and dots leaves the centre.
 */
function FavouriteButton({ track }: { track: Track }) {
  const setFavorite = useLibrary(state => state.setFavorite);
  const [burstKey, setBurstKey] = useState(0);
  const favorite = track.favorite;
  const rays = Array.from({ length: 8 }, (_, index) => {
    const angle = index * 45 + 22.5;
    const radians = (angle * Math.PI) / 180;
    return {
      angle,
      dx: `${(Math.cos(radians) * 14).toFixed(1)}px`,
      dy: `${(Math.sin(radians) * 14).toFixed(1)}px`,
    };
  });
  return (
    <button
      type="button"
      className={`fs-disc fs-info-disc fs-like ${favorite ? "is-active" : ""}`}
      aria-label={favorite ? "Remove from favourites" : "Add to favourites"}
      title={favorite ? "Remove from favourites" : "Add to favourites"}
      aria-pressed={favorite}
      data-testid="fullscreen-favourite"
      onClick={() => {
        const next = !favorite;
        if (next) setBurstKey(key => key + 1);
        void setFavorite(track.id, next);
      }}
    >
      <span className={`fs-rate-icon ${burstKey ? "fs-rate-fire" : ""}`} key={burstKey}>
        <span className="fs-rate-layer">
          <Heart size={18} />
        </span>
        <span className="fs-rate-layer fs-rate-layer-fill">
          <Heart size={18} fill="currentColor" />
        </span>
        {burstKey ? (
          <span className="fs-rate-burst" aria-hidden="true">
            {rays.map(ray => (
              <span
                key={ray.angle}
                className="fs-rate-ray is-go"
                style={{ "--a": `${ray.angle}deg`, "--dx": ray.dx, "--dy": ray.dy } as CSSProperties}
              />
            ))}
            {rays.map(ray => (
              <span key={`dot-${ray.angle}`} className="fs-rate-dot is-go" style={{ "--dx": ray.dx, "--dy": ray.dy } as CSSProperties} />
            ))}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** The actions at the end of the song-info row: favourite, volume, queue, mini player. */
export function FullscreenInfoActions({ track, concealed = false }: { track: Track | null; concealed?: boolean }) {
  const queueOpen = useUi(state => state.queueOpen);
  const toggleQueue = useUi(state => state.toggleQueue);
  const setMiniPlayer = useUi(state => state.setMiniPlayer);
  return (
    <div className={`fs-info-actions ${concealed ? "is-concealed" : ""}`} data-testid="fullscreen-info-actions">
      {track ? <FavouriteButton track={track} /> : null}
      <FullscreenVolume />
      <button
        type="button"
        className={`fs-disc fs-info-disc ${queueOpen ? "is-active" : ""}`}
        aria-label="Queue"
        aria-expanded={queueOpen}
        aria-controls={queueOpen ? "playback-queue" : undefined}
        title="Queue (Q)"
        onClick={() => toggleQueue()}
      >
        <ListMusic size={18} />
      </button>
      <button
        type="button"
        className="fs-disc fs-info-disc"
        aria-label="Mini player"
        title="Mini player (Ctrl+Shift+P)"
        data-testid="open-mini-player"
        onClick={() => setMiniPlayer(true)}
      >
        <PictureInPicture2 size={17} />
      </button>
    </div>
  );
}

const VOLUME_KEY_STEP = 5;
const VOLUME_WHEEL_STEP = 4;
const VOLUME_CLOSE_MS = 350;
const VOLUME_WHEEL_NOTCH_PX = 100;

/**
 * The reference's hover-expanding volume control: a mute button whose 4px slider slides out to
 * the left while the pointer is over it or it has focus. The wheel adjusts in notches, the arrow
 * keys in 5% steps, and Escape closes it.
 */
export function FullscreenVolume() {
  const { volume, muted, setVolume, setMuted } = usePlayer(
    useShallow(state => ({ volume: state.volume, muted: state.muted, setVolume: state.setVolume, setMuted: state.setMuted }))
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);
  const wheelDelta = useRef(0);

  const level = Math.round((muted ? 0 : volume) * 100);
  const tier = level <= 0 ? "muted" : level < 50 ? "low" : "high";

  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = () => {
    cancelClose();
    if (!openRef.current) {
      openRef.current = true;
      setOpen(true);
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      const root = rootRef.current;
      if (!root || root.matches(":hover") || root.querySelector(":focus-visible")) return;
      openRef.current = false;
      setOpen(false);
    }, VOLUME_CLOSE_MS);
  };
  const commit = (next: number) => setVolume(Math.min(1, Math.max(0, next / 100)));

  const levelAt = (clientX: number) => {
    const bar = rootRef.current?.querySelector<HTMLElement>(".fs-volume__bar");
    if (!bar) return level;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return level;
    return Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    show();
    wheelDelta.current += event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
    const notches = Math.trunc(wheelDelta.current / VOLUME_WHEEL_NOTCH_PX);
    if (notches !== 0) {
      wheelDelta.current -= notches * VOLUME_WHEEL_NOTCH_PX;
      commit(level - notches * VOLUME_WHEEL_STEP);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      rootRef.current?.querySelector<HTMLButtonElement>(".fs-volume__button")?.focus();
      cancelClose();
      openRef.current = false;
      setOpen(false);
      return;
    }
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = level + VOLUME_KEY_STEP;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = level - VOLUME_KEY_STEP;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 100;
    if (next === null) return;
    event.preventDefault();
    show();
    commit(next);
  };

  return (
    <div
      ref={rootRef}
      className={`fs-volume ${open ? "is-open" : ""}`}
      data-level={tier}
      data-muted={tier === "muted" ? "" : undefined}
      data-testid="fullscreen-volume"
      onPointerEnter={event => event.pointerType !== "touch" && show()}
      onPointerLeave={event => event.pointerType !== "touch" && scheduleClose()}
      onFocus={show}
      onBlur={scheduleClose}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      style={{ "--fs-volume-level": level / 100 } as CSSProperties}
    >
      <div className="fs-volume__track">
        <div
          className="fs-volume__bar"
          role="slider"
          tabIndex={0}
          aria-label="Volume"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={level}
          aria-valuetext={`${level}%`}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.classList.add("is-dragging");
            commit(levelAt(event.clientX));
          }}
          onPointerMove={event => {
            if (!event.currentTarget.classList.contains("is-dragging")) return;
            commit(levelAt(event.clientX));
          }}
          onPointerUp={event => {
            event.currentTarget.classList.remove("is-dragging");
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={event => event.currentTarget.classList.remove("is-dragging")}
        >
          <div className="fs-volume__fill" />
          <div className="fs-volume__knob" />
        </div>
      </div>
      <button
        type="button"
        className="fs-volume__button"
        aria-label={tier === "muted" ? "Unmute" : "Mute"}
        title={tier === "muted" ? "Unmute" : "Mute"}
        onClick={event => {
          // Touch: the first tap only opens the slider, so the slider can be reached.
          const touch = (event.nativeEvent as PointerEvent).pointerType === "touch";
          if (touch && !open) {
            show();
            return;
          }
          setMuted(!muted);
        }}
      >
        <svg className="fs-volume__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path data-part="speaker" d="M11 5 6 9H2v6h4l5 4V5z" />
          <path data-part="wave-low" d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path data-part="wave-high" d="M19 5a10 10 0 0 1 0 14" />
          <line data-part="mute" x1="22" y1="9" x2="16" y2="15" />
          <line data-part="mute" x1="16" y1="9" x2="22" y2="15" />
        </svg>
      </button>
    </div>
  );
}

export function FullscreenControls({
  track,
  cover,
  text,
  concealed = false,
}: FullscreenControlsProps) {
  const setFavorite = useLibrary(state => state.setFavorite);
  const queueOpen = useUi(state => state.queueOpen);
  const toggleQueue = useUi(state => state.toggleQueue);
  const setMiniPlayer = useUi(state => state.setMiniPlayer);

  const favourite = track ? (
    <button
      type="button"
      className={`icon-button heart ${track.favorite ? "active" : ""}`}
      aria-label={track.favorite ? "Remove from favourites" : "Add to favourites"}
      title={track.favorite ? "Remove from favourites" : "Add to favourites"}
      aria-pressed={track.favorite}
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
      aria-expanded={queueOpen}
      aria-controls={queueOpen ? "playback-queue" : undefined}
      title="Queue (Q)"
      onClick={() => toggleQueue()}
    >
      <ListMusic size={18} />
    </button>
  );

  const mini = (
    <button
      type="button"
      className="icon-button"
      aria-label="Mini player"
      title="Mini player (Ctrl+Shift+P)"
      data-testid="open-mini-player"
      onClick={() => setMiniPlayer(true)}
    >
      <PictureInPicture2 size={17} />
    </button>
  );

  // The footer duplicate is decorative: only the hero artwork and heading join the layout
  // handoff, so neither of these slots carries a `data-player-part` slot name.
  return (
    <div className={`fs-controls ${concealed ? "is-concealed" : ""}`} data-testid="fullscreen-controls">
      <div className="fs-controls-row">
        <div className="player-track fs-player-track">
          <PlaybackArtwork cover={cover} label={cover.front.value.label || track?.title || "No track"} shared={false} />
          <div className="player-track-meta fs-player-meta">
            <PlaybackText text={text}>
              {display => (
                <>
                  <MarqueeText as="div" auto className="player-title" title={display?.title}>
                    {display?.title ?? "Nothing playing"}
                  </MarqueeText>
                  <div className="player-artist" title={display?.artistLabel}>
                    <MarqueeText className="player-artist-name">{display?.artistLabel ?? "Choose a song to begin"}</MarqueeText>
                    {display ? <SourceBadge source={display.source} compact /> : null}
                  </div>
                </>
              )}
            </PlaybackText>
          </div>
          {favourite}
        </div>

        <div className="player-center fs-player-center">
          <FullscreenBarTransport />
          <SeekRow />
        </div>

        <div className="player-right fs-player-right">
          <BarVolume />
          <div className="player-tools" role="group" aria-label="Player views">
            {queue}
            {mini}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The bar's transport: YouTube Music-style plain icons with the same click feedback. */
export function FullscreenBarTransport() {
  const { isPlaying, shuffle, repeat, toggle, next, previous, toggleShuffle, cycleRepeat } = useTransportState();
  return (
    <div className="transport" data-player-part="transport">
      <TransportDisc kind="previous" label="Shuffle" className="fs-bar-disc" active={shuffle} pressed={shuffle} onClick={() => toggleShuffle()}>
        <Shuffle size={17} />
      </TransportDisc>
      <TransportDisc kind="previous" label="Previous track" className="fs-bar-disc" onClick={previous}>
        <SkipBack size={19} />
      </TransportDisc>
      <TransportDisc
        kind="play-pause"
        label={isPlaying ? "Pause" : "Play"}
        className="fs-bar-disc fs-bar-play play-button"
        testId="play-toggle"
        onClick={() => void toggle()}
      >
        <span className="play-icon" key={isPlaying ? "pause" : "play"} aria-hidden="true">
          {isPlaying ? <Pause size={32} fill="currentColor" /> : <Play size={32} fill="currentColor" />}
        </span>
      </TransportDisc>
      <TransportDisc kind="next" label="Next track" className="fs-bar-disc" onClick={() => void next(false)}>
        <SkipForward size={19} />
      </TransportDisc>
      <TransportDisc
        kind="previous"
        label={`Repeat: ${repeat}`}
        className="fs-bar-disc"
        active={repeat !== "off"}
        pressed={repeat !== "off"}
        onClick={() => cycleRepeat()}
      >
        {repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />}
      </TransportDisc>
    </div>
  );
}

/** The bottom bar's volume: the same expanding slider, at the bar's 48px icon size. */
function BarVolume() {
  return (
    <div className="volume-group fs-bar-volume">
      <FullscreenVolume />
    </div>
  );
}

