/**
 * Lazy Home shelves for official YouTube Data API discovery.
 *
 * Trending uses `videos.list?chart=mostPopular`, so it can load lazily when the shelf nears
 * the viewport. New uploads use `search.list`, whose separate daily search-call allocation is
 * much scarcer; that shelf therefore waits for an explicit user click. Both shelves fetch a
 * full 50-item page, reveal it progressively, and then continue through real API pages.
 */

import { useEffect, useRef, useState } from "react";
import { KeyRound, RotateCcw } from "lucide-react";
import type {
  CatalogPage,
  MediaItem,
  YouTubeCatalogError,
  YouTubeCatalogResult,
} from "../../../shared/types";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import { getYouTubeNewReleases, getYouTubeTrending } from "./catalogApi";
import { CatalogSkeletonRows, RemoteTrackList } from "./RemoteMediaItems";

type ShelfFetcher = (
  pageToken: string | null
) => Promise<YouTubeCatalogResult<CatalogPage<MediaItem>>>;

const VISIBLE_STEP = 10;

function PaginatedCatalogShelf({
  title,
  detail,
  testId,
  emptyMessage,
  loadPage,
  autoStart,
  explicitNote,
}: {
  title: string;
  detail: string;
  testId: string;
  emptyMessage: string;
  loadPage: ShelfFetcher;
  autoStart: boolean;
  explicitNote?: string;
}) {
  const settings = useSettings(state => state.settings);
  const navigate = useUi(state => state.navigate);
  const sectionRef = useRef<HTMLElement | null>(null);
  const startedRef = useRef(false);
  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;
  const [started, setStarted] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [totalResults, setTotalResults] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<YouTubeCatalogError | null>(null);

  const catalog = settings?.youtubeCatalog;
  const configured = Boolean(catalog?.enabled && catalog.apiKey);
  const resetKey = `${testId}:${catalog?.enabled ? "on" : "off"}:${catalog?.region ?? ""}:${catalog?.apiKey ? "key" : "none"}`;

  useEffect(() => {
    startedRef.current = false;
    setStarted(false);
    setItems([]);
    setNextPageToken(null);
    setTotalResults(null);
    setVisibleCount(VISIBLE_STEP);
    setError(null);
    setLoading(false);
    setLoadingMore(false);
  }, [resetKey]);

  useEffect(() => {
    if (!configured || !autoStart || startedRef.current) return;
    const node = sectionRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      const timer = window.setTimeout(() => {
        startedRef.current = true;
        setStarted(true);
      }, 900);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        startedRef.current = true;
        setStarted(true);
        observer.disconnect();
      },
      { rootMargin: "420px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoStart, configured, resetKey]);

  useEffect(() => {
    if (!configured || !started) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadPageRef.current(null).then(result => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        if (result.error.kind !== "aborted") setError(result.error);
        return;
      }
      setItems(result.data.items);
      setNextPageToken(result.data.nextPageToken);
      setTotalResults(result.data.totalResults);
      setVisibleCount(VISIBLE_STEP);
    });
    return () => {
      cancelled = true;
    };
  }, [configured, started]);

  if (!configured) return null;

  const retry = () => {
    setError(null);
    setItems([]);
    setNextPageToken(null);
    setTotalResults(null);
    setVisibleCount(VISIBLE_STEP);
    setStarted(false);
    startedRef.current = true;
    window.setTimeout(() => setStarted(true), 0);
  };

  const loadMore = async () => {
    if (visibleCount < items.length) {
      setVisibleCount(previous => previous + VISIBLE_STEP);
      return;
    }
    if (!nextPageToken || loadingMore) return;
    setLoadingMore(true);
    const result = await loadPageRef.current(nextPageToken);
    setLoadingMore(false);
    if (!result.ok) {
      if (result.error.kind !== "aborted") setError(result.error);
      return;
    }
    setItems(previous => [...previous, ...result.data.items]);
    setNextPageToken(result.data.nextPageToken);
    setTotalResults(result.data.totalResults);
    setVisibleCount(previous => previous + VISIBLE_STEP);
  };

  const needsSettings = error
    ? ["disabled", "missing-key", "invalid-key", "api-not-enabled"].includes(error.kind)
    : false;
  const canLoadMore = visibleCount < items.length || Boolean(nextPageToken);

  return (
    <section className="shelf youtube-discovery-shelf" ref={sectionRef} data-testid={testId}>
      <div className="shelf-heading">
        <div>
          <p className="eyebrow">Online catalog</p>
          <h2>{title}</h2>
        </div>
        <span className="muted">
          {detail}
          {items.length ? ` · ${items.length} loaded` : ""}
          {totalResults !== null ? ` · about ${totalResults.toLocaleString()} total` : ""}
        </span>
      </div>

      {!started && !autoStart ? (
        <div className="catalog-explicit-load">
          <p>{explicitNote}</p>
          <button
            type="button"
            className="primary"
            data-testid={`${testId}-load`}
            onClick={() => {
              startedRef.current = true;
              setStarted(true);
            }}
          >
            Load new uploads
          </button>
        </div>
      ) : !started || loading ? (
        <CatalogSkeletonRows count={4} />
      ) : error && items.length === 0 ? (
        <div className="catalog-state error compact" role="alert">
          <strong>{title} unavailable</strong>
          <p>{error.message}</p>
          <div className="heading-actions">
            {needsSettings ? (
              <button type="button" className="primary" onClick={() => navigate({ name: "settings" })}>
                <KeyRound size={15} /> Catalog settings
              </button>
            ) : null}
            <button type="button" onClick={retry}>
              <RotateCcw size={15} /> Retry
            </button>
          </div>
        </div>
      ) : (
        <>
          {error ? (
            <div className="catalog-state error compact" role="alert">
              <strong>Could not load another page</strong>
              <p>{error.message}</p>
            </div>
          ) : null}
          <RemoteTrackList
            items={items.slice(0, visibleCount)}
            contextItems={items}
            testId={`${testId}-list`}
            emptyMessage={emptyMessage}
          />
          {canLoadMore ? (
            <div className="catalog-load-more">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid={`${testId}-load-more`}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
              <span>
                {visibleCount < items.length
                  ? "More results from this fetched page are already loaded."
                  : "The next page uses another official YouTube Data API request."}
              </span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function YouTubeTrendingShelf() {
  const region = useSettings(state => state.settings?.youtubeCatalog.region);
  return (
    <PaginatedCatalogShelf
      title="Trending music videos"
      detail={`YouTube chart${region ? ` · ${region}` : " · system region"}`}
      testId="youtube-trending-shelf"
      emptyMessage="YouTube returned no trending music videos for this region."
      autoStart
      loadPage={pageToken => getYouTubeTrending({ pageToken, maxResults: 50 })}
    />
  );
}

export function YouTubeNewReleasesShelf() {
  const region = useSettings(state => state.settings?.youtubeCatalog.region);
  return (
    <PaginatedCatalogShelf
      title="New music uploads"
      detail={`Last 30 days${region ? ` · ${region}` : " · system region"}`}
      testId="youtube-new-releases-shelf"
      emptyMessage="YouTube returned no recent embeddable Music-category uploads."
      autoStart={false}
      explicitNote="Recent uploads use YouTube search, which has a separate 100-calls-per-day project allocation. Cadence loads this shelf only when you ask."
      loadPage={pageToken => getYouTubeNewReleases({ pageToken, maxResults: 50 })}
    />
  );
}

export default YouTubeTrendingShelf;
