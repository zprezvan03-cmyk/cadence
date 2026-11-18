/**
 * Navigation sidebar. Written for Cadence.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  Album as AlbumIcon,
  ChartColumn,
  Heart,
  Home,
  History,
  AudioLines,
  ListMusic,
  Mic2,
  Music2,
  Plus,
  Settings,
  Users,
} from "lucide-react";
import { EMPTY_PLAYLISTS, useLibrary } from "../state/libraryStore";
import { useUi, type LibraryTab } from "../state/uiStore";

const NAV: { label: string; icon: React.ReactNode; route: Parameters<ReturnType<typeof useUi.getState>["navigate"]>[0]; group?: string }[] = [
  { label: "Home", group: "Listen", icon: <Home size={18} />, route: { name: "home" } },
  { label: "Now Playing", icon: <Mic2 size={18} />, route: { name: "lyrics" } },
  { label: "History", icon: <History size={18} />, route: { name: "history" } },
  { label: "Stats", icon: <ChartColumn size={18} />, route: { name: "stats" } },
  { label: "Songs", group: "Library", icon: <Music2 size={18} />, route: { name: "library", tab: "songs" } },
  { label: "Albums", icon: <AlbumIcon size={18} />, route: { name: "library", tab: "albums" } },
  { label: "Artists", icon: <Users size={18} />, route: { name: "library", tab: "artists" } },
  { label: "Playlists", icon: <ListMusic size={18} />, route: { name: "library", tab: "playlists" } },
  { label: "Liked songs", icon: <Heart size={18} />, route: { name: "library", tab: "favorites" } },
];

export function Sidebar() {
  const route = useUi(state => state.route);
  const navigate = useUi(state => state.navigate);
  const requestPlaylistCreate = useUi(state => state.requestPlaylistCreate);
  const playlists = useLibrary(state => state.snapshot?.playlists ?? EMPTY_PLAYLISTS);
  const counts = useLibrary(state => state.snapshot?.counts);

  const isActive = (candidate: (typeof NAV)[number]["route"]) => {
    // Keep the parent collection identifiable while browsing its detail page.
    if (candidate.name === "library") {
      if (route.name === "album") return candidate.tab === "albums";
      if (route.name === "artist") return candidate.tab === "artists";
      if (route.name === "playlist") return candidate.tab === "playlists";
    }
    if (candidate.name !== route.name) return false;
    if (candidate.name === "library" && route.name === "library") {
      return candidate.tab === route.tab;
    }
    return true;
  };

  const navRef = useRef<HTMLElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const slots = useRef(new Map<Element, { height: number; top: number }>());
  const measureSlots = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    slots.current.clear();
    for (const button of nav.querySelectorAll<HTMLElement>(".nav-item")) {
      slots.current.set(button, { height: button.offsetHeight, top: button.offsetTop });
    }
  }, []);

  /**
   * One pill slides between nav items instead of each item fading its own background in. The DOM is
   * measured only when the rail's geometry changes. Navigation just picks the cached slot,
   * avoiding a forced layout of the incoming page in the same commit.
   */
  const placePill = useCallback((instant: boolean) => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return;
    const button = nav.querySelector<HTMLButtonElement>(".nav-item.active");
    if (!button) {
      pill.classList.remove("is-visible");
      return;
    }
    const slot = slots.current.get(button);
    if (!slot) return;
    const height = `${slot.height}px`;
    const transform = `translateY(${slot.top}px)`;
    // Compact hover can resize the rail on every interpolated frame without changing the pill's
    // vertical geometry. Don't restart (or snap) a navigation move for those notifications.
    const moved = pill.style.height !== height || pill.style.transform !== transform;
    if (instant && moved) pill.dataset.instant = "true";
    if (moved) {
      pill.style.height = height;
      pill.style.transform = transform;
    }
    pill.classList.add("is-visible");
    nav.dataset.pill = "ready";
    if (instant && moved) {
      // Flush the measured position with transitions off, then let later moves animate.
      void pill.offsetHeight;
      delete pill.dataset.instant;
    }
    // Stable on purpose: rebuilding the resize observer on every navigation would fire its initial
    // callback immediately and cancel the very transition it was about to animate.
  }, []);

  useLayoutEffect(measureSlots, [measureSlots]);
  useLayoutEffect(() => {
    placePill(navRef.current?.dataset.pill !== "ready");
  }, [placePill, route]);

  // The nav can move under the pill without a route change: a resized window, a compact sidebar, or
  // playlists appearing above the footer. Re-place instantly instead of sliding from a stale spot.
  useEffect(() => {
    const replace = () => {
      measureSlots();
      placePill(true);
    };
    window.addEventListener("resize", replace);
    const nav = navRef.current;
    // Width-only hover measurements cannot move these single-line buttons vertically.
    // Avoid reading layout from every intermediate compact-sidebar resize notification.
    let height: number | undefined;
    const observer = nav ? new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.height === height) return;
      height = entry.contentRect.height;
      replace();
    }) : null;
    if (nav && observer) observer.observe(nav);
    return () => {
      window.removeEventListener("resize", replace);
      observer?.disconnect();
    };
  }, [measureSlots, placePill]);

  return (
    <aside className="sidebar">
      <button type="button" className="brand" onClick={() => navigate({ name: "home" })} aria-label="Cadence home">
        <span className="brand-mark" aria-hidden="true"><AudioLines size={20} /></span>
        <span className="brand-text"><strong>Cadence</strong></span>
      </button>

      <nav className="nav" aria-label="Music navigation" ref={navRef}>
        <span className="nav-pill" ref={pillRef} aria-hidden="true" />
        {NAV.map(item => {
          const active = isActive(item.route);
          return (
            <NavEntry key={item.label} item={item} active={active} navigate={navigate} />
          );
        })}
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-heading">
          <span>My playlists</span>
          <button type="button" className="icon-button" onClick={requestPlaylistCreate} aria-label="New playlist">
            <Plus size={15} />
          </button>
        </div>
        <div className="sidebar-playlists">
          {playlists.slice(0, 8).map(playlist => (
            <button
              type="button"
              key={playlist.id}
              className={`sidebar-link ${route.name === "playlist" && route.playlistId === playlist.id ? "active" : ""}`}
              onClick={() => navigate({ name: "playlist", playlistId: playlist.id })}
              title={playlist.name}
              aria-current={route.name === "playlist" && route.playlistId === playlist.id ? "page" : undefined}
            >
              <ListMusic size={15} aria-hidden="true" />
              <span>{playlist.name}</span>
            </button>
          ))}
          {playlists.length === 0 ? <p className="sidebar-hint">Playlists you create appear here.</p> : null}
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-stats">
          {counts ? `${counts.tracks} songs · ${counts.albums} albums` : "Loading library…"}
        </div>
        <button
          type="button"
          className={`nav-item ${route.name === "settings" ? "active" : ""}`}
          onClick={() => navigate({ name: "settings" })}
          title="Settings"
          aria-label="Settings"
          aria-current={route.name === "settings" ? "page" : undefined}
        >
          <Settings size={18} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

function NavEntry({ item, active, navigate }: {
  item: (typeof NAV)[number];
  active: boolean;
  navigate: ReturnType<typeof useUi.getState>["navigate"];
}) {
  return (
    <>
      {item.group ? <p className="nav-group" aria-hidden="true">{item.group}</p> : null}
      <button
        type="button"
        className={`nav-item ${active ? "active" : ""}`}
        onClick={() => navigate(item.route)}
        title={item.label}
        aria-label={item.label}
        aria-current={active ? "location" : undefined}
      >
        {item.icon}
        <span>{item.label}</span>
      </button>
    </>
  );
}

export type { LibraryTab };
