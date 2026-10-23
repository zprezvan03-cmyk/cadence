/**
 * The Lyrics tab: the upstream Braccato renderer over the upstream Kawarp shader background, with
 * Cadence's dock, provider picker and translation controls. Written for Cadence.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Music4, RefreshCw, Search } from "lucide-react";
import type { AppSettings, Track } from "../../../shared/types";
import { useSettings } from "../../state/settingsStore";
import { BraccatoLyrics } from "./BraccatoLyrics";
import { LyricsDock } from "./LyricsDock";
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
  const [syncLabel, setSyncLabel] = useState("No lyrics");

  const lyricsSettings = settings?.lyrics;
  const shaderSettings = settings?.shaders;

  const lyrics = useLyrics(track ?? null, lyricsSettings ?? fallbackLyricsSettings);

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

  const handleSave = useCallback(async () => {
    try {
      const path = await lyrics.saveSidecar();
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

  return (
    <div className={`lyrics-view ${fullscreen ? "is-fullscreen" : ""}`} data-testid="lyrics-view">
      <KawarpBackground
        artworkUrl={track?.artworkUrl ?? null}
        animatedArtUrl={track?.animatedArtUrl ?? null}
        settings={shaderSettings ?? settings.shaders}
        playing={playing}
      />

      <div className="lyrics-header">
        <div className="lyrics-heading">
          <h1>{track?.title ?? "Nothing playing"}</h1>
          <p>{track ? [track.artist, track.album].filter(Boolean).join(" · ") : "Pick a song from your library"}</p>
        </div>
        {track ? (
          <div className="lyrics-header-actions">
            <button
              type="button"
              className="sync-pill"
              onClick={() => onToggleFullscreen()}
              title={fullscreen ? "Exit fullscreen lyrics (Esc)" : "Fullscreen lyrics (F)"}
            >
              {fullscreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="lyrics-body">
        {track ? (
          <BraccatoLyrics
            lyrics={lyrics.lyrics}
            themeCss={themeCss}
            offsetMs={lyricsSettings?.offsetMs ?? 0}
            passiveScroll={lyricsSettings?.passiveScroll ?? true}
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

        {track && lyrics.status === "empty" ? (
          <div className="lyrics-empty-panel">
            <h2>No lyrics found</h2>
            <p>
              Cadence looked for a sidecar <code>.lrc</code>/<code>.ttml</code> file, an embedded tag and
              LRCLIB{lyricsSettings?.autoFetch ? "" : " (offline mode is on)"}.
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
          <div className="lyrics-empty-panel error">
            <h2>Lyrics could not be loaded</h2>
            <p>{lyrics.error}</p>
            <button type="button" onClick={lyrics.reload}>
              <RefreshCw size={16} /> Retry
            </button>
          </div>
        ) : null}
      </div>

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
          syncLabel={syncLabel}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
          busy={lyrics.status === "loading" || lyrics.translating || lyrics.romanizing}
        />
      ) : null}

      {toast ? (
        <div className="toast" role="status" data-testid="toast">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

const fallbackLyricsSettings: AppSettings["lyrics"] = {
  providerOrder: ["local-sidecar", "embedded-tag", "lrclib-synced", "lrclib-plain"],
  autoFetch: true,
  offsetMs: 0,
  translationLanguage: "",
  romanization: false,
  themeId: "default",
  customThemeCss: "",
  fontSizeRem: 3,
  fontWeight: 700,
  lineHeight: 1.333,
  activeOpacity: 1,
  inactiveOpacity: 0.3,
  targetScrollRatio: 0.5,
  showCredits: true,
  hideInstrumentalOnly: false,
  passiveScroll: true,
  fullscreenOnOpen: false,
};
