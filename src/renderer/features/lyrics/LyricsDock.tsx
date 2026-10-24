/**
 * The lyrics dock: provider choice, offset, translation, romanization, typography, theme and
 * Mirrors the controls Better Lyrics exposes in its lyrics dock, rebuilt as Cadence
 * React components. Written for Cadence.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Album,
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  Clock,
  Download,
  FolderOpen,
  Languages,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Wand2,
  XCircle,
  Youtube,
} from "lucide-react";
import type { LyricsCandidate, LyricsSettings } from "../../../shared/types";
import { formatDurationSeconds, resolveSearchFields, type ManualSearchInput } from "../../../shared/youtube";
import type { SearchDraft } from "../../../state/lyricsStore";
import type { ManualSearchState, YouTubeResolveState } from "./useLyrics";
import { TRANSLATION_LANGUAGES } from "./translationLanguages";

interface LyricsDockProps {
  settings: LyricsSettings;
  onPatch: (patch: Partial<LyricsSettings>) => void;
  candidates: LyricsCandidate[];
  activeSource: string | null;
  onSelectSource: (source: string) => void;
  providerStatus: { provider: string; status: string; detail?: string }[];
  onReload: () => void;
  onSaveSidecar: () => void;
  onChooseFile: () => void;
  syncLabel: string;
  busy: boolean;
  /** Playing track's duration, used for the effective-search preview and provider matching. */
  trackDuration: number;
  /** Persisted per-track form draft; survives panel close, tab switches and restarts. */
  searchDraft: SearchDraft;
  onDraftChange: (patch: Partial<SearchDraft>) => void;
  /** Explicit reset of the search session back to the track's tag defaults. */
  onClearSearch: () => void;
  manualSearchState: ManualSearchState;
  youtubeState: YouTubeResolveState;
  onManualSearch: (input: ManualSearchInput) => void;
  onResolveYouTube: (url: string) => void;
  onSelectSearchResult: (candidate: LyricsCandidate) => void;
  /** Hover visibility: faded out and non-interactive while true. */
  concealed?: boolean;
  /** Reports whether a popover is open, so the controls stay visible while it is in use. */
  onPopoverChange?: (open: boolean) => void;
}

