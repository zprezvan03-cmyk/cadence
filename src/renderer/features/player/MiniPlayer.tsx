/**
 * Compact always-on-top player rendered inside the main window while mini
 * mode is active. It deliberately reuses the normal transport/seek controls
 * so playback behaviour (gapless, crossfade, shuffle, repeat) is identical.
 */

import { Heart, Maximize2, Minus, X } from "lucide-react";
import type { WindowAction } from "../../../shared/types";
import { useCurrentMediaItem, useCurrentTrack } from "../../app/hooks";
import { SourceBadge } from "../../components/SourceBadge";
import { useLibrary } from "../../state/libraryStore";
import { useUi } from "../../state/uiStore";
import { SeekRow, TransportButtons } from "./PlaybackControls";
import { PlaybackArtwork, PlaybackText } from "./PlaybackVisuals";
import { usePlaybackPresentation } from "./usePlaybackPresentation";

function windowAction(action: WindowAction): void {
  void window.cadence?.app.window(action).catch(() => undefined);
}

export function MiniPlayer() {
  const track = useCurrentTrack();
  const item = useCurrentMediaItem();
  const { cover, text } = usePlaybackPresentation(item);
  const setMiniPlayer = useUi(state => state.setMiniPlayer);
  const navigate = useUi(state => state.navigate);
  const setFavorite = useLibrary(state => state.setFavorite);

  const expand = () => setMiniPlayer(false);
  const openNowPlaying = () => {
    setMiniPlayer(false);
    navigate({ name: "lyrics" });
  };

  return (
    <section className="mini-player" data-testid="mini-player" aria-label="Mini player">
      <div className="mini-player-chrome">
        <div className="mini-player-drag" data-tauri-drag-region>
          <span data-tauri-drag-region>Cadence</span>
        </div>
        <div className="mini-player-window-actions">
          <button
            type="button"
            className="icon-button mini-window-button"
            aria-label="Restore full player"
            title="Restore full player (Ctrl+Shift+P)"
            data-testid="mini-expand"
            onClick={expand}
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            className="icon-button mini-window-button"
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => windowAction("minimize")}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="icon-button mini-window-button danger"
            aria-label="Close Cadence"
            title="Close"
            data-testid="mini-close"
            onClick={() => windowAction("close")}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="mini-player-main">
        <button
          type="button"
          className="mini-player-artwork"
          data-player-part="artwork"
          aria-label="Open Now Playing"
          title="Open Now Playing"
          onClick={openNowPlaying}
        >
          <PlaybackArtwork cover={cover} label={item?.albumLabel ?? item?.title ?? "No track"} />
        </button>
        <PlaybackText text={text} className="mini-player-meta" shared draggable>
          {display => (
            <>
              <div className="mini-player-title" title={display?.title} data-tauri-drag-region>
                {display?.title ?? "Nothing playing"}
              </div>
              <div className="mini-player-artist" title={display?.artistLabel} data-tauri-drag-region>
                {display?.artistLabel ?? "Choose a song in the full player"}
              </div>
              {display ? <SourceBadge source={display.source} compact /> : null}
            </>
          )}
        </PlaybackText>
        {track ? (
          <button
            type="button"
            className={`icon-button heart ${track.favorite ? "active" : ""}`}
            aria-label={track.favorite ? "Remove from favourites" : "Add to favourites"}
            onClick={() => void setFavorite(track.id, !track.favorite)}
          >
            <Heart size={16} fill={track.favorite ? "currentColor" : "none"} />
          </button>
        ) : null}
        <TransportButtons />
      </div>

      <SeekRow />
    </section>
  );
}
