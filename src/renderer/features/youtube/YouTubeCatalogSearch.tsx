/**
 * Integrated YouTube section for Cadence's existing Search view.
 *
 * Local results render first and are not delayed by this component. Remote search is lazy,
 * debounced and tab-scoped because every Data API `search.list` call consumes the user's own
 * limited daily search quota. Results are labelled as videos/channels/playlists—not native
 * YouTube Music songs/albums/artists.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, KeyRound, Link2, ListMusic, Play, RotateCcw, UserRound } from "lucide-react";
import { youtubeMediaItem } from "../../../shared/media";
import type {
  CatalogPage,
  MediaItem,
  YouTubeCatalogError,
  YouTubeCatalogResult,
  YouTubeCatalogSearchOrder,
  YouTubeChannelItem,
  YouTubePlaylistSummary,
} from "../../../shared/types";
import { parseYouTubeLink } from "../../../shared/youtube";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import {
  searchYouTubeAlbumCollections,
  searchYouTubeChannels,
  searchYouTubeMusicVideos,
  searchYouTubePlaylists,
} from "./catalogApi";
import {
  CatalogSkeletonRows,
  RemoteTrackList,
  YouTubeChannelCard,
  YouTubePlaylistCard,
  openRemoteMediaItem,
} from "./RemoteMediaItems";

type CatalogTab = "videos" | "channels" | "albums" | "playlists";

interface PageState<T> {
  items: T[];
  nextPageToken: string | null;
  totalResults: number | null;
  loading: boolean;
  loadingMore: boolean;
  error: YouTubeCatalogError | null;
}

const initialPage = <T,>(): PageState<T> => ({
  items: [],
  nextPageToken: null,
  totalResults: null,
  loading: true,
  loadingMore: false,
  error: null,
});

function useCatalogPage<T>(
  fetchPage: (pageToken: string | null) => Promise<YouTubeCatalogResult<CatalogPage<T>>>,
  resetKey: string
) {
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const generationRef = useRef(0);
  const [state, setState] = useState<PageState<T>>(() => initialPage<T>());

  const load = useCallback(async (pageToken: string | null, append: boolean) => {
    const generation = ++generationRef.current;
    setState(previous => ({
      ...previous,
      loading: !append,
      loadingMore: append,
      error: null,
      items: append ? previous.items : [],
      nextPageToken: append ? previous.nextPageToken : null,
    }));
    const result = await fetchRef.current(pageToken);
    if (generationRef.current !== generation) return;
    if (!result.ok) {
      if (result.error.kind === "aborted") return;
      setState(previous => ({
        ...previous,
        loading: false,
        loadingMore: false,
        error: result.error,
      }));
      return;
    }
    setState(previous => ({
      items: append ? [...previous.items, ...result.data.items] : result.data.items,
      nextPageToken: result.data.nextPageToken,
      totalResults: result.data.totalResults,
      loading: false,
      loadingMore: false,
      error: null,
    }));
  }, []);

  useEffect(() => {
    setState(initialPage<T>());
    void load(null, false);
    return () => {
      generationRef.current += 1;
    };
  }, [load, resetKey]);

  return {
    ...state,
    retry: () => void load(null, false),
    loadMore: () => {
      if (state.nextPageToken) void load(state.nextPageToken, true);
    },
  };
}

function CatalogErrorState({
  error,
  onRetry,
}: {
  error: YouTubeCatalogError;
  onRetry: () => void;
}) {
  const navigate = useUi(state => state.navigate);
  const needsSettings = ["disabled", "missing-key", "invalid-key", "api-not-enabled"].includes(
    error.kind
  );
  return (
    <div className="catalog-state error" role="alert" data-testid="youtube-catalog-error-state">
      <strong>YouTube catalog unavailable</strong>
      <p>{error.message}</p>
      <div className="heading-actions">
        {needsSettings ? (
          <button type="button" className="primary" onClick={() => navigate({ name: "settings" })}>
            <KeyRound size={15} /> Open catalog settings
          </button>
        ) : null}
        <button type="button" onClick={onRetry}>
          <RotateCcw size={15} /> Retry
        </button>
      </div>
    </div>
  );
}

function PageSummary({
  loaded,
  total,
  label,
}: {
  loaded: number;
  total: number | null;
  label: string;
}) {
  return (
    <p className="muted catalog-result-count" data-testid="youtube-catalog-result-count">
      {loaded.toLocaleString()} {label} loaded
      {total !== null ? ` · about ${total.toLocaleString()} total results` : ""}
    </p>
  );
}

function LoadMore({ visible, loading, onClick }: { visible: boolean; loading: boolean; onClick: () => void }) {
  if (!visible) return null;
  return (
    <div className="catalog-load-more">
      <button type="button" onClick={onClick} disabled={loading} data-testid="youtube-catalog-load-more">
        {loading ? "Loading…" : "Load more"}
      </button>
      <span>Each extra page uses another YouTube search-quota call.</span>
    </div>
  );
}

function VideoResults({
  query,
  order,
  resetKey,
}: {
  query: string;
  order: YouTubeCatalogSearchOrder;
  resetKey: string;
}) {
  const page = useCatalogPage<MediaItem>(
    pageToken => searchYouTubeMusicVideos({ query, pageToken, maxResults: 50, order }),
    resetKey
  );
  if (page.loading) return <CatalogSkeletonRows />;
  if (page.error) return <CatalogErrorState error={page.error} onRetry={page.retry} />;
  return (
    <>
      <PageSummary loaded={page.items.length} total={page.totalResults} label="music videos" />
      <RemoteTrackList
        items={page.items}
        testId="youtube-search-videos"
        emptyMessage="No embeddable YouTube music videos matched that search."
      />
      <LoadMore visible={Boolean(page.nextPageToken)} loading={page.loadingMore} onClick={page.loadMore} />
    </>
  );
}

function ChannelResults({
  query,
  order,
  resetKey,
}: {
  query: string;
  order: YouTubeCatalogSearchOrder;
  resetKey: string;
}) {
  const page = useCatalogPage<YouTubeChannelItem>(
    pageToken => searchYouTubeChannels({ query, pageToken, maxResults: 50, order }),
    resetKey
  );
  if (page.loading) return <CatalogSkeletonRows />;
  if (page.error) return <CatalogErrorState error={page.error} onRetry={page.retry} />;
  if (page.items.length === 0) {
    return <div className="empty-state">No YouTube channels matched that search.</div>;
  }
  return (
    <>
      <PageSummary loaded={page.items.length} total={page.totalResults} label="channels" />
      <div className="card-grid artist-grid" data-testid="youtube-search-channels">
        {page.items.map(channel => (
          <YouTubeChannelCard key={channel.id} channel={channel} />
        ))}
      </div>
      <LoadMore visible={Boolean(page.nextPageToken)} loading={page.loadingMore} onClick={page.loadMore} />
    </>
  );
}

function PlaylistResults({
  query,
  order,
  resetKey,
}: {
  query: string;
  order: YouTubeCatalogSearchOrder;
  resetKey: string;
}) {
  const page = useCatalogPage<YouTubePlaylistSummary>(
    pageToken => searchYouTubePlaylists({ query, pageToken, maxResults: 50, order }),
    resetKey
  );
  if (page.loading) return <CatalogSkeletonRows />;
  if (page.error) return <CatalogErrorState error={page.error} onRetry={page.retry} />;
  if (page.items.length === 0) {
    return <div className="empty-state">No public YouTube playlists matched that search.</div>;
  }
  return (
    <>
      <PageSummary loaded={page.items.length} total={page.totalResults} label="playlists" />
      <div className="card-grid" data-testid="youtube-search-playlists">
        {page.items.map(playlist => (
          <YouTubePlaylistCard key={playlist.id} playlist={playlist} />
        ))}
      </div>
      <LoadMore visible={Boolean(page.nextPageToken)} loading={page.loadingMore} onClick={page.loadMore} />
    </>
  );
}

function AlbumCollectionResults({
  query,
  order,
  resetKey,
}: {
  query: string;
  order: YouTubeCatalogSearchOrder;
  resetKey: string;
}) {
  const page = useCatalogPage<YouTubePlaylistSummary>(
    pageToken => searchYouTubeAlbumCollections({ query, pageToken, maxResults: 50, order }),
    resetKey
  );
  if (page.loading) return <CatalogSkeletonRows />;
  if (page.error) return <CatalogErrorState error={page.error} onRetry={page.retry} />;
  if (page.items.length === 0) {
    return (
      <div className="empty-state">
        No verified YouTube Music album collections were found in the scanned playlist results.
        The Data API has no native album search, so Cadence does not guess albums from titles.
      </div>
    );
  }
  return (
    <>
      <PageSummary loaded={page.items.length} total={null} label="verified album collections" />
      <div className="card-grid" data-testid="youtube-search-albums">
        {page.items.map(playlist => (
          <YouTubePlaylistCard key={playlist.id} playlist={playlist} />
        ))}
      </div>
      <LoadMore visible={Boolean(page.nextPageToken)} loading={page.loadingMore} onClick={page.loadMore} />
    </>
  );
}

function DirectLinkCard({ query }: { query: string }) {
  const navigate = useUi(state => state.navigate);
  const link = parseYouTubeLink(query);
  if (!link) return null;

  if (link.kind === "video") {
    const item = youtubeMediaItem({
      videoId: link.videoId,
      sourceKind: link.sourceKind,
      title: `${link.sourceKind === "youtube-music" ? "YouTube Music" : "YouTube"} video ${link.videoId}`,
      artistLabel: "",
      artworkUrl: `https://i.ytimg.com/vi/${link.videoId}/hqdefault.jpg`,
      availability: "unknown",
    });
    return (
      <div className="catalog-direct-link" data-testid="youtube-direct-link">
        <span className="catalog-direct-icon">
          <Link2 size={19} />
        </span>
        <span>
          <strong>Open this {link.sourceKind === "youtube-music" ? "YouTube Music" : "YouTube"} link</strong>
          <em>It will open in Cadence’s main Now Playing with the official visible player. No API search quota is used.</em>
        </span>
        <span className="heading-actions">
          {link.playlistId ? (
            <button
              type="button"
              onClick={() => navigate({ name: "youtube-playlist", playlistId: link.playlistId! })}
            >
              <ListMusic size={15} /> Playlist
            </button>
          ) : null}
          <button type="button" className="primary" onClick={() => openRemoteMediaItem(item)}>
            <Play size={15} /> Open video
          </button>
        </span>
      </div>
    );
  }

  if (link.kind === "playlist") {
    return (
      <div className="catalog-direct-link" data-testid="youtube-direct-link">
        <span className="catalog-direct-icon">
          <ListMusic size={19} />
        </span>
        <span>
          <strong>Open this public YouTube playlist</strong>
          <em>Cadence will load its public videos with your Data API key.</em>
        </span>
        <button
          type="button"
          className="primary"
          onClick={() => navigate({ name: "youtube-playlist", playlistId: link.playlistId })}
        >
          Open playlist <ArrowRight size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="catalog-direct-link" data-testid="youtube-direct-link">
      <span className="catalog-direct-icon">
        <UserRound size={19} />
      </span>
      <span>
        <strong>Open this YouTube channel</strong>
        <em>Cadence will load the channel’s public uploads and playlists.</em>
      </span>
      <button
        type="button"
        className="primary"
        onClick={() => navigate({ name: "youtube-channel", channelId: link.channelId })}
      >
        Open channel <ArrowRight size={15} />
      </button>
    </div>
  );
}

export function YouTubeCatalogSearch({ query }: { query: string }) {
  const settings = useSettings(state => state.settings);
  const navigate = useUi(state => state.navigate);
  const [activeTab, setActiveTab] = useState<CatalogTab>("videos");
  const [searchOrder, setSearchOrder] = useState<YouTubeCatalogSearchOrder>("relevance");
  const [debouncedQuery, setDebouncedQuery] = useState(() => query.trim());

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 650);
    return () => window.clearTimeout(timer);
  }, [query]);

  const directLink = parseYouTubeLink(query);
  const catalogSettings = settings?.youtubeCatalog;
  const configured = Boolean(catalogSettings?.enabled && catalogSettings.apiKey);
  const resetKey = `${debouncedQuery}\u0000${searchOrder}\u0000${catalogSettings?.region ?? ""}\u0000${catalogSettings?.enabled ? "on" : "off"}`;

  return (
    <section className="shelf remote-search-section" data-testid="youtube-catalog-search">
      <div className="shelf-heading">
        <div>
          <p className="eyebrow">Online catalog</p>
          <h2>YouTube</h2>
        </div>
        <span className="muted">Public data · no YouTube account</span>
      </div>

      <DirectLinkCard query={query} />

      {!settings ? (
        <CatalogSkeletonRows count={3} />
      ) : !configured ? (
        directLink?.kind === "video" ? (
          <p className="muted catalog-setup-note">
            Direct video links work without a key. Add a Data API key to search the public
            catalog and open channel/playlist details.
          </p>
        ) : (
          <div className="catalog-state setup" data-testid="youtube-catalog-setup">
            <span className="catalog-direct-icon">
              <KeyRound size={19} />
            </span>
            <span>
              <strong>Add your YouTube Data API key to search online</strong>
              <em>
                Cadence ships no shared key and never asks you to sign in to Google. Your local
                results above remain fully available without one.
              </em>
            </span>
            <button type="button" className="primary" onClick={() => navigate({ name: "settings" })}>
              Set up catalog
            </button>
          </div>
        )
      ) : directLink ? (
        <p className="muted catalog-setup-note">
          Cadence recognized a direct YouTube link, so no search-quota call was made.
        </p>
      ) : debouncedQuery.length < 2 ? (
        <div className="empty-state">Type at least two characters to search YouTube.</div>
      ) : (
        <>
          <div className="catalog-search-controls">
            <nav className="catalog-tabs" aria-label="YouTube search type">
              {(
                [
                  ["videos", "Music videos"],
                  ["channels", "Channels"],
                  ["albums", "Album collections"],
                  ["playlists", "Public playlists"],
                ] as [CatalogTab, string][]
              ).map(([tab, label]) => (
                <button
                  type="button"
                  key={tab}
                  className={activeTab === tab ? "active" : ""}
                  data-testid={`youtube-search-tab-${tab}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <label className="catalog-order-control">
              <span>Order</span>
              <select
                value={searchOrder}
                data-testid="youtube-search-order"
                onChange={event => setSearchOrder(event.target.value as YouTubeCatalogSearchOrder)}
              >
                <option value="relevance">Relevance</option>
                <option value="date">Newest</option>
                <option value="viewCount">Most viewed</option>
                <option value="rating">Highest rated</option>
                <option value="title">Title</option>
              </select>
            </label>
          </div>
          <p className="muted catalog-search-note">
            The official Data API returns videos, channels and public playlists. “Album
            collections” only includes playlists in YouTube Music’s verified album-playlist ID
            namespace; Cadence does not invent native album objects or account library items.
          </p>
          {query.trim() !== debouncedQuery ? (
            <CatalogSkeletonRows count={3} />
          ) : activeTab === "videos" ? (
            <VideoResults key={`videos:${resetKey}`} query={debouncedQuery} order={searchOrder} resetKey={resetKey} />
          ) : activeTab === "channels" ? (
            <ChannelResults key={`channels:${resetKey}`} query={debouncedQuery} order={searchOrder} resetKey={resetKey} />
          ) : activeTab === "albums" ? (
            <AlbumCollectionResults key={`albums:${resetKey}`} query={debouncedQuery} order={searchOrder} resetKey={resetKey} />
          ) : (
            <PlaylistResults key={`playlists:${resetKey}`} query={debouncedQuery} order={searchOrder} resetKey={resetKey} />
          )}
        </>
      )}
    </section>
  );
}
