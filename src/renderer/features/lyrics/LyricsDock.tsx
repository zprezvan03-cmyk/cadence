/**
 * The lyrics dock: provider choice, offset, translation, romanization, typography, theme and
 * Mirrors the controls Better Lyrics exposes in its lyrics dock, rebuilt as Cadence
 * React components. Written for Cadence.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Album,
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  Clapperboard,
  Clock,
  Download,
  FolderOpen,
  Languages,
  ListMusic,
  Minus,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Type,
  XCircle,
  Youtube,
} from "lucide-react";
import type { LyricsCandidate, LyricsSettings, NowPlayingProfile } from "../../../shared/types";
import { providerConfig } from "../../../shared/upstream/better-lyrics/constants";
import { formatDurationSeconds, resolveSearchFields, type ManualSearchInput } from "../../../shared/youtube";
import type { SearchDraft } from "../../state/lyricsStore";
import type { ManualSearchState, YouTubeResolveState } from "./useLyrics";
import { TRANSLATION_LANGUAGES } from "./translationLanguages";
import { staggerDelayMs, STAGGER_CAP } from "../../app/motion";
import { usePresence } from "../../app/usePresence";

interface LyricsDockProps {
  settings: LyricsSettings;
  onPatch: (patch: Partial<LyricsSettings>) => void;
  nowPlayingProfiles: readonly NowPlayingProfile[];
  activeNowPlayingProfileId: string;
  onSelectNowPlayingProfile: (profileId: string) => void;
  candidates: LyricsCandidate[];
  activeSource: string | null;
  onSelectSource: (source: string) => void;
  providerStatus: { provider: string; status: string; detail?: string }[];
  onReload: () => void;
  onRegenerateTranslation: () => void;
  onRegenerateRomanization: () => void;
  onSaveSidecar: (format?: "ttml" | "lrc") => void;
  onChooseFile: () => void;
  /** Remote queue items have no local file/sidecar; all other dock controls still apply. */
  localFileActions?: boolean;
  mvEnabled: boolean;
  onToggleMv: () => void;
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

/**
 * The name shown for a candidate. Registry keys resolve through `PROVIDER_CONFIGS` — the same
 * authoritative configuration Settings renders — so "Better Lyrics" and "Better Lyrics Line" read
 * identically in both places. Ephemeral sources (a chosen file, a manual search row from a
 * catalogue) keep the provider's own label.
 */
function providerLabel(candidate: LyricsCandidate): string {
  return providerConfig(candidate.source)?.displayName ?? candidate.provider;
}

