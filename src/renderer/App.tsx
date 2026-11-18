/**
 * Application shell. Written for Cadence.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { useCurrentMediaItem, useCurrentTrack } from "./app/hooks";
import { useAutofetchLyrics } from "./features/lyrics/useAutofetch";
import { useLastFmScrobbler } from "./features/scrobble/useLastFmScrobbler";
import { Onboarding } from "./features/onboarding/Onboarding";
import { useLibrary } from "./state/libraryStore";
import { useOnboarding } from "./state/onboardingStore";
import { useSettings } from "./state/settingsStore";
import { PlaylistPicker } from "./app/PlaylistPicker";
import { ShortcutsHelp } from "./app/ShortcutsHelp";
import { TrackEditor } from "./features/library/TrackEditor";
import { Sidebar } from "./app/Sidebar";
import { useReducedMotion } from "./app/useMotionPreference";
import { useWindowChrome, WindowTitleBar } from "./app/WindowTitleBar";
import { useBootstrap } from "./app/useBootstrap";
import { useLastNonNull, usePresence } from "./app/usePresence";
import { DecodeTesterView } from "./features/decode-tester/DecodeTesterView";
import { AlbumView, ArtistView, PlaylistView, SearchView } from "./features/library/DetailViews";
import { HomeView } from "./features/library/HomeView";
import { LibraryView } from "./features/library/LibraryView";
import { HistoryView } from "./features/history/HistoryView";
import { LyricsView } from "./features/lyrics/LyricsView";
import { MiniPlayer } from "./features/player/MiniPlayer";
import { PlayerBar } from "./features/player/PlayerBar";
import { PlayerLayoutMotion, type PlayerLayout } from "./features/player/PlayerLayoutMotion";
import { useMiniWindow } from "./features/player/useMiniWindow";
import { QueuePanel } from "./features/player/QueuePanel";
import { SettingsView } from "./features/settings/SettingsView";
import { StatsView } from "./features/stats/StatsView";
import { usePlayer } from "./state/playerStore";
import { useUi, type Route } from "./state/uiStore";

function NowPlayingRoute() {
  const track = useCurrentTrack();
  const item = useCurrentMediaItem();
  const playing = usePlayer(state => state.isPlaying);
  const fullscreen = useUi(state => state.fullscreenLyrics);
  const setFullscreen = useUi(state => state.setFullscreenLyrics);
  const navigate = useUi(state => state.navigate);
  return (
    <LyricsView
      track={track}
      item={item}
      playing={playing}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen(!fullscreen)}
      onOpenSearch={() => navigate({ name: "settings" })}
    />
  );
}

function renderRoute(route: Route) {
  switch (route.name) {
    case "home":
      return <HomeView />;
    case "history":
      return <HistoryView />;
    case "stats":
      return <StatsView />;
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
      return <NowPlayingRoute />;
    case "decode-tester":
      return <DecodeTesterView />;
    case "settings":
      return <SettingsView />;
    default:
      return <HomeView />;
  }
}

/**
 * Shared feedback toast. `uiStore.showToast` is called from Settings, the playlist picker and
 * bootstrap, but nothing rendered it, so those confirmations (including "Clear lyrics cache")
 * were invisible. The lyrics view keeps its own toast for in-view messages.
 */
function AppToast() {
  const toast = useUi(state => state.toast);
  // The store clears the message on its own lifetime timer; presence adds only the fast
  // fade-out, rendering the last message so the toast never blanks before it leaves.
  const presence = usePresence(Boolean(toast));
  const renderedToast = useLastNonNull(toast);
  if (!presence.mounted || !renderedToast) return null;
  return (
    <div className={`toast ${presence.phaseClass}`} data-presence={presence.phase} role="status" data-testid="app-toast">
      {renderedToast}
    </div>
  );
}

const scrollMemory = new Map<string, number>();

export function App() {
  useBootstrap();
  // Autofetch: lyrics lookup begins on every track change, whichever tab is open.
  useAutofetchLyrics();
  useLastFmScrobbler();

  const settingsLoaded = useSettings(state => state.loaded);
  const folderCount = useLibrary(state => state.snapshot?.folders.length ?? null);
  const trackCount = useLibrary(state => state.snapshot?.tracks.length ?? null);
  const maybeAutoShowOnboarding = useOnboarding(state => state.maybeAutoShow);
  useEffect(() => {
    // First launch only (no folders yet, onboarding never completed); latched in the store.
    if (settingsLoaded && folderCount !== null && trackCount !== null) {
      maybeAutoShowOnboarding(folderCount, trackCount);
    }
  }, [settingsLoaded, folderCount, trackCount, maybeAutoShowOnboarding]);
  const fullscreenLyrics = useUi(state => state.fullscreenLyrics);
  const miniRequested = useUi(state => state.miniPlayer);
  const reducedMotion = useReducedMotion();
  const { mini: miniPlayer, staging } = useMiniWindow(miniRequested, reducedMotion);
  const route = useUi(state => state.route);
  const error = usePlayer(state => state.error);
  const chrome = useWindowChrome();

  const immersive = fullscreenLyrics && route.name === "lyrics";
  // The title bar is only drawn when the OS frame is off (Windows); immersive and native fullscreen
  // hand the whole window to the content.
  const titleBar = chrome.undecorated && !chrome.fullscreen && !immersive;

  const viewKey = route.name === "search" ? "search" : `${route.name}-${JSON.stringify(route)}`;
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const top = scrollMemory.get(viewKey);
    if (top) contentRef.current?.scrollTo({ top, behavior: "instant" });
  }, [viewKey, miniPlayer]);

  const layout: PlayerLayout = miniPlayer ? "mini" : immersive ? "fullscreen" : route.name === "lyrics" ? "now-playing" : "library";
  return (
    <PlayerLayoutMotion layout={layout} reducedMotion={reducedMotion}>
      {miniPlayer ? (
        <div className="mini-shell" data-mini-staging={staging || undefined}>
          <MiniPlayer />
          <AppToast />
        </div>
      ) : (
        <div className={`app-shell ${immersive ? "is-immersive" : ""} ${titleBar ? "has-title-bar" : ""}`} data-route={route.name}>
          {titleBar ? <WindowTitleBar chrome={chrome} /> : null}
          {!immersive ? <Sidebar /> : null}
          <main className="app-main">
            {error && !immersive ? (
              <div className="error-banner" role="alert">
                {error}
                <button type="button" onClick={() => usePlayer.getState().setError(null)}>
                  Dismiss
                </button>
              </div>
            ) : null}
            <div
              className="content-scroll"
              key={viewKey}
              ref={contentRef}
              onScroll={event => scrollMemory.set(viewKey, event.currentTarget.scrollTop)}
            >
              {renderRoute(route)}
            </div>
          </main>
          {!immersive ? <PlayerBar /> : null}
          <QueuePanel />
          <PlaylistPicker />
          <TrackEditor />
          <ShortcutsHelp />
          <AppToast />
          <Onboarding />
        </div>
      )}
    </PlayerLayoutMotion>
  );
}
