/**
 * Persistent bottom playback bar. Written for Cadence.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Heart, ListMusic, Maximize2, Mic2, Pause, PictureInPicture2, Play, SkipForward } from "lucide-react";
import { trackSourceKey } from "../../../shared/media";
import { useCurrentMediaItem, useCurrentTrack } from "../../app/hooks";
import { useMobileShell } from "../../app/useMobileShell";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";
import { SeekRow, TransportButtons, VolumeControl } from "./PlaybackControls";

export function PlayerBar() {
  const isMobile = useMobileShell();
  const track = useCurrentTrack();
  const item = useCurrentMediaItem();
  const artRef = useRef<HTMLDivElement | null>(null);
  const metaRef = useRef<HTMLDivElement | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const itemKey = item ? trackSourceKey(item.source) : null;
  const toggleQueue = useUi(state => state.toggleQueue);
  const queueOpen = useUi(state => state.queueOpen);
  const navigate = useUi(state => state.navigate);
  const setFavorite = useLibrary(state => state.setFavorite);
  const toggleFullscreenLyrics = useUi(state => state.toggleFullscreenLyrics);
  const setMiniPlayer = useUi(state => state.setMiniPlayer);
  const buffering = usePlayer(state => state.buffering);
  const isPlaying = usePlayer(state => state.isPlaying);
  const position = usePlayer(state => state.position);
  const duration = usePlayer(state => state.duration);
  const toggle = usePlayer(state => state.toggle);
  const next = usePlayer(state => state.next);
  const previous = usePlayer(state => state.previous);
  const queueLength = usePlayer(state => state.queue.length);
  const playbackMechanism = usePlayer(state => state.playbackMechanism);
  const remoteError = usePlayer(state => state.remoteError);
  // Apple Lossless is decoded before it can play, which can take a moment. Show that work only
  // once it is clearly not instant, so ordinary formats never flash a label.
  const [slowStart, setSlowStart] = useState(false);

  // The cover and the title block settle in when the song changes. This restarts a CSS animation
  // on the existing nodes rather than remounting them: remounting the artwork made React stack
  // duplicate covers in the player bar, and a class toggle touches nothing else.
  useLayoutEffect(() => {
    if (itemKey === null) return;
    for (const node of [artRef.current, metaRef.current]) {
      if (!node) continue;
      node.classList.remove("is-swapping");
      void node.offsetWidth; // flush the removed class so the animation can start again
      node.classList.add("is-swapping");
    }
  }, [itemKey]);

  useEffect(() => {
    if (!buffering || isPlaying) {
      setSlowStart(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowStart(true), 260);
    return () => window.clearTimeout(timer);
  }, [buffering, isPlaying]);

  if (isMobile) {
    const progressRatio =
      duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
    return (
      <footer
        className={`player-bar is-mobile ${item ? "" : "is-empty"}`}
        data-testid="player-bar"
        data-playback-mechanism={playbackMechanism}
        data-source-kind={item?.source.kind ?? "none"}
        style={item?.artworkUrl ? { ["--player-artwork" as string]: `url("${item.artworkUrl}")` } : undefined}
        onTouchStart={event => {
          const touch = event.touches[0];
          if (touch) touchStartRef.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchEnd={event => {
          const start = touchStartRef.current;
          touchStartRef.current = null;
          const touch = event.changedTouches[0];
          if (!start || !touch) return;
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (Math.abs(dy) > 38 && Math.abs(dy) > Math.abs(dx) && dy < 0) {
            navigate({ name: "lyrics" });
          } else if (Math.abs(dx) > 54 && Math.abs(dx) > Math.abs(dy) && queueLength > 0) {
            if (dx < 0) void next(false);
            else void previous();
          }
        }}
      >
        <div className="mobile-mini-progress" aria-hidden="true">
          <span
            className="mobile-mini-progress-fill"
            style={{ transform: `scaleX(${progressRatio.toFixed(4)})` }}
          />
        </div>
        <button
          type="button"
          className="mobile-mini-track"
          onClick={() => navigate({ name: "lyrics" })}
          aria-label="Open Now Playing"
        >
          <div className="player-artwork-swap" ref={artRef}>
            <Artwork src={item?.artworkUrl} alt={item?.albumLabel ?? item?.title ?? "No track"} size="sm" />
          </div>
          <div className="player-track-meta" ref={metaRef}>
            <div className="player-title">{item?.title ?? "Nothing playing"}</div>
            <div className="player-artist">
              {slowStart ? "Preparing audio…" : item?.artistLabel ?? "Tap a song to begin"}
            </div>
          </div>
        </button>
        <div className="mobile-mini-controls">
          {track ? (
            <button
              type="button"
              className={`icon-button heart ${track.favorite ? "active" : ""}`}
              aria-label={track.favorite ? "Remove from favourites" : "Add to favourites"}
              onClick={() => void setFavorite(track.id, !track.favorite)}
            >
              <Heart size={18} fill={track.favorite ? "currentColor" : "none"} />
            </button>
          ) : null}
          <button
            type="button"
            className="mobile-mini-play"
            aria-label={isPlaying ? "Pause" : "Play"}
            disabled={queueLength === 0}
            onClick={() => void toggle()}
          >
            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next"
            disabled={queueLength === 0}
            onClick={() => void next(false)}
          >
            <SkipForward size={18} />
          </button>
        </div>
      </footer>
    );
  }

  return (
    <footer
      className={`player-bar ${item ? "" : "is-empty"}`}
      data-testid="player-bar"
      data-playback-mechanism={playbackMechanism}
      data-source-kind={item?.source.kind ?? "none"}
      style={item?.artworkUrl ? { ["--player-artwork" as string]: `url("${item.artworkUrl}")` } : undefined}
    >
      <div className="player-track">
        <div className="player-artwork-swap" ref={artRef}>
          <Artwork src={item?.artworkUrl} alt={item?.albumLabel ?? item?.title ?? "No track"} size="sm" />
        </div>
        <div className="player-track-meta" ref={metaRef}>
          <div className="player-title" title={item?.title}>
            {item?.title ?? "Nothing playing"}
          </div>
          <div className="player-artist" title={item?.artistLabel}>
            {item?.artistLabel ?? "Choose a song to begin"}
          </div>
          {item ? (
            <div className="player-source-line">
              <SourceBadge source={item.source} compact />
            </div>
          ) : null}
          {remoteError && item?.source.kind !== "local" ? (
            <div
              className="player-remote-error"
              role="status"
              title={remoteError}
              data-testid="player-remote-error"
            >
              {remoteError}
            </div>
          ) : slowStart ? (
            <div className="player-preparing" role="status" data-testid="player-preparing">
              Preparing audio…
            </div>
          ) : null}
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
          aria-label="Mini player"
          title="Mini player (Ctrl+Shift+P)"
          data-testid="open-mini-player"
          onClick={() => setMiniPlayer(true)}
        >
          <PictureInPicture2 size={17} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Fullscreen lyrics"
          title="Fullscreen lyrics (F)"
          onClick={() => toggleFullscreenLyrics()}
        >
          <Maximize2 size={17} />
        </button>
      </div>
    </footer>
  );
}
