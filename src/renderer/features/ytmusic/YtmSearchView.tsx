/**
 * YouTube Music search inside Cadence: music-oriented categories (All / Songs / Videos / Albums /
 * Artists / Playlists), live suggestions, search history, continuation-based load-more, and
 * explicit loading / error / empty states. Results are real InnerTube music results — never a
 * relabelled generic YouTube video search.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { YTM_SEARCH_FILTERS, YTM_SEARCH_FILTER_LABELS, type YtmSearchFilter, type YtmTrack } from "../../../shared/ytmusic";
import { useYtm } from "../../state/ytmusicStore";
import { useUi } from "../../state/uiStore";
import { usePlayer, currentSource } from "../../state/playerStore";
import { YtmCardGrid, YtmTrackList, trackToItem } from "./YtmItems";

export function YtmSearchView({ query }: { query: string }) {
  const searchState = useYtm(state => state.searchState);
  const performSearch = useYtm(state => state.performSearch);
  const setFilter = useYtm(state => state.setFilter);
  const loadMoreSearch = useYtm(state => state.loadMoreSearch);
  const suggestions = useYtm(state => state.suggestions);
  const fetchSuggestions = useYtm(state => state.fetchSuggestions);
  const searchHistory = useYtm(state => state.searchHistory);
  const navigate = useUi(state => state.navigate);
  const [input, setInput] = useState(query);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const currentVideoId = usePlayer(state => {
    const source = currentSource(state);
    return source && source.kind === "youtube-music" ? source.remoteId : null;
  });
  const isPlaying = usePlayer(state => state.isPlaying);

  // A route change (back/forward, suggestion click) re-runs the search for that query.
  useEffect(() => {
    setInput(query);
    if (query.trim() && (searchState.query !== query.trim() || searchState.status === "idle")) {
      void performSearch(query.trim(), searchState.filter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Debounced live suggestions while typing.
  useEffect(() => {
    const trimmed = input.trim();
    if (!trimmed || !suggestionsOpen) return;
    const handle = setTimeout(() => void fetchSuggestions(trimmed), 180);
    return () => clearTimeout(handle);
  }, [input, suggestionsOpen, fetchSuggestions]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setSuggestionsOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const results = searchState.data;
  const resultTracks: YtmTrack[] = useMemo(
    () =>
      (results?.items ?? [])
        .filter((item): item is { type: "song" | "video"; track: YtmTrack } => item.type === "song" || item.type === "video")
        .map(item => item.track),
    [results],
  );
  const resultCards = useMemo(() => (results?.items ?? []).filter(item => item.type !== "song" && item.type !== "video"), [results]);
  const showTracks = searchState.filter === "all" || searchState.filter === "songs" || searchState.filter === "videos";

  const submit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSuggestionsOpen(false);
    navigate({ name: "ytm-search", query: trimmed });
    void performSearch(trimmed, searchState.filter);
  };

  return (
    <div className="view ytm-view" data-testid="ytm-search-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">YouTube Music</p>
          <h1>Search</h1>
        </div>
      </header>

      <div className="ytm-search-box" ref={boxRef}>
        <form
          className="global-search"
          onSubmit={event => {
            event.preventDefault();
            submit(input);
          }}
        >
          <Search size={17} />
          <input
            type="search"
            aria-label="Search YouTube Music"
            placeholder="Search songs, albums, artists, playlists"
            value={input}
            data-testid="ytm-search-input"
            onChange={event => {
              setInput(event.target.value);
              setSuggestionsOpen(true);
            }}
            onFocus={() => setSuggestionsOpen(true)}
          />
          {input ? (
            <button type="button" className="icon-button" aria-label="Clear" onClick={() => setInput("")}>
              <X size={15} />
            </button>
          ) : null}
        </form>
        {suggestionsOpen && (suggestions.items.queries.length > 0 || suggestions.items.items.length > 0) ? (
          <div className="ytm-suggestions" data-testid="ytm-suggestions">
            {suggestions.items.queries.map(text => (
              <button key={text} type="button" className="ytm-suggestion" onClick={() => submit(text)}>
                <Search size={13} /> {text}
              </button>
            ))}
            {suggestions.items.items.map(item => {
              if (item.type === "song" || item.type === "video") {
                const track = item.track;
                return (
                  <button
                    key={track.videoId}
                    type="button"
                    className="ytm-suggestion"
                    onClick={() => void usePlayer.getState().playMediaItem(trackToItem(track))}
                  >
                    {track.title} <span className="muted">— {track.artists.map(a => a.name).join(", ")}</span>
                  </button>
                );
              }
              const label = item.type === "album" ? item.album.title : item.type === "artist" ? item.artist.name : item.playlist.title;
              const key = item.type === "album" ? item.album.browseId : item.type === "artist" ? item.artist.browseId : item.playlist.id;
              return (
                <button
                  key={key}
                  type="button"
                  className="ytm-suggestion"
                  onClick={() => {
                    if (item.type === "album") navigate({ name: "ytm-album", albumId: item.album.browseId });
                    else if (item.type === "artist") navigate({ name: "ytm-artist", artistId: item.artist.browseId });
                    else navigate({ name: "ytm-playlist", playlistId: item.playlist.id });
                  }}
                >
                  {label} <span className="muted">({item.type})</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {suggestionsOpen && !input.trim() && searchHistory.length > 0 ? (
          <div className="ytm-suggestions" data-testid="ytm-search-history">
            {searchHistory.map(text => (
              <button key={text} type="button" className="ytm-suggestion" onClick={() => submit(text)}>
                <Search size={13} /> {text}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="ytm-chip-row" data-testid="ytm-search-filters">
        {YTM_SEARCH_FILTERS.map(filter => (
          <button
            key={filter}
            type="button"
            className={`ytm-chip${searchState.filter === filter ? " selected" : ""}`}
            data-testid={`ytm-filter-${filter}`}
            onClick={() => void setFilter(filter)}
          >
            {YTM_SEARCH_FILTER_LABELS[filter]}
          </button>
        ))}
      </div>

      {searchState.status === "loading" ? (
        <div className="view-loading" data-testid="ytm-search-loading">
          <Loader2 size={16} className="spin" /> Searching YouTube Music…
        </div>
      ) : null}

      {searchState.status === "error" ? (
        <div className="empty-state" data-testid="ytm-search-error">
          <p>Search failed.</p>
          <p className="muted">{searchState.error}</p>
          <button type="button" className="primary" onClick={() => void performSearch(searchState.query, searchState.filter)}>
            Retry
          </button>
        </div>
      ) : null}

      {searchState.status === "ready" && results && results.items.length === 0 ? (
        <div className="empty-state" data-testid="ytm-search-empty">
          No results for “{searchState.query}” in {YTM_SEARCH_FILTER_LABELS[searchState.filter].toLowerCase()}.
        </div>
      ) : null}

      {results?.topResult ? (
        <section className="shelf" data-testid="ytm-top-result">
          <div className="shelf-heading"><h2>Top result</h2></div>
          <YtmCardGrid items={[results.topResult]} />
        </section>
      ) : null}

      {showTracks && resultTracks.length > 0 ? (
        <section className="shelf">
          <div className="shelf-heading"><h2>{YTM_SEARCH_FILTER_LABELS[searchState.filter]}</h2></div>
          <YtmTrackList tracks={resultTracks} activeVideoId={currentVideoId} playingVideoId={isPlaying ? currentVideoId : null} />
        </section>
      ) : null}

      {resultCards.length > 0 ? (
        <section className="shelf">
          <div className="shelf-heading"><h2>{YTM_SEARCH_FILTER_LABELS[searchState.filter]}</h2></div>
          <YtmCardGrid items={resultCards} />
        </section>
      ) : null}

      {searchState.status === "ready" && searchState.continuation ? (
        <button type="button" className="ghost-button" disabled={searchState.loadingMore} onClick={() => void loadMoreSearch()} data-testid="ytm-search-more">
          {searchState.loadingMore ? <Loader2 size={14} className="spin" /> : null} Load more results
        </button>
      ) : null}
    </div>
  );
}