export function LyricsDock({
  settings,
  onPatch,
  candidates,
  activeSource,
  onSelectSource,
  providerStatus,
  onReload,
  onSaveSidecar,
  onChooseFile,
  syncLabel,
  busy,
  trackDuration,
  searchDraft,
  onDraftChange,
  onClearSearch,
  manualSearchState,
  youtubeState,
  onManualSearch,
  onResolveYouTube,
  onSelectSearchResult,
  concealed = false,
  onPopoverChange,
}: LyricsDockProps) {
  const [panel, setPanel] = useState<"none" | "sources" | "appearance" | "search">("none");
  const [languageOpen, setLanguageOpen] = useState(false);
  const { title: searchTitle, artist: searchArtist, album: searchAlbum, youtubeUrl } = searchDraft;

  useEffect(() => {
    onPopoverChange?.(panel !== "none" || languageOpen);
  }, [panel, languageOpen, onPopoverChange]);

  // Debounce link pastes so typing a URL does not fire a lookup per keystroke. The lookup itself
  // is main-process and keyless; an empty field resets the resolved card immediately.
  useEffect(() => {
    if (panel !== "search") return;
    const trimmed = youtubeUrl.trim();
    if (!trimmed) {
      onResolveYouTube("");
      return;
    }
    const timer = window.setTimeout(() => onResolveYouTube(trimmed), 550);
    return () => window.clearTimeout(timer);
  }, [youtubeUrl, panel, onResolveYouTube]);

  // Effective metadata after merging typed values, YouTube supplements and the track's duration.
  // This is exactly what gets sent to the providers, and the card below renders the same values.
  const effective = useMemo(
    () =>
      resolveSearchFields(
        searchDraft,
        youtubeState.status === "ready" ? youtubeState.metadata : null,
        trackDuration
      ),
    [searchDraft, youtubeState, trackDuration]
  );

  const submitSearch = () => {
    if (!effective.title || manualSearchState.status === "loading") return;
    onManualSearch(searchDraft);
  };

  return (
    <div className={`lyrics-dock ${concealed ? "is-concealed" : ""}`} data-testid="lyrics-dock">
      <div className="dock-group dock-status" title={syncLabel} data-testid="sync-label">
        <span className={`sync-dot sync-${syncLabel.toLowerCase().replace(/\s+/g, "-")}`} />
        {syncLabel}
      </div>

      <div className="dock-group">
        <button
          type="button"
          className="dock-button"
          onClick={() => setPanel(panel === "sources" ? "none" : "sources")}
          title="Lyrics source"
          aria-expanded={panel === "sources"}
        >
          <Sparkles size={16} /> Source <ChevronDown size={14} />
        </button>
        <button
          type="button"
          className="dock-button"
          onClick={() => setPanel(panel === "appearance" ? "none" : "appearance")}
          title="Lyrics appearance"
          aria-expanded={panel === "appearance"}
        >
          <Settings2 size={16} /> Style
        </button>
        <button
          type="button"
          className="dock-button"
          onClick={() => setLanguageOpen(open => !open)}
          title="Translate lyrics"
          aria-expanded={languageOpen}
        >
          <Languages size={16} /> {settings.translationLanguage ? languageLabel(settings.translationLanguage) : "Translate"}
        </button>
        <button
          type="button"
          className={`dock-button ${settings.romanization ? "active" : ""}`}
          onClick={() => onPatch({ romanization: !settings.romanization })}
          title="Romanize lyrics"
        >
          <Wand2 size={16} /> Romanize
        </button>
      </div>

      <div className="dock-group dock-offset" title="Lyrics timing offset">
        <button type="button" className="dock-icon" onClick={() => onPatch({ offsetMs: settings.offsetMs - 100 })}>
          <Minus size={14} />
        </button>
        <span className="offset-value">{settings.offsetMs > 0 ? "+" : ""}{(settings.offsetMs / 1000).toFixed(1)}s</span>
        <button type="button" className="dock-icon" onClick={() => onPatch({ offsetMs: settings.offsetMs + 100 })}>
          <Plus size={14} />
        </button>
      </div>

      <div className="dock-group dock-actions">
        <button type="button" className="dock-icon" onClick={onReload} title="Reload lyrics" disabled={busy}>
          <RefreshCw size={16} className={busy ? "spin" : undefined} />
        </button>
        <button type="button" className="dock-icon" onClick={onChooseFile} title="Open a lyrics file">
          <FolderOpen size={16} />
        </button>
        <button type="button" className="dock-icon" onClick={onSaveSidecar} title="Save lyrics next to the track">
          <Download size={16} />
        </button>
      </div>

      {panel === "sources" ? (
        <div className="dock-popover dock-sources">
          <div className="popover-title">Lyrics source</div>
          {candidates.length === 0 ? <div className="muted">No lyrics found for this track.</div> : null}
          {candidates.map(candidate => (
            <button
              type="button"
              key={`${candidate.source}-${candidate.provider}`}
              className={`source-row ${activeSource === candidate.source ? "active" : ""}`}
              onClick={() => {
                onSelectSource(candidate.source);
                setPanel("none");
              }}
            >
              <span>
                <strong>{candidate.provider}</strong>
                <em>{candidate.syncHint === "richsync" ? "Word synced" : candidate.syncHint === "synced" ? "Line synced" : "Unsynced"}</em>
              </span>
              {candidate.cached ? <span className="badge">cached</span> : null}
            </button>
          ))}
          <div className="popover-divider" />
          <div className="popover-title">Providers</div>
          {providerStatus.map(entry => (
            <div className="provider-row" key={entry.provider}>
              <span>{entry.provider}</span>
              <span className={`provider-${entry.status}`}>{entry.detail || entry.status}</span>
            </div>
          ))}
          <div className="popover-divider" />
          <button type="button" className="source-row manual-search-entry" onClick={() => setPanel("search")}>
            <span>
              <strong>
                <Search size={13} /> Search Manually
              </strong>
              <em>Find lyrics with a different title or artist</em>
            </span>
            <ChevronDown size={14} className="chev-right" />
          </button>
        </div>
      ) : null}

      {panel === "search" ? (
        <div className="dock-popover dock-search" data-testid="manual-search">
          <div className="search-panel-head">
            <button type="button" className="dock-icon" title="Back to sources" onClick={() => setPanel("sources")}>
              <ArrowLeft size={15} />
            </button>
            <div className="popover-title">Search lyrics</div>
            <button
              type="button"
              className="dock-icon search-clear"
              title="Clear query and results"
              aria-label="Clear query and results"
              onClick={() => {
                onClearSearch();
              }}
            >
              <XCircle size={15} />
            </button>
          </div>
          <form
            className="search-form"
            onSubmit={event => {
              event.preventDefault();
              submitSearch();
            }}
          >
            <input
              className="search-input"
              type="text"
              placeholder="Song title (required)"
              aria-label="Song title"
              value={searchTitle}
              onChange={event => onDraftChange({ title: event.target.value })}
              autoFocus
            />
            <input
              className="search-input"
              type="text"
              placeholder="Artist (optional)"
              aria-label="Artist (optional)"
              value={searchArtist}
              onChange={event => onDraftChange({ artist: event.target.value })}
            />
            <div className="search-input-wrap">
              <Album size={14} className="search-input-icon" aria-hidden />
              <input
                className="search-input has-icon"
                type="text"
                placeholder="Album (optional)"
                aria-label="Album (optional)"
                value={searchAlbum}
                onChange={event => onDraftChange({ album: event.target.value })}
              />
            </div>
            <div className="search-input-wrap">
              <Youtube size={15} className="search-input-icon" aria-hidden />
              <input
                className="search-input has-icon"
                type="url"
                inputMode="url"
                placeholder="YouTube link (optional)"
                aria-label="YouTube link (optional)"
                value={youtubeUrl}
                onChange={event => onDraftChange({ youtubeUrl: event.target.value })}
              />
            </div>

            {youtubeState.status === "resolving" ? (
              <div className="yt-card yt-resolving muted">
                <RefreshCw size={13} className="spin" /> Looking up video metadata…
              </div>
            ) : null}
            {youtubeState.status === "ready" && youtubeState.metadata ? (
              <div className="yt-card" data-testid="youtube-metadata">
                <div className="yt-card-head">
                  <Youtube size={13} />
                  <span>From YouTube video</span>
                  <span className="yt-id">{youtubeState.metadata.videoId}</span>
                </div>
                <strong className="yt-title">{youtubeState.metadata.title}</strong>
                <div className="yt-meta-line">
                  {youtubeState.metadata.artist ? <span>{youtubeState.metadata.artist}</span> : null}
                  {youtubeState.metadata.durationSeconds ? (
                    <span className="yt-duration">
                      <Clock size={11} /> {formatDurationSeconds(youtubeState.metadata.durationSeconds)}
                    </span>
                  ) : null}
                </div>
                <div className="yt-fills">
                  Fills missing:
                  {effective.sources.title === "youtube" ? <span>title</span> : null}
                  {effective.sources.artist === "youtube" ? <span>artist</span> : null}
                  {effective.sources.duration === "youtube" ? <span>duration</span> : null}
                  {effective.sources.title !== "youtube" &&
                  effective.sources.artist !== "youtube" &&
                  effective.sources.duration !== "youtube" ? (
                    <em>nothing — all fields already provided</em>
                  ) : null}
                </div>
              </div>
            ) : null}
            {youtubeState.status === "invalid" ? (
              <div className="yt-card yt-problem" role="alert">
                <AlertCircle size={13} /> Enter a valid YouTube watch, youtu.be or Shorts link.
              </div>
            ) : null}
            {youtubeState.status === "unavailable" ? (
              <div className="yt-card yt-problem" role="alert">
                <AlertCircle size={13} /> {youtubeState.detail || "This video is private or unavailable."}
              </div>
            ) : null}
            {youtubeState.status === "error" ? (
              <div className="yt-card yt-problem" role="alert">
                <AlertCircle size={13} /> {youtubeState.detail || "Couldn't fetch video metadata."}
                <button type="button" className="search-retry" onClick={() => onResolveYouTube(youtubeUrl)}>
                  <RefreshCw size={12} /> Retry
                </button>
              </div>
            ) : null}

            <div className="effective-search" data-testid="effective-search">
              <div className="effective-head">
                <Check size={12} /> Searching as
              </div>
              <div className="effective-line" title="Title sent to providers">
                <span className="effective-label">Title</span>
                <span className="effective-value">{effective.title || "—"}</span>
                {effective.sources.title ? <span className="effective-source">{effective.sources.title}</span> : null}
              </div>
              <div className="effective-line" title="Artist sent to providers">
                <span className="effective-label">Artist</span>
                <span className="effective-value">{effective.artist || "—"}</span>
                {effective.sources.artist ? <span className="effective-source">{effective.sources.artist}</span> : null}
              </div>
              {effective.album ? (
                <div className="effective-line" title="Album sent to providers">
                  <span className="effective-label">Album</span>
                  <span className="effective-value">{effective.album}</span>
                  <span className="effective-source">user</span>
                </div>
              ) : null}
              {effective.duration ? (
                <div className="effective-line" title="Duration sent to providers">
                  <span className="effective-label">Duration</span>
                  <span className="effective-value">{formatDurationSeconds(effective.duration)}</span>
                  <span className="effective-source">{effective.sources.duration ?? ""}</span>
                </div>
              ) : null}
            </div>

            <button type="submit" className="search-submit" disabled={!effective.title || manualSearchState.status === "loading"}>
              {manualSearchState.status === "loading" ? <RefreshCw size={15} className="spin" /> : <Search size={15} />}
              Search
            </button>
          </form>

          {manualSearchState.status === "loading" ? (
            <div className="muted search-feedback">Searching providers…</div>
          ) : null}
          {manualSearchState.status === "empty" ? (
            <div className="muted search-feedback">No lyrics found for that search. Try a different title or artist.</div>
          ) : null}
          {manualSearchState.status === "error" ? (
            <div className="search-feedback search-error">
              Search failed: {manualSearchState.error}
              <button type="button" className="search-retry" onClick={submitSearch}>
                <RefreshCw size={13} /> Retry
              </button>
            </div>
          ) : null}
          {manualSearchState.status === "ready"
            ? manualSearchState.results.map(candidate => (
                <button
                  type="button"
                  key={`${candidate.source}-${candidate.matchTitle ?? ""}-${candidate.text.length}`}
                  className="source-row"
                  onClick={() => {
                    onSelectSearchResult(candidate);
                    setPanel("none");
                  }}
                >
                  <span>
                    <strong>{candidate.matchTitle ?? searchTitle}</strong>
                    <em>
                      {[candidate.matchArtist, candidate.matchAlbum, candidate.matchDuration ? `${candidate.matchDuration}s` : null]
                        .filter(Boolean)
                        .join(" · ") || "Unknown artist"}
                    </em>
                    <em className="search-provider">
                      {candidate.provider} ·{" "}
                      {candidate.syncHint === "richsync"
                        ? "Word synced"
                        : candidate.syncHint === "synced"
                          ? "Line synced"
                          : "Unsynced"}
                    </em>
                  </span>
                </button>
              ))
            : null}
        </div>
      ) : null}

      {panel === "appearance" ? (
        <div className="dock-popover dock-appearance">
          <label className="slider-row">
            <span>Font size</span>
            <input
              type="range"
              min={1.5}
              max={5.5}
              step={0.1}
              value={settings.fontSizeRem}
              onChange={event => onPatch({ fontSizeRem: Number(event.target.value) })}
            />
            <output>{settings.fontSizeRem.toFixed(1)}rem</output>
          </label>
          <label className="slider-row">
            <span>Translation Font Size</span>
            <input
              type="range"
              min={10}
              max={48}
              step={1}
              value={settings.translationFontSizePx}
              onChange={event => onPatch({ translationFontSizePx: Number(event.target.value) })}
              aria-label="Translation Font Size"
            />
            <output>{settings.translationFontSizePx} px</output>
          </label>
          <label className="slider-row">
            <span>Romanization Font Size</span>
            <input
              type="range"
              min={10}
              max={48}
              step={1}
              value={settings.romanizationFontSizePx}
              onChange={event => onPatch({ romanizationFontSizePx: Number(event.target.value) })}
              aria-label="Romanization Font Size"
            />
            <output>{settings.romanizationFontSizePx} px</output>
          </label>
          <label className="slider-row">
            <span>Weight</span>
            <input
              type="range"
              min={300}
              max={900}
              step={50}
              value={settings.fontWeight}
              onChange={event => onPatch({ fontWeight: Number(event.target.value) })}
            />
            <output>{settings.fontWeight}</output>
          </label>
          <label className="slider-row">
            <span>Line height</span>
            <input
              type="range"
              min={1}
              max={2}
              step={0.05}
              value={settings.lineHeight}
              onChange={event => onPatch({ lineHeight: Number(event.target.value) })}
            />
            <output>{settings.lineHeight.toFixed(2)}</output>
          </label>
          <label className="slider-row">
            <span>Active</span>
            <input
              type="range"
              min={0.4}
              max={1}
              step={0.02}
              value={settings.activeOpacity}
              onChange={event => onPatch({ activeOpacity: Number(event.target.value) })}
            />
            <output>{Math.round(settings.activeOpacity * 100)}%</output>
          </label>
          <label className="slider-row">
            <span>Inactive</span>
            <input
              type="range"
              min={0.05}
              max={0.9}
              step={0.02}
              value={settings.inactiveOpacity}
              onChange={event => onPatch({ inactiveOpacity: Number(event.target.value) })}
            />
            <output>{Math.round(settings.inactiveOpacity * 100)}%</output>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.showCredits}
              onChange={event => onPatch({ showCredits: event.target.checked })}
            />
            <span>Show songwriters</span>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.passiveScroll}
              onChange={event => onPatch({ passiveScroll: event.target.checked })}
            />
            <span>Auto-scroll unsynced lyrics</span>
          </label>
        </div>
      ) : null}

      {languageOpen ? (
        <div className="dock-popover dock-languages">
          <div className="popover-title">Translate to</div>
          <button
            type="button"
            className={`source-row ${settings.translationLanguage === "" ? "active" : ""}`}
            onClick={() => {
              onPatch({ translationLanguage: "" });
              setLanguageOpen(false);
            }}
          >
            <span>
              <strong>Off</strong>
            </span>
          </button>
          <div className="language-list">
            {TRANSLATION_LANGUAGES.map(language => (
              <button
                type="button"
                key={language.code}
                className={`source-row ${settings.translationLanguage === language.code ? "active" : ""}`}
                onClick={() => {
                  onPatch({ translationLanguage: language.code });
                  setLanguageOpen(false);
                }}
              >
                <span>
                  <strong>{language.name}</strong>
                  <em>{language.native}</em>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function languageLabel(code: string): string {
  return TRANSLATION_LANGUAGES.find(language => language.code === code)?.name ?? code.toUpperCase();
}
