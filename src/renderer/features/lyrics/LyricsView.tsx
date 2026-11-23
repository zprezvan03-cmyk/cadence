/**
 * Now Playing: Braccato, the artwork background and the live playback controls. The old
 * windowed route remains readable for saved links; the player opens the immersive view.
 */

import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Disc3, Minimize2, Music4, RefreshCw, Search } from "lucide-react";
import { trackSourceKey } from "../../../shared/media";
import type { AppSettings, MediaItem, NowPlayingLayoutMode, NowPlayingProfile, Track } from "../../../shared/types";
import { DEFAULT_PROVIDER_ORDER } from "../../../shared/upstream/better-lyrics/constants";
import {
  getEffectiveNowPlayingProfile,
  getLyricsOffNowPlayingProfile,
  getNowPlayingAnimationCacheKey,
  listNowPlayingProfiles,
} from "../../../shared/nowPlayingProfiles";
import { fontStack } from "../../../shared/fonts";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import { SourceBadge } from "../../components/SourceBadge";
import { MarqueeText } from "../../components/MarqueeText";
import { BraccatoLyrics } from "./BraccatoLyrics";
import { LyricsDock } from "./LyricsDock";
import { LyricsModeMotion } from "./LyricsModeMotion";
import {
  FullscreenBarTransport,
  FullscreenColumnControls,
  FullscreenControls,
  FullscreenInfoActions,
} from "./FullscreenControls";
import { ProgressBar } from "../player/ProgressBar";
import { PlaybackArtwork, PlaybackText } from "../player/PlaybackVisuals";
import { usePlaybackPresentation } from "../player/usePlaybackPresentation";
import { useFullscreenChrome } from "./useFullscreenChrome";
import { NowPlayingBackground } from "./NowPlayingBackground";
import { useLyrics } from "./useLyrics";
import { buildThemeCss } from "../../upstream/better-lyrics/themes";
import { useLastNonNull, usePresence } from "../../app/usePresence";

export interface LyricsViewProps {
  /** Non-null only for the current local media item; remote items never receive a fake Track. */
  track: Track | null;
  /** Unified current item from playerStore, for either local or remote playback. */
  item: MediaItem | null;
  playing: boolean;
  fullscreen: boolean;
  onExit?: () => void;
  preview?: { profile: NowPlayingProfile; mode: NowPlayingLayoutMode };
  onOpenLyricsSettings?: () => void;
}

function clampFinite(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value as number)) : fallback;
}

const NO_LYRIC_CREDITS: readonly string[] = [];

