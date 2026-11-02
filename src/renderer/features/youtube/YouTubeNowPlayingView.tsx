/**
 * YouTube Now Playing prototype.
 *
 * Cadence supplies the surrounding interface and lyrics; YouTube's official embedded player
 * supplies the actual audiovisual playback. This view intentionally has no connection to the
 * local queue, local history, playlists, or SQLite.
 */

import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ExternalLink,
  Link2,
  Maximize2,
  Minimize2,
  Music4,
  Pause,
  Play,
  RefreshCw,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { AppSettings } from "../../../shared/types";
import { DEFAULT_PROVIDER_ORDER } from "../../../shared/upstream/better-lyrics/constants";
import { normalizeYouTubeArtist, parseYouTubeVideoId } from "../../../shared/youtube";
import { Artwork } from "../../components/Artwork";
import { formatTime } from "../../player/queue";
import {
  EMPTY_REMOTE_PLAYBACK_CLOCK,
  projectRemotePlaybackClock,
} from "../../player/playbackClock";
import { usePlayer } from "../../state/playerStore";
import { useSettings } from "../../state/settingsStore";
import { useUi } from "../../state/uiStore";
import { useYouTubeRemote, youtubePlaybackClock } from "../../state/youtubeStore";
import { buildThemeCss } from "../../upstream/better-lyrics/themes";
import { BraccatoLyrics } from "../lyrics/BraccatoLyrics";
import {
  YOUTUBE_PLAYER_SIZES,
  YouTubeIframePlayer,
  type YouTubePlayerErrorInfo,
  type YouTubePlayerHandle,
  type YouTubePlayerMetadata,
  type YouTubePlayerSnapshot,
} from "./YouTubeIframePlayer";
import { useYouTubeLyrics } from "./useYouTubeLyrics";

