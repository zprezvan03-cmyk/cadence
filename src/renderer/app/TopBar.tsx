/**
 * Top bar with navigation history, global search and library actions. Written for Cadence.
 */

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, FolderPlus, Loader2, Search, X } from "lucide-react";
import { useLibrary } from "../state/libraryStore";
import { useUi } from "../state/uiStore";
import { FetchAllIndicator } from "../features/lyrics-fetch/FetchAllIndicator";

export function TopBar() {
  const navigate = useUi(state => state.navigate);
  const goBack = useUi(state => state.goBack);
  const goForward = useUi(state => state.goForward);
  const route = useUi(state => state.route);
  const scanning = useLibrary(state => state.scanning);
  const addFolder = useLibrary(state => state.addFolder);
  const scan = useLibrary(state => state.snapshot?.scan);
  const [query, setQuery] = useState(route.name === "search" ? route.query : "");

  useEffect(() => {
    if (route.name === "search") setQuery(route.query);
  }, [route]);

  return (
    <header className="top-bar">
      <div className="history-buttons">
        <button type="button" className="icon-button" onClick={goBack} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <button type="button" className="icon-button" onClick={goForward} aria-label="Forward">
          <ArrowRight size={18} />
        </button>
      </div>

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
          placeholder="Search songs, artists and albums"
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
        ) : null}
      </form>

      <div className="top-actions">
        <FetchAllIndicator />
        {scanning || scan?.running ? (
          <span className="scan-indicator" title={scan?.message}>
            <Loader2 size={15} className="spin" />
            {scan ? `${scan.filesProcessed}/${scan.filesSeen || "?"}` : "Scanning"}
          </span>
        ) : null}
        <button type="button" className="ghost-button" onClick={() => void addFolder()} disabled={scanning}>
          <FolderPlus size={16} /> Add music
        </button>
      </div>
    </header>
  );
}
