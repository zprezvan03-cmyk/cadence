/**
 * Navigation sidebar. Written for Cadence.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Album as AlbumIcon,
  ChartColumn,
  ChevronDown,
  Clock3,
  Heart,
  Home,
  History,
  AudioLines,
  Library,
  ListMusic,
  Music2,
  Plus,
  Settings,
  Users,
} from "lucide-react";
import { EMPTY_PLAYLISTS, useLibrary } from "../state/libraryStore";
import { useSettings } from "../state/settingsStore";
import { useUi, type Route } from "../state/uiStore";
import { SidebarTools } from "./SidebarTools";
import { useSessionState } from "./useSessionState";
import { MarqueeText } from "../components/MarqueeText";

type Destination = { label: string; icon: ReactNode; route: Route };
const LISTEN: Destination[] = [
  { label: "Home", icon: <Home size={18} />, route: { name: "home" } },
  { label: "History", icon: <History size={18} />, route: { name: "history" } },
  { label: "Stats", icon: <ChartColumn size={18} />, route: { name: "stats" } },
];
const LIBRARY: Destination[] = [
  { label: "Recently Added", icon: <Clock3 size={16} />, route: { name: "library", tab: "recently-added" } },
  { label: "Artists", icon: <Users size={16} />, route: { name: "library", tab: "artists" } },
  { label: "Albums", icon: <AlbumIcon size={16} />, route: { name: "library", tab: "albums" } },
  { label: "Songs", icon: <Music2 size={16} />, route: { name: "library", tab: "songs" } },
];
const LIKED: Destination = { label: "Liked songs", icon: <Heart size={18} />, route: { name: "library", tab: "favorites" } };
const ALL_PLAYLISTS: Destination = { label: "All playlists", icon: <ListMusic size={16} />, route: { name: "library", tab: "playlists" } };

type SectionId = "library" | "playlists";

export function Sidebar({ showHistory = false }: { showHistory?: boolean }) {
  const route = useUi(state => state.route);
  const navigate = useUi(state => state.navigate);
  const requestPlaylistCreate = useUi(state => state.requestPlaylistCreate);
  const playlists = useLibrary(state => state.snapshot?.playlists ?? EMPTY_PLAYLISTS);
  const counts = useLibrary(state => state.snapshot?.counts);

  const isActive = (candidate: Route) => {
    // Keep the parent collection identifiable while browsing its detail page.
    if (candidate.name === "library") {
      if (route.name === "album") return candidate.tab === "albums";
      if (route.name === "artist") return candidate.tab === "artists";
    }
    if (candidate.name !== route.name) return false;
    if (candidate.name === "library" && route.name === "library") {
      return candidate.tab === route.tab;
    }
    if (candidate.name === "playlist" && route.name === "playlist") return candidate.playlistId === route.playlistId;
    return true;
  };

  const inLibrary = LIBRARY.some(item => isActive(item.route));
  const inPlaylists = route.name === "playlist" || isActive(ALL_PLAYLISTS.route);
  const [libraryOpen, setLibraryOpen] = useSessionState("sidebar.library-open", true);
  const [playlistsOpen, setPlaylistsOpen] = useSessionState("sidebar.playlists-open", false);
  const compact = useSettings(state => state.settings?.appearance.compactSidebar ?? false);
  const hoverExpand = useSettings(state => state.settings?.appearance.compactSidebarHoverExpand ?? true);
  // A collapsed compact rail cannot reveal nested destinations, and without hover expansion it
  // has no other way to widen. Pin both disclosures open in that combination so every destination
  // is one peek away; the remembered user state is left untouched for when either setting changes.
  const sectionsAlwaysOpen = compact && !hoverExpand;
  const libraryExpanded = sectionsAlwaysOpen || libraryOpen;
  const playlistsExpanded = sectionsAlwaysOpen || playlistsOpen;
  // The section toggle only widens the rail in this mode; the disclosure itself stays open.
  const [peek, setPeek] = useState<SectionId | null>(null);
  const peeking = sectionsAlwaysOpen && peek !== null;
  const sidebarRef = useRef<HTMLElement | null>(null);
  // Deep links and browser history reveal the destination. The disclosure is still free to
  // collapse while looking at that same page; it does not change the route.
  const routeKey = route.name === "library" ? route.tab : route.name === "playlist" ? route.playlistId : route.name;
  useLayoutEffect(() => {
    setPeek(null);
    // Pinned disclosures are already open; don't overwrite the preferences they will restore.
    if (sectionsAlwaysOpen) return;
    if (inLibrary) setLibraryOpen(true);
    if (inPlaylists) setPlaylistsOpen(true);
  }, [routeKey, inLibrary, inPlaylists, sectionsAlwaysOpen, setLibraryOpen, setPlaylistsOpen]);

  useEffect(() => {
    if (!sectionsAlwaysOpen) setPeek(null);
  }, [sectionsAlwaysOpen]);

  useEffect(() => {
    if (!peek) return;
    const dismissPointer = (event: PointerEvent) => {
      if (sidebarRef.current?.contains(event.target as Node)) return;
      setPeek(null);
    };
    const dismissKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPeek(null);
    };
    document.addEventListener("pointerdown", dismissPointer, true);
    document.addEventListener("keydown", dismissKey);
    return () => {
      document.removeEventListener("pointerdown", dismissPointer, true);
      document.removeEventListener("keydown", dismissKey);
    };
  }, [peek]);

  const toggleSection = (id: SectionId, open: boolean, setOpen: (open: boolean) => void) => {
    if (sectionsAlwaysOpen) {
      // The disclosure is pinned open, so this button only widens or dismisses the rail.
      setPeek(current => (current === id ? null : id));
      return;
    }
    setOpen(!open);
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
    let button = nav.querySelector<HTMLButtonElement>(".nav-item.active");
    // Compact rails clip nested destinations. Park the pill on the section toggle so the rail still
    // shows where the current page lives instead of measuring a hidden child. Skip this during a
    // peek expansion, where the content starts at zero height but is already becoming visible.
    if (button) {
      const content = button.closest<HTMLElement>(".nav-section-content");
      const collapsed = content?.offsetHeight === 0 && !sidebarRef.current?.classList.contains("is-compact-peek");
      if (button.offsetParent === null || collapsed) {
        button = button.closest(".nav-section")?.querySelector<HTMLButtonElement>(".nav-section-toggle") ?? null;
      }
    }
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
    pill.dataset.nested = String(Boolean(button.closest(".nav-section-content")));
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

  useLayoutEffect(measureSlots, [measureSlots, libraryExpanded, playlistsExpanded, playlists, peek]);
  useLayoutEffect(() => {
    placePill(navRef.current?.dataset.pill !== "ready");
  }, [placePill, route, libraryExpanded, playlistsExpanded, playlists, peek]);

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
    <aside ref={sidebarRef} className={`sidebar${peeking ? " is-compact-peek" : ""}`}>
      <button type="button" className="brand" onClick={() => navigate({ name: "home" })} aria-label="Cadence home">
        <span className="brand-mark" aria-hidden="true"><AudioLines size={20} /></span>
        <span className="brand-text"><strong>Cadence</strong></span>
      </button>

      <SidebarTools showHistory={showHistory} />

      <div className="sidebar-scroll">
        <nav className="nav" aria-label="Music navigation" ref={navRef}>
          <span className="nav-pill" ref={pillRef} aria-hidden="true" />
          <p className="nav-group" aria-hidden="true">Listen</p>
          {LISTEN.map(item => <NavEntry key={item.label} item={item} active={isActive(item.route)} navigate={navigate} />)}
          <NavSection id="library" icon={<Library size={18} />} label="Library" current={inLibrary} open={libraryExpanded} onToggle={() => toggleSection("library", libraryOpen, setLibraryOpen)}>
            {LIBRARY.map(item => <NavEntry key={item.label} item={item} active={libraryExpanded && isActive(item.route)} navigate={navigate} />)}
          </NavSection>
          <NavEntry item={LIKED} active={isActive(LIKED.route)} navigate={navigate} />
          <NavSection id="playlists" icon={<ListMusic size={18} />} label="Playlists" current={inPlaylists} open={playlistsExpanded} onToggle={() => toggleSection("playlists", playlistsOpen, setPlaylistsOpen)}>
            <NavEntry item={ALL_PLAYLISTS} active={playlistsExpanded && isActive(ALL_PLAYLISTS.route)} navigate={navigate} />
            {playlists.map(playlist => {
              const item: Destination = { label: playlist.name, icon: <ListMusic size={16} />, route: { name: "playlist", playlistId: playlist.id } };
              return <NavEntry key={playlist.id} item={item} active={playlistsExpanded && isActive(item.route)} navigate={navigate} className="sidebar-link" />;
            })}
            <button type="button" className="nav-item" onClick={requestPlaylistCreate} aria-label="New playlist" title="New playlist">
              <Plus size={16} /> <span>New playlist</span>
            </button>
          </NavSection>
        </nav>
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

function NavSection({ id, label, icon, current, open, onToggle, children }: {
  id: string;
  label: string;
  icon: ReactNode;
  current: boolean;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="nav-section">
      <button
        type="button"
        className={`nav-item nav-section-toggle ${current && !open ? "active" : ""}`}
        aria-expanded={open}
        aria-controls={`sidebar-${id}`}
        aria-label={label}
        title={label}
        onClick={onToggle}
      >
        {icon}<MarqueeText>{label}</MarqueeText><ChevronDown size={14} className="nav-chevron" aria-hidden="true" />
      </button>
      <div className="nav-section-content" id={`sidebar-${id}`} data-open={open} inert={!open} aria-hidden={!open}>
        <div className="nav-section-inner">{children}</div>
      </div>
    </div>
  );
}

function NavEntry({ item, active, navigate, className = "" }: {
  item: Destination;
  active: boolean;
  navigate: ReturnType<typeof useUi.getState>["navigate"];
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`nav-item ${active ? "active" : ""} ${className}`}
      onClick={() => navigate(item.route)}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? "location" : undefined}
    >
      {item.icon}
      <MarqueeText>{item.label}</MarqueeText>
    </button>
  );
}
