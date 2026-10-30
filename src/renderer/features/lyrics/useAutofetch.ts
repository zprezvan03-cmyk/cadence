/**
 * App-level Autofetch driver: starts a lyrics lookup the moment a track starts playing,
 * without waiting for the user to open Now Playing. It only *triggers* the shared
 * `ensureLyricsForTrack` pipeline (same store, same bridge resolve, same service-side request
 * coordination as the lyrics view and Fetch All) and promotes the track inside any running
 * Fetch All job. Mounted once in `App`.
 */

import { useEffect } from "react";
import { bridge, hasBridge } from "../../state/bridge";
import { useLibrary } from "../../state/libraryStore";
import { currentTrackId, usePlayer } from "../../state/playerStore";
import { useSettings } from "../../state/settingsStore";
import { ensureLyricsForTrack } from "./useLyrics";

export function useAutofetchLyrics(): void {
  useEffect(() => {
    let lastKey = "";

    const check = () => {
      const settings = useSettings.getState().settings;
      if (!settings) return;
      // Only fetch for a track the user is actually playing. A queue restored at launch sits
      // paused on its last track; fetching for it before the user presses play would spend
      // network (and re-populate a just-cleared cache) on every startup for lyrics nobody has
      // asked for yet. Pressing play fires the same check via the subscription below.
      if (!usePlayer.getState().isPlaying) return;
      const trackId = currentTrackId(usePlayer.getState());
      if (trackId === null) return;
      const track = useLibrary.getState().tracksById.get(trackId);
      if (!track) return;
      const lyrics = settings.lyrics;
      const key = `${track.id}:${lyrics.autoFetch ? "online" : "local"}:${lyrics.providerOrder.join(",")}`;
      if (key === lastKey) return;
      lastKey = key;

      // If a Fetch All job is running, this track jumps the queue; if it is already being
      // processed there, the service-level in-flight sharing makes this resolve reuse it.
      if (hasBridge()) {
        void bridge.lyrics.fetchAll?.promote(track.id).catch(() => undefined);
      }
      void ensureLyricsForTrack(track, lyrics);
    };

    check();
    // Cheap guards inside `check` (key compare) keep 10 Hz playback ticks from doing work;
    // subscriptions still only re-check on state changes of the three owning stores.
    const unsubscribes = [
      usePlayer.subscribe((state, previous) => {
        if (
          currentTrackId(state) !== currentTrackId(previous) ||
          (state.isPlaying && !previous.isPlaying)
        ) {
          check();
        }
      }),
      useSettings.subscribe((state, previous) => {
        if (state.settings?.lyrics !== previous.settings?.lyrics) check();
      }),
      useLibrary.subscribe((state, previous) => {
        if (state.tracksById !== previous.tracksById) check();
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, []);
}
