/**
 * Public YouTube channel and playlist detail views.
 *
 * They reuse Cadence's existing detail-hero, card and track-row language, but their identities
 * remain YouTube string IDs. Phase A opens one video at a time in the existing official player;
 * it does not claim Play All, queue, playlist import or History support before those gated
 * phases are implemented.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, KeyRound, Play, RotateCcw } from "lucide-react";
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
  getYouTubePlaylist,
  getYouTubePlaylistItems,
} from "./catalogApi";
import {
  CatalogSkeletonRows,
  RemoteTrackList,
  YouTubePlaylistCard,
  openRemoteMediaItem,
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

function firstPlayable(items: MediaItem[]): MediaItem | undefined {
  return items.find(item => item.availability !== "not-embeddable" && item.availability !== "unavailable");
}

export function YouTubeChannelView({ channelId }: { channelId: string }) {
  const navigate = useUi(state => state.navigate);
  const goBack = useUi(state => state.goBack);
  const knownChannel = useRemoteMedia(state => state.channelsById[channelId]);
  const [detail, setDetail] = useState<YouTubeChannelDetail | null>(null);
  const [uploads, setUploads] = useState<MediaItem[]>([]);
  const [nextUploadsToken, setNextUploadsToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<YouTubeCatalogError | null>(null);
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
  }, [channelId]);

  useEffect(() => {
    setDetail(null);
    setUploads([]);
    setNextUploadsToken(null);
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
      25
    );
    setLoadingMore(false);
    if (!result.ok) {
      if (result.error.kind !== "aborted") setError(result.error);
      return;
    }
    setUploads(previous => [...previous, ...result.data.items]);
    setNextUploadsToken(result.data.nextPageToken);
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
  const first = firstPlayable(uploads);

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
            {channel.handle ? `${channel.handle} · ` : ""}Public uploads and playlists
          </p>
          <SourceBadge
            source={{ kind: "youtube", remoteId: channel.id, canonicalUrl: channel.canonicalUrl }}
          />
          <div className="heading-actions">
            <button
              type="button"
              className="primary"
              disabled={!first}
              onClick={() => first && openRemoteMediaItem(first)}
            >
              <Play size={16} fill="currentColor" /> Open first video
            </button>
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

          {detail.playlists.length > 0 ? (
            <section className="shelf">
              <div className="shelf-heading">
                <h2>Public playlists</h2>
              </div>
              <div className="card-grid" data-testid="youtube-channel-playlists">
                {detail.playlists.map(playlist => (
                  <YouTubePlaylistCard key={playlist.id} playlist={playlist} />
                ))}
              </div>
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
  const first = firstPlayable(items);
  const loadedDuration = items.reduce((total, item) => total + (item.durationSeconds ?? 0), 0);

  return (
    <div className="view detail-view" data-testid="youtube-playlist-view">
      <header className="detail-hero" data-testid="detail-hero">
        <button type="button" className="icon-button back-button" onClick={goBack} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <Artwork src={playlist.artworkUrl} alt={playlist.title} size="xl" />
        <div className="detail-meta">
          <p className="eyebrow">Public YouTube playlist</p>
          <h1>{playlist.title}</h1>
          <p className="muted">
            {playlist.channelTitle ? `${playlist.channelTitle} · ` : ""}
            {playlist.itemCount !== null ? `${playlist.itemCount} videos` : `${items.length} loaded`}
            {loadedDuration > 0 ? ` · ${formatTime(loadedDuration)} loaded` : ""}
          </p>
          <SourceBadge
            source={{ kind: "youtube", remoteId: playlist.id, canonicalUrl: playlist.canonicalUrl }}
          />
          <div className="heading-actions">
            <button
              type="button"
              className="primary"
              disabled={!first}
              onClick={() => first && openRemoteMediaItem(first)}
            >
              <Play size={16} fill="currentColor" /> Open first video
            </button>
            {playlist.channelId ? (
              <button
                type="button"
                onClick={() => navigate({ name: "youtube-channel", channelId: playlist.channelId! })}
              >
                Channel
              </button>
            ) : null}
            <button type="button" onClick={() => void openExternal(playlist.canonicalUrl)}>
              <ExternalLink size={16} /> YouTube
            </button>
          </div>
        </div>
      </header>

      {playlist.description ? (
        <details className="remote-description">
          <summary>About this playlist</summary>
          <p>{playlist.description}</p>
        </details>
      ) : null}

      <p className="muted remote-phase-note">
        Phase A opens one public video at a time in YouTube’s official player. Mixed Cadence
        playlists and a unified queue remain later, separately gated phases.
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
