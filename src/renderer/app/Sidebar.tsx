/**
 * Navigation sidebar. Written for Cadence.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  Album as AlbumIcon,
  Heart,
  Home,
  Library,
  ListMusic,
  Mic2,
  Music2,
  Plus,
  Settings,
  Users,
} from "lucide-react";
import { EMPTY_PLAYLISTS, useLibrary } from "../state/libraryStore";
import { useUi, type LibraryTab } from "../state/uiStore";

const NAV: { label: string; icon: React.ReactNode; route: Parameters<ReturnType<typeof useUi.getState>["navigate"]>[0] }[] = [
  { label: "Home", icon: <Home size={18} />, route: { name: "home" } },
  { label: "Songs", icon: <Music2 size={18} />, route: { name: "library", tab: "songs" } },
  { label: "Albums", icon: <AlbumIcon size={18} />, route: { name: "library", tab: "albums" } },
  { label: "Artists", icon: <Users size={18} />, route: { name: "library", tab: "artists" } },
  { label: "Playlists", icon: <ListMusic size={18} />, route: { name: "library", tab: "playlists" } },
  { label: "Liked songs", icon: <Heart size={18} />, route: { name: "library", tab: "favorites" } },
  { label: "Now Playing", icon: <Mic2 size={18} />, route: { name: "lyrics" } },
];

export function Sidebar() {
  const route = useUi(state => state.route);
  const navigate = useUi(state => state.navigate);
  const requestPlaylistCreate = useUi(state => state.requestPlaylistCreate);
  const playlists = useLibrary(state => state.snapshot?.playlists ?? EMPTY_PLAYLISTS);
  const counts = useLibrary(state => state.snapshot?.counts);

  const isActive = (candidate: (typeof NAV)[number]["route"]) => {
    if (candidate.name !== route.name) return false;
    if (candidate.name === "library" && route.name === "library") {
      return candidate.tab === route.tab;
    }
    return true;
  };

  const navRef = useRef<HTMLElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);

  /**
   * One pill slides between nav items instead of each item fading its own background in. The DOM is
   * measured here — on navigation and on resize, never per frame — and the `.active` class stays
   * the single source of truth for which item the pill belongs to.
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
    if (instant) pill.dataset.instant = "true";
    pill.style.height = `${button.offsetHeight}px`;
    pill.style.transform = `translateY(${button.offsetTop}px)`;
    pill.classList.add("is-visible");
    nav.dataset.pill = "ready";
    if (instant) {
      // Flush the measured position with transitions off, then let later moves animate.
      void pill.offsetHeight;
      delete pill.dataset.instant;
    }
    // Stable on purpose: rebuilding the resize observer on every navigation would fire its initial
    // callback immediately and cancel the very transition it was about to animate.
  }, []);

  useLayoutEffect(() => {
    placePill(navRef.current?.dataset.pill !== "ready");
  }, [placePill, route]);

  // The nav can move under the pill without a route change: a resized window, a compact sidebar, or
  // playlists appearing above the footer. Re-place instantly instead of sliding from a stale spot.
  useEffect(() => {
    const replace = () => placePill(true);
    window.addEventListener("resize", replace);
    const nav = navRef.current;
    const observer = nav ? new ResizeObserver(replace) : null;
    if (nav && observer) observer.observe(nav);
    return () => {
      window.removeEventListener("resize", replace);
      observer?.disconnect();
    };
  }, [placePill]);

  return (
    <aside className="sidebar">
      <div
        className="brand"
        onClick={() => navigate({ name: "home" })}
        role="button"
        tabIndex={0}
        onKeyDown={event => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          navigate({ name: "home" });
        }}
      >
        <span className="brand-mark">
          <Library size={19} />
        </span>
        <span className="brand-text">
          <strong>Cadence</strong>
          <em>local music · better lyrics</em>
        </span>
      </div>

      <nav className="nav" ref={navRef}>
        <span className="nav-pill" ref={pillRef} aria-hidden="true" />
        {NAV.map(item => (
          <button
            type="button"
            key={item.label}
            className={`nav-item ${isActive(item.route) ? "active" : ""}`}
            onClick={() => navigate(item.route)}
            title={item.label}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-heading">
          <span>Playlists</span>
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
            >
              {playlist.name}
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
        >
          <Settings size={18} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

export type { LibraryTab };
