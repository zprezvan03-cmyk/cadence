/**
 * Application shell. Written for Cadence.
 */

import { useCurrentTrack } from "./app/hooks";
import { PlaylistPicker } from "./app/PlaylistPicker";
import { Sidebar } from "./app/Sidebar";
import { TopBar } from "./app/TopBar";
import { useWindowChrome, WindowTitleBar } from "./app/WindowTitleBar";
import { useBootstrap } from "./app/useBootstrap";
import { DecodeTesterView } from "./features/decode-tester/DecodeTesterView";
import { AlbumView, ArtistView, PlaylistView, SearchView } from "./features/library/DetailViews";
import { HomeView } from "./features/library/HomeView";
import { LibraryView } from "./features/library/LibraryView";
import { LyricsView } from "./features/lyrics/LyricsView";
import { PlayerBar } from "./features/player/PlayerBar";
import { QueuePanel } from "./features/player/QueuePanel";
import { SettingsView } from "./features/settings/SettingsView";
import { usePlayer } from "./state/playerStore";
import { useUi } from "./state/uiStore";

function RouteContent() {
  const route = useUi(state => state.route);
  const track = useCurrentTrack();
  const isPlaying = usePlayer(state => state.isPlaying);
  const fullscreenLyrics = useUi(state => state.fullscreenLyrics);
  const setFullscreenLyrics = useUi(state => state.setFullscreenLyrics);
  const navigate = useUi(state => state.navigate);

  switch (route.name) {
    case "home":
      return <HomeView />;
    case "library":
      return <LibraryView tab={route.tab} />;
    case "search":
      return <SearchView query={route.query} />;
    case "album":
      return <AlbumView albumId={route.albumId} />;
    case "artist":
      return <ArtistView artistId={route.artistId} />;
    case "playlist":
      return <PlaylistView playlistId={route.playlistId} />;
    case "lyrics":
      return (
        <LyricsView
          track={track}
          playing={isPlaying}
          fullscreen={fullscreenLyrics}
          onToggleFullscreen={() => setFullscreenLyrics(!fullscreenLyrics)}
          onOpenSearch={() => navigate({ name: "settings" })}
        />
      );
    case "decode-tester":
      return <DecodeTesterView />;
    case "settings":
      return <SettingsView />;
    default:
      return <HomeView />;
  }
}

export function App() {
  useBootstrap();
  const fullscreenLyrics = useUi(state => state.fullscreenLyrics);
  const route = useUi(state => state.route);
  const error = usePlayer(state => state.error);
  const chrome = useWindowChrome();

  const immersive = fullscreenLyrics && route.name === "lyrics";
  // The title bar is only drawn when the OS frame is off (Windows); immersive and native fullscreen
  // hand the whole window to the content.
  const titleBar = chrome.undecorated && !chrome.fullscreen && !immersive;

  return (
    <div className={`app-shell ${immersive ? "is-immersive" : ""} ${titleBar ? "has-title-bar" : ""}`}>
      {titleBar ? <WindowTitleBar chrome={chrome} /> : null}
      {!immersive ? <Sidebar /> : null}
      <main className="app-main">
        {!immersive ? <TopBar /> : null}
        {error && !immersive ? (
          <div className="error-banner" role="alert">
            {error}
            <button type="button" onClick={() => usePlayer.getState().setError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        <div className="content-scroll" key={`${route.name}-${JSON.stringify(route)}`}>
          <RouteContent />
        </div>
        {!immersive ? <PlayerBar /> : null}
      </main>
      <QueuePanel />
      <PlaylistPicker />
    </div>
  );
}
