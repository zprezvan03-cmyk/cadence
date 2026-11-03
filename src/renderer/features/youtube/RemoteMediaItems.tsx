/**
 * Cadence-native rows and cards for source-aware YouTube catalog media.
 *
 * These components mirror the local TrackList/card language while preserving string remote
 * identities. Selecting a video installs it in Cadence's one unified player queue and opens
 * the main Now Playing view, where the official IFrame is visibly mounted.
 */

import { memo } from "react";
import { ListPlus, Play, Plus } from "lucide-react";
import { canOpenInYouTubePlayer, mediaItemKey, trackSourceKey } from "../../../shared/media";
import type { MediaItem, YouTubeChannelItem, YouTubePlaylistSummary } from "../../../shared/types";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";
import { formatTime } from "../../player/queue";
import { currentQueueEntry, usePlayer } from "../../state/playerStore";
import { useRemoteMedia } from "../../state/remoteMediaStore";
import { useUi } from "../../state/uiStore";

function remoteUnavailableMessage(item: MediaItem): string {
  return item.availability === "not-embeddable"
    ? "YouTube does not allow this video to play in embedded players."
    : "That YouTube video is unavailable.";
}

export function openRemoteMediaItem(
  item: MediaItem,
  context?: { items: readonly MediaItem[]; startIndex?: number }
): boolean {
  const ui = useUi.getState();
  if (!canOpenInYouTubePlayer(item)) {
    ui.showToast(remoteUnavailableMessage(item));
    return false;
  }
  const items = context?.items?.length ? context.items : [item];
  const startIndex = Math.max(
    0,
    Math.min(context?.startIndex ?? items.indexOf(item), items.length - 1)
  );
  useRemoteMedia.getState().rememberVideos(items);
  if (items.length > 1) void usePlayer.getState().playMediaQueue(items, startIndex);
  else void usePlayer.getState().playMediaItem(item);
  ui.navigate({ name: "lyrics" });
  return true;
}

export function playRemoteContext(
  items: readonly MediaItem[],
  startIndex = 0,
  shuffled = false
): boolean {
  const playable = items.filter(canOpenInYouTubePlayer);
  if (playable.length === 0) {
    useUi.getState().showToast("No embeddable YouTube videos are loaded in this list yet.");
    return false;
  }
  const requested = items[startIndex];
  const start = requested ? Math.max(0, playable.indexOf(requested)) : 0;
  useRemoteMedia.getState().rememberVideos(playable);
  if (shuffled) void usePlayer.getState().playMediaShuffled(playable, start);
  else void usePlayer.getState().playMediaQueue(playable, start);
  useUi.getState().navigate({ name: "lyrics" });
  return true;
}

export function queueRemoteItems(
  items: readonly MediaItem[],
  placement: "next" | "end" = "end"
): boolean {
  const playable = items.filter(canOpenInYouTubePlayer);
  if (playable.length === 0) return false;
  useRemoteMedia.getState().rememberVideos(playable);
  usePlayer.getState().addMediaToQueue(playable, placement);
  useUi
    .getState()
    .showToast(
      placement === "next"
        ? `Playing next: ${playable[0].title}`
        : `${playable.length} YouTube video${playable.length === 1 ? "" : "s"} added to the queue.`
    );
  return true;
}

function availabilityLabel(item: MediaItem): string | null {
  switch (item.availability) {
    case "not-embeddable":
      return "Not embeddable";
    case "unavailable":
      return "Unavailable";
    case "live":
      return "Live";
    default:
      return null;
  }
}

