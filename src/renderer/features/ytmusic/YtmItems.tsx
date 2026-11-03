/**
 * Shared row/card components for YouTube Music catalog surfaces inside Cadence.
 *
 * Every playable row converts its YTM track to a source-aware MediaItem (youtube-music source,
 * string video id — never a fake local id) and hands it to the unified player queue. Every remote
 * row carries the YT Music SourceBadge; local lists are untouched.
 */

import { memo, useCallback } from "react";
import { ListPlus, Play, Plus, Shuffle } from "lucide-react";
import type { YtmAlbum, YtmArtist, YtmItem, YtmPlaylist, YtmTrack } from "../../../shared/ytmusic";
import { mediaItemFromYtmTrack, ytmItemKey } from "../../../shared/ytmusic";
import { formatTime } from "../../player/queue";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";

export function trackToItem(track: YtmTrack) {
  return mediaItemFromYtmTrack(track);
}

interface YtmTrackRowProps {
  track: YtmTrack;
  index: number;
  allTracks: YtmTrack[];
  active?: boolean;
  playing?: boolean;
}

export const YtmTrackRow = memo(function YtmTrackRow({ track, index, allTracks, active, playing }: YtmTrackRowProps) {
  const playMediaQueue = usePlayer(state => state.playMediaQueue);
  const playMediaItem = usePlayer(state => state.playMediaItem);
  const addMediaToQueue = usePlayer(state => state.addMediaToQueue);
  const navigate = useUi(state => state.navigate);

  const item = trackToItem(track);
  const artist = track.artists[0];

  const onPlay = useCallback(() => {
    void playMediaQueue(allTracks.map(trackToItem), index);
  }, [allTracks, index, playMediaQueue]);

  const onPlaySingle = useCallback(() => {
    void playMediaItem(trackToItem(track));
  }, [track, playMediaItem]);

  return (
    <div
      className={`ytm-track-row${active ? " active" : ""}`}
      data-testid="ytm-track-row"
      data-video-id={track.videoId}
      data-source-kind="youtube-music"
    >
      <button type="button" className="icon-button ytm-row-play" onClick={onPlay} aria-label={`Play ${track.title}`} title={`Play ${track.title}`}>
        <Play size={14} fill="currentColor" />
      </button>
      <div className="ytm-row-artwork">
        <Artwork src={track.artworkUrl} alt={track.album?.title ?? track.title} size="xs" />
      </div>
      <div className="ytm-row-info">
        <strong title={track.title}>
          {track.title}
          {track.explicit ? <span className="ytm-explicit" title="Explicit">E</span> : null}
        </strong>
        <span className="muted">
          {artist ? (
            <button
              type="button"
              className="link"
              onClick={() => artist.browseId && navigate({ name: "ytm-artist", artistId: artist.browseId })}
            >
              {artist.name}
            </button>
          ) : (
            "Unknown artist"
          )}
          {track.album ? (
            <>
              {" · "}
              <button
                type="button"
                className="link"
                onClick={() => navigate({ name: "ytm-album", albumId: track.album!.browseId })}
              >
                {track.album.title}
              </button>
            </>
          ) : null}
        </span>
      </div>
      <SourceBadge source={item.source} compact />
      <span className="ytm-row-duration muted">{formatTime(track.durationSeconds ?? 0)}</span>
      <div className="ytm-row-actions">
        <button type="button" className="icon-button" title="Play just this track" aria-label="Play this track" onClick={onPlaySingle}>
          <Play size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Add to queue"
          aria-label="Add to queue"
          onClick={() => addMediaToQueue([trackToItem(track)])}
        >
          <ListPlus size={14} />
        </button>
      </div>
      {playing ? <span className="ytm-playing-dot" aria-label="Playing" /> : null}
    </div>
  );
});

