/**
 * Background last.fm scrobbler.
 *
 * Listened time is accumulated from real position movement while playing, so
 * pausing, seeking forward, and leaving a track parked halfway cannot fake a
 * scrobble. A track scrobbles once per play-through (half the track or four
 * minutes of actual listening), and a repeat-one replay counts as a new play.
 */

import { useEffect } from "react";
import {
  isLastFmConnected,
  lastFmScrobble,
  lastFmUpdateNowPlaying,
  shouldScrobble,
  type LastFmTrackInfo,
} from "../../../main/scrobble/lastfmCore";
import { useLibrary } from "../../state/libraryStore";
import { currentTrackId, usePlayer } from "../../state/playerStore";
import { useSettings } from "../../state/settingsStore";

const RETRY_DELAY_MS = 30_000;
type PlayerSnapshot = ReturnType<typeof usePlayer.getState>;

export function useLastFmScrobbler(): void {
  useEffect(() => {
    let activeTrackId: number | null = null;
    let playStartedAtMs = 0;
    let listenedSeconds = 0;
    let lastPosition = 0;
    let scrobbled = false;
    let nowPlayingSent = false;
    let scrobbleInFlight = false;
    let nextRetryAt = 0;

    const beginPlay = (state: PlayerSnapshot, approximateStart: boolean) => {
      playStartedAtMs = Date.now() - (approximateStart ? state.position * 1000 : 0);
      listenedSeconds = 0;
      scrobbled = false;
      nowPlayingSent = false;
      scrobbleInFlight = false;
      nextRetryAt = 0;
    };

    const unsubscribe = usePlayer.subscribe(state => {
      const scrobbling = useSettings.getState().settings?.scrobbling;
      const trackId = currentTrackId(state);

      if (!scrobbling?.enabled || !isLastFmConnected(scrobbling)) {
        // Keep the position baseline fresh so enabling scrobbling mid-track
        // cannot credit unheard time as a giant delta later.
        activeTrackId = trackId;
        lastPosition = state.position;
        listenedSeconds = 0;
        scrobbled = false;
        nowPlayingSent = false;
        return;
      }

      const previousPosition = lastPosition;
      if (trackId !== activeTrackId) {
        activeTrackId = trackId;
        beginPlay(state, true);
      } else if (trackId !== null) {
        const delta = state.position - previousPosition;
        const duration = state.duration || 0;
        const repeatedFromStart =
          delta < -1 && duration > 0 && previousPosition >= duration - 2 && state.position < 2;
        if (repeatedFromStart) {
          beginPlay(state, false);
        } else if (state.isPlaying && delta > 0 && delta <= 2.5) {
          listenedSeconds += delta;
        }
      }
      lastPosition = state.position;

      if (trackId === null || !state.isPlaying) return;
      const track = useLibrary.getState().tracksById.get(trackId);
      if (!track) return;

      const info: LastFmTrackInfo = {
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: state.duration || track.duration,
        trackNo: track.trackNo,
      };
      const credentials = {
        apiKey: scrobbling.apiKey,
        apiSecret: scrobbling.apiSecret,
        sessionKey: scrobbling.sessionKey,
      };

      if (!nowPlayingSent) {
        nowPlayingSent = true;
        void lastFmUpdateNowPlaying(credentials, info).catch(error => {
          nowPlayingSent = false;
          console.warn("[Cadence] last.fm now-playing update failed:", error);
        });
      }

      const durationSeconds = state.duration || track.duration || 0;
      if (
        !scrobbleInFlight &&
        Date.now() >= nextRetryAt &&
        shouldScrobble({ durationSeconds, listenedSeconds, alreadyScrobbled: scrobbled })
      ) {
        scrobbleInFlight = true;
        const startedAtSeconds = playStartedAtMs / 1000;
        void lastFmScrobble(credentials, info, startedAtSeconds)
          .then(accepted => {
            scrobbled = true;
            if (!accepted) {
              console.warn("[Cadence] last.fm ignored a scrobble for:", info.title);
            }
          })
          .catch(error => {
            nextRetryAt = Date.now() + RETRY_DELAY_MS;
            console.warn("[Cadence] last.fm scrobble failed; will retry once later:", error);
          })
          .finally(() => {
            scrobbleInFlight = false;
          });
      }
    });

    return unsubscribe;
  }, []);
}
