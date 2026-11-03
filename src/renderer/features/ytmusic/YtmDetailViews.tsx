/**
 * YouTube Music detail pages inside Cadence: artist (bio, popular tracks, albums, singles,
 * related), album (artwork, year, tracklist with play/shuffle), playlist (creator, metadata,
 * paginated tracklist). All rendered with Cadence's existing detail layout, artwork and track
 * components — no separate remote screens.
 */

import { useEffect } from "react";
import { Loader2, Play, Shuffle } from "lucide-react";
import { useYtm } from "../../state/ytmusicStore";
import { useUi } from "../../state/uiStore";
import { usePlayer, currentSource } from "../../state/playerStore";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";
import { YtmShelfSection } from "./YtmHomeView";
import { YtmCardGrid, YtmQueueAddAll, YtmTrackList, trackToItem } from "./YtmItems";
import type { YtmTrack } from "../../../shared/ytmusic";

function usePlayingVideoId(): { activeVideoId: string | null; playingVideoId: string | null } {
  const activeVideoId = usePlayer(state => {
    const source = currentSource(state);
    return source && source.kind === "youtube-music" ? source.remoteId : null;
  });
  const isPlaying = usePlayer(state => state.isPlaying);
  return { activeVideoId, playingVideoId: isPlaying ? activeVideoId : null };
}

export function YtmArtistView({ artistId }: { artistId: string }) {
  const page = useYtm(state => state.artistPages[artistId]);
  const loadArtist = useYtm(state => state.loadArtist);
  const goBack = useUi(state => state.goBack);
  const { activeVideoId, playingVideoId } = usePlayingVideoId();

  useEffect(() => {
    void loadArtist(artistId);
  }, [artistId, loadArtist]);

  if (!page || page.status === "loading") {
    return <div className="view-loading" data-testid="ytm-artist-loading"><Loader2 size={16} className="spin" /> Loading artist…</div>;
  }
  if (page.status === "error" || !page.data) {
    return (
      <div className="empty-state" data-testid="ytm-artist-error">
        <p>Could not load this artist.</p>
        <p className="muted">{page.error}</p>
        <button type="button" className="primary" onClick={() => void loadArtist(artistId)}>Retry</button>
      </div>
    );
  }
  const data = page.data;
  const popularTracks = data.shelves.flatMap(shelf =>
    shelf.items.filter((i): i is { type: "song" | "video"; track: YtmTrack } => i.type === "song" || i.type === "video").map(i => i.track),
  );

  return (
    <div className="view detail-view" data-testid="ytm-artist-view">
      <header className="detail-hero">
        <button type="button" className="icon-button back-button" onClick={goBack} aria-label="Back">←</button>
        <div className="detail-artwork">
          <Artwork src={data.artworkUrl} alt={data.name} size="hero" rounded="full" />
        </div>
        <div className="detail-meta">
          <p className="eyebrow">Artist · YouTube Music</p>
          <h1>{data.name}</h1>
          <p className="muted">
            {[data.subscriberCountText, "YouTube Music artist page"].filter(Boolean).join(" · ")}
          </p>
          {data.description ? <p className="muted ytm-description">{data.description}</p> : null}
        </div>
      </header>

      {popularTracks.length > 0 ? (
        <section className="shelf" data-testid="ytm-artist-popular">
          <div className="shelf-heading">
            <h2>Popular</h2>
            <div className="ytm-shelf-actions">
              <button type="button" className="ghost-button" onClick={() => void usePlayer.getState().playMediaQueue(popularTracks.map(trackToItem), 0)}>
                <Play size={14} fill="currentColor" /> Play
              </button>
              <button type="button" className="ghost-button" onClick={() => void usePlayer.getState().playMediaShuffled(popularTracks.map(trackToItem), 0)}>
                <Shuffle size={14} /> Shuffle
              </button>
            </div>
          </div>
          <YtmTrackList tracks={popularTracks} activeVideoId={activeVideoId} playingVideoId={playingVideoId} />
        </section>
      ) : null}

      {data.shelves.map((shelf, index) => (
        <YtmShelfSection key={`${shelf.title ?? "shelf"}-${index}`} shelf={shelf} />
      ))}
    </div>
  );
}

