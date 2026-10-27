/**
 * Persistent bottom playback bar. Written for Cadence.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Heart, ListMusic, Maximize2, Mic2 } from "lucide-react";
import { useCurrentTrack } from "../../app/hooks";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { Artwork } from "../../components/Artwork";
import { SeekRow, TransportButtons, VolumeControl } from "./PlaybackControls";

export function PlayerBar() {
  const track = useCurrentTrack();
  const artRef = useRef<HTMLDivElement | null>(null);
  const metaRef = useRef<HTMLDivElement | null>(null);
  const trackId = track?.id ?? null;
  const toggleQueue = useUi(state => state.toggleQueue);
  const queueOpen = useUi(state => state.queueOpen);
  const navigate = useUi(state => state.navigate);
  const setFavorite = useLibrary(state => state.setFavorite);
  const toggleFullscreenLyrics = useUi(state => state.toggleFullscreenLyrics);
  const buffering = usePlayer(state => state.buffering);
  const isPlaying = usePlayer(state => state.isPlaying);
  // Apple Lossless is decoded before it can play, which can take a moment. Show that work only
  // once it is clearly not instant, so ordinary formats never flash a label.
  const [slowStart, setSlowStart] = useState(false);

  // The cover and the title block settle in when the song changes. This restarts a CSS animation
  // on the existing nodes rather than remounting them: remounting the artwork made React stack
  // duplicate covers in the player bar, and a class toggle touches nothing else.
  useLayoutEffect(() => {
    if (trackId === null) return;
    for (const node of [artRef.current, metaRef.current]) {
      if (!node) continue;
      node.classList.remove("is-swapping");
      void node.offsetWidth; // flush the removed class so the animation can start again
      node.classList.add("is-swapping");
    }
  }, [trackId]);

  useEffect(() => {
    if (!buffering || isPlaying) {
      setSlowStart(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowStart(true), 260);
    return () => window.clearTimeout(timer);
  }, [buffering, isPlaying]);

  return (
    <footer
      className={`player-bar ${track ? "" : "is-empty"}`}
      data-testid="player-bar"
      style={track?.artworkUrl ? { ["--player-artwork" as string]: `url("${track.artworkUrl}")` } : undefined}
    >
      <div className="player-track">
        <div className="player-artwork-swap" ref={artRef}>
          <Artwork src={track?.artworkUrl} alt={track?.album ?? "No track"} size="sm" />
        </div>
        <div className="player-track-meta" ref={metaRef}>
          <div className="player-title" title={track?.title}>
            {track?.title ?? "Nothing playing"}
          </div>
          <div className="player-artist" title={track?.artist}>
            {track?.artist ?? "Choose a song to begin"}
          </div>
          {slowStart ? (
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
