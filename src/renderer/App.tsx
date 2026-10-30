/**
 * Application shell. Written for Cadence.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { useCurrentTrack } from "./app/hooks";
import { useAutofetchLyrics } from "./features/lyrics/useAutofetch";
import { Onboarding } from "./features/onboarding/Onboarding";
import { useLibrary } from "./state/libraryStore";
import { useOnboarding } from "./state/onboardingStore";
import { useSettings } from "./state/settingsStore";
import { PlaylistPicker } from "./app/PlaylistPicker";
import { Sidebar } from "./app/Sidebar";
import { TopBar } from "./app/TopBar";
import { useWindowChrome, WindowTitleBar } from "./app/WindowTitleBar";
import { useBootstrap } from "./app/useBootstrap";
import { useLastNonNull, usePresence } from "./app/usePresence";
import { DecodeTesterView } from "./features/decode-tester/DecodeTesterView";
import { AlbumView, ArtistView, PlaylistView, SearchView } from "./features/library/DetailViews";
import { HomeView } from "./features/library/HomeView";
import { LibraryView } from "./features/library/LibraryView";
import { HistoryView } from "./features/history/HistoryView";
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
    case "history":
      return <HistoryView />;
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

/**
 * Scroll offsets per view, kept for the session. Views remount on navigation (that is what gives
 * each one its entering animation), so without this the list you were halfway down would throw you
 * back to the top every time you looked at an album and came back.
 */
const scrollMemory = new Map<string, number>();

export function App() {
  useBootstrap();
  // Autofetch: lyrics lookup begins on every track change, whichever tab is open.
  useAutofetchLyrics();

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
  const route = useUi(state => state.route);
  const error = usePlayer(state => state.error);
  const chrome = useWindowChrome();

  // One key per view instance. The search query is deliberately not part of it: typing in the
  // global search is not a page change, and remounting the results on every keystroke made them
  // flicker. Library tabs keep separate keys so switching Songs → Albums still animates.
  const viewKey = route.name === "search" ? "search" : `${route.name}-${JSON.stringify(route)}`;
  const contentRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const saved = scrollMemory.get(viewKey) ?? 0;
    if (!saved) return;
    // `scroll-behavior: smooth` is for user scrolling; a restored position must be immediate.
    node.style.scrollBehavior = "auto";
    node.scrollTop = saved;
    node.style.scrollBehavior = "";
  }, [viewKey]);

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
        <div
          className="content-scroll"
          key={viewKey}
          ref={contentRef}
          onScroll={event => scrollMemory.set(viewKey, event.currentTarget.scrollTop)}
        >
          <RouteContent />
        </div>
        {!immersive ? <PlayerBar /> : null}
      </main>
      <QueuePanel />
      <PlaylistPicker />
      <AppToast />
      <Onboarding />
    </div>
  );
}
