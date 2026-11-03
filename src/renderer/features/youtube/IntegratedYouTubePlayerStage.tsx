/**
 * The one visible official-YouTube playback stage inside Cadence's main Now Playing view.
 *
 * This component owns only the IFrame mount and its local size/visibility presentation. It is
 * not a second player: queue position, current item, transport state, history eligibility and
 * lyrics metadata all stay in `playerStore`, which receives the documented IFrame callbacks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { canOpenInYouTubePlayer, remoteVideoId } from "../../../shared/media";
import type { MediaItem } from "../../../shared/types";
import { SourceBadge } from "../../components/SourceBadge";
import { registerYouTubePlayer, youtubePlaybackClock } from "../../player/youtubePlayerAdapter";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import {
  YOUTUBE_PLAYER_SIZES,
  YouTubeIframePlayer,
  type YouTubePlayerErrorInfo,
  type YouTubePlayerHandle,
  type YouTubePlayerMetadata,
  type YouTubePlayerSizeMode,
  type YouTubePlayerSnapshot,
} from "./YouTubeIframePlayer";

function statusText(status: string, error: string | null): string {
  if (error) return error;
  switch (status) {
    case "playing":
      return "Playing in YouTube’s official embedded player";
    case "buffering":
    case "loading":
      return "Loading in YouTube’s official embedded player…";
    case "cued":
      return "Cued in YouTube’s official embedded player";
    case "ended":
      return "Ended";
    case "needs-now-playing":
      return "The official player must be visible here before playback can start";
    case "error":
      return "The official YouTube player reported an error";
    default:
      return "Paused in YouTube’s official embedded player";
  }
}

export function IntegratedYouTubePlayerStage({ item }: { item: MediaItem }) {
  const videoId = remoteVideoId(item);
  const volume = usePlayer(state => state.volume);
  const remoteStatus = usePlayer(state => state.remoteStatus);
  const remoteError = usePlayer(state => state.remoteError);
  const setRemotePlayerMounted = usePlayer(state => state.setRemotePlayerMounted);
  const setRemotePlayerVisible = usePlayer(state => state.setRemotePlayerVisible);
  const remotePlayerReady = usePlayer(state => state.remotePlayerReady);
  const syncRemoteSnapshot = usePlayer(state => state.syncRemoteSnapshot);
  const syncRemoteMetadata = usePlayer(state => state.syncRemoteMetadata);
  const syncRemoteError = usePlayer(state => state.syncRemoteError);
  const handleRemoteEnded = usePlayer(state => state.handleRemoteEnded);
  const modalOpen = useUi(
    state => state.shortcutsHelpOpen || state.playlistPicker !== null || state.trackEditorId !== null
  );

  const stageRef = useRef<HTMLElement | null>(null);
  const handleRef = useRef<YouTubePlayerHandle | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const [sizePreference, setSizePreference] = useState<YouTubePlayerSizeMode | null>(null);
  const [visibilityRatio, setVisibilityRatio] = useState(1);
  const [localError, setLocalError] = useState<YouTubePlayerErrorInfo | null>(null);

  const setPlayerHandle = useCallback((handle: YouTubePlayerHandle | null) => {
    handleRef.current = handle;
    registerYouTubePlayer(handle);
  }, []);

  // The IFrame component itself stays mounted across remote-track changes; only its videoId
  // prop changes. Unregister/report unmounted only for a real stage unmount, otherwise a
  // Next/Previous transition would briefly erase the store's pending autoplay intent and the
  // newly cued video would never receive its Play retry.
  useEffect(
    () => () => {
      registerYouTubePlayer(null);
      setRemotePlayerMounted(false);
    },
    [setRemotePlayerMounted]
  );

  useEffect(() => {
    if (!videoId) return;
    setLocalError(null);
    setRemotePlayerMounted(true, videoId);
  }, [setRemotePlayerMounted, videoId]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setMeasuredWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // The official player is not hidden/background audio. If Cadence covers it with a modal or
  // the desktop window is hidden, pause through the one player store rather than leaving the
  // iframe playing underneath another surface.
  useEffect(() => {
    if (modalOpen && usePlayer.getState().isPlaying) void usePlayer.getState().toggle();
  }, [modalOpen]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.hidden && usePlayer.getState().isPlaying) void usePlayer.getState().toggle();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  const handleReady = useCallback(
    (snapshot: YouTubePlayerSnapshot) => {
      if (!videoId) return;
      syncRemoteSnapshot(videoId, snapshot);
      remotePlayerReady(videoId);
    },
    [remotePlayerReady, syncRemoteSnapshot, videoId]
  );

  const handleSnapshot = useCallback(
    (snapshot: YouTubePlayerSnapshot) => {
      if (videoId) syncRemoteSnapshot(videoId, snapshot);
    },
    [syncRemoteSnapshot, videoId]
  );

  const handleMetadata = useCallback(
    (metadata: YouTubePlayerMetadata) => {
      if (videoId) syncRemoteMetadata(videoId, metadata);
    },
    [syncRemoteMetadata, videoId]
  );

  const handleError = useCallback(
    (error: YouTubePlayerErrorInfo) => {
      setLocalError(error);
      if (videoId) syncRemoteError(videoId, error);
    },
    [syncRemoteError, videoId]
  );

  const handleEnded = useCallback(
    (snapshot: YouTubePlayerSnapshot) => {
      if (!videoId) return;
      syncRemoteSnapshot(videoId, snapshot);
      void handleRemoteEnded(videoId);
    },
    [handleRemoteEnded, syncRemoteSnapshot, videoId]
  );

  const handleVisibility = useCallback(
    (ratio: number) => {
      setVisibilityRatio(ratio);
      if (!videoId) return;
      setRemotePlayerVisible(ratio > 0.5, videoId);
      if (ratio <= 0.5 && usePlayer.getState().isPlaying) {
        void usePlayer.getState().toggle();
      }
    },
    [setRemotePlayerVisible, videoId]
  );

  if (!videoId || item.source.kind === "local") return null;

  const sizeMode: YouTubePlayerSizeMode =
    measuredWidth > 0 && measuredWidth < 512 ? "compact" : sizePreference ?? "expanded";
  const size = YOUTUBE_PLAYER_SIZES[sizeMode];
  const playable = canOpenInYouTubePlayer(item);
  const errorMessage = localError?.message ?? remoteError;

  const openSource = () => {
    if (usePlayer.getState().isPlaying) void usePlayer.getState().toggle();
    const url = item.source.kind === "local" ? "" : item.source.canonicalUrl;
    if (!url) return;
    if (window.cadence?.app?.openExternal) void window.cadence.app.openExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <section
      ref={stageRef}
      className="integrated-youtube-stage"
      data-testid="integrated-youtube-player"
      data-remote-id={videoId}
      data-source-kind={item.source.kind}
      data-playback-mechanism="youtube-iframe"
      data-player-size={sizeMode}
      aria-label="Official YouTube player"
    >
      <div className="integrated-youtube-heading">
        <div className="integrated-youtube-status">
          <SourceBadge source={item} />
          <span role="status" data-testid="integrated-youtube-status">
            {statusText(remoteStatus, errorMessage)}
          </span>
        </div>
        <div className="integrated-youtube-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={sizeMode === "expanded" ? "Use compact YouTube player" : "Use larger YouTube player"}
            title={sizeMode === "expanded" ? "Compact player (200×200)" : "Larger player (480×270)"}
            data-testid="integrated-youtube-size-toggle"
            onClick={() => setSizePreference(sizeMode === "expanded" ? "compact" : "expanded")}
          >
            {sizeMode === "expanded" ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Open source on YouTube"
            title="Open source on YouTube"
            data-testid="integrated-youtube-open-source"
            onClick={openSource}
          >
            <ExternalLink size={16} />
          </button>
        </div>
      </div>

      {playable ? (
        <div className="integrated-youtube-player-area">
          <YouTubeIframePlayer
            ref={setPlayerHandle}
            videoId={videoId}
            sizeMode={sizeMode}
            clockSource={youtubePlaybackClock}
            initialVolume={volume}
            onReady={handleReady}
            onSnapshot={handleSnapshot}
            onMetadata={handleMetadata}
            onError={handleError}
            onEnded={handleEnded}
            onVisibilityChange={handleVisibility}
          />
        </div>
      ) : (
        <div
          className="youtube-player-placeholder integrated-youtube-unavailable"
          style={{ width: size.width, height: size.height }}
          role="alert"
        >
          <strong>Playback unavailable</strong>
          <span>
            {item.availability === "not-embeddable"
              ? "YouTube does not allow this video in embedded players."
              : "This YouTube video is unavailable."}
          </span>
        </div>
      )}

      <p className="integrated-youtube-note">
        {size.width}×{size.height} official embedded player · Playback is not routed through
        Cadence’s local audio engine.
        {visibilityRatio <= 0.5
          ? " Keep more than half of the player visible before pressing Play."
          : ""}
      </p>
    </section>
  );
}
