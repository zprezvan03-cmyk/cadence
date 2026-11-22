/**
 * Audio controls for the fullscreen Now Playing view. The bar mirrors the home player bar —
 * track identity on the left, transport above the seek row in the middle, volume and view tools
 * on the right — so only the living background makes the fullscreen view different. The panel
 * variant sits beside the artwork when lyrics are off. Written for Cadence.
 */

import { Heart, ListMusic, PictureInPicture2 } from "lucide-react";
import type { MediaItem, Track } from "../../../shared/types";
import type { Dissolve } from "../../app/useDissolve";
import { MarqueeText } from "../../components/MarqueeText";
import { SourceBadge } from "../../components/SourceBadge";
import { SeekRow, TransportButtons, VolumeControl } from "../player/PlaybackControls";
import { PlaybackArtwork, PlaybackText } from "../player/PlaybackVisuals";
import type { Cover } from "../player/usePlaybackPresentation";
import { useLibrary } from "../../state/libraryStore";
import { useUi } from "../../state/uiStore";

export interface FullscreenControlsProps {
  track: Track | null;
  /** Live dissolve layers from the view, used by the decorative footer thumbnail and title. */
  cover: Dissolve<Cover>;
  text: Dissolve<MediaItem | null>;
  /** Hover visibility: faded out and non-interactive while true. */
  concealed?: boolean;
  /** "bar" along the bottom (default); "panel" beside the artwork. */
  variant?: "bar" | "panel";
}

export function FullscreenControls({
  track,
  cover,
  text,
  concealed = false,
  variant = "bar",
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
          <TransportButtons />
          <SeekRow />
        </div>

        <div className="player-right fs-player-right">
          <VolumeControl />
          <div className="player-tools" role="group" aria-label="Player views">
            {queue}
            {mini}
          </div>
        </div>
      </div>
    </div>
  );
}