export function YtmTrackList({ tracks, activeVideoId, playingVideoId }: { tracks: YtmTrack[]; activeVideoId?: string | null; playingVideoId?: string | null }) {
  if (tracks.length === 0) return null;
  return (
    <div className="ytm-track-list" data-testid="ytm-track-list">
      {tracks.map((track, index) => (
        <YtmTrackRow
          key={`${track.videoId}-${index}`}
          track={track}
          index={index}
          allTracks={tracks}
          active={track.videoId === activeVideoId}
          playing={track.videoId === playingVideoId}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ cards */

export function YtmItemCard({ item }: { item: YtmItem }) {
  const navigate = useUi(state => state.navigate);
  if (item.type === "song" || item.type === "video") {
    const track = item.track;
    return (
      <button
        type="button"
        className="ytm-card"
        data-testid="ytm-card"
        data-item-key={ytmItemKey(item)}
        onClick={() => void usePlayer.getState().playMediaItem(trackToItem(track))}
      >
        <span className="ytm-card-artwork">
          <Artwork src={track.artworkUrl} alt={track.title} size="md" rounded="md" />
          <span className="ytm-card-play"><Play size={16} fill="currentColor" /></span>
        </span>
        <span className="ytm-card-title" title={track.title}>{track.title}</span>
        <span className="ytm-card-sub muted">
          {track.artists.map(a => a.name).join(", ") || "Unknown artist"}
          {track.durationText ? ` · ${track.durationText}` : ""}
        </span>
        <SourceBadge source={trackToItem(track).source} compact />
      </button>
    );
  }
  if (item.type === "album") {
    const album: YtmAlbum = item.album;
    return (
      <button
        type="button"
        className="ytm-card"
        data-testid="ytm-card"
        data-item-key={ytmItemKey(item)}
        onClick={() => navigate({ name: "ytm-album", albumId: album.browseId })}
      >
        <span className="ytm-card-artwork">
          <Artwork src={album.artworkUrl} alt={album.title} size="md" rounded="md" />
        </span>
        <span className="ytm-card-title" title={album.title}>{album.title}</span>
        <span className="ytm-card-sub muted">
          Album{album.year ? ` · ${album.year}` : ""}
          {album.artists.length ? ` · ${album.artists.map(a => a.name).join(", ")}` : ""}
        </span>
      </button>
    );
  }
  if (item.type === "artist") {
    const artist: YtmArtist = item.artist;
    return (
      <button
        type="button"
        className="ytm-card"
        data-testid="ytm-card"
        data-item-key={ytmItemKey(item)}
        onClick={() => navigate({ name: "ytm-artist", artistId: artist.browseId })}
      >
        <span className="ytm-card-artwork ytm-card-round">
          <Artwork src={artist.artworkUrl} alt={artist.name} size="md" rounded="full" />
        </span>
        <span className="ytm-card-title" title={artist.name}>{artist.name}</span>
        <span className="ytm-card-sub muted">Artist{artist.subscriberCountText ? ` · ${artist.subscriberCountText}` : ""}</span>
      </button>
    );
  }
  const playlist: YtmPlaylist = item.playlist;
  return (
    <button
      type="button"
      className="ytm-card"
      data-testid="ytm-card"
      data-item-key={ytmItemKey(item)}
      onClick={() => navigate({ name: "ytm-playlist", playlistId: playlist.id })}
    >
      <span className="ytm-card-artwork">
        <Artwork src={playlist.artworkUrl} alt={playlist.title} size="md" rounded="md" />
      </span>
      <span className="ytm-card-title" title={playlist.title}>{playlist.title}</span>
      <span className="ytm-card-sub muted">
        Playlist{playlist.trackCountText ? ` · ${playlist.trackCountText}` : ""}
        {playlist.author ? ` · ${playlist.author.name}` : ""}
      </span>
    </button>
  );
}

export function YtmCardGrid({ items }: { items: YtmItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="card-grid ytm-card-grid" data-testid="ytm-card-grid">
      {items.map(item => (
        <YtmItemCard key={ytmItemKey(item)} item={item} />
      ))}
    </div>
  );
}

/** Shelf header with optional Play / Shuffle / More actions. */
export function YtmShelfActions({
  tracks,
  moreLabel,
  onMore,
}: {
  tracks: YtmTrack[];
  moreLabel?: string;
  onMore?: () => void;
}) {
  const playMediaQueue = usePlayer(state => state.playMediaQueue);
  const playMediaShuffled = usePlayer(state => state.playMediaShuffled);
  if (tracks.length === 0 && !onMore) return null;
  return (
    <div className="ytm-shelf-actions">
      {tracks.length > 0 ? (
        <>
          <button type="button" className="ghost-button" onClick={() => void playMediaQueue(tracks.map(trackToItem), 0)}>
            <Play size={14} fill="currentColor" /> Play
          </button>
          <button type="button" className="ghost-button" onClick={() => void playMediaShuffled(tracks.map(trackToItem), 0)}>
            <Shuffle size={14} /> Shuffle
          </button>
        </>
      ) : null}
      {onMore ? (
        <button type="button" className="link" onClick={onMore}>
          {moreLabel ?? "More"}
        </button>
      ) : null}
    </div>
  );
}

export function YtmQueueAddAll({ tracks }: { tracks: YtmTrack[] }) {
  const addMediaToQueue = usePlayer(state => state.addMediaToQueue);
  if (tracks.length === 0) return null;
  return (
    <button type="button" className="ghost-button" onClick={() => addMediaToQueue(tracks.map(trackToItem), "end")}>
      <Plus size={14} /> Add all to queue
    </button>
  );
}
