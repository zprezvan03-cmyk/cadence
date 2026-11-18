/**
 * Track list with playback, favourites and queue actions. Written for Cadence.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Disc3,
  Heart,
  ListPlus,
  MoreHorizontal,
  Music2,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import type { Track } from "../../shared/types";
import { formatTime } from "../player/queue";
import { useLibrary } from "../state/libraryStore";
import { usePlayer } from "../state/playerStore";
import { useUi } from "../state/uiStore";
import { codecSupport } from "../audio/codecs";
import { currentTrackId } from "../state/playerStore";
import { useLastNonNull, usePresence } from "../app/usePresence";
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

interface MenuState {
  track: Track;
  anchor: HTMLButtonElement;
  scrollTop: number;
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
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Menu actions and dismissal flip `menu` instantly; presence only keeps the surface
  // mounted for its fast pop-out, rendering the last target so it never blanks mid-exit.
  const menuPresence = usePresence(menu !== null);
  const renderedMenu = useLastNonNull(menu);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 40 });
  const playQueue = usePlayer(state => state.playQueue);
  const addToQueue = usePlayer(state => state.addToQueue);
  const playNext = usePlayer(state => state.playNext);
  const currentId = usePlayer(state => currentTrackId(state));
  const isPlaying = usePlayer(state => state.isPlaying);
  const toggle = usePlayer(state => state.toggle);
  const setFavorite = useLibrary(state => state.setFavorite);
  const openPlaylistPicker = useUi(state => state.openPlaylistPicker);
  const openTrackEditor = useUi(state => state.openTrackEditor);
  const navigate = useUi(state => state.navigate);

  const trackIds = useMemo(() => tracks.map(track => track.id), [tracks]);
  const play = useCallback(
    (index: number) => {
      void playQueue(trackIds, index);
    },
    [playQueue, trackIds]
  );
  const openMenu = useCallback((track: Track, anchor: HTMLButtonElement) => {
    const scrollTop = listRef.current?.closest(".content-scroll")?.scrollTop ?? 0;
    setMenu(previous => previous?.anchor === anchor ? null : { track, anchor, scrollTop });
  }, []);

  const closeMenuAndRestoreFocus = () => {
    setMenu(null);
    menu?.anchor.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const surface = menuRef.current;
    if (!menu || !surface) return;
    const anchor = menu.anchor.getBoundingClientRect();
    // offset dimensions ignore the entrance transform, so the settled panel stays in bounds.
    const width = surface.offsetWidth;
    const height = surface.offsetHeight;
    const inset = 10;
    const below = anchor.bottom + 6;
    const top = below + height <= window.innerHeight - inset ? below : anchor.top - height - 6;
    surface.style.left = `${Math.max(inset, Math.min(anchor.right - width, window.innerWidth - width - inset))}px`;
    surface.style.top = `${Math.max(inset, Math.min(top, window.innerHeight - height - inset))}px`;
    surface.querySelector("button")?.focus({ preventScroll: true });
  }, [menu, menuPresence.mounted]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || menu.anchor.contains(event.target))) return;
      setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMenu(null);
        menu.anchor.focus({ preventScroll: true });
      }
    };
    const dismiss = () => setMenu(null);
    const scroll = listRef.current?.closest(".content-scroll");
    // A scroll event can arrive after a click even if its movement preceded opening the menu.
    // Ignore that pending event, but close if the list actually moves away from the anchor.
    const onScroll = () => {
      if (scroll?.scrollTop !== menu.scrollTop) dismiss();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", dismiss);
    scroll?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", dismiss);
      scroll?.removeEventListener("scroll", onScroll);
    };
  }, [menu]);

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
            menuOpen={menu?.track.id === track.id}
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

      {menuPresence.mounted && renderedMenu ? createPortal(
        <div
          className={`context-menu ${menuPresence.phaseClass}`}
          data-presence={menuPresence.phase}
          inert={!menu}
          ref={menuRef}
          role="group"
          aria-label={`Actions for ${renderedMenu.track.title}`}
        >
          <div className="context-menu-title" title={renderedMenu.track.title}>{renderedMenu.track.title}</div>
          <button type="button" onClick={() => { playNext([renderedMenu.track.id]); closeMenuAndRestoreFocus(); }}>
            <Play size={15} /> Play next
          </button>
          <button type="button" onClick={() => { addToQueue([renderedMenu.track.id]); closeMenuAndRestoreFocus(); }}>
            <ListPlus size={15} /> Add to queue
          </button>
          <button type="button" onClick={() => { openPlaylistPicker([renderedMenu.track.id]); setMenu(null); }}>
            <Plus size={15} /> Add to playlist…
          </button>
          <hr />
          <button
            type="button"
            data-testid="track-edit-details"
            onClick={() => {
              openTrackEditor(renderedMenu.track.id);
              setMenu(null);
            }}
          >
            <Pencil size={15} /> Edit details…
          </button>
          <button
            type="button"
            onClick={() => {
              navigate({ name: "album", albumId: `${renderedMenu.track.albumArtist || renderedMenu.track.artist}\u0000${renderedMenu.track.album}` });
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
                onRemove(renderedMenu.track);
                setMenu(null);
              }}
            >
              <Trash2 size={15} /> Remove
            </button>
          ) : null}
        </div>, document.body
      ) : null}
    </div>
  );
});
