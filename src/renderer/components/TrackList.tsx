/**
 * Track list with playback, favourites and queue actions. Written for Cadence.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Heart,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
} from "lucide-react";
import type { Track } from "../../shared/types";
import { formatTime } from "../player/queue";
import { useLibrary } from "../state/libraryStore";
import { currentTrackId, usePlayer } from "../state/playerStore";
import { codecSupport } from "../audio/codecs";
import { useTrackMenu } from "./useTrackMenu";
import { Artwork } from "./Artwork";

const ROW_HEIGHT_PX = 58;
const HEADER_HEIGHT_PX = 40;
const OVERSCAN_ROWS = 8;
const VIRTUALIZATION_THRESHOLD = 100;

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

interface TrackRowProps {
  track: Track;
  index: number;
  active: boolean;
  playing: boolean;
  menuOpen: boolean;
  showAlbum: boolean;
  showArtwork: boolean;
  onPlay: (index: number) => void;
  onToggle: () => Promise<void>;
  onFavorite: (id: number, favorite: boolean) => Promise<void>;
  onOpenMenu: (track: Track, anchor: HTMLButtonElement) => void;
}

/** Rows are memoized so playback and favourite updates do not rebuild every visible row. */
const TrackRow = memo(function TrackRow({
  track,
  index,
  active,
  playing,
  menuOpen,
  showAlbum,
  showArtwork,
  onPlay,
  onToggle,
  onFavorite,
  onOpenMenu,
}: TrackRowProps) {
  return (
    <div
      className={`track-row${index % 2 === 0 ? " is-striped" : ""}${active ? " active" : ""}`}
      onDoubleClick={() => onPlay(index)}
      onClick={() => {
        if (active) {
          void onToggle();
          return;
        }
        onPlay(index);
      }}
      data-testid="track-row"
      data-track-id={track.id}
    >
      <button
        type="button"
        className="col-index track-play"
        aria-label={`${active && playing ? "Pause" : "Play"} ${track.title}`}
        onDoubleClick={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          if (active) void onToggle();
          else onPlay(index);
        }}
      >
        <span className="index-number" aria-hidden="true">{index + 1}</span>
        <span className="index-play" aria-hidden="true">{active && playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}</span>
      </button>
      <span className="col-title">
        {showArtwork ? <Artwork src={track.artworkUrl} alt={track.album} size="xs" /> : null}
        <span className="title-block">
          <span className="title-text" title={track.title}>{track.title}</span>
          <span className="subtitle-text" title={track.artist}>{track.artist}</span>
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
      {showAlbum ? <span className="col-album" title={track.album}>{track.album}</span> : null}
      <span className="col-duration">{formatTime(track.duration)}</span>
      <span className="col-actions" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        <button
          type="button"
          className={`icon-button heart ${track.favorite ? "active" : ""}`}
          aria-label={track.favorite ? "Remove from favourites" : "Add to favourites"}
          aria-pressed={track.favorite}
          onClick={() => void onFavorite(track.id, !track.favorite)}
        >
          <Heart size={15} fill={track.favorite ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="More actions"
          aria-expanded={menuOpen}
          onClick={event => onOpenMenu(track, event.currentTarget)}
        >
          <MoreHorizontal size={17} />
        </button>
      </span>
    </div>
  );
});

export const TrackList = memo(function TrackList({
  tracks,
  showAlbum = true,
  showArtwork = true,
  onRemove,
  emptyMessage = "No songs here yet.",
  compact = false,
  testId,
}: TrackListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const { openMenu, menuTrackId, surface } = useTrackMenu(listRef, onRemove);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 40 });
  const playQueue = usePlayer(state => state.playQueue);
  const currentId = usePlayer(state => currentTrackId(state));
  const isPlaying = usePlayer(state => state.isPlaying);
  const toggle = usePlayer(state => state.toggle);
  const setFavorite = useLibrary(state => state.setFavorite);

  const trackIds = useMemo(() => tracks.map(track => track.id), [tracks]);
  const play = useCallback(
    (index: number) => {
      void playQueue(trackIds, index);
    },
    [playQueue, trackIds]
  );
  const virtualized = tracks.length >= VIRTUALIZATION_THRESHOLD;

  useEffect(() => {
    if (!virtualized || !listRef.current) return;
    const list = listRef.current;
    const scroller = list.closest(".content-scroll");
    if (!(scroller instanceof HTMLElement)) return;

    let frame: number | null = null;
    const updateRange = () => {
      frame = null;
      const viewport = scroller.getBoundingClientRect();
      const listBox = list.getBoundingClientRect();
      const rowsTop = listBox.top + HEADER_HEIGHT_PX;
      const first = Math.floor((viewport.top - rowsTop) / ROW_HEIGHT_PX) - OVERSCAN_ROWS;
      const last = Math.ceil((viewport.bottom - rowsTop) / ROW_HEIGHT_PX) + OVERSCAN_ROWS;
      const start = Math.max(0, Math.min(tracks.length, first));
      const end = Math.max(start, Math.min(tracks.length, last));
      setVisibleRange(previous => (previous.start === start && previous.end === end ? previous : { start, end }));
    };
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(updateRange);
    };

    updateRange();
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [tracks.length, virtualized]);

  if (tracks.length === 0) {
    return <div className="empty-state"><Music2 size={26} aria-hidden="true" /><p>{emptyMessage}</p></div>;
  }

  const start = virtualized ? Math.min(visibleRange.start, Math.max(0, tracks.length - 1)) : 0;
  const end = virtualized ? Math.max(start, Math.min(visibleRange.end, tracks.length)) : tracks.length;

  return (
    <div className={`track-list ${compact || !showAlbum ? "compact" : ""}`} data-testid={testId} ref={listRef}>
      <div className="track-head">
        <span className="col-index">#</span>
        <span className="col-title">Title</span>
        {showAlbum ? <span className="col-album">Album</span> : null}
        <span className="col-duration">Time</span>
        <span className="col-actions" />
      </div>
      {start > 0 ? <div aria-hidden="true" style={{ height: start * ROW_HEIGHT_PX, flexShrink: 0 }} /> : null}
      {tracks.slice(start, end).map((track, visibleIndex) => {
        const index = start + visibleIndex;
        const active = track.id === currentId;
        return (
          <TrackRow
            key={track.id}
            track={track}
            index={index}
            active={active}
            playing={active && isPlaying}
            menuOpen={menuTrackId === track.id}
            showAlbum={showAlbum}
            showArtwork={showArtwork}
            onPlay={play}
            onToggle={toggle}
            onFavorite={setFavorite}
            onOpenMenu={openMenu}
          />
        );
      })}
      {end < tracks.length ? (
        <div aria-hidden="true" style={{ height: (tracks.length - end) * ROW_HEIGHT_PX, flexShrink: 0 }} />
      ) : null}

      {surface}
    </div>
  );
});