const FALLBACK_LYRICS_SETTINGS: AppSettings["lyrics"] = {
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

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function canonicalSourceUrl(input: string, videoId: string): string {
  try {
    const raw = input.trim();
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase() === "music.youtube.com"
      ? `https://music.youtube.com/watch?v=${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`;
  } catch {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
}

function stateLabel(snapshot: YouTubePlayerSnapshot | null, ready: boolean, hasVideo: boolean): string {
  if (!hasVideo) return "No video loaded";
  if (!ready) return "Loading official player…";
  switch (snapshot?.state) {
    case "playing":
      return "Playing in the official YouTube player";
    case "paused":
      return "Paused";
    case "buffering":
      return "Buffering…";
    case "cued":
      return "Cued and ready";
    case "ended":
      return "Ended";
    default:
      return "Ready";
  }
}

function YouTubeControls({
  playerRef,
  ready,
  disabled,
  visibilityRatio,
  onPlayRejected,
}: {
  playerRef: RefObject<YouTubePlayerHandle | null>;
  ready: boolean;
  disabled: boolean;
  visibilityRatio: number;
  onPlayRejected: () => void;
}) {
  const clock = useSyncExternalStore(
    youtubePlaybackClock.subscribe,
    youtubePlaybackClock.getSnapshot,
    () => EMPTY_REMOTE_PLAYBACK_CLOCK
  );
  const projected = projectRemotePlaybackClock(clock);
  const volume = useYouTubeRemote(state => state.volume);
  const muted = useYouTubeRemote(state => state.muted);
  const setVolume = useYouTubeRemote(state => state.setVolume);
  const effectiveVolume = muted ? 0 : volume;
  const unavailable = disabled || !ready;

  const toggle = () => {
    const player = playerRef.current;
    if (!player) return;
    if (clock.isPlaying) {
      player.pause();
      return;
    }
    if (!player.play()) onPlayRejected();
  };

  return (
    <div className="youtube-controls" data-testid="youtube-controls">
      <div className="youtube-seek-row">
        <span className="time" data-testid="youtube-position">
          {formatTime(projected.currentTime)}
        </span>
        <input
          className="seek"
          type="range"
          min={0}
          max={projected.duration || 0}
          step={0.1}
          value={Math.min(projected.currentTime, projected.duration || 0)}
          disabled={unavailable || projected.duration <= 0}
          aria-label="Seek YouTube playback"
          data-testid="youtube-seek"
          onChange={event => playerRef.current?.seekTo(Number(event.target.value), true)}
          style={{
            ["--progress" as string]: `${projected.duration ? (projected.currentTime / projected.duration) * 100 : 0}%`,
          }}
        />
        <span className="time" data-testid="youtube-duration">
          {formatTime(projected.duration)}
        </span>
      </div>

      <div className="youtube-control-row">
        <button
          type="button"
          className="play-button youtube-play-button"
          onClick={toggle}
          disabled={unavailable}
          aria-label={clock.isPlaying ? "Pause YouTube playback" : "Play YouTube playback"}
          data-testid="youtube-play-toggle"
        >
          {clock.isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>

        <div className="volume-group youtube-volume-group">
          <button
            type="button"
            className="icon-button"
            disabled={unavailable}
            aria-label={muted ? "Unmute YouTube playback" : "Mute YouTube playback"}
            onClick={() => {
              const nextMuted = !muted;
              setVolume(volume, nextMuted);
              playerRef.current?.setMuted(nextMuted);
            }}
          >
            {effectiveVolume === 0 ? <VolumeX size={17} /> : effectiveVolume < 0.5 ? <Volume1 size={17} /> : <Volume2 size={17} />}
          </button>
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={effectiveVolume}
            disabled={unavailable}
            aria-label="YouTube volume"
            data-testid="youtube-volume"
            onChange={event => {
              const next = Number(event.target.value);
              setVolume(next, next === 0 ? muted : false);
              playerRef.current?.setVolume(next);
            }}
            style={{ ["--progress" as string]: `${effectiveVolume * 100}%` }}
          />
        </div>

        <label className="youtube-rate-control">
          <span>Speed</span>
          <select
            value={PLAYBACK_RATES.includes(clock.playbackRate) ? String(clock.playbackRate) : "1"}
            disabled={unavailable}
            aria-label="YouTube playback speed"
            data-testid="youtube-playback-rate"
            onChange={event => playerRef.current?.setPlaybackRate(Number(event.target.value))}
          >
            {PLAYBACK_RATES.map(rate => (
              <option key={rate} value={rate}>
                {rate}×
              </option>
            ))}
          </select>
        </label>
      </div>

      {visibilityRatio < 0.5 ? (
        <p className="youtube-visibility-note" role="status">
          Keep at least half of the YouTube player visible before using Cadence’s Play control.
        </p>
      ) : null}
    </div>
  );
}

export function YouTubeNowPlayingView() {
  const draftUrl = useYouTubeRemote(state => state.draftUrl);
  const videoId = useYouTubeRemote(state => state.videoId);
  const sourceUrl = useYouTubeRemote(state => state.sourceUrl);
  const metadata = useYouTubeRemote(state => state.metadata);
  const sizeMode = useYouTubeRemote(state => state.sizeMode);
  const volume = useYouTubeRemote(state => state.volume);
  const setDraftUrl = useYouTubeRemote(state => state.setDraftUrl);
  const load = useYouTubeRemote(state => state.load);
  const setMetadata = useYouTubeRemote(state => state.setMetadata);
  const setSizeMode = useYouTubeRemote(state => state.setSizeMode);
  const setVolume = useYouTubeRemote(state => state.setVolume);
  const clearRemote = useYouTubeRemote(state => state.clear);

  const settings = useSettings(state => state.settings);
  const lyricsSettings = settings?.lyrics ?? FALLBACK_LYRICS_SETTINGS;
  const playerRef = useRef<YouTubePlayerHandle | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<YouTubePlayerErrorInfo | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [latestSnapshot, setLatestSnapshot] = useState<YouTubePlayerSnapshot | null>(null);
  const [visibilityRatio, setVisibilityRatio] = useState(1);
  const [playVisibilityMessage, setPlayVisibilityMessage] = useState(false);

  const remoteLyrics = useYouTubeLyrics(metadata, lyricsSettings);
  const themeCss = useMemo(() => buildThemeCss(lyricsSettings), [lyricsSettings]);

  // One audible source at a time: starting a local track from Cadence's normal bar pauses the
  // iframe, while an actual iframe "playing" state pauses the local engine in onSnapshot below.
  useEffect(
    () =>
      usePlayer.subscribe((state, previous) => {
        if (state.isPlaying && !previous.isPlaying) playerRef.current?.pause();
      }),
    []
  );

  // The embedded player is not background audio: pause it if a centered Cadence modal would
  // cover it, or if the desktop document itself is hidden/minimized. Route changes already
  // unmount and destroy the player component.
  const modalOpen = useUi(
    state => state.shortcutsHelpOpen || state.playlistPicker !== null || state.trackEditorId !== null
  );
  useEffect(() => {
    if (modalOpen) playerRef.current?.pause();
  }, [modalOpen]);
  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.hidden) playerRef.current?.pause();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  const submitUrl = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedVideoId = parseYouTubeVideoId(draftUrl);
    if (!parsedVideoId) {
      setInputError(
        "That doesn't look like a supported YouTube video link. Paste a music.youtube.com/watch, youtube.com/watch, or youtu.be link."
      );
      return;
    }
    setInputError(null);
    setPlayerError(null);
    setPlayVisibilityMessage(false);
    load(parsedVideoId, canonicalSourceUrl(draftUrl, parsedVideoId));
  };

  const updateMetadataDuration = useCallback(
    (duration: number) => {
      if (!Number.isFinite(duration) || duration <= 0) return;
      const current = useYouTubeRemote.getState().metadata;
      if (!current || Math.abs(current.duration - duration) < 0.01) return;
      setMetadata({ ...current, duration });
    },
    [setMetadata]
  );

  const handleMetadata = useCallback(
    (playerMetadata: YouTubePlayerMetadata) => {
      const current = useYouTubeRemote.getState();
      if (current.videoId !== playerMetadata.videoId) return;
      const clock = youtubePlaybackClock.getSnapshot();
      setMetadata({
        videoId: playerMetadata.videoId,
        sourceId: `youtube:${playerMetadata.videoId}`,
        title: playerMetadata.title,
        artist: normalizeYouTubeArtist(playerMetadata.author) ?? playerMetadata.author,
        album: current.metadata?.album ?? "",
        duration: clock.duration > 0 ? clock.duration : current.metadata?.duration ?? 0,
        artworkUrl: `https://i.ytimg.com/vi/${playerMetadata.videoId}/hqdefault.jpg`,
        sourceUrl: current.sourceUrl ?? canonicalSourceUrl(current.draftUrl, playerMetadata.videoId),
      });
    },
    [setMetadata]
  );

  const handleSnapshot = useCallback(
    (snapshot: YouTubePlayerSnapshot) => {
      setLatestSnapshot(previous =>
        previous?.state === snapshot.state &&
        previous.duration === snapshot.duration &&
        previous.isPlaying === snapshot.isPlaying &&
        previous.volume === snapshot.volume &&
        previous.muted === snapshot.muted
          ? previous
          : snapshot
      );
      updateMetadataDuration(snapshot.duration);
      const remote = useYouTubeRemote.getState();
      if (Math.abs(remote.volume - snapshot.volume) > 0.01 || remote.muted !== snapshot.muted) {
        remote.setVolume(snapshot.volume, snapshot.muted);
      }
      if (snapshot.isPlaying) {
        setPlayVisibilityMessage(false);
        const local = usePlayer.getState();
        if (local.isPlaying) void local.toggle();
      }
    },
    [updateMetadataDuration]
  );

  const handlePlayerError = useCallback((error: YouTubePlayerErrorInfo) => {
    setPlayerError(error);
  }, []);

  const openSource = useCallback(() => {
    if (!sourceUrl) return;
    if (window.cadence?.app?.openExternal) {
      void window.cadence.app.openExternal(sourceUrl);
    } else {
      window.open(sourceUrl, "_blank", "noopener,noreferrer");
    }
  }, [sourceUrl]);

  const clearLoadedVideo = () => {
    playerRef.current?.pause();
    clearRemote();
    setPlayerError(null);
    setLatestSnapshot(null);
    setPlayerReady(false);
  };

  const syncLabel =
    remoteLyrics.status === "loading"
      ? "Finding lyrics…"
      : remoteLyrics.syncType === "richsync"
        ? "Word synced"
        : remoteLyrics.syncType === "synced"
          ? "Line synced"
          : remoteLyrics.status === "ready"
            ? "Unsynchronized"
            : "No lyrics";

  const statusPanel =
    !videoId || remoteLyrics.status === "empty" || remoteLyrics.status === "error";
  const playerSize = YOUTUBE_PLAYER_SIZES[sizeMode];

  return (
    <section className="view youtube-view" data-testid="youtube-now-playing">
      <header className="youtube-heading">
        <div>
          <div className="eyebrow">YouTube · official embedded player</div>
          <h1>YouTube Now Playing</h1>
          <p className="muted">
            Cadence provides the interface and lyrics. Playback happens inside YouTube’s visible
            official player—not Cadence’s local audio engine.
          </p>
        </div>
        {videoId ? (
          <button type="button" className="icon-button" onClick={clearLoadedVideo} aria-label="Unload YouTube video" title="Unload video">
            <X size={18} />
          </button>
        ) : null}
      </header>

      <form className="youtube-url-form" onSubmit={submitUrl}>
        <label htmlFor="youtube-music-url">
          <Link2 size={16} aria-hidden="true" />
          <span>YouTube or YouTube Music link</span>
        </label>
        <div className="youtube-url-row">
          <input
            id="youtube-music-url"
            data-testid="youtube-url-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://music.youtube.com/watch?v=…"
            value={draftUrl}
            onChange={event => {
              setDraftUrl(event.target.value);
              if (inputError) setInputError(null);
            }}
          />
          <button type="submit" className="primary" data-testid="youtube-load-button">
            Load video
          </button>
        </div>
        {inputError ? (
          <p className="error-text" data-testid="youtube-url-error" role="alert">
            {inputError}
          </p>
        ) : (
          <p className="youtube-form-hint">
            Supported links are validated locally and only the 11-character video ID is handed to the
            official player. Playlist-only links are not loaded in this prototype.
          </p>
        )}
      </form>

      {playerError ? (
        <div className="youtube-player-error" data-testid="youtube-player-error" role="alert">
          <strong>Playback unavailable.</strong>
          <span>{playerError.message}</span>
          {sourceUrl ? (
            <button type="button" onClick={openSource}>
              Open on YouTube <ExternalLink size={14} />
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="youtube-layout">
        <div className="youtube-stage" aria-label="YouTube playback">
          <div className="youtube-track-summary">
            <Artwork
              src={metadata?.artworkUrl ?? null}
              alt={metadata?.title ?? "YouTube artwork"}
              size="lg"
              className="youtube-artwork"
            />
            <div className="youtube-track-copy">
              <span className="youtube-source-badge">YouTube</span>
              <h2 data-testid="youtube-title">{metadata?.title ?? "Paste a link to begin"}</h2>
              <p data-testid="youtube-artist">{metadata?.artist || "Artist will appear after the player loads"}</p>
              <p className="youtube-album-note">
                {metadata?.album ? metadata.album : "Album is not provided by the YouTube player"}
              </p>
              {sourceUrl ? (
                <button type="button" className="youtube-source-link" onClick={openSource} data-testid="youtube-open-source">
                  Open source <ExternalLink size={13} />
                </button>
              ) : null}
            </div>
          </div>

          <div className="youtube-player-area">
            {videoId ? (
              <YouTubeIframePlayer
                ref={playerRef}
                videoId={videoId}
                sizeMode={sizeMode}
                clockSource={youtubePlaybackClock}
                initialVolume={volume}
                onReady={snapshot => {
                  setPlayerReady(true);
                  handleSnapshot(snapshot);
                }}
                onSnapshot={handleSnapshot}
                onMetadata={handleMetadata}
                onError={handlePlayerError}
                onVisibilityChange={setVisibilityRatio}
              />
            ) : (
              <div
                className="youtube-player-placeholder"
                style={{ width: playerSize.width, height: playerSize.height }}
                data-testid="youtube-player-placeholder"
              >
                <Music4 size={28} />
                <span>Official player appears here</span>
              </div>
            )}
          </div>

          <div className="youtube-size-row" aria-label="YouTube player size">
            <span>{stateLabel(latestSnapshot, playerReady, Boolean(videoId))}</span>
            <div className="youtube-size-toggle">
              <button
                type="button"
                className={sizeMode === "compact" ? "active" : ""}
                aria-pressed={sizeMode === "compact"}
                data-testid="youtube-size-compact"
                onClick={() => setSizeMode("compact")}
              >
                <Minimize2 size={14} /> Compact 200×200
              </button>
              <button
                type="button"
                className={sizeMode === "expanded" ? "active" : ""}
                aria-pressed={sizeMode === "expanded"}
                data-testid="youtube-size-expanded"
                onClick={() => setSizeMode("expanded")}
              >
                <Maximize2 size={14} /> Expanded 480×270
              </button>
            </div>
          </div>

          <YouTubeControls
            playerRef={playerRef}
            ready={playerReady && Boolean(videoId)}
            disabled={Boolean(playerError)}
            visibilityRatio={visibilityRatio}
            onPlayRejected={() => setPlayVisibilityMessage(true)}
          />
          {playVisibilityMessage ? (
            <p className="error-text" role="alert">
              Cadence did not start playback because at least half of the official player must be visible.
            </p>
          ) : null}
          <p className="youtube-engine-note">
            Remote playback does not use Cadence EQ, ReplayGain, crossfade, gapless playback, or the
            local queue/history in this prototype.
          </p>
        </div>

        <div className="youtube-lyrics-panel" aria-label="Cadence lyrics for YouTube playback">
          <div className="youtube-lyrics-toolbar">
            <div>
              <span className={`sync-dot sync-${syncLabel.toLowerCase().replace(/\s+/g, "-")}`} />
              <strong data-testid="youtube-lyrics-sync-label">{syncLabel}</strong>
              {remoteLyrics.activeCandidate ? (
                <span className="youtube-lyrics-provider"> · {remoteLyrics.activeCandidate.provider}</span>
              ) : null}
              {remoteLyrics.translating ? <span className="youtube-lyrics-provider"> · translating…</span> : null}
              {remoteLyrics.romanizing ? <span className="youtube-lyrics-provider"> · romanizing…</span> : null}
            </div>
            <div className="youtube-lyrics-actions">
              {remoteLyrics.candidates.length > 1 ? (
                <select
                  value={remoteLyrics.activeIndex}
                  onChange={event => remoteLyrics.selectCandidate(Number(event.target.value))}
                  aria-label="Lyrics provider result"
                  data-testid="youtube-lyrics-source-select"
                >
                  {remoteLyrics.candidates.map((candidate, index) => (
                    <option key={`${candidate.source}-${index}`} value={index}>
                      {candidate.provider}
                      {candidate.matchTitle ? ` — ${candidate.matchTitle}` : ""}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                className="icon-button"
                onClick={remoteLyrics.reload}
                disabled={!metadata || remoteLyrics.status === "loading"}
                aria-label="Retry lyrics search"
                title="Retry lyrics search"
              >
                <RefreshCw size={15} className={remoteLyrics.status === "loading" ? "spin" : ""} />
              </button>
            </div>
          </div>

          {remoteLyrics.activeCandidate?.matchAlbum ? (
            <p className="youtube-lyrics-match">Lyrics match album: {remoteLyrics.activeCandidate.matchAlbum}</p>
          ) : null}
          {remoteLyrics.decorationError ? <p className="error-text">{remoteLyrics.decorationError}</p> : null}

          <div className={`lyrics-body youtube-lyrics-body ${statusPanel ? "has-status-panel" : ""}`}>
            {videoId && metadata ? (
              <BraccatoLyrics
                lyrics={
                  lyricsSettings.hideInstrumentalOnly && remoteLyrics.parsed?.instrumentalOnly
                    ? []
                    : remoteLyrics.lyrics
                }
                trackId={metadata.sourceId}
                sourceKey={remoteLyrics.activeCandidate?.source ?? null}
                themeCss={themeCss}
                offsetMs={lyricsSettings.offsetMs}
                passiveScroll={lyricsSettings.passiveScroll}
                fontFamily={settings?.appearance.fontFamily}
                songwriters={remoteLyrics.parsed?.songwriters ?? []}
                language={remoteLyrics.parsed?.language ?? null}
                loaderVisible={remoteLyrics.status === "loading" && !remoteLyrics.lyrics?.length}
                noLyrics={remoteLyrics.status === "empty"}
                remoteClockSource={youtubePlaybackClock}
                onLineClick={timeS => playerRef.current?.seekTo(timeS, true)}
              />
            ) : null}

            {!videoId ? (
              <div className="lyrics-empty-panel" data-testid="youtube-lyrics-idle">
                <div className="lyrics-empty-icon" aria-hidden="true">
                  <Music4 size={20} />
                </div>
                <h2>Lyrics will follow the iframe clock</h2>
                <p>Load a YouTube link and Cadence will search its existing lyrics providers using the player’s title, artist, and duration.</p>
              </div>
            ) : null}

            {videoId && remoteLyrics.status === "empty" ? (
              <div className="lyrics-empty-panel" data-testid="youtube-lyrics-empty">
                <div className="lyrics-empty-icon" aria-hidden="true">
                  <Music4 size={20} />
                </div>
                <h2>No lyrics found</h2>
                <p>
                  {lyricsSettings.autoFetch
                    ? "Cadence checked the enabled online lyrics providers for this video's metadata."
                    : "Online lyrics lookup is turned off in Settings, and a remote YouTube video has no local sidecar or embedded tag."}
                </p>
                <div className="empty-actions">
                  <button type="button" onClick={remoteLyrics.reload}>
                    <RefreshCw size={16} /> Try again
                  </button>
                </div>
              </div>
            ) : null}

            {videoId && remoteLyrics.status === "error" ? (
              <div className="lyrics-empty-panel error" data-testid="youtube-lyrics-error">
                <div className="lyrics-empty-icon" aria-hidden="true">
                  <RefreshCw size={20} />
                </div>
                <h2>Lyrics could not be loaded</h2>
                <p>{remoteLyrics.error}</p>
                <div className="empty-actions">
                  <button type="button" onClick={remoteLyrics.reload}>
                    <RefreshCw size={16} /> Retry
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
