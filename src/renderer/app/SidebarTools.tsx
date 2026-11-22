/**
 * Global search, navigation fallback and library status in the sidebar. Written for Cadence.
 */

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Loader2, Search, X } from "lucide-react";
import { useLibrary } from "../state/libraryStore";
import { useUi } from "../state/uiStore";

export function SidebarTools({ showHistory = false }: { showHistory?: boolean }) {
  const navigate = useUi(state => state.navigate);
  const goBack = useUi(state => state.goBack);
  const goForward = useUi(state => state.goForward);
  const route = useUi(state => state.route);
  const scanning = useLibrary(state => state.scanning);
  const scan = useLibrary(state => state.snapshot?.scan);
  const [query, setQuery] = useState(route.name === "search" ? route.query : "");

  useEffect(() => {
    setQuery(route.name === "search" ? route.query : "");
  }, [route]);

  return (
    <div className="sidebar-tools">
      <form
        className="global-search"
        onSubmit={event => {
          event.preventDefault();
          const trimmed = query.trim();
          if (trimmed) navigate({ name: "search", query: trimmed });
        }}
      >
        <Search size={17} />
        <input
          id="global-search"
          type="search"
          placeholder="Search your library"
          aria-label="Search your library"
          value={query}
          onChange={event => {
            const value = event.target.value;
            setQuery(value);
            // Typing searches immediately; SearchView debounces the IPC call itself.
            navigate(value.trim() ? { name: "search", query: value } : { name: "home" });
          }}
        />
        {query ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              if (route.name === "search") navigate({ name: "home" });
            }}
          >
            <X size={15} />
          </button>
        ) : <kbd className="search-shortcut" aria-hidden="true">Ctrl K</kbd>}
      </form>

      {showHistory ? (
        <div className="history-buttons">
          <button type="button" className="icon-button" onClick={goBack} aria-label="Back" title="Back">
            <ArrowLeft size={16} />
          </button>
          <button type="button" className="icon-button" onClick={goForward} aria-label="Forward" title="Forward">
            <ArrowRight size={16} />
          </button>
        </div>
      ) : null}
      {scanning || scan?.running ? (
        <span className="scan-indicator" role="status" title={scan?.message ?? "Scanning library"}>
          <Loader2 size={15} className="spin" />
          <span>{scan ? `${scan.filesProcessed}/${scan.filesSeen || "?"}` : "Scanning"}</span>
        </span>
      ) : null}
    </div>
  );
}
