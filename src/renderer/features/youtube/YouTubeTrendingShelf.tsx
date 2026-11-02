/**
 * Lazy Home shelf for YouTube's regional Music-category chart.
 *
 * It mounts only when the user has configured the Data API catalog and does not request data
 * until the shelf approaches the viewport, so local Home rendering/playback is never delayed by
 * the network. The chart is cached for six hours in the catalog core.
 */

import { useEffect, useRef, useState } from "react";
import { KeyRound, RotateCcw } from "lucide-react";
import type { MediaItem, YouTubeCatalogError } from "../../../shared/types";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import { getYouTubeTrending } from "./catalogApi";
import { CatalogSkeletonRows, RemoteTrackList } from "./RemoteMediaItems";

export function YouTubeTrendingShelf() {
  const settings = useSettings(state => state.settings);
  const navigate = useUi(state => state.navigate);
  const sectionRef = useRef<HTMLElement | null>(null);
  const startedRef = useRef(false);
  const [started, setStarted] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<YouTubeCatalogError | null>(null);

  const catalog = settings?.youtubeCatalog;
  const configured = Boolean(catalog?.enabled && catalog.apiKey);
  const resetKey = `${catalog?.enabled ? "on" : "off"}:${catalog?.region ?? ""}:${catalog?.apiKey ? "key" : "none"}`;

  useEffect(() => {
    startedRef.current = false;
    setStarted(false);
    setItems([]);
    setError(null);
    setLoading(false);
  }, [resetKey]);

  useEffect(() => {
    if (!configured || startedRef.current) return;
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
  }, [configured, resetKey]);

  useEffect(() => {
    if (!configured || !started) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getYouTubeTrending({ maxResults: 12 }).then(result => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        if (result.error.kind !== "aborted") setError(result.error);
        return;
      }
      setItems(result.data.items);
    });
    return () => {
      cancelled = true;
    };
  }, [configured, started]);

  if (!configured) return null;

  const retry = () => {
    setError(null);
    setItems([]);
    setStarted(false);
    startedRef.current = true;
    window.setTimeout(() => setStarted(true), 0);
  };
  const needsSettings = error
    ? ["disabled", "missing-key", "invalid-key", "api-not-enabled"].includes(error.kind)
    : false;

  return (
    <section className="shelf youtube-trending-shelf" ref={sectionRef} data-testid="youtube-trending-shelf">
      <div className="shelf-heading">
        <div>
          <p className="eyebrow">Online catalog</p>
          <h2>Trending music videos</h2>
        </div>
        <span className="muted">
          YouTube chart{catalog?.region ? ` · ${catalog.region}` : " · system region"}
        </span>
      </div>
      {!started || loading ? (
        <CatalogSkeletonRows count={4} />
      ) : error ? (
        <div className="catalog-state error compact" role="alert">
          <strong>Trending videos unavailable</strong>
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
        <RemoteTrackList
          items={items.slice(0, 10)}
          testId="youtube-trending-list"
          emptyMessage="YouTube returned no trending music videos for this region."
        />
      )}
    </section>
  );
}

export default YouTubeTrendingShelf;
