/**
 * Cadence-native rows and cards for source-aware YouTube catalog media.
 *
 * These components intentionally mirror the local TrackList/card language while keeping the
 * data model remote and string-identified. Opening a video cues it in the existing official
 * IFrame view; it does not add it to the local queue, database, playlists or History in
 * Phase A.
 */

import { memo } from "react";
import { Play } from "lucide-react";
import { canOpenInYouTubePlayer, mediaItemKey } from "../../../shared/media";
import type { MediaItem, YouTubeChannelItem, YouTubePlaylistSummary } from "../../../shared/types";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";
import { formatTime } from "../../player/queue";
import { useRemoteMedia } from "../../state/remoteMediaStore";
import { useUi } from "../../state/uiStore";
import { useYouTubeRemote } from "../../state/youtubeStore";

export function openRemoteMediaItem(item: MediaItem): boolean {
  const ui = useUi.getState();
  if (!canOpenInYouTubePlayer(item)) {
    ui.showToast(
      item.availability === "not-embeddable"
        ? "YouTube does not allow this video to play in embedded players."
        : "That YouTube video is unavailable."
    );
    return false;
  }
  useRemoteMedia.getState().rememberVideos([item]);
  if (!useYouTubeRemote.getState().loadMediaItem(item)) {
    ui.showToast("That item does not contain a valid YouTube video ID.");
    return false;
  }
  ui.navigate({ name: "youtube" });
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
}: {
  items: MediaItem[];
  emptyMessage?: string;
  testId?: string;
  startIndex?: number;
}) {
  const navigate = useUi(state => state.navigate);
  if (items.length === 0) return <div className="empty-state">{emptyMessage}</div>;

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
        return (
          <div
            className={`track-row remote-track-row ${disabled ? "unavailable" : ""}`}
            key={`${mediaItemKey(item)}:${index}`}
            data-testid="remote-track-row"
            data-remote-id={item.source.kind === "local" ? undefined : item.source.remoteId}
            onClick={() => openRemoteMediaItem(item)}
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
                </span>
              </span>
              {availability ? <span className="badge warn">{availability}</span> : null}
            </span>
            <span className="col-duration">
              {item.durationSeconds ? formatTime(item.durationSeconds) : "—"}
            </span>
            <span className="col-actions">
              <button
                type="button"
                className="icon-button"
                aria-label={`Open ${item.title} in the YouTube player`}
                disabled={disabled}
                onClick={event => {
                  event.stopPropagation();
                  openRemoteMediaItem(item);
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
      <div className="card-subtitle">{channel.handle || "YouTube channel"}</div>
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
        {playlist.itemCount !== null
          ? `${playlist.itemCount} video${playlist.itemCount === 1 ? "" : "s"}`
          : "Public playlist"}
        {playlist.channelTitle ? ` · ${playlist.channelTitle}` : ""}
      </div>
      <SourceBadge
        source={{ kind: "youtube", remoteId: playlist.id, canonicalUrl: playlist.canonicalUrl }}
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