export function YtmAlbumView({ albumId }: { albumId: string }) {
  const page = useYtm(state => state.albumPages[albumId]);
  const loadAlbum = useYtm(state => state.loadAlbum);
  const goBack = useUi(state => state.goBack);
  const { activeVideoId, playingVideoId } = usePlayingVideoId();

  useEffect(() => {
    void loadAlbum(albumId);
  }, [albumId, loadAlbum]);

  if (!page || page.status === "loading") {
    return <div className="view-loading" data-testid="ytm-album-loading"><Loader2 size={16} className="spin" /> Loading album…</div>;
  }
  if (page.status === "error" || !page.data) {
    return (
      <div className="empty-state" data-testid="ytm-album-error">
        <p>Could not load this album.</p>
        <p className="muted">{page.error}</p>
        <button type="button" className="primary" onClick={() => void loadAlbum(albumId)}>Retry</button>
      </div>
    );
  }
  const data = page.data;
  const playMediaQueue = usePlayer(state => state.playMediaQueue);
  const playMediaShuffled = usePlayer(state => state.playMediaShuffled);

  return (
    <div className="view detail-view" data-testid="ytm-album-view">
      <header className="detail-hero">
        <button type="button" className="icon-button back-button" onClick={goBack} aria-label="Back">←</button>
        <div className="detail-artwork">
          <Artwork src={data.artworkUrl} alt={data.title} size="hero" />
        </div>
        <div className="detail-meta">
          <p className="eyebrow">Album · YouTube Music</p>
          <h1>{data.title}</h1>
          <p className="muted">
            {[data.artists.map(a => a.name).join(", ") || "Unknown artist", data.year, data.trackCountText, data.durationText]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {data.description ? <p className="muted ytm-description">{data.description}</p> : null}
          <div className="heading-actions">
            <button type="button" className="primary" disabled={data.tracks.length === 0} onClick={() => void playMediaQueue(data.tracks.map(trackToItem), 0)}>
              <Play size={15} fill="currentColor" /> Play
            </button>
            <button type="button" className="ghost-button" disabled={data.tracks.length === 0} onClick={() => void playMediaShuffled(data.tracks.map(trackToItem), 0)}>
              <Shuffle size={15} /> Shuffle
            </button>
            <YtmQueueAddAll tracks={data.tracks} />
            <SourceBadge source={{ kind: "youtube-music", remoteId: data.tracks[0]?.videoId ?? albumId, canonicalUrl: `https://music.youtube.com/browse/${albumId}` }} compact />
          </div>
        </div>
      </header>

      <section className="shelf">
        <div className="shelf-heading"><h2>Tracks</h2></div>
        {data.tracks.length === 0 ? (
          <div className="empty-state">No tracks found for this album.</div>
        ) : (
          <YtmTrackList tracks={data.tracks} activeVideoId={activeVideoId} playingVideoId={playingVideoId} />
        )}
      </section>
    </div>
  );
}

export function YtmPlaylistView({ playlistId }: { playlistId: string }) {
  const page = useYtm(state => state.playlistPages[playlistId]);
  const loadPlaylist = useYtm(state => state.loadPlaylist);
  const loadMorePlaylist = useYtm(state => state.loadMorePlaylist);
  const goBack = useUi(state => state.goBack);
  const { activeVideoId, playingVideoId } = usePlayingVideoId();
  const playMediaQueue = usePlayer(state => state.playMediaQueue);
  const playMediaShuffled = usePlayer(state => state.playMediaShuffled);

  useEffect(() => {
    void loadPlaylist(playlistId);
  }, [playlistId, loadPlaylist]);

  if (!page || page.status === "loading") {
    return <div className="view-loading" data-testid="ytm-playlist-loading"><Loader2 size={16} className="spin" /> Loading playlist…</div>;
  }
  if (page.status === "error" || !page.data) {
    return (
      <div className="empty-state" data-testid="ytm-playlist-error">
        <p>Could not load this playlist.</p>
        <p className="muted">{page.error}</p>
        <button type="button" className="primary" onClick={() => void loadPlaylist(playlistId)}>Retry</button>
      </div>
    );
  }
  const data = page.data;

  return (
    <div className="view detail-view" data-testid="ytm-playlist-view">
      <header className="detail-hero">
        <button type="button" className="icon-button back-button" onClick={goBack} aria-label="Back">←</button>
        <div className="detail-artwork">
          <Artwork src={data.artworkUrl} alt={data.title} size="hero" />
        </div>
        <div className="detail-meta">
          <p className="eyebrow">Playlist · YouTube Music</p>
          <h1>{data.title}</h1>
          <p className="muted">
            {[
              data.author?.name ? `by ${data.author.name}` : null,
              data.trackCountText,
              data.viewCountText,
            ].filter(Boolean).join(" · ")}
          </p>
          {data.description ? <p className="muted ytm-description">{data.description}</p> : null}
          <div className="heading-actions">
            <button type="button" className="primary" disabled={data.tracks.length === 0} onClick={() => void playMediaQueue(data.tracks.map(trackToItem), 0)}>
              <Play size={15} fill="currentColor" /> Play
            </button>
            <button type="button" className="ghost-button" disabled={data.tracks.length === 0} onClick={() => void playMediaShuffled(data.tracks.map(trackToItem), 0)}>
              <Shuffle size={15} /> Shuffle
            </button>
            <YtmQueueAddAll tracks={data.tracks} />
            <YtmCardGrid items={[]} />
          </div>
        </div>
      </header>

      <section className="shelf">
        <div className="shelf-heading"><h2>Tracks</h2></div>
        {data.tracks.length === 0 ? (
          <div className="empty-state">This playlist has no tracks.</div>
        ) : (
          <YtmTrackList tracks={data.tracks} activeVideoId={activeVideoId} playingVideoId={playingVideoId} />
        )}
        {page.continuation ? (
          <button type="button" className="ghost-button" disabled={page.loadingMore} onClick={() => void loadMorePlaylist(playlistId)} data-testid="ytm-playlist-more">
            {page.loadingMore ? <Loader2 size={14} className="spin" /> : null} Load more tracks
          </button>
        ) : null}
      </section>
    </div>
  );
}
