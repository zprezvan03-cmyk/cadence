/**
 * Public YouTube channel and playlist detail views.
 *
 * They reuse Cadence's existing detail-hero, card and track-row language while preserving
 * YouTube string IDs. Loaded videos play through Cadence's one source-aware queue and main
 * Now Playing view; user-created Cadence playlists themselves remain local-only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  KeyRound,
  ListPlus,
  Play,
  RotateCcw,
  Shuffle,
} from "lucide-react";
import { canOpenInYouTubePlayer, isYouTubeMusicAlbumPlaylistId } from "../../../shared/media";
import type {
  MediaItem,
  YouTubeCatalogError,
  YouTubeChannelDetail,
  YouTubePlaylistSummary,
} from "../../../shared/types";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";
import { formatTime } from "../../player/queue";
import { useRemoteMedia } from "../../state/remoteMediaStore";
import { useUi } from "../../state/uiStore";
import {
  getYouTubeChannel,
  getYouTubeChannelPlaylists,
  getYouTubeChannelVideos,
  getYouTubePlaylist,
  getYouTubePlaylistItems,
} from "./catalogApi";
import {
  CatalogSkeletonRows,
  RemoteTrackList,
  YouTubePlaylistCard,
  playRemoteContext,
  queueRemoteItems,
} from "./RemoteMediaItems";

async function openExternal(url: string): Promise<void> {
  if (window.cadence?.app?.openExternal) {
    await window.cadence.app.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function DetailError({
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
    <div className="catalog-state error" role="alert" data-testid="youtube-detail-error">
      <strong>Could not load this YouTube page</strong>
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

function formatCompactCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function RemoteContextActions({ items }: { items: readonly MediaItem[] }) {
  const hasPlayable = items.some(canOpenInYouTubePlayer);
  return (
    <>
      <button
        type="button"
        className="primary"
        disabled={!hasPlayable}
        onClick={() => playRemoteContext(items, 0, false)}
        data-testid="youtube-context-play"
      >
        <Play size={16} fill="currentColor" /> Play loaded
      </button>
      <button
        type="button"
        disabled={!hasPlayable}
        onClick={() => playRemoteContext(items, 0, true)}
        data-testid="youtube-context-shuffle"
      >
        <Shuffle size={16} /> Shuffle loaded
      </button>
      <button
        type="button"
        disabled={!hasPlayable}
        onClick={() => queueRemoteItems(items, "end")}
        data-testid="youtube-context-queue"
      >
        <ListPlus size={16} /> Add loaded to queue
      </button>
    </>
  );
}

export function YouTubeChannelView({ channelId }: { channelId: string }) {
  const navigate = useUi(state => state.navigate);
  const goBack = useUi(state => state.goBack);
  const knownChannel = useRemoteMedia(state => state.channelsById[channelId]);
  const [detail, setDetail] = useState<YouTubeChannelDetail | null>(null);
  const [uploads, setUploads] = useState<MediaItem[]>([]);
  const [nextUploadsToken, setNextUploadsToken] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<YouTubePlaylistSummary[]>([]);
  const [nextPlaylistsToken, setNextPlaylistsToken] = useState<string | null>(null);
  const [popularVideos, setPopularVideos] = useState<MediaItem[]>([]);
  const [nextPopularToken, setNextPopularToken] = useState<string | null>(null);
  const [popularRequested, setPopularRequested] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMorePlaylists, setLoadingMorePlaylists] = useState(false);
  const [loadingPopular, setLoadingPopular] = useState(false);
  const [error, setError] = useState<YouTubeCatalogError | null>(null);
  const [popularError, setPopularError] = useState<YouTubeCatalogError | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    const result = await getYouTubeChannel(channelId);
    if (generationRef.current !== generation) return;
    setLoading(false);
    if (!result.ok) {
      if (result.error.kind !== "aborted") setError(result.error);
      return;
    }
    setDetail(result.data);
    setUploads(result.data.uploads.items);
    setNextUploadsToken(result.data.uploads.nextPageToken);
    setPlaylists(result.data.playlists);
    setNextPlaylistsToken(result.data.playlistsNextPageToken ?? null);
  }, [channelId]);

  useEffect(() => {
    setDetail(null);
    setUploads([]);
    setNextUploadsToken(null);
    setPlaylists([]);
    setNextPlaylistsToken(null);
    setPopularVideos([]);
    setNextPopularToken(null);
    setPopularRequested(false);
    setPopularError(null);
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  const channel = detail?.channel ?? knownChannel;
  const loadMoreUploads = async () => {
    if (!detail?.channel.uploadsPlaylistId || !nextUploadsToken || loadingMore) return;
    setLoadingMore(true);
    const result = await getYouTubePlaylistItems(
      detail.channel.uploadsPlaylistId,
      nextUploadsToken,
      50
    );
    setLoadingMore(false);
    if (!result.ok) {
      if (result.error.kind !== "aborted") setError(result.error);
      return;
    }
    setUploads(previous => [...previous, ...result.data.items]);
    setNextUploadsToken(result.data.nextPageToken);
  };

  const loadMorePlaylists = async () => {
    if (!nextPlaylistsToken || loadingMorePlaylists) return;
    setLoadingMorePlaylists(true);
    const result = await getYouTubeChannelPlaylists(channelId, nextPlaylistsToken, 50);
    setLoadingMorePlaylists(false);
    if (!result.ok) {
      if (result.error.kind !== "aborted") setError(result.error);
      return;
    }
    setPlaylists(previous => [...previous, ...result.data.items]);
    setNextPlaylistsToken(result.data.nextPageToken);
  };

  const loadPopularVideos = async (append = false) => {
    if (loadingPopular || (append && !nextPopularToken)) return;
    setPopularRequested(true);
    setLoadingPopular(true);
    setPopularError(null);
    const result = await getYouTubeChannelVideos(
      channelId,
      append ? nextPopularToken : null,
      50,
      "viewCount"
    );
    setLoadingPopular(false);
    if (!result.ok) {
      if (result.error.kind !== "aborted") setPopularError(result.error);
      return;
    }
    setPopularVideos(previous => (append ? [...previous, ...result.data.items] : result.data.items));
    setNextPopularToken(result.data.nextPageToken);
  };

  if (!channel && loading) {
    return (
      <div className="view detail-view" data-testid="youtube-channel-view">
        <CatalogSkeletonRows count={6} />
      </div>
    );
  }

  if (!channel && error) {
    return (
      <div className="view detail-view" data-testid="youtube-channel-view">
        <button type="button" className="icon-button back-button" onClick={goBack} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <DetailError error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!channel) return <div className="empty-state">YouTube channel not found.</div>;
  const albumCollections = playlists.filter(
    playlist => playlist.isAlbumCollection || isYouTubeMusicAlbumPlaylistId(playlist.id)
  );
  const regularPlaylists = playlists.filter(
    playlist => !playlist.isAlbumCollection && !isYouTubeMusicAlbumPlaylistId(playlist.id)
  );
  const visiblePlaylists = albumCollections.length > 0 ? regularPlaylists : playlists;
  const channelStats = [
    channel.handle,
    formatCompactCount(channel.subscriberCount)
      ? `${formatCompactCount(channel.subscriberCount)} subscribers`
      : null,
    formatCompactCount(channel.videoCount) ? `${formatCompactCount(channel.videoCount)} videos` : null,
    formatCompactCount(channel.viewCount) ? `${formatCompactCount(channel.viewCount)} views` : null,
  ].filter(Boolean);

  return (
    <div className="view detail-view" data-testid="youtube-channel-view">
      <header className="detail-hero" data-testid="detail-hero">
        <button type="button" className="icon-button back-button" onClick={goBack} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <Artwork src={channel.artworkUrl} alt={channel.title} size="xl" rounded="full" />
        <div className="detail-meta">
          <p className="eyebrow">YouTube channel</p>
          <h1>{channel.title}</h1>
          <p className="muted">
            {channelStats.length ? `${channelStats.join(" · ")} · ` : ""}Public uploads and playlists
          </p>
          <SourceBadge
            source={{ kind: "youtube", remoteId: channel.id, canonicalUrl: channel.canonicalUrl }}
          />
          <div className="heading-actions">
            <RemoteContextActions items={uploads} />
            <button type="button" onClick={() => void openExternal(channel.canonicalUrl)}>
              <ExternalLink size={16} /> YouTube
            </button>
          </div>
        </div>
      </header>

      {channel.description ? (
        <details className="remote-description">
          <summary>About this channel</summary>
          <p>{channel.description}</p>
        </details>
      ) : null}

      {loading && !detail ? <CatalogSkeletonRows count={6} /> : null}
      {error ? <DetailError error={error} onRetry={() => void load()} /> : null}

      {detail ? (
        <>
          <section className="shelf">
            <div className="shelf-heading">
              <h2>Latest uploads</h2>
              <span className="muted">{uploads.length} loaded</span>
            </div>
            <RemoteTrackList
              items={uploads}
              testId="youtube-channel-uploads"
              emptyMessage="This channel has no public uploads Cadence could load."
            />
            {nextUploadsToken ? (
              <div className="catalog-load-more">
                <button type="button" onClick={() => void loadMoreUploads()} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more uploads"}
                </button>
              </div>
            ) : null}
          </section>

          <section className="shelf" data-testid="youtube-channel-popular-section">
            <div className="shelf-heading">
              <div>
                <h2>Popular videos</h2>
                <p className="muted">Ordered by view count through channel-scoped YouTube search.</p>
              </div>
              <span className="muted">{popularVideos.length} loaded</span>
            </div>
            {!popularRequested ? (
              <div className="catalog-explicit-load">
                <p>
                  Popular ordering has no uploads-playlist equivalent, so Cadence only spends a
                  YouTube search-quota call when you ask for it.
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void loadPopularVideos(false)}
                  data-testid="youtube-channel-load-popular"
                >
                  Load popular videos
                </button>
              </div>
            ) : loadingPopular && popularVideos.length === 0 ? (
              <CatalogSkeletonRows count={5} />
            ) : popularError ? (
              <DetailError error={popularError} onRetry={() => void loadPopularVideos(false)} />
            ) : (
              <>
                <RemoteTrackList
                  items={popularVideos}
                  testId="youtube-channel-popular"
                  emptyMessage="YouTube returned no popular public videos for this channel."
                  contextItems={popularVideos}
                />
                {nextPopularToken ? (
                  <div className="catalog-load-more">
                    <button
                      type="button"
                      onClick={() => void loadPopularVideos(true)}
                      disabled={loadingPopular}
                      data-testid="youtube-channel-popular-load-more"
                    >
                      {loadingPopular ? "Loading…" : "Load more popular videos"}
                    </button>
                    <span>Each extra page uses another YouTube search-quota call.</span>
                  </div>
                ) : null}
              </>
            )}
          </section>

          {albumCollections.length > 0 ? (
            <section className="shelf">
              <div className="shelf-heading">
                <div>
                  <h2>Album collections</h2>
                  <p className="muted">Verified YouTube Music album playlists.</p>
                </div>
                <span className="muted">{albumCollections.length} loaded</span>
              </div>
              <div className="card-grid" data-testid="youtube-channel-album-collections">
                {albumCollections.map(playlist => (
                  <YouTubePlaylistCard key={playlist.id} playlist={playlist} />
                ))}
              </div>
            </section>
          ) : null}

          {visiblePlaylists.length > 0 || nextPlaylistsToken ? (
            <section className="shelf">
              <div className="shelf-heading">
                <h2>Public playlists</h2>
                <span className="muted">{playlists.length} loaded</span>
              </div>
              <div className="card-grid" data-testid="youtube-channel-playlists">
                {visiblePlaylists.map(playlist => (
                  <YouTubePlaylistCard key={playlist.id} playlist={playlist} />
                ))}
              </div>
              {nextPlaylistsToken ? (
                <div className="catalog-load-more">
                  <button
                    type="button"
                    onClick={() => void loadMorePlaylists()}
                    disabled={loadingMorePlaylists}
                    data-testid="youtube-channel-playlists-load-more"
                  >
                    {loadingMorePlaylists ? "Loading…" : "Load more playlists"}
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}

      <button type="button" className="link remote-back-link" onClick={() => navigate({ name: "search", query: channel.title })}>
        Search Cadence for “{channel.title}”
      </button>
    </div>
  );
}

export function YouTubePlaylistView({ playlistId }: { playlistId: string }) {
  const navigate = useUi(state => state.navigate);
  const goBack = useUi(state => state.goBack);
  const knownPlaylist = useRemoteMedia(state => state.playlistsById[playlistId]);
  const [playlist, setPlaylist] = useState<YouTubePlaylistSummary | null>(knownPlaylist ?? null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<YouTubeCatalogError | null>(null);
  const generationRef = useRef(0);

  const loadItems = useCallback(
    async (generation: number) => {
      setLoadingItems(true);
      const result = await getYouTubePlaylistItems(playlistId, null, 50);
      if (generationRef.current !== generation) return;
      setLoadingItems(false);
      if (!result.ok) {
        if (result.error.kind !== "aborted") setError(result.error);
        return;
      }
      setItems(result.data.items);
      setNextPageToken(result.data.nextPageToken);
    },
    [playlistId]
  );

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setItems([]);
    setNextPageToken(null);
    const result = await getYouTubePlaylist(playlistId);
    if (generationRef.current !== generation) return;
    setLoading(false);
    if (!result.ok) {
      if (result.error.kind !== "aborted") setError(result.error);
      return;
    }
    setPlaylist(result.data.playlist);
    await loadItems(generation);
  }, [loadItems, playlistId]);

  useEffect(() => {
    setPlaylist(knownPlaylist ?? null);
    void load();
    return () => {
      generationRef.current += 1;
    };
    // knownPlaylist is only the initial paint; a registry refresh should not restart loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, playlistId]);

  const loadMore = async () => {
    if (!nextPageToken || loadingMore) return;
    setLoadingMore(true);
    const result = await getYouTubePlaylistItems(playlistId, nextPageToken, 50);
    setLoadingMore(false);
    if (!result.ok) {
      if (result.error.kind !== "aborted") setError(result.error);
      return;
    }
    setItems(previous => [...previous, ...result.data.items]);
    setNextPageToken(result.data.nextPageToken);
  };

  if (!playlist && loading) {
    return (
      <div className="view detail-view" data-testid="youtube-playlist-view">
        <CatalogSkeletonRows count={6} />
      </div>
    );
  }

  if (!playlist && error) {
    return (
      <div className="view detail-view" data-testid="youtube-playlist-view">
        <button type="button" className="icon-button back-button" onClick={goBack} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <DetailError error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!playlist) return <div className="empty-state">YouTube playlist not found.</div>;
  const isAlbumCollection =
    playlist.isAlbumCollection || isYouTubeMusicAlbumPlaylistId(playlist.id);
  const loadedDuration = items.reduce((total, item) => total + (item.durationSeconds ?? 0), 0);

  return (
    <div className="view detail-view" data-testid="youtube-playlist-view">
      <header className="detail-hero" data-testid="detail-hero">
        <button type="button" className="icon-button back-button" onClick={goBack} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <Artwork src={playlist.artworkUrl} alt={playlist.title} size="xl" />
        <div className="detail-meta">
          <p className="eyebrow">
            {isAlbumCollection ? "YouTube Music album collection" : "Public YouTube playlist"}
          </p>
          <h1>{playlist.title}</h1>
          <p className="muted">
            {(playlist.artistLabel ?? playlist.channelTitle)
              ? `${playlist.artistLabel ?? playlist.channelTitle} · `
              : ""}
            {playlist.itemCount !== null ? `${playlist.itemCount} videos` : `${items.length} loaded`}
            {loadedDuration > 0 ? ` · ${formatTime(loadedDuration)} loaded` : ""}
          </p>
          <SourceBadge
            source={{
              kind: isAlbumCollection ? "youtube-music" : "youtube",
              remoteId: playlist.id,
              canonicalUrl: playlist.canonicalUrl,
            }}
          />
          <div className="heading-actions">
            <RemoteContextActions items={items} />
            {playlist.channelId ? (
              <button
                type="button"
                onClick={() => navigate({ name: "youtube-channel", channelId: playlist.channelId! })}
              >
                Channel
              </button>
            ) : null}
            <button type="button" onClick={() => void openExternal(playlist.canonicalUrl)}>
              <ExternalLink size={16} /> {isAlbumCollection ? "YouTube Music" : "YouTube"}
            </button>
          </div>
        </div>
      </header>

      {playlist.description ? (
        <details className="remote-description">
          <summary>{isAlbumCollection ? "About this album collection" : "About this playlist"}</summary>
          <p>{playlist.description}</p>
        </details>
      ) : null}

      <p className="muted remote-phase-note">
        {isAlbumCollection
          ? "This is a verified YouTube Music album playlist. The Data API has no native album object, so Cadence labels it an album collection and uses its actual playlist title as the tracks’ album label."
          : "Loaded public videos play through Cadence’s unified queue and main Now Playing view. Load more pages to extend the context available to Play, Shuffle and Add to Queue."}
      </p>

      {loadingItems ? <CatalogSkeletonRows count={6} /> : null}
      {error ? <DetailError error={error} onRetry={() => void load()} /> : null}
      {!loadingItems ? (
        <RemoteTrackList
          items={items}
          testId="youtube-playlist-items"
          emptyMessage="This public playlist has no videos Cadence could load."
        />
      ) : null}
      {nextPageToken ? (
        <div className="catalog-load-more">
          <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more videos"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
