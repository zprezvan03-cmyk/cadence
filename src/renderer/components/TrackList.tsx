/**
 * Track list with playback, favourites and queue actions. Written for Cadence.
 */

import { useEffect, useRef, useState } from "react";
import {
  Disc3,
  Heart,
  ListPlus,
  MoreHorizontal,
  Play,
  Plus,
  Rows3,
  Trash2,
} from "lucide-react";
import type { Track } from "../../shared/types";
import { formatTime } from "../player/queue";
import { useLibrary } from "../state/libraryStore";
import { usePlayer } from "../state/playerStore";
import { useUi } from "../state/uiStore";
import { codecSupport } from "../audio/codecs";
import { currentTrackId } from "../state/playerStore";
import { Artwork } from "./Artwork";

interface TrackListProps {
  tracks: Track[];
  /** Optional label for the artwork column (albums/playlists). */
  showAlbum?: boolean;
  showArtwork?: boolean;
  onRemove?: (track: Track) => void;
  emptyMessage?: string;
  compact?: boolean;
  testId?: string;
}

interface MenuState {
  track: Track;
  x: number;
  y: number;
}

export function TrackList({
  tracks,
  showAlbum = true,
  showArtwork = true,
  onRemove,
  emptyMessage = "No songs here yet.",
  compact = false,
  testId,
}: TrackListProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const playQueue = usePlayer(state => state.playQueue);
  const addToQueue = usePlayer(state => state.addToQueue);
  const playNext = usePlayer(state => state.playNext);
  const currentId = usePlayer(state => currentTrackId(state));
  const isPlaying = usePlayer(state => state.isPlaying);
  const toggle = usePlayer(state => state.toggle);
  const setFavorite = useLibrary(state => state.setFavorite);
  const openPlaylistPicker = useUi(state => state.openPlaylistPicker);
  const navigate = useUi(state => state.navigate);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [menu]);

  const play = (index: number) => {
    void playQueue(
      tracks.map(track => track.id),
      index
    );
  };

  if (tracks.length === 0) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  return (
    <div className={`track-list ${compact ? "compact" : ""}`} data-testid={testId}>
      <div className="track-head">
        <span className="col-index">#</span>
        <span className="col-title">Title</span>
        {showAlbum ? <span className="col-album">Album</span> : null}
        <span className="col-duration">Time</span>
        <span className="col-actions" />
      </div>
      {tracks.map((track, index) => {
        const active = track.id === currentId;
        return (
          <div
            key={`${track.id}-${index}`}
            className={`track-row ${active ? "active" : ""}`}
            onDoubleClick={() => play(index)}
            onClick={() => {
              if (active) {
                void toggle();
                return;
              }
              play(index);
            }}
            data-testid="track-row"
            data-track-id={track.id}
          >
            <span className="col-index">
              <span className="index-number">{index + 1}</span>
              <span className="index-play">{active && isPlaying ? <Rows3 size={15} /> : <Play size={15} />}</span>
            </span>
            <span className="col-title">
              {showArtwork ? <Artwork src={track.artworkUrl} alt={track.album} size="xs" /> : null}
              <span className="title-block">
                <span className="title-text">{track.title}</span>
                <span className="subtitle-text">{track.artist}</span>
              </span>
              {!track.playable || codecSupport(track) === "unsupported" ? (
                <span
                  className="badge warn"
                  title={`${track.codec} is not decodable by Chromium's built-in media stack — convert to FLAC to play it`}
                >
                  no decoder
                </span>
              ) : null}
              {track.hasSidecarLyrics ? (
                <span className="badge" title="Sidecar lyrics found">
                  LRC
                </span>
              ) : null}
            </span>
            {showAlbum ? <span className="col-album">{track.album}</span> : null}
            <span className="col-duration">{formatTime(track.duration)}</span>
            <span className="col-actions" onClick={event => event.stopPropagation()}>
              <button
                type="button"
                className={`icon-button heart ${track.favorite ? "active" : ""}`}
                aria-label={track.favorite ? "Remove from favourites" : "Add to favourites"}
                onClick={() => void setFavorite(track.id, !track.favorite)}
              >
                <Heart size={15} fill={track.favorite ? "currentColor" : "none"} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="More actions"
                onClick={event => {
                  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenu({ track, x: rect.right, y: rect.bottom + 6 });
                }}
              >
                <MoreHorizontal size={17} />
              </button>
            </span>
          </div>
        );
      })}

      {menu ? (
        <div className="context-menu" style={{ left: Math.max(12, menu.x - 220), top: menu.y }} ref={menuRef}>
          <button type="button" onClick={() => { playNext([menu.track.id]); setMenu(null); }}>
            <Play size={15} /> Play next
          </button>
          <button type="button" onClick={() => { addToQueue([menu.track.id]); setMenu(null); }}>
            <ListPlus size={15} /> Add to queue
          </button>
          <button type="button" onClick={() => { openPlaylistPicker([menu.track.id]); setMenu(null); }}>
            <Plus size={15} /> Add to playlist…
          </button>
          <button
            type="button"
            onClick={() => {
              navigate({ name: "album", albumId: `${menu.track.albumArtist}\u0000${menu.track.album}` });
              setMenu(null);
            }}
          >
            <Disc3 size={15} /> Go to album
          </button>
          {onRemove ? (
            <button
              type="button"
              className="danger"
              onClick={() => {
                onRemove(menu.track);
                setMenu(null);
              }}
            >
              <Trash2 size={15} /> Remove
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
