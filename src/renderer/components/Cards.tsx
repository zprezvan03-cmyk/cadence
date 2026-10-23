/**
 * Album, artist and playlist cards. Written for Cadence.
 */

import { Play } from "lucide-react";
import type { Album, Artist, Playlist } from "../../shared/types";
import { useLibrary } from "../state/libraryStore";
import { usePlayer } from "../state/playerStore";
import { useUi } from "../state/uiStore";
import { Artwork } from "./Artwork";

export function AlbumCard({ album }: { album: Album }) {
  const navigate = useUi(state => state.navigate);
  const playQueue = usePlayer(state => state.playQueue);
  const snapshot = useLibrary(state => state.snapshot);

  return (
    <article
      className="media-card"
      onClick={() => navigate({ name: "album", albumId: album.id })}
      data-testid="album-card"
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === "Enter") navigate({ name: "album", albumId: album.id });
      }}
    >
      <div className="card-art">
        <Artwork src={album.artworkUrl} alt={album.name} size="md" />
        <button
          type="button"
          className="card-play"
          aria-label={`Play ${album.name}`}
          onClick={event => {
            event.stopPropagation();
            const tracks =
              snapshot?.tracks
                .filter(track => `${track.albumArtist}\u0000${track.album}` === album.id)
                .sort((a, b) => (a.discNo ?? 0) - (b.discNo ?? 0) || (a.trackNo ?? 0) - (b.trackNo ?? 0)) ?? [];
            void playQueue(tracks.map(track => track.id), 0);
          }}
        >
          <Play size={20} fill="currentColor" />
        </button>
      </div>
      <div className="card-title" title={album.name}>
        {album.name}
      </div>
      <div className="card-subtitle">
        {album.albumArtist}
        {album.year ? ` · ${album.year}` : ""}
      </div>
    </article>
  );
}

export function ArtistCard({ artist }: { artist: Artist }) {
  const navigate = useUi(state => state.navigate);
  return (
    <article
      className="media-card artist-card"
      onClick={() => navigate({ name: "artist", artistId: artist.id })}
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === "Enter") navigate({ name: "artist", artistId: artist.id });
      }}
    >
      <Artwork src={artist.artworkUrl} alt={artist.name} size="md" rounded="full" />
      <div className="card-title">{artist.name}</div>
      <div className="card-subtitle">
        {artist.albumCount} album{artist.albumCount === 1 ? "" : "s"} · {artist.trackCount} songs
      </div>
    </article>
  );
}

export function PlaylistCard({ playlist }: { playlist: Playlist }) {
  const navigate = useUi(state => state.navigate);
  return (
    <article
      className="media-card"
      onClick={() => navigate({ name: "playlist", playlistId: playlist.id })}
      role="button"
      tabIndex={0}
      data-testid="playlist-card"
      onKeyDown={event => {
        if (event.key === "Enter") navigate({ name: "playlist", playlistId: playlist.id });
      }}
    >
      <Artwork src={playlist.artworkUrl} alt={playlist.name} size="md" />
      <div className="card-title">{playlist.name}</div>
      <div className="card-subtitle">
        {playlist.trackCount} song{playlist.trackCount === 1 ? "" : "s"}
      </div>
    </article>
  );
}
