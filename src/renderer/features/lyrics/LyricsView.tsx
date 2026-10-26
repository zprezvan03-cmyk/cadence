/**
 * The Now Playing page (route `lyrics`): the upstream Braccato renderer over the upstream Kawarp
 * shader background, with Cadence's dock, provider picker and translation controls. In fullscreen
 * it is the single Now Playing view: artwork on the left, lyrics on the right, and the audio controls
 * and lyrics on/off toggle along the bottom. Written for Cadence.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Minimize2, Music4, RefreshCw, Search } from "lucide-react";
import type { AppSettings, Track } from "../../../shared/types";
import { DEFAULT_PROVIDER_ORDER } from "../../../shared/upstream/better-lyrics/constants";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import { BraccatoLyrics } from "./BraccatoLyrics";
import { LyricsDock } from "./LyricsDock";
import { FullscreenControls } from "./FullscreenControls";
import { Artwork } from "../../components/Artwork";
import { useControlsHover } from "./useControlsHover";
import { KawarpBackground } from "../shaders/KawarpBackground";
import { useLyrics } from "./useLyrics";
import { buildThemeCss } from "../../upstream/better-lyrics/themes";

export interface LyricsViewProps {
  track: Track | null;
  playing: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenSearch?: () => void;
}

export function LyricsView({ track, playing, fullscreen, onToggleFullscreen, onOpenSearch }: LyricsViewProps) {
  const settings = useSettings(state => state.settings);
  const patchSettings = useSettings(state => state.patch);
  const [toast, setToast] = useState<string | null>(null);
  // Local files resolve almost instantly; only a wait the listener can notice earns a loading card.
  const [slowLoading, setSlowLoading] = useState(false);
  const [syncLabel, setSyncLabel] = useState("No lyrics");
  const [dockPopoverOpen, setDockPopoverOpen] = useState(false);
  const queueOpen = useUi(state => state.queueOpen);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  // Fullscreen only: the controls show while the pointer is over them and fade out when it leaves,
  // unless a popover or the queue is open.
  // Fullscreen with lyrics on: the footer (controls and dock) is shown over the lyrics. Fullscreen with
  // lyrics off: the artwork and the controls form a panel instead, with no footer.
  const showLyricsSetting = settings?.lyrics?.showLyricsInFullscreen ?? true;
  const footerPresent = fullscreen && showLyricsSetting;
  const panelMode = fullscreen && !showLyricsSetting;
  const controlsVisible = useControlsHover(footerPresent, dockPopoverOpen || queueOpen, footerRef);

  // Fullscreen only: the controls overlay the bottom of the lyrics body instead of taking space from it.
  // The footer's measured height is published to the view as --fs-footer-height, so the body keeps its
  // lines above the controls and the toast clears them, at any window size and whatever the dock's wrap.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const footer = footerRef.current;
    if (!footerPresent || !view || !footer) return;
    const publish = () => view.style.setProperty("--fs-footer-height", `${footer.offsetHeight}px`);
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(publish);
    observer.observe(footer);
    return () => {
      observer.disconnect();
      view.style.removeProperty("--fs-footer-height");
    };
  }, [footerPresent]);

  const lyricsSettings = settings?.lyrics;
  const shaderSettings = settings?.shaders;
  const showLyrics = lyricsSettings?.showLyricsInFullscreen ?? true;
  // The toggle only applies in fullscreen; the normal page always shows lyrics.
  const lyricsVisible = !fullscreen || showLyrics;

  const lyrics = useLyrics(track ?? null, lyricsSettings ?? fallbackLyricsSettings);

  useEffect(() => {
    if (lyrics.status !== "loading") {
      setSlowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowLoading(true), 350);
    return () => window.clearTimeout(timer);
  }, [lyrics.status, track?.id]);

  const themeCss = useMemo(() => (lyricsSettings ? buildThemeCss(lyricsSettings) : ""), [lyricsSettings]);

  const patchLyrics = useCallback(
    (patch: Partial<NonNullable<AppSettings["lyrics"]>>) => {
      void patchSettings({ lyrics: patch });
    },
    [patchSettings]
  );

  useEffect(() => {
    if (lyrics.status === "loading") setSyncLabel("Loading…");
    else if (lyrics.status === "empty") setSyncLabel("Not found");
    else if (lyrics.status === "error") setSyncLabel("Error");
    else if (lyrics.syncType === "richsync") setSyncLabel("Word synced");
    else if (lyrics.syncType === "synced") setSyncLabel("Line synced");
    else if (lyrics.status === "ready") setSyncLabel("Unsynced");
    else setSyncLabel("No lyrics");
  }, [lyrics.status, lyrics.syncType]);

  const flash = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  // Stable identity so the dock's debounced YouTube lookup doesn't reset on unrelated re-renders.
  const handleResolveYouTube = useCallback(
    (url: string) => {
      void lyrics.resolveYouTube(url);
    },
    [lyrics.resolveYouTube]
  );

  const handleSave = useCallback(async () => {
    try {
      const path = await lyrics.saveSidecar();
      if (path) flash(`Lyrics saved to ${path}`);
    } catch (error) {
      flash(`Could not save lyrics: ${(error as Error).message}`);
    }
  }, [lyrics, flash]);

  const toggleLyricsVisible = useCallback(() => {
    patchLyrics({ showLyricsInFullscreen: !showLyrics });
  }, [patchLyrics, showLyrics]);

  const handleError = useCallback((message: string) => {
    console.error("[Cadence] Lyrics renderer error:", message);
    flash(message);
  }, [flash]);

  if (!settings) return <div className="view-loading">Loading…</div>;

  // The title block: in fullscreen it sits under the artwork in the left column; on the normal page it
  // is the header's heading.
  const heading = (
    <div className="lyrics-heading">
      <h1>{track?.title ?? "Nothing playing"}</h1>
      <p>{track ? [track.artist, track.album].filter(Boolean).join(" · ") : "Pick a song from your library"}</p>
    </div>
  );

  // "Loading", "no lyrics" and "could not load" all replace the lyric lines, so the body centres
  // that card instead of scrolling it below a full-height lyric host (or, worse, leaving the
  // previous track's lines on screen while the new track resolves).
  const statusPanel =
    track !== null && (slowLoading || lyrics.status === "empty" || lyrics.status === "error");

  return (
    <div
      ref={viewRef}
      className={`lyrics-view ${fullscreen ? "is-fullscreen" : ""} ${panelMode ? "is-lyrics-off" : ""}`}
      data-testid="lyrics-view"
    >
      <KawarpBackground
        artworkUrl={track?.artworkUrl ?? null}
        animatedArtUrl={track?.animatedArtUrl ?? null}
        settings={shaderSettings ?? settings.shaders}
        playing={playing}
        verbose={settings.advanced.showLogs}
      />

      {fullscreen && showLyricsSetting ? (
        <div className="fs-side">
          <div className="fs-artwork">
            <Artwork src={track?.artworkUrl} alt={track?.album ?? "Artwork"} size="hero" />
          </div>
          {heading}
        </div>
      ) : null}

      <div className="lyrics-header">
        {fullscreen ? null : heading}
        {/* One exit button, top-right, in both fullscreen layouts. */}
        {fullscreen ? (
          <button
            type="button"
            className="icon-button fs-exit"
            onClick={onToggleFullscreen}
            aria-label={panelMode ? "Exit fullscreen" : "Exit fullscreen lyrics"}
            title={panelMode ? "Exit fullscreen (Esc)" : "Exit fullscreen lyrics (Esc)"}
          >
            <Minimize2 size={18} />
          </button>
        ) : null}
        {panelMode ? <span className="eyebrow fs-eyebrow">Now playing</span> : null}
      </div>

      {panelMode ? (
        <div className="fs-panel-layout">
          <div className="fs-panel-art">
            <Artwork src={track?.artworkUrl} alt={track?.album ?? "Artwork"} size="hero" />
          </div>
          <div className="fs-panel">
            {heading}
            <FullscreenControls
              variant="panel"
              track={track}
              showLyrics={showLyrics}
              onToggleLyrics={toggleLyricsVisible}
            />
          </div>
        </div>
      ) : null}

      <div
        className={`lyrics-body ${lyricsVisible ? "" : "is-hidden"} ${
          statusPanel ? "has-status-panel" : ""
        }`}
      >
        {track ? (
          <BraccatoLyrics
            lyrics={lyricsSettings?.hideInstrumentalOnly && lyrics.parsed?.instrumentalOnly ? [] : lyrics.lyrics}
            themeCss={themeCss}
            offsetMs={lyricsSettings?.offsetMs ?? 0}
            passiveScroll={lyricsSettings?.passiveScroll ?? true}
            fontFamily={settings.appearance.fontFamily}
            songwriters={lyrics.parsed?.songwriters ?? []}
            language={lyrics.parsed?.language ?? null}
            noLyrics={lyrics.status === "empty"}
            loaderVisible={lyrics.status === "loading"}
            onError={handleError}
          />
        ) : (
          <div className="lyrics-empty">
            <Music4 size={40} />
            <h2>Your lyrics live here</h2>
            <p>Play something from your library and the lyrics will follow the audio clock.</p>
          </div>
        )}

        {track && lyrics.status === "loading" && slowLoading ? (
          <div className="lyrics-empty-panel loading" role="status" data-testid="lyrics-loading-panel">
            <div className="lyrics-empty-icon" aria-hidden="true">
              <RefreshCw size={20} className="spin" />
            </div>
            <h2>Finding lyrics…</h2>
            <p>Checking local files, embedded tags and your enabled providers.</p>
          </div>
        ) : null}

        {track && lyrics.status === "empty" ? (
          <div className="lyrics-empty-panel" data-testid="lyrics-empty-panel">
            <div className="lyrics-empty-icon" aria-hidden="true">
              <Music4 size={20} />
            </div>
            <h2>No lyrics found</h2>
            <p>
              {lyricsSettings?.autoFetch ? (
                <>
                  Cadence checked sidecar <code>.lrc</code>/<code>.ttml</code>/<code>.qrc</code> files, embedded
                  tags, and enabled online providers (Better Lyrics, Unison, BiniLyrics, LRCLIB).
                  {lyrics.providerStatus.some(entry => entry.status === "error")
                    ? ` Some providers reported an issue (${lyrics.providerStatus.find(entry => entry.status === "error")?.detail ?? "request failed"}).`
                    : ""}
                </>
              ) : (
                <>
                  Cadence checked sidecar <code>.lrc</code>/<code>.ttml</code>/<code>.qrc</code> files and embedded
                  tags (online lyrics lookup is turned off).
                </>
              )}
            </p>
            <div className="empty-actions">
              <button type="button" className="primary" onClick={() => void lyrics.chooseFile()}>
                <Search size={16} /> Choose a lyrics file
              </button>
              <button type="button" onClick={lyrics.reload}>
                <RefreshCw size={16} /> Try again
              </button>
              {!lyricsSettings?.autoFetch && onOpenSearch ? (
                <button type="button" onClick={onOpenSearch}>
                  Enable online lyrics in settings
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {track && lyrics.status === "error" ? (
          <div className="lyrics-empty-panel error" data-testid="lyrics-error-panel">
            <div className="lyrics-empty-icon" aria-hidden="true">
              <RefreshCw size={20} />
            </div>
            <h2>Lyrics could not be loaded</h2>
            <p>{lyrics.error}</p>
            <div className="empty-actions">
              <button type="button" onClick={lyrics.reload}>
                <RefreshCw size={16} /> Retry
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {panelMode ? null : (
      <div ref={footerRef} className="lyrics-footer">
        {fullscreen ? (
          <FullscreenControls
            track={track}
            showLyrics={showLyrics}
            onToggleLyrics={toggleLyricsVisible}
            concealed={!controlsVisible}
          />
        ) : null}

        {track ? (
          <LyricsDock
            settings={lyricsSettings ?? fallbackLyricsSettings}
            onPatch={patchLyrics}
            candidates={lyrics.candidates}
            activeSource={lyrics.activeSource}
            onSelectSource={lyrics.selectSource}
            providerStatus={lyrics.providerStatus}
            onReload={lyrics.reload}
            onSaveSidecar={() => void handleSave()}
            onChooseFile={() => void lyrics.chooseFile()}
            trackDuration={track?.duration ?? 0}
            searchDraft={lyrics.searchDraft}
            onDraftChange={lyrics.patchDraft}
            onClearSearch={lyrics.clearSearch}
            manualSearchState={lyrics.manualSearchState}
            youtubeState={lyrics.youtubeState}
            onManualSearch={input => void lyrics.manualSearch(input)}
            onResolveYouTube={handleResolveYouTube}
            onSelectSearchResult={lyrics.selectSearchResult}
            syncLabel={syncLabel}
            busy={lyrics.status === "loading" || lyrics.translating || lyrics.romanizing}
            concealed={!controlsVisible}
            onPopoverChange={setDockPopoverOpen}
          />
        ) : null}
      </div>
      )}

      {toast ? (
        <div className="toast" role="status" data-testid="toast">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

const fallbackLyricsSettings: AppSettings["lyrics"] = {
  providerOrder: [...DEFAULT_PROVIDER_ORDER],
  autoFetch: true,
  offsetMs: 0,
  translationLanguage: "",
  romanization: false,
  themeId: "default",
  customThemeCss: "",
  fontSizeRem: 3,
  fontWeight: 700,
  lineHeight: 1.333,
  translationFontSizePx: 32,
  romanizationFontSizePx: 26,
  activeOpacity: 1,
  inactiveOpacity: 0.3,
  targetScrollRatio: 0.5,
  showCredits: true,
  hideInstrumentalOnly: false,
  passiveScroll: true,
  fullscreenOnOpen: false,
  showLyricsInFullscreen: true,
};
