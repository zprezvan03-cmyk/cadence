/**
 * Persistent bottom playback bar. Written for Cadence.
 */

import { useEffect, useState } from "react";
import { Heart, ListMusic, Maximize2, Mic2, PictureInPicture2 } from "lucide-react";
import { useCurrentMediaItem, useCurrentTrack } from "../../app/hooks";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { SourceBadge } from "../../components/SourceBadge";
import { SeekRow, TransportButtons, VolumeControl } from "./PlaybackControls";
import { PlaybackArtwork, PlaybackText } from "./PlaybackVisuals";
import { usePlaybackPresentation } from "./usePlaybackPresentation";

export function PlayerBar() {
  const track = useCurrentTrack();
  const item = useCurrentMediaItem();
  const { cover, text } = usePlaybackPresentation(item);
  const toggleQueue = useUi(state => state.toggleQueue);
  const queueOpen = useUi(state => state.queueOpen);
  const lyricsOpen = useUi(state => state.route.name === "lyrics");
  const navigate = useUi(state => state.navigate);
  const setFavorite = useLibrary(state => state.setFavorite);
  const toggleFullscreenLyrics = useUi(state => state.toggleFullscreenLyrics);
  const setMiniPlayer = useUi(state => state.setMiniPlayer);
  const buffering = usePlayer(state => state.buffering);
  const isPlaying = usePlayer(state => state.isPlaying);
  const playbackMechanism = usePlayer(state => state.playbackMechanism);
  const remoteError = usePlayer(state => state.remoteError);
  // Apple Lossless is decoded before it can play, which can take a moment. Show that work only
  // once it is clearly not instant, so ordinary formats never flash a label.
  const [slowStart, setSlowStart] = useState(false);

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
      className={`player-bar ${item ? "" : "is-empty"}`}
      data-testid="player-bar"
      data-playback-mechanism={playbackMechanism}
      data-source-kind={item?.source.kind ?? "none"}
      data-artwork-wash={Boolean(cover.front.value.src) || undefined}
      style={cover.front.value.src ? { ["--player-artwork" as string]: `url("${cover.front.value.src.replace(/"/g, "%22")}")` } : undefined}
    >
      <div className="player-track">
        <button type="button" className="player-cover-button" aria-label="Open Now Playing" title="Open Now Playing" onClick={() => navigate({ name: "lyrics" })}>
          <PlaybackArtwork cover={cover} label={item?.albumLabel ?? item?.title ?? "No track"} />
        </button>
        <div className="player-track-meta" data-player-part="metadata">
          <PlaybackText text={text}>
            {display => (
              <>
                <div className="player-title" title={display?.title}>
                  {display?.title ?? "Nothing playing"}
                </div>
                <div className="player-artist" title={display?.artistLabel}>
                  <span className="player-artist-name">{display?.artistLabel ?? "Choose a song to begin"}</span>
                  {display ? <SourceBadge source={display.source} compact /> : null}
                </div>
              </>
            )}
          </PlaybackText>
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
            title={track.favorite ? "Remove from favourites" : "Add to favourites"}
            aria-pressed={track.favorite}
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
        <div className="player-tools" role="group" aria-label="Player views">
          <button
            type="button"
            className={`icon-button ${lyricsOpen ? "active" : ""}`}
            aria-label="Now Playing"
            aria-pressed={lyricsOpen}
            title="Now Playing (L)"
            onClick={() => navigate({ name: "lyrics" })}
          >
            <Mic2 size={18} />
          </button>
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
      </div>
    </footer>
  );
}