export const RemoteTrackList = memo(function RemoteTrackList({
  items,
  emptyMessage = "No YouTube videos here yet.",
  testId,
  startIndex = 0,
  contextItems,
}: {
  items: MediaItem[];
  emptyMessage?: string;
  testId?: string;
  startIndex?: number;
  /** Full loaded context when this list is only a visible slice of it (for example Home). */
  contextItems?: readonly MediaItem[];
}) {
  const navigate = useUi(state => state.navigate);
  const currentEntry = usePlayer(currentQueueEntry);
  const isPlaying = usePlayer(state => state.isPlaying);
  const currentSourceKey = currentEntry ? trackSourceKey(currentEntry.item.source) : null;
  if (items.length === 0) return <div className="empty-state">{emptyMessage}</div>;
  const queueContext = contextItems?.length ? contextItems : items;

  return (
    <div className="track-list compact remote-track-list" data-testid={testId}>
      <div className="track-head" aria-hidden="true">
        <span className="col-index">#</span>
        <span className="col-title">Title</span>
        <span className="col-duration">Time</span>
        <span className="col-actions" />
      </div>
      {items.map((item, offset) => {
        const index = startIndex + offset;
        const availability = availabilityLabel(item);
        const disabled = !canOpenInYouTubePlayer(item);
        const isCurrent = currentSourceKey === trackSourceKey(item.source);
        const contextIndex = queueContext.indexOf(item);
        return (
          <div
            className={`track-row remote-track-row ${disabled ? "unavailable" : ""} ${isCurrent ? "current" : ""}`}
            key={`${mediaItemKey(item)}:${index}`}
            data-testid="remote-track-row"
            data-remote-id={item.source.kind === "local" ? undefined : item.source.remoteId}
            data-source-kind={item.source.kind}
            data-current={isCurrent ? "true" : undefined}
            data-playing={isCurrent && isPlaying ? "true" : undefined}
            onClick={() =>
              openRemoteMediaItem(item, {
                items: queueContext,
                startIndex: contextIndex >= 0 ? contextIndex : offset,
              })
            }
          >
            <span className="col-index">
              <span className="index-number">{index + 1}</span>
              <span className="index-play">
                <Play size={15} />
              </span>
            </span>
            <span className="col-title">
              <Artwork src={item.artworkUrl} alt={item.title} size="xs" />
              <span className="title-block">
                <span className="remote-title-line">
                  <span className="title-text" title={item.title}>
                    {item.title}
                  </span>
                  <SourceBadge source={item} compact />
                </span>
                <span className="subtitle-text">
                  {item.channelId ? (
                    <button
                      type="button"
                      className="remote-channel-link"
                      onClick={event => {
                        event.stopPropagation();
                        navigate({ name: "youtube-channel", channelId: item.channelId! });
                      }}
                    >
                      {item.artistLabel}
                    </button>
                  ) : (
                    item.artistLabel
                  )}
                  {item.albumLabel ? ` · ${item.albumLabel}` : ""}
                </span>
              </span>
              {availability ? <span className="badge warn">{availability}</span> : null}
            </span>
            <span className="col-duration">
              {item.durationSeconds ? formatTime(item.durationSeconds) : "—"}
            </span>
            <span className="col-actions remote-track-actions">
              <button
                type="button"
                className="icon-button"
                aria-label={`Play ${item.title} next`}
                title="Play next"
                disabled={disabled}
                onClick={event => {
                  event.stopPropagation();
                  queueRemoteItems([item], "next");
                }}
              >
                <ListPlus size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Add ${item.title} to queue`}
                title="Add to queue"
                disabled={disabled}
                onClick={event => {
                  event.stopPropagation();
                  queueRemoteItems([item], "end");
                }}
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Play ${item.title} in Cadence Now Playing`}
                title="Play"
                disabled={disabled}
                onClick={event => {
                  event.stopPropagation();
                  openRemoteMediaItem(item, {
                    items: queueContext,
                    startIndex: contextIndex >= 0 ? contextIndex : offset,
                  });
                }}
              >
                <Play size={16} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
});

function formatCompactCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function YouTubeChannelCard({ channel }: { channel: YouTubeChannelItem }) {
  const navigate = useUi(state => state.navigate);
  const open = () => navigate({ name: "youtube-channel", channelId: channel.id });
  return (
    <article
      className="media-card artist-card remote-media-card"
      data-testid="youtube-channel-card"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        open();
      }}
    >
      <Artwork src={channel.artworkUrl} alt={channel.title} size="md" rounded="full" />
      <div className="card-title" title={channel.title}>
        {channel.title}
      </div>
      <div className="card-subtitle">
        {channel.handle || "YouTube channel"}
        {formatCompactCount(channel.subscriberCount)
          ? ` · ${formatCompactCount(channel.subscriberCount)} subscribers`
          : ""}
        {formatCompactCount(channel.videoCount) ? ` · ${formatCompactCount(channel.videoCount)} videos` : ""}
      </div>
      <SourceBadge
        source={{ kind: "youtube", remoteId: channel.id, canonicalUrl: channel.canonicalUrl }}
        compact
      />
    </article>
  );
}

export function YouTubePlaylistCard({ playlist }: { playlist: YouTubePlaylistSummary }) {
  const navigate = useUi(state => state.navigate);
  const open = () => navigate({ name: "youtube-playlist", playlistId: playlist.id });
  return (
    <article
      className="media-card remote-media-card"
      data-testid="youtube-playlist-card"
      data-album-collection={playlist.isAlbumCollection ? "true" : undefined}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        open();
      }}
    >
      <div className="card-art">
        <Artwork src={playlist.artworkUrl} alt={playlist.title} size="md" />
      </div>
      <div className="card-title" title={playlist.title}>
        {playlist.title}
      </div>
      <div className="card-subtitle">
        {playlist.isAlbumCollection ? "Album collection" : "Public playlist"}
        {playlist.itemCount !== null
          ? ` · ${playlist.itemCount} track${playlist.itemCount === 1 ? "" : "s"}`
          : ""}
        {(playlist.artistLabel ?? playlist.channelTitle)
          ? ` · ${playlist.artistLabel ?? playlist.channelTitle}`
          : ""}
      </div>
      <SourceBadge
        source={{
          kind: playlist.isAlbumCollection ? "youtube-music" : "youtube",
          remoteId: playlist.id,
          canonicalUrl: playlist.canonicalUrl,
        }}
        compact
      />
    </article>
  );
}

export function CatalogSkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div className="remote-skeleton-list" aria-hidden="true" data-testid="youtube-catalog-loading">
      {Array.from({ length: count }, (_, index) => (
        <div className="remote-skeleton-row" key={index}>
          <span className="remote-skeleton-art" />
          <span className="remote-skeleton-lines">
            <span />
            <span />
          </span>
          <span className="remote-skeleton-time" />
        </div>
      ))}
    </div>
  );
}
