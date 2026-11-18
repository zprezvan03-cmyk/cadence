/**
 * Album, artist and playlist cards. Written for Cadence.
 */

import { ListMusic, Play } from "lucide-react";
import type { Album, Artist, Playlist } from "../../shared/types";
import { useLibrary } from "../state/libraryStore";
import { usePlayer } from "../state/playerStore";
import { useUi } from "../state/uiStore";
import { Artwork } from "./Artwork";
import { ArtistAvatar } from "./ArtistAvatar";

export function AlbumCard({ album }: { album: Album }) {
  const navigate = useUi(state => state.navigate);
  const playQueue = usePlayer(state => state.playQueue);
  const snapshot = useLibrary(state => state.snapshot);

  return (
    <article className="media-card" data-testid="album-card">
      <button type="button" className="card-open" onClick={() => navigate({ name: "album", albumId: album.id })}>
        <Artwork src={album.artworkUrl} alt="" size="md" />
        <span className="card-title" title={album.name}>{album.name}</span>
        <span className="card-subtitle" title={album.albumArtist}>
          {album.albumArtist}{album.year ? ` · ${album.year}` : ""}
        </span>
      </button>
      <div className="card-overlay">
        <button
          type="button"
          className="card-play"
          aria-label={`Play ${album.name}`}
          title={`Play ${album.name}`}
          onClick={() => {
            const tracks =
              snapshot?.tracks
                .filter(track => `${track.albumArtist || track.artist}\u0000${track.album}` === album.id)
                .sort((a, b) => (a.discNo ?? 0) - (b.discNo ?? 0) || (a.trackNo ?? 0) - (b.trackNo ?? 0)) ?? [];
            void playQueue(tracks.map(track => track.id), 0);
          }}
        >
          <Play size={20} fill="currentColor" />
        </button>
      </div>
    </article>
  );
}

export function ArtistCard({ artist }: { artist: Artist }) {
  const navigate = useUi(state => state.navigate);
  return (
    <button type="button" className="media-card card-open artist-card" onClick={() => navigate({ name: "artist", artistId: artist.id })}>
      <ArtistAvatar name={artist.name} size="md" />
      <span className="card-title" title={artist.name}>{artist.name}</span>
      <span className="card-subtitle">
        {artist.albumCount} {artist.albumCount === 1 ? "album" : "albums"} · {artist.trackCount} {artist.trackCount === 1 ? "song" : "songs"}
      </span>
    </button>
  );
}

export function PlaylistCard({ playlist }: { playlist: Playlist }) {
  const navigate = useUi(state => state.navigate);
  return (
    <button
      type="button"
      className="card-open playlist-open"
      data-testid="playlist-card"
      onClick={() => navigate({ name: "playlist", playlistId: playlist.id })}
    >
      <Artwork src={playlist.artworkUrl} alt="" size="md" fallbackIcon={<ListMusic className="artwork-fallback-icon" aria-hidden="true" />} />
      <span className="card-title" title={playlist.name}>{playlist.name}</span>
      <span className="card-subtitle">
        {playlist.kind === "smart" ? "Smart · " : ""}
        {playlist.trackCount} {playlist.trackCount === 1 ? "song" : "songs"}
      </span>
    </button>
  );
}
