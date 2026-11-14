/**
 * Touch-friendly mobile top bar and bottom navigation bar for Android and narrow
 * phone viewports. Written for Cadence.
 */

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Clock3,
  Home,
  Library,
  Loader2,
  Mic2,
  Music2,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useLibrary } from "../state/libraryStore";
import { useUi, type Route } from "../state/uiStore";
import { FetchAllIndicator } from "../features/lyrics-fetch/FetchAllIndicator";

function routeTitle(route: Route): string {
  switch (route.name) {
    case "home":
      return "Cadence";
    case "library":
      switch (route.tab) {
        case "albums":
          return "Albums";
        case "artists":
          return "Artists";
        case "playlists":
          return "Playlists";
        case "favorites":
          return "Liked songs";
        default:
          return "Library";
      }
    case "search":
      return "Search";
    case "album":
      return "Album";
    case "artist":
      return "Artist";
    case "playlist":
      return "Playlist";
    case "lyrics":
      return "Now Playing";
    case "history":
      return "History";
    case "stats":
      return "Stats";
    case "decode-tester":
      return "Decode Tester";
    case "settings":
      return "Settings";
  }
}

export function MobileHeader() {
  const route = useUi(state => state.route);
  const navigate = useUi(state => state.navigate);
  const goBack = useUi(state => state.goBack);
  const scanning = useLibrary(state => state.scanning);
  const scan = useLibrary(state => state.snapshot?.scan);
  const [query, setQuery] = useState(route.name === "search" ? route.query : "");

  useEffect(() => {
    if (route.name === "search") setQuery(route.query);
  }, [route]);

  const showBack = route.name !== "home" && route.name !== "library" && route.name !== "search";

  return (
    <header className="mobile-header" data-testid="mobile-header">
      <div className="mobile-header-left">
        {showBack ? (
          <button
            type="button"
            className="icon-button mobile-icon-btn"
            onClick={() => {
              const prevHash = window.location.hash;
              goBack();
              window.setTimeout(() => {
                if (window.location.hash === prevHash && useUi.getState().route.name !== "home") {
                  navigate({ name: "home" });
                }
              }, 80);
            }}
            aria-label="Back"
          >
            <ArrowLeft size={20} />
          </button>
        ) : (
          <span className="mobile-brand-mark" aria-hidden="true">
            <Music2 size={17} />
          </span>
        )}
      </div>

      {route.name === "search" ? (
        <form
          className="mobile-search-form"
          onSubmit={event => {
            event.preventDefault();
            navigate({ name: "search", query: query.trim() });
          }}
        >
          <Search size={16} />
          <input
            type="search"
            aria-label="Search library"
            placeholder="Songs, artists, albums"
            value={query}
            onChange={event => {
              const value = event.target.value;
              setQuery(value);
              navigate({ name: "search", query: value });
            }}
          />
          {query ? (
            <button
              type="button"
              className="icon-button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                navigate({ name: "search", query: "" });
              }}
            >
              <X size={15} />
            </button>
          ) : null}
        </form>
      ) : (
        <h1 className="mobile-header-title">{routeTitle(route)}</h1>
      )}

      <div className="mobile-header-actions">
        <FetchAllIndicator />
        {scanning || scan?.running ? (
          <span className="mobile-scan-badge" title={scan?.message ?? "Scanning"}>
            <Loader2 size={16} className="spin" />
          </span>
        ) : null}
        {route.name !== "history" ? (
          <button
            type="button"
            className="icon-button mobile-icon-btn"
            aria-label="Listening history"
            onClick={() => navigate({ name: "history" })}
          >
            <Clock3 size={19} />
          </button>
        ) : null}
        {route.name !== "settings" ? (
          <button
            type="button"
            className="icon-button mobile-icon-btn"
            aria-label="Settings"
            data-testid="mobile-open-settings"
            onClick={() => navigate({ name: "settings" })}
          >
            <Settings size={19} />
          </button>
        ) : null}
      </div>
    </header>
  );
}

export function MobileBottomNav() {
  const route = useUi(state => state.route);
  const navigate = useUi(state => state.navigate);

  const items = [
    {
      id: "home",
      label: "Home",
      icon: Home,
      active: route.name === "home",
      onClick: () => navigate({ name: "home" }),
    },
    {
      id: "search",
      label: "Search",
      icon: Search,
      active: route.name === "search",
      onClick: () => navigate({ name: "search", query: route.name === "search" ? route.query : "" }),
    },
    {
      id: "library",
      label: "Library",
      icon: Library,
      active:
        route.name === "library" ||
        route.name === "album" ||
        route.name === "artist" ||
        route.name === "playlist",
      onClick: () => navigate({ name: "library", tab: "songs" }),
    },
    {
      id: "lyrics",
      label: "Lyrics",
      icon: Mic2,
      active: route.name === "lyrics",
      onClick: () => navigate({ name: "lyrics" }),
    },
  ] as const;

  return (
    <nav className="mobile-bottom-nav" aria-label="Primary navigation" data-testid="mobile-bottom-nav">
      {items.map(item => {
        const Icon = item.icon;
        return (
          <button
            type="button"
            key={item.id}
            className={`mobile-nav-tab ${item.active ? "active" : ""}`}
            aria-current={item.active ? "page" : undefined}
            data-testid={`mobile-nav-${item.id}`}
            onClick={item.onClick}
          >
            <span className="mobile-nav-pill">
              <Icon size={20} />
            </span>
            <span className="mobile-nav-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
