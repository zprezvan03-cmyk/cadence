/**
 * The Now Playing page (route `lyrics`): the upstream Braccato renderer over the upstream Kawarp
 * shader background, with Cadence's dock, provider picker and translation controls. In fullscreen
 * it is the single Now Playing view: artwork on the left, lyrics on the right, and the audio controls
 * and lyrics on/off toggle along the bottom. Written for Cadence.
 */

import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Minimize2, Music4, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import type { AppSettings, NowPlayingProfile, Track } from "../../../shared/types";
import { DEFAULT_PROVIDER_ORDER } from "../../../shared/upstream/better-lyrics/constants";
import {
  cloneNowPlayingProfile,
  getActiveNowPlayingProfile,
  getEffectiveNowPlayingProfile,
  getNowPlayingAnimationCacheKey,
  listNowPlayingProfiles,
  resolveNowPlayingProfileConfig,
} from "../../../shared/nowPlayingProfiles";
import { fontStack } from "../../../shared/fonts";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import { BraccatoLyrics } from "./BraccatoLyrics";
import { LyricsDock } from "./LyricsDock";
import { FullscreenControls } from "./FullscreenControls";
import { Artwork } from "../../components/Artwork";
import { useControlsHover } from "./useControlsHover";
import { NowPlayingBackground } from "./NowPlayingBackground";
import { CustomizationStudio, type StudioSavePayload } from "./CustomizationStudio";
import { useLyrics } from "./useLyrics";
import { buildThemeCss } from "../../upstream/better-lyrics/themes";
import { useLastNonNull, usePresence } from "../../app/usePresence";

export interface LyricsViewProps {
  track: Track | null;
  playing: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenSearch?: () => void;
}

function clampFinite(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value as number)) : fallback;
}