export function LyricsView({ track, item, playing, fullscreen, onExit, onOpenLyricsSettings, preview }: LyricsViewProps) {
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
  const isRemote = Boolean(item && item.source.kind !== "local");
  const itemIdentity = item ? trackSourceKey(item.source) : null;
  const mvSettings = settings?.mvBackground;
  const mvUrl =
    Boolean(item) && mvSettings?.enabled
      ? (itemIdentity && mvSettings.bindings[itemIdentity]) || (track?.mvUrl ?? null)
      : null;
  const mvErrorUrls = useRef(new Set<string>());
  const viewRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  // Lyrics On keeps the hover-only footer over the lyrics unless a popover or queue is open.
  // Lyrics Off puts its controls in the artwork panel instead.
  const showLyricsSetting = preview ? preview.mode !== "lyricsOff" : settings?.lyrics?.showLyricsInFullscreen ?? true;
  const footerPresent = fullscreen && showLyricsSetting;
  const panelMode = fullscreen && !showLyricsSetting;
  // The chrome (song-info actions, column transport, player bar, dock, page actions) follows Better
  // Lyrics' fullscreen idle rule: shown by pointer activity, hidden again after three still seconds.
  const chromePinned = dockPopoverOpen || queueOpen || Boolean(preview);
  const controlsVisible = useFullscreenChrome(fullscreen, chromePinned, footerRef);

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
  const nowPlayingProfilesSettings = settings?.nowPlayingProfiles;
  const lyricsOnProfile = useMemo(
    () => getEffectiveNowPlayingProfile(nowPlayingProfilesSettings, fullscreen),
    [fullscreen, nowPlayingProfilesSettings]
  );
  const lyricsOffProfile = useMemo(() => getLyricsOffNowPlayingProfile(nowPlayingProfilesSettings), [nowPlayingProfilesSettings]);
  const availableNowPlayingProfiles = useMemo(() => listNowPlayingProfiles(nowPlayingProfilesSettings), [nowPlayingProfilesSettings]);
  const activeNowPlayingProfile = preview?.profile ?? (panelMode ? lyricsOffProfile : lyricsOnProfile);
  const profileConfig = activeNowPlayingProfile[panelMode ? "lyricsOff" : fullscreen ? "fullscreen" : "windowed"];
  // The hidden Braccato renderer keeps its Lyrics On configuration and media clock.
  const rendererConfig = panelMode ? lyricsOnProfile.fullscreen : profileConfig;
  const { cover, text } = usePlaybackPresentation(item, fullscreen && profileConfig.artworkVisible);
  const lyricsVisible = !panelMode;

  const lyrics = useLyrics(
    isRemote ? null : track ?? null,
    lyricsSettings ?? fallbackLyricsSettings
  );

  useEffect(() => {
    if (lyrics.status !== "loading") {
      setSlowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowLoading(true), 350);
    return () => window.clearTimeout(timer);
  }, [lyrics.status, itemIdentity]);

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
    const key = getNowPlayingAnimationCacheKey(rendererConfig);
    return `${buildThemeCss(lyricsSettings)}\n/* cadence-anim-key: ${key} */`;
  }, [lyricsSettings, rendererConfig]);

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
    const cfg = rendererConfig;
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
      "--np-profile-artwork-scale": profileConfig.artworkScale,
      "--np-profile-title-scale": profileConfig.titleScale,
      "--np-profile-metadata-scale": profileConfig.metadataScale,
      "--np-profile-controls-scale": profileConfig.controlsScale,
      "--np-profile-spacing-scale": profileConfig.spacingScale,
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
    if (cfg.fontId) style["--blyrics-font-family"] = fontStack(cfg.fontId, "lyrics");
    if (cfg.translationFontId) {
      style["--blyrics-translated-font-family"] = fontStack(cfg.translationFontId, "lyrics");
    }
    if (cfg.romanizationFontId) {
      style["--np-romanization-font"] = fontStack(cfg.romanizationFontId, "lyrics");
    }
    if (cfg.activeColor) style["--np-active-color"] = cfg.activeColor;
    if (cfg.inactiveColor) style["--np-inactive-color"] = cfg.inactiveColor;
    return style as CSSProperties;
  }, [
    lyricsSettings?.fontSizeRem,
    lyricsSettings?.translationFontSizePx,
    lyricsSettings?.romanizationFontSizePx,
    profileConfig,
    rendererConfig,
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

  const handleChooseMvFile = useCallback(() => {
    if (!itemIdentity) return;
    void (async () => {
      try {
        const picked = await window.cadence.app.chooseMvFile(track?.id ?? 0);
        if (picked.canceled || !picked.url) return;
        await patchSettings({
          mvBackground: {
            enabled: true,
            bindings: { ...(mvSettings?.bindings ?? {}), [itemIdentity]: picked.url },
          },
        });
        mvErrorUrls.current.delete(picked.url);
        flash("Music video set for this track");
      } catch {
        flash("Could not set the music video");
      }
    })();
  }, [flash, itemIdentity, mvSettings?.bindings, patchSettings, track?.id]);

  // Stable identity so the dock's debounced YouTube lookup doesn't reset on unrelated re-renders.
  const handleResolveYouTube = useCallback(
    (url: string) => {
      void lyrics.resolveYouTube(url);
    },
    [lyrics.resolveYouTube]
  );

  const handleSave = useCallback(async (format: "ttml" | "lrc" = "lrc") => {
    try {
      const path = await lyrics.saveSidecar(format);
      if (path) flash(`Lyrics saved to ${path}`);
    } catch (error) {
      flash(`Could not save lyrics: ${(error as Error).message}`);
    }
  }, [lyrics, flash]);

  const handleError = useCallback((message: string) => {
    console.error("[Cadence] Lyrics renderer error:", message);
    flash(message);
  }, [flash]);

  if (!settings) return <div className="view-loading">Loading…</div>;

  const artwork = <PlaybackArtwork cover={cover} label={item?.albumLabel ?? item?.title ?? "Artwork"} size="hero" />;
  const heading = (
    <PlaybackText text={text} className="lyrics-heading" shared={fullscreen}>
      {display => (
        <>
          <MarqueeText as="h1" auto title={display?.title}>{display?.title ?? "Nothing playing"}</MarqueeText>
          <MarqueeText as="p" auto title={display?.artistLabel}>
            {display ? (
              fullscreen ? [display.artistLabel, display.albumLabel].filter(Boolean).join(" · ") : display.artistLabel
            ) : "Pick a song from your library"}
          </MarqueeText>
          {!fullscreen && display?.albumLabel ? <MarqueeText as="p" auto className="lyrics-album-label" title={display.albumLabel}>{display.albumLabel}</MarqueeText> : null}
          {display ? (
            <div className="lyrics-heading-source">
              <SourceBadge source={display} />
            </div>
          ) : null}
        </>
      )}
    </PlaybackText>
  );

  // "Loading", "no lyrics" and "could not load" all replace the lyric lines, so the body centres
  // that card instead of scrolling it below a full-height lyric host (or, worse, leaving the
  // previous track's lines on screen while the new track resolves). A same-track Autofetch
  // upgrade pass is *not* a status panel: fallback lyrics stay on screen while it runs.
  const statusPanel =
    item !== null &&
    (isRemote ||
      (slowLoading && !lyrics.hasLyrics) ||
      lyrics.status === "empty" ||
      lyrics.status === "error");

  // Better Lyrics' fullscreen column (its `#blyrics-fs-column`): the artwork, then the song-info row
  // with its favourite/volume/queue/mini-player actions, then the progress bar and transport — all
  // exactly as wide as the artwork. Profiles can drop the artwork, the metadata or the controls, and
  // the column contracts accordingly; without the controls the bar keeps the transport, as in the style
  // profiles that predate this layout.
  const headingInSide =
    fullscreen && showLyricsSetting && profileConfig.metadataSlot === "artwork" && profileConfig.metadataVisible;
  const columnControls = fullscreen && showLyricsSetting && profileConfig.controlsVisible && !preview;
  const headingInColumn = headingInSide && columnControls;
  const showSide = fullscreen && showLyricsSetting && (profileConfig.artworkVisible || headingInColumn || columnControls);
  // With no lyrics to show the artwork column stays put and the lyrics column carries the
  // reference's compact "Lyrics not found" message (see the `.np-message` rules in lyrics.css).
  const noLyrics = fullscreen && !panelMode && lyrics.status === "empty";
  const headingInHeader = profileConfig.metadataVisible && (!fullscreen || profileConfig.metadataSlot === "top");
  const panelDetailsVisible = (profileConfig.metadataVisible && !headingInHeader) || profileConfig.controlsVisible;

  // One instance of the dock: a floating pill at the bottom-right of the lyrics column in fullscreen
  // (Better Lyrics' dock position), in the footer on the windowed route and in the Studio preview.
  // It follows the fullscreen idle rule together with the rest of the chrome.
  const lyricsDock = item && track ? (
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
      onRegenerateTranslation={lyrics.regenerateTranslation}
      onRegenerateRomanization={lyrics.regenerateRomanization}
      onSaveSidecar={(format) => void handleSave(format)}
      onChooseFile={() => void lyrics.chooseFile()}
      onChooseMvFile={handleChooseMvFile}
      mvEnabled={Boolean(mvSettings?.enabled)}
      onToggleMv={() => void patchSettings({ mvBackground: { enabled: !mvSettings?.enabled } })}
      trackDuration={track.duration ?? 0}
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
      concealed={fullscreen && !controlsVisible}
      onPopoverChange={setDockPopoverOpen}
    />
  ) : null;

  return (
    <LyricsModeMotion mode={showLyricsSetting ? "on" : "off"} active={fullscreen && !preview}>
    <div
      ref={viewRef}
      className={[
        "lyrics-view",
        fullscreen ? "is-fullscreen" : "",
        preview ? "is-preview" : "",
        panelMode ? "is-lyrics-off" : "",
        profileConfig.artworkSlot === "right" ? "artwork-right" : "",
        fullscreen && showLyricsSetting && !showSide ? "has-no-side" : "",
      ].join(" ")}
      style={nowPlayingScaleStyle}
      data-testid="lyrics-view"
      data-current-source={item?.source.kind ?? "none"}
      data-current-source-key={itemIdentity ?? ""}
      data-now-playing-profile={activeNowPlayingProfile.id}
      data-profile-mode={panelMode ? "lyricsOff" : fullscreen ? "fullscreen" : "windowed"}
      data-lyrics-mode={panelMode ? "off" : "on"}
      data-no-lyrics={noLyrics ? "true" : "false"}
      data-chrome={controlsVisible ? "shown" : "hidden"}
      data-loading={item !== null && !isRemote && lyrics.status === "loading" && !lyrics.hasLyrics ? "true" : "false"}
      data-profile-artwork={profileConfig.artworkVisible ? "visible" : "hidden"}
      data-profile-metadata={profileConfig.metadataVisible ? "visible" : "hidden"}
      data-profile-background={profileConfig.backgroundMode}
      data-profile-dock={profileConfig.dockVisible ? "visible" : "hidden"}
      data-profile-controls={profileConfig.controlsVisible ? "visible" : "hidden"}
      data-profile-blur={rendererConfig.inactiveBlurPx > 0 ? "on" : "off"}
      data-profile-active-color={rendererConfig.activeColor ? "custom" : "theme"}
      data-profile-inactive-color={rendererConfig.inactiveColor ? "custom" : "theme"}
    >
      <NowPlayingBackground
        mode={profileConfig.backgroundMode}
        artworkUrl={item?.artworkUrl ?? null}
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
        mvUrl={mvUrl}
        mvEnabled={Boolean(mvSettings?.enabled)}
        mvScrimOpacity={mvSettings?.scrimOpacity ?? 0.45}
        mvRate={settings.playback.playbackRate}
        songDuration={item?.durationSeconds ?? track?.duration ?? 0}
        onMvError={(url) => {
          if (mvErrorUrls.current.has(url)) return;
          mvErrorUrls.current.add(url);
          flash("Music video unavailable — showing the regular background.");
        }}
      />

      {showSide ? (
        <div className="fs-side">
          {profileConfig.artworkVisible ? <div className="fs-artwork">{artwork}</div> : null}
          {columnControls ? (
            <div className="fs-col">
              <div className="fs-info-row">
                {headingInColumn ? heading : null}
                <FullscreenInfoActions track={track} concealed={!controlsVisible} />
              </div>
              <FullscreenColumnControls concealed={!controlsVisible} />
            </div>
          ) : headingInSide ? (
            <div className="fs-col fs-col-info-only">{heading}</div>
          ) : null}
        </div>
      ) : null}

      <div className="lyrics-header">
        {headingInHeader ? heading : null}
        {fullscreen && !preview ? (
          <div className={`fs-page-actions fs-chrome ${controlsVisible ? "" : "is-concealed"}`}>
            <div className="fs-mode-tabs" role="group" aria-label="Lyrics display">
              <button type="button" data-testid="lyrics-mode-on" aria-pressed={showLyricsSetting} onClick={() => !showLyricsSetting && patchLyrics({ showLyricsInFullscreen: true })}>
                Lyrics On
              </button>
              <button type="button" data-testid="lyrics-mode-off" aria-pressed={!showLyricsSetting} onClick={() => showLyricsSetting && patchLyrics({ showLyricsInFullscreen: false })}>
                Lyrics Off
              </button>
            </div>
            <button type="button" className="icon-button fs-exit" onClick={onExit} aria-label="Exit Now Playing" title="Exit Now Playing (Esc)">
              <Minimize2 size={18} />
            </button>
          </div>
        ) : null}
      </div>

      {panelMode && (profileConfig.artworkVisible || panelDetailsVisible) ? (
        <div className="fs-panel-layout">
          {profileConfig.artworkVisible ? <div className="fs-panel-art">{artwork}</div> : null}
          {panelDetailsVisible ? (
            <div className="fs-panel">
              {profileConfig.metadataVisible && !headingInHeader ? heading : null}
              {profileConfig.controlsVisible ? (
                <div className="fs-panel-bar" data-testid="fullscreen-controls">
                  <ProgressBar />
                  <div className="fs-panel-transport">
                    <FullscreenBarTransport />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className={`lyrics-body ${lyricsVisible ? "" : "is-hidden"} ${
          statusPanel ? "has-status-panel" : ""
        }`}
        inert={!lyricsVisible}
      >
        {item && isRemote ? (
          <div className="lyrics-empty-panel" data-testid="remote-playback-unavailable">
            <div className="lyrics-empty-icon" aria-hidden="true">
              <Music4 size={20} />
            </div>
            <h2>Remote playback unavailable</h2>
            <p>
              This saved remote item remains in your History, but no remote provider is registered
              in this build.
            </p>
          </div>
        ) : item ? (
          <BraccatoLyrics
            lyrics={lyricsSettings?.hideInstrumentalOnly && lyrics.parsed?.instrumentalOnly ? [] : lyrics.lyrics}
            trackId={track?.id ?? itemIdentity ?? item.title}
            sourceKey={lyrics.activeSource}
            themeCss={themeCss}
            offsetMs={lyricsSettings?.offsetMs ?? 0}
            passiveScroll={lyricsSettings?.passiveScroll ?? true}
            active={lyricsVisible && !statusPanel}
            fontFamily={rendererConfig.fontId || settings.appearance.fontFamily}
            songwriters={lyrics.parsed?.songwriters ?? NO_LYRIC_CREDITS}
            language={lyrics.parsed?.language ?? null}
            noLyrics={lyrics.status === "empty"}
            loaderVisible={lyrics.status === "loading" && !lyrics.hasLyrics}
            onError={handleError}
          />
        ) : (
          <div className="lyrics-empty">
            <Music4 size={40} />
            <h2>Your lyrics live here</h2>
            <p>Play something from your library and the lyrics will follow the song.</p>
          </div>
        )}

        {item && !isRemote && lyrics.status === "loading" && slowLoading && !lyrics.hasLyrics ? (
          // Better Lyrics' loader: a spinning mark beside a shimmering status line, centred in the
          // panel while the lines slide up into place behind it when they arrive.
          <div className="np-loader" role="status" data-testid="lyrics-loading-panel">
            <span className="np-loader__mark" aria-hidden="true">
              <Disc3 size={28} />
            </span>
            <span className="np-loader__text">Fetching lyrics…</span>
          </div>
        ) : null}

        {item && !isRemote && lyrics.status === "empty" ? (
          <div className="lyrics-empty-panel lyrics-unavailable" data-testid="lyrics-empty-panel">
            <p role="status" className="np-message">Lyrics not found</p>
            <div className="empty-actions">
              <button type="button" onClick={() => void lyrics.chooseFile()}>
                <Search size={16} /> Choose a lyrics file
              </button>
              <button type="button" onClick={lyrics.reload}>
                <RefreshCw size={16} /> Try again
              </button>
              {!lyricsSettings?.autoFetch && onOpenLyricsSettings ? (
                <button type="button" onClick={onOpenLyricsSettings}>
                  Enable online lyrics in settings
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {item && !isRemote && lyrics.status === "error" ? (
          <div className="lyrics-empty-panel error" data-testid="lyrics-error-panel">
            <p role="status" className="np-message np-message--error">Lyrics could not be loaded</p>
            <p className="np-error-detail">{lyrics.error}</p>
            <div className="empty-actions">
              <button type="button" onClick={lyrics.reload}>
                <RefreshCw size={16} /> Retry
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {!panelMode && fullscreen && lyricsDock ? (
        <div className={`fs-dock fs-chrome ${controlsVisible ? "" : "is-concealed"}`}>{lyricsDock}</div>
      ) : null}

      {!panelMode ? (
        <div
          ref={footerRef}
          className={`lyrics-footer fs-chrome ${fullscreen ? "is-fullscreen-bar" : ""} ${controlsVisible ? "" : "is-concealed"}`}
        >
          {fullscreen ? (
            <FullscreenControls track={track} cover={cover} text={text} concealed={!controlsVisible} />
          ) : null}

          {!fullscreen ? lyricsDock : null}
        </div>
      ) : null}

      {toastPresence.mounted && renderedToast ? (
        <div className={`toast ${toastPresence.phaseClass}`} data-presence={toastPresence.phase} role="status" data-testid="toast">
          {renderedToast}
        </div>
      ) : null}
    </div>
    </LyricsModeMotion>
  );
}

const fallbackLyricsSettings: AppSettings["lyrics"] = {
  aiTranslation: { enabled: false, protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", chatPath: "/chat/completions", modelsPath: "/models", apiKey: "", model: "", temperature: 0.25, maxOutputTokens: 4096, timeoutMs: 60000, targetLanguage: "en", customHeaders: "{}" },
  aiRomanization: { enabled: false, protocol: "ollama-native", baseUrl: "http://localhost:11434", chatPath: "/api/chat", modelsPath: "/api/tags", apiKey: "", model: "", temperature: 0.1, maxOutputTokens: 4096, timeoutMs: 120000, romanizationStandard: "auto", customHeaders: "{}" },
  providerOrder: [...DEFAULT_PROVIDER_ORDER],
  autoFetch: true,
  notFoundCooldownDays: 7,
  fetchConcurrency: "balanced",
  offsetMs: 0,
  translationLanguage: "",
  romanization: false,
  romanizationMode: "line",
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
