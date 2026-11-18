/** Anchored actions shared by track rows and the Home ranked shelf. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Disc3, ListPlus, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Track } from "../../shared/types";
import { usePlayer } from "../state/playerStore";
import { useUi } from "../state/uiStore";
import { useLastNonNull, usePresence } from "../app/usePresence";

interface MenuState {
  track: Track;
  anchor: HTMLButtonElement;
  scrollTop: number;
  scrollLeft: number;
}

export function useTrackMenu(listRef: RefObject<HTMLDivElement | null>, onRemove?: (track: Track) => void) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Menu actions and dismissal flip `menu` instantly; presence only keeps the surface
  // mounted for its fast pop-out, rendering the last target so it never blanks mid-exit.
  const menuPresence = usePresence(menu !== null);
  const renderedMenu = useLastNonNull(menu);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const addToQueue = usePlayer(state => state.addToQueue);
  const playNext = usePlayer(state => state.playNext);
  const openPlaylistPicker = useUi(state => state.openPlaylistPicker);
  const openTrackEditor = useUi(state => state.openTrackEditor);
  const navigate = useUi(state => state.navigate);

  const openMenu = useCallback((track: Track, anchor: HTMLButtonElement) => {
    const scrollTop = listRef.current?.closest(".content-scroll")?.scrollTop ?? 0;
    const scrollLeft = listRef.current?.scrollLeft ?? 0;
    setMenu(previous => previous?.anchor === anchor ? null : { track, anchor, scrollTop, scrollLeft });
  }, [listRef]);

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
    const list = listRef.current;
    const scroll = list?.closest(".content-scroll");
    // A scroll event can arrive after a click even if its movement preceded opening the menu.
    // Ignore that pending event, but close if the list actually moves away from the anchor.
    const onScroll = () => {
      if ((scroll?.scrollTop ?? 0) !== menu.scrollTop || (list?.scrollLeft ?? 0) !== menu.scrollLeft) dismiss();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", dismiss);
    scroll?.addEventListener("scroll", onScroll, { passive: true });
    list?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", dismiss);
      scroll?.removeEventListener("scroll", onScroll);
      list?.removeEventListener("scroll", onScroll);
    };
  }, [menu, listRef]);

  const surface =
    menuPresence.mounted && renderedMenu ? createPortal(
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
    ) : null;

  return { openMenu, menuTrackId: menu?.track.id, surface };
}