export function LyricsView({ track, playing, fullscreen, onToggleFullscreen, onOpenSearch }: LyricsViewProps) {
  const settings = useSettings(state => state.settings);
  const patchSettings = useSettings(state => state.patch);
  const [toast, setToast] = useState<string | null>(null);
  const toastPresence = usePresence(toast !== null);
  const renderedToast = useLastNonNull(toast);
  // Local files resolve almost instantly; only a wait the listener can notice earns a loading card.
  const [slowLoading, setSlowLoading] = useState(false);
  const [syncLabel, setSyncLabel] = useState("No lyrics");
  const [dockPopoverOpen, setDockPopoverOpen] = useState(false);
  const queueOpen = useUi(state => state.queueOpen);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const fsArtworkRef = useRef<HTMLDivElement | null>(null);
  const fsPanelArtRef = useRef<HTMLDivElement | null>(null);
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

  // Restart only the artwork wrapper's entrance on a real track change. The Artwork component
  // itself stays mounted, so its decode/fallback state and layout do not jump.
  useLayoutEffect(() => {
    if (track?.id === undefined || track?.id === null) return;
    for (const node of [fsArtworkRef.current, fsPanelArtRef.current]) {
      if (!node) continue;
      node.classList.remove("is-swapping");
      void node.offsetWidth;
      node.classList.add("is-swapping");
    }
  }, [track?.id]);

  const lyricsSettings = settings?.lyrics;
  const shaderSettings = settings?.shaders;
  const nowPlayingProfilesSettings = settings?.nowPlayingProfiles;
  // The Studio edits a draft clone; while it exists the view renders the draft so
  // every control previews live on this same tree, and nothing reaches settings
  // until Save. Playback, the lyrics clock and scroll state are never touched.
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioDraft, setStudioDraft] = useState<NowPlayingProfile | null>(null);
  const studioPresence = usePresence(studioOpen);
  const activeNowPlayingProfile = useMemo(
    () =>
      studioDraft ??
      getEffectiveNowPlayingProfile(nowPlayingProfilesSettings, fullscreen),
    [fullscreen, nowPlayingProfilesSettings, studioDraft]
  );
  const availableNowPlayingProfiles = useMemo(
    () => listNowPlayingProfiles(nowPlayingProfilesSettings),
    [nowPlayingProfilesSettings]
  );
  const nowPlayingProfileConfig = useMemo(
    () =>
      studioDraft
        ? fullscreen
          ? studioDraft.fullscreen
          : studioDraft.windowed
        : resolveNowPlayingProfileConfig(nowPlayingProfilesSettings, fullscreen),
    [fullscreen, nowPlayingProfilesSettings, studioDraft]
  );
  const profileConfig = nowPlayingProfileConfig;
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

  // The renderer caches every CSS value it reads into JS — karaoke swipe/glow
  // switches, glow radius, letter emphasis, active-line scale — and only
  // re-reads them when a theme is applied (its setTheme clears the style
  // caches). Profile values travel through inherited --np-* variables, which
  // plain CSS follows instantly but that JS cache does not, so the theme
  // carries a generation key built from exactly the JS-read profile values:
  // when one changes, the wrapper reapplies the theme and the next line
  // animates with the new values. Without this, karaoke style changes appear
  // to do nothing until the next track. The comment uses a colon, so the
  // renderer's theme-setting parser never treats it as a setting.
  const themeCss = useMemo(() => {
    if (!lyricsSettings) return "";
    const key = getNowPlayingAnimationCacheKey(profileConfig);
    return `${buildThemeCss(lyricsSettings)}\n/* cadence-anim-key: ${key} */`;
  }, [lyricsSettings, profileConfig]);

  // Legacy typography settings were authored against a 48px (3rem) main lyric. Their
  // ratios multiply the container-derived fluid base in `lyrics.css`; the active
  // profile's mode-specific proportions then layer on that user-chosen base. Balanced
  // uses 1× throughout, so the reference rendering remains the pre-profile result.
  const nowPlayingScaleStyle = useMemo<CSSProperties>(() => {
    const fontSizeRem = clampFinite(lyricsSettings?.fontSizeRem, 3, 1.4, 6);
    const translationFontSizePx = clampFinite(
      lyricsSettings?.translationFontSizePx,
      32,
      10,
      48
    );
    const romanizationFontSizePx = clampFinite(
      lyricsSettings?.romanizationFontSizePx,
      26,
      10,
      48
    );
    const cfg = nowPlayingProfileConfig;
    const karaoke = {
      sweep: { swipe: 1, glow: 1, fade: 1 },
      solid: { swipe: 0, glow: 0, fade: 1 },
      gradient: { swipe: 1, glow: 0, fade: 1 },
      glow: { swipe: 1, glow: 1, fade: 1 },
      minimal: { swipe: 0, glow: 0, fade: 1 },
    }[cfg.karaokeStyle];
    const style: Record<string, string | number> = {
      "--np-lyrics-font-scale": (fontSizeRem / 3) * cfg.lyricsScale,
      "--np-translation-font-ratio": (translationFontSizePx / 48) * cfg.translationScale,
      "--np-romanization-font-ratio": (romanizationFontSizePx / 48) * cfg.romanizationScale,
      "--np-profile-artwork-scale": cfg.artworkScale,
      "--np-profile-title-scale": cfg.titleScale,
      "--np-profile-metadata-scale": cfg.metadataScale,
      "--np-profile-controls-scale": cfg.controlsScale,
      "--np-profile-spacing-scale": cfg.spacingScale,
      "--np-profile-lyrics-max-width": `${cfg.lyricsMaxWidth}px`,
      "--np-lyrics-align": cfg.lyricsAlignment,
      "--np-line-spacing-scale": cfg.lineSpacingScale,
      "--np-letter-spacing": `${cfg.letterSpacingEm}em`,
      "--np-inactive-opacity-scale": cfg.inactiveOpacityScale,
      "--np-active-line-scale": cfg.activeLineScale,
      "--np-inactive-blur": `${cfg.inactiveBlurPx}px`,
      "--np-karaoke-swipe": karaoke.swipe,
      "--np-karaoke-glow": karaoke.glow,
      "--np-karaoke-fade": karaoke.fade,
      // Subtle glow is its own look, not just Progressive sweep renamed: the same
      // wipe with a wider, softer halo (1.6x radius) and no letter pop, so the
      // emphasis sits in the bloom around the word instead of its motion.
      "--np-karaoke-glow-radius": `${(
        0.8 * cfg.karaokeIntensity * (cfg.karaokeStyle === "glow" ? 1.6 : 1)
      ).toFixed(3)}rem`,
      "--np-active-word-scale":
        cfg.karaokeStyle === "minimal" || cfg.karaokeStyle === "glow"
          ? 1
          : cfg.activeWordScale,
    };
    if (cfg.lyricsWeight > 0) style["--np-lyrics-weight"] = cfg.lyricsWeight;
    if (cfg.fontId) style["--blyrics-font-family"] = fontStack(cfg.fontId);
    if (cfg.translationFontId) {
      style["--blyrics-translated-font-family"] = fontStack(cfg.translationFontId);
    }
    if (cfg.romanizationFontId) {
      style["--np-romanization-font"] = fontStack(cfg.romanizationFontId);
    }
    if (cfg.activeColor) style["--np-active-color"] = cfg.activeColor;
    if (cfg.inactiveColor) style["--np-inactive-color"] = cfg.inactiveColor;
    return style as CSSProperties;
  }, [
    lyricsSettings?.fontSizeRem,
    lyricsSettings?.translationFontSizePx,
    lyricsSettings?.romanizationFontSizePx,
    nowPlayingProfileConfig,
  ]);

  const patchLyrics = useCallback(
    (patch: Partial<NonNullable<AppSettings["lyrics"]>>) => {
      void patchSettings({ lyrics: patch });
    },
    [patchSettings]
  );

  const handleSelectNowPlayingProfile = useCallback(
    (profileId: string) => {
      const context = nowPlayingProfilesSettings?.contextSwitching;
      void patchSettings({
        nowPlayingProfiles: {
          activeProfileId: profileId,
          ...(context?.enabled
            ? {
                contextSwitching: {
                  ...context,
                  ...(fullscreen
                    ? { fullscreenProfileId: profileId }
                    : { windowedProfileId: profileId }),
                },
              }
            : {}),
        },
      });
    },
    [fullscreen, nowPlayingProfilesSettings?.contextSwitching, patchSettings]
  );

  const openStudio = useCallback(() => {
    setStudioDraft(
      cloneNowPlayingProfile(
        getEffectiveNowPlayingProfile(nowPlayingProfilesSettings, fullscreen)
      )
    );
    setStudioOpen(true);
  }, [fullscreen, nowPlayingProfilesSettings]);

  const closeStudio = useCallback(() => {
    setStudioOpen(false);
    setStudioDraft(null);
  }, []);

  const saveStudio = useCallback(
    (payload: StudioSavePayload) => {
      void patchSettings({
        nowPlayingProfiles: {
          customProfiles: payload.customProfiles,
          activeProfileId: payload.activeProfileId,
          contextSwitching: payload.contextSwitching,
        },
      });
      setStudioOpen(false);
      setStudioDraft(null);
    },
    [patchSettings]
  );

  useEffect(() => {
    if (lyrics.status === "loading" && !lyrics.hasLyrics) setSyncLabel("Loading…");
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
    <div className="lyrics-heading" key={track?.id ?? "none"}>
      <h1>{track?.title ?? "Nothing playing"}</h1>
      <p>{track ? [track.artist, track.album].filter(Boolean).join(" · ") : "Pick a song from your library"}</p>
    </div>
  );

  // "Loading", "no lyrics" and "could not load" all replace the lyric lines, so the body centres
  // that card instead of scrolling it below a full-height lyric host (or, worse, leaving the
  // previous track's lines on screen while the new track resolves). A same-track Autofetch
  // upgrade pass is *not* a status panel: fallback lyrics stay on screen while it runs.
  const statusPanel =
    track !== null &&
    ((slowLoading && !lyrics.hasLyrics) || lyrics.status === "empty" || lyrics.status === "error");

  const headingInSide =
    fullscreen && showLyricsSetting && profileConfig.metadataSlot === "artwork" && profileConfig.metadataVisible;
  const showSide =
    fullscreen && showLyricsSetting && (profileConfig.artworkVisible || headingInSide);
  const headingInHeader =
    profileConfig.metadataVisible &&
    (!fullscreen || (showLyricsSetting && profileConfig.metadataSlot === "top"));

  return (
    <div
      ref={viewRef}
      className={[
        "lyrics-view",
        fullscreen ? "is-fullscreen" : "",
        panelMode ? "is-lyrics-off" : "",
        profileConfig.artworkSlot === "right" ? "artwork-right" : "",
        fullscreen && showLyricsSetting && !showSide ? "has-no-side" : "",
      ].join(" ")}
      style={nowPlayingScaleStyle}
      data-testid="lyrics-view"
      data-now-playing-profile={activeNowPlayingProfile.id}
      data-profile-mode={fullscreen ? "fullscreen" : "windowed"}
      data-profile-artwork={profileConfig.artworkVisible ? "visible" : "hidden"}
      data-profile-background={profileConfig.backgroundMode}
      data-profile-dock={profileConfig.dockVisible ? "visible" : "hidden"}
      data-profile-controls={profileConfig.controlsVisible ? "visible" : "hidden"}
      data-profile-blur={profileConfig.inactiveBlurPx > 0 ? "on" : "off"}
      data-profile-active-color={profileConfig.activeColor ? "custom" : "theme"}
      data-profile-inactive-color={profileConfig.inactiveColor ? "custom" : "theme"}
    >
      <NowPlayingBackground
        mode={profileConfig.backgroundMode}
        artworkUrl={track?.artworkUrl ?? null}
        animatedArtUrl={track?.animatedArtUrl ?? null}
        shaderSettings={shaderSettings ?? settings.shaders}
        playing={playing}
        verbose={settings.advanced.showLogs}
        intensity={profileConfig.backgroundIntensity}
        blurPx={profileConfig.backgroundBlurPx}
        speed={profileConfig.effectSpeed}
        density={profileConfig.effectDensity}
        accentColor={track?.accentColor ?? null}
        fallbackAccent={settings.appearance.accent}
      />

      {showSide ? (
        <div className="fs-side">
          <div className="fs-artwork" ref={fsArtworkRef}>
            <Artwork src={track?.artworkUrl} alt={track?.album ?? "Artwork"} size="hero" />
          </div>
          {headingInSide ? heading : null}
        </div>
      ) : null}

      <div className="lyrics-header">
        {headingInHeader ? heading : null}
        <button
          type="button"
          className="np-customize-button"
          onClick={openStudio}
          aria-label="Customize Now Playing"
          title="Customize Now Playing"
          data-testid="customize-now-playing"
        >
          <SlidersHorizontal size={16} /> Customize
        </button>
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
          <div className="fs-panel-art" ref={fsPanelArtRef}>
            <Artwork src={track?.artworkUrl} alt={track?.album ?? "Artwork"} size="hero" />
          </div>
          <div className="fs-panel">
            {profileConfig.metadataVisible ? heading : null}
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
            trackId={track.id}
            sourceKey={lyrics.activeSource}
            themeCss={themeCss}
            offsetMs={lyricsSettings?.offsetMs ?? 0}
            passiveScroll={lyricsSettings?.passiveScroll ?? true}
            fontFamily={profileConfig.fontId || settings.appearance.fontFamily}
            songwriters={lyrics.parsed?.songwriters ?? []}
            language={lyrics.parsed?.language ?? null}
            noLyrics={lyrics.status === "empty"}
            loaderVisible={lyrics.status === "loading" && !lyrics.hasLyrics}
            onError={handleError}
          />
        ) : (
          <div className="lyrics-empty">
            <Music4 size={40} />
            <h2>Your lyrics live here</h2>
            <p>Play something from your library and the lyrics will follow the audio clock.</p>
          </div>
        )}

        {track && lyrics.status === "loading" && slowLoading && !lyrics.hasLyrics ? (
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
            nowPlayingProfiles={availableNowPlayingProfiles}
            activeNowPlayingProfileId={activeNowPlayingProfile.id}
            onSelectNowPlayingProfile={handleSelectNowPlayingProfile}
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

      {studioPresence.mounted && studioDraft && nowPlayingProfilesSettings ? (
        <CustomizationStudio
          profilesSettings={nowPlayingProfilesSettings}
          draft={studioDraft}
          onDraftChange={setStudioDraft}
          initialMode={fullscreen ? "fullscreen" : "windowed"}
          onSave={saveStudio}
          onClose={closeStudio}
          phaseClass={studioPresence.phaseClass}
          phase={studioPresence.phase}
        />
      ) : null}

      {toastPresence.mounted && renderedToast ? (
        <div className={`toast ${toastPresence.phaseClass}`} data-presence={toastPresence.phase} role="status" data-testid="toast">
          {renderedToast}
        </div>
      ) : null}
    </div>
  );
}

const fallbackLyricsSettings: AppSettings["lyrics"] = {
  providerOrder: [...DEFAULT_PROVIDER_ORDER],
  autoFetch: true,
  notFoundCooldownDays: 7,
  fetchConcurrency: "balanced",
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