export function LyricsDock({
  settings,
  onPatch,
  nowPlayingProfiles,
  activeNowPlayingProfileId,
  onSelectNowPlayingProfile,
  candidates,
  activeSource,
  onSelectSource,
  providerStatus,
  onReload,
  onRegenerateTranslation,
  onRegenerateRomanization,
  onSaveSidecar,
  onChooseFile,
  localFileActions = true,
  mvEnabled,
  onToggleMv,
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
  const [panel, setPanel] = useState<"none" | "sources" | "profiles" | "search">("none");
  const [languageOpen, setLanguageOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const anchorsRef = useRef<Record<string, HTMLElement | null>>({});
  const popoversRef = useRef<Record<string, HTMLElement | null>>({});
  const setAnchor = (key: string) => (node: HTMLElement | null) => {
    anchorsRef.current[key] = node;
  };
  const setPopover = (key: string) => (node: HTMLElement | null) => {
    popoversRef.current[key] = node;
  };
  // Popovers close the instant their state flips; presence only keeps each mounted for
  // its fast pop-out. Switching panels crossfades for one 120ms beat instead of cutting.
  const sourcesPresence = usePresence(panel === "sources");
  const searchPresence = usePresence(panel === "search");
  const profilesPresence = usePresence(panel === "profiles");
  const languagesPresence = usePresence(languageOpen);
  const activeNowPlayingProfile =
    nowPlayingProfiles.find(profile => profile.id === activeNowPlayingProfileId) ??
    nowPlayingProfiles[0];
  const { title: searchTitle, artist: searchArtist, album: searchAlbum, youtubeUrl } = searchDraft;

  const closePopovers = () => {
    setPanel("none");
    setLanguageOpen(false);
    setSaveOpen(false);
    setRegenerateOpen(false);
  };
  const togglePanel = (next: Exclude<typeof panel, "none">) => {
    const opening = panel !== next;
    closePopovers();
    if (opening) setPanel(next);
  };
  const toggleLanguage = () => {
    const opening = !languageOpen;
    closePopovers();
    if (opening) setLanguageOpen(true);
  };
  const toggleSave = () => {
    const opening = !saveOpen;
    closePopovers();
    if (opening) setSaveOpen(true);
  };
  const toggleRegenerate = () => {
    const opening = !regenerateOpen;
    closePopovers();
    if (opening) setRegenerateOpen(true);
  };

  // A pointer press anywhere outside the dock dismisses its popovers. Clicks on the dock itself
  // stay here: its triggers and rows close or switch panels explicitly.
  useEffect(() => {
    if (panel === "none" && !languageOpen && !saveOpen && !regenerateOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && dockRef.current?.contains(event.target)) return;
      setPanel("none");
      setLanguageOpen(false);
      setSaveOpen(false);
      setRegenerateOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [panel, languageOpen, saveOpen, regenerateOpen]);

  // Each popover is a direct child of the dock, so pin its horizontal edge to the button that
  // opened it instead of letting every panel pile up at the dock's right edge. Presence-mounted
  // panels appear one render after their state flips, so their `mounted` flags are deps too.
  useLayoutEffect(() => {
    const openKeys: string[] = [];
    if (panel !== "none") openKeys.push(panel);
    if (languageOpen) openKeys.push("languages");
    if (saveOpen) openKeys.push("save");
    if (regenerateOpen) openKeys.push("regenerate");
    if (!openKeys.length) return;
    const place = () => {
      for (const key of openKeys) {
        const anchor = anchorsRef.current[key];
        const popover = popoversRef.current[key];
        // Fullscreen popovers resolve against the full-width footer; windowed ones against the dock.
        const container = popover?.offsetParent as HTMLElement | null;
        if (!anchor || !popover || !container) continue;
        const box = container.getBoundingClientRect();
        const maxInset = Math.max(0, container.clientWidth);
        const anchorRect = anchor.getBoundingClientRect();
        const width = popover.getBoundingClientRect().width;
        if (key === "save" || key === "regenerate") {
          const right = Math.min(Math.max(0, box.right - anchorRect.right), Math.max(0, maxInset - width));
          popover.style.left = "auto";
          popover.style.right = `${right}px`;
        } else {
          const left = Math.min(Math.max(0, anchorRect.left - box.left), Math.max(0, maxInset - width));
          popover.style.left = `${left}px`;
          popover.style.right = "auto";
        }
      }
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [panel, languageOpen, saveOpen, regenerateOpen, sourcesPresence.mounted, searchPresence.mounted, profilesPresence.mounted, languagesPresence.mounted]);

  useEffect(() => {
    onPopoverChange?.(panel !== "none" || languageOpen || saveOpen || regenerateOpen);
  }, [panel, languageOpen, saveOpen, regenerateOpen, onPopoverChange]);

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
  const translateTarget = settings.aiTranslation?.enabled
    ? (settings.aiTranslation.targetLanguage ?? "en")
    : settings.translationLanguage;
  const patchTranslateTarget = (language: string) => {
    if (settings.aiTranslation?.enabled) {
      if (!language) onPatch({ aiTranslation: { ...settings.aiTranslation, enabled: false }, translationLanguage: "" });
      else onPatch({ aiTranslation: { ...settings.aiTranslation, targetLanguage: language } });
    } else onPatch({ translationLanguage: language });
  };

  return (
    <div ref={dockRef} className={`lyrics-dock ${concealed ? "is-concealed" : ""}`} data-testid="lyrics-dock">
      <div className="dock-group dock-status" title={syncLabel} data-testid="sync-label">
        <span className={`sync-dot sync-${syncLabel.toLowerCase().replace(/\s+/g, "-")}`} />
        {syncLabel}
      </div>

      <div className="dock-group">
        <button
          ref={node => {
            anchorsRef.current.sources = node;
            anchorsRef.current.search = node;
          }}
          type="button"
          className="dock-button dock-button--icon"
          onClick={() => togglePanel("sources")}
          title="Lyrics source"
          aria-label="Lyrics source"
          aria-expanded={panel === "sources"}
        >
          <ListMusic size={17} /> <ChevronDown size={13} />
        </button>
        <button
          ref={setAnchor("profiles")}
          type="button"
          className="dock-button dock-button--icon"
          onClick={() => togglePanel("profiles")}
          title={`Now Playing profile: ${activeNowPlayingProfile?.name ?? "Balanced"}`}
          aria-label={`Now Playing profile: ${activeNowPlayingProfile?.name ?? "Balanced"}`}
          aria-expanded={panel === "profiles"}
          aria-haspopup="true"
          data-testid="now-playing-profile-button"
        >
          <Palette size={17} />
        </button>
        <button
          ref={setAnchor("languages")}
          type="button"
          className="dock-button dock-button--icon"
          onClick={toggleLanguage}
          title="Translate lyrics"
          aria-label={translateTarget ? `Translate lyrics → ${languageLabel(translateTarget)}` : "Translate lyrics"}
          aria-expanded={languageOpen}
        >
          <Languages size={17} />
        </button>
        <button
          type="button"
          className={`dock-button dock-button--icon ${mvEnabled ? "active" : ""}`}
          onClick={onToggleMv}
          title="Music video background"
          aria-label="Music video background"
          aria-pressed={mvEnabled}
          data-testid="now-playing-mv-button"
        >
          <Clapperboard size={17} />
        </button>
        <button
          type="button"
          className={`dock-button dock-button--icon ${settings.romanization ? "active" : ""}`}
          onClick={() => onPatch({ romanization: !settings.romanization })}
          title="Romanize lyrics"
          aria-label="Romanize lyrics"
          aria-pressed={settings.romanization}
        >
          <Type size={17} />
        </button>
        {(settings.aiTranslation?.enabled || settings.translationLanguage || settings.romanization) ? (
          <div ref={setAnchor("regenerate")} className="dock-regenerate-wrap">
            <button
              type="button"
              className="dock-button dock-button--icon"
              onClick={toggleRegenerate}
              disabled={busy}
              title="Regenerate lyrics"
              aria-label="Regenerate lyrics"
              aria-expanded={regenerateOpen}
            >
              <RefreshCw size={16} /> <ChevronDown size={13} />
            </button>
            {regenerateOpen ? (
              <div ref={setPopover("regenerate")} className="dock-popover dock-regenerate-popover">
                {(settings.aiTranslation?.enabled || settings.translationLanguage) ? (
                  <button
                    type="button"
                    className="source-row"
                    onClick={() => { setRegenerateOpen(false); onRegenerateTranslation(); }}
                  >
                    <span><strong>Translation</strong><em>Force-regenerate translated lines</em></span>
                  </button>
                ) : null}
                {settings.romanization ? (
                  <button
                    type="button"
                    className="source-row"
                    onClick={() => { setRegenerateOpen(false); onRegenerateRomanization(); }}
                  >
                    <span><strong>Romanization</strong><em>Force-regenerate romanized lines</em></span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
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
        {localFileActions ? (
          <>
            <button type="button" className="dock-icon" onClick={onChooseFile} title="Open a lyrics file">
              <FolderOpen size={16} />
            </button>
            <div ref={setAnchor("save")} className="dock-save-wrap">
              <button
                type="button"
                className="dock-button dock-button--icon"
                onClick={toggleSave}
                title="Save lyrics next to the track"
                aria-label="Save lyrics next to the track"
                aria-expanded={saveOpen}
              >
                <Download size={17} /> <ChevronDown size={13} />
              </button>
              {saveOpen ? (
                <div ref={setPopover("save")} className="dock-popover dock-save-popover">
                  <button
                    type="button"
                    className="source-row"
                    onClick={() => { setSaveOpen(false); onSaveSidecar("ttml"); }}
                  >
                    <span><strong>TTML</strong><em>Timed text markup</em></span>
                  </button>
                  <button
                    type="button"
                    className="source-row"
                    onClick={() => { setSaveOpen(false); onSaveSidecar("lrc"); }}
                  >
                    <span><strong>LRC</strong><em>Lyric text</em></span>
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {sourcesPresence.mounted ? (
        <div ref={setPopover("sources")} className={`dock-popover dock-sources ${sourcesPresence.phaseClass}`} data-presence={sourcesPresence.phase}>
          <div className="popover-title">Lyrics source</div>
          {candidates.length === 0 ? <div className="muted">No lyrics found for this track.</div> : null}
          {candidates.map(candidate => (
            <button
              type="button"
              key={`${candidate.source}-${candidate.provider}`}
              className={`source-row ${activeSource === candidate.source ? "active" : ""}`}
              onClick={() => {
                onSelectSource(candidate.source);
                closePopovers();
              }}
            >
              <span>
                <strong>{providerLabel(candidate)}</strong>
                <em>{candidate.syncHint === "richsync" ? "Word synced" : candidate.syncHint === "synced" ? "Line synced" : "Unsynced"}</em>
              </span>
              {candidate.cached ? <span className="badge">cached</span> : null}
            </button>
          ))}
          <div className="popover-divider" />
          <div className="popover-title">Providers</div>
          {providerStatus.map(entry => (
            <div className="provider-row" key={entry.provider}>
              <span>{providerConfig(entry.provider)?.displayName ?? entry.provider}</span>
              <span className={`provider-${entry.status}`}>{entry.detail || entry.status}</span>
            </div>
          ))}
          <div className="popover-divider" />
          <button type="button" className="source-row manual-search-entry" onClick={() => togglePanel("search")}>
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

      {profilesPresence.mounted ? (
        <div
          ref={setPopover("profiles")}
          className={`dock-popover dock-profiles ${profilesPresence.phaseClass}`}
          data-presence={profilesPresence.phase}
          data-testid="now-playing-profile-switcher"
          role="menu"
          aria-label="Now Playing profiles"
        >
          <div className="popover-title">Now Playing profile</div>
          {nowPlayingProfiles.map(profile => {
            const active = profile.id === activeNowPlayingProfile?.id;
            return (
              <button
                type="button"
                key={profile.id}
                className={`profile-row ${active ? "active" : ""}`}
                onClick={() => {
                  onSelectNowPlayingProfile(profile.id);
                  closePopovers();
                }}
                aria-pressed={active}
                data-profile-id={profile.id}
              >
                <NowPlayingProfileThumbnail profile={profile} />
                <span className="profile-row-copy">
                  <strong>{profile.name}</strong>
                  <em>
                    {profile.description ||
                      (profile.builtIn ? "Built-in profile" : "Custom profile")}
                  </em>
                </span>
                {active ? (
                  <Check size={16} aria-hidden="true" />
                ) : (
                  <span className="badge">{profile.builtIn ? "Built-in" : "Custom"}</span>
                )}
              </button>
            );
          })}
          <p className="profile-switcher-note">
            Each profile keeps separate windowed and fullscreen proportions.
          </p>
        </div>
      ) : null}

      {searchPresence.mounted ? (
        <div ref={setPopover("search")} className={`dock-popover dock-search ${searchPresence.phaseClass}`} data-presence={searchPresence.phase} data-testid="manual-search">
          <div className="search-panel-head">
            <button type="button" className="dock-icon" title="Back to sources" onClick={() => togglePanel("sources")}>
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
            ? manualSearchState.results.map((candidate, index) => (
                <button
                  type="button"
                  key={`${candidate.source}-${candidate.matchTitle ?? ""}-${candidate.text.length}`}
                  className="source-row search-result-row"
                  style={
                    index < STAGGER_CAP
                      ? { animationDelay: `${staggerDelayMs(index, 8)}ms` }
                      : undefined
                  }
                  onClick={() => {
                    onSelectSearchResult(candidate);
                    closePopovers();
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
                      {providerLabel(candidate)} ·{" "}
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

      {languagesPresence.mounted ? (
        <div ref={setPopover("languages")} className={`dock-popover dock-languages ${languagesPresence.phaseClass}`} data-presence={languagesPresence.phase}>
          <div className="popover-title">Translate to</div>
          <button
            type="button"
            className={`source-row ${translateTarget === "" ? "active" : ""}`}
            onClick={() => {
              patchTranslateTarget("");
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
                className={`source-row ${translateTarget === language.code ? "active" : ""}`}
                onClick={() => {
                  patchTranslateTarget(language.code);
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

/**
 * A tiny data-driven preview, not a screenshot: artwork size, lyric weight and measure
 * come from the profile's fullscreen proportions, so custom profiles preview truthfully
 * without mounting a second Now Playing tree or running an off-screen renderer.
 */
function NowPlayingProfileThumbnail({ profile }: { profile: NowPlayingProfile }) {
  const config = profile.fullscreen;
  const artworkSize = Math.min(24, Math.max(12, Math.round(18 * config.artworkScale)));
  const lineHeight = Math.min(7, Math.max(4, 5 * config.lyricsScale));
  const lineWidth = Math.min(100, Math.max(58, config.lyricsMaxWidth / 12));
  return (
    <span className="profile-thumb" aria-hidden="true">
      {config.artworkVisible ? (
        <span
          className="profile-thumb-art"
          style={{ width: artworkSize, height: artworkSize }}
        />
      ) : null}
      <span className="profile-thumb-lines">
        <span style={{ height: lineHeight, width: `${lineWidth}%` }} />
        <span style={{ height: lineHeight, width: `${Math.max(48, lineWidth * 0.82)}%` }} />
        <span style={{ height: lineHeight, width: `${Math.max(38, lineWidth * 0.62)}%` }} />
      </span>
    </span>
  );
}

function languageLabel(code: string): string {
  return TRANSLATION_LANGUAGES.find(language => language.code === code)?.name ?? code.toUpperCase();
}
