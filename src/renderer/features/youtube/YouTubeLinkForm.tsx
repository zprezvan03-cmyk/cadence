/**
 * Direct YouTube link entry for Cadence's unified queue.
 *
 * Videos become ordinary remote queue items in `playerStore`; public playlist and channel links
 * open the existing catalog detail routes. This form never executes a pasted URL as application
 * code and does not create a second playback store or Now Playing surface.
 */

import { useState, type FormEvent } from "react";
import { Link2 } from "lucide-react";
import { youtubeMediaItem } from "../../../shared/media";
import { parseYouTubeLink } from "../../../shared/youtube";
import { useUi } from "../../state/uiStore";
import { openRemoteMediaItem } from "./RemoteMediaItems";

export function YouTubeLinkForm() {
  const navigate = useUi(state => state.navigate);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseYouTubeLink(url);
    if (!parsed) {
      setError(
        "That doesn't look like a supported YouTube link. Paste a video, public playlist, or /channel/ link from YouTube or YouTube Music."
      );
      return;
    }

    setError(null);
    if (parsed.kind === "playlist") {
      navigate({ name: "youtube-playlist", playlistId: parsed.playlistId });
      return;
    }
    if (parsed.kind === "channel") {
      navigate({ name: "youtube-channel", channelId: parsed.channelId });
      return;
    }

    const item = youtubeMediaItem({
      videoId: parsed.videoId,
      sourceKind: parsed.sourceKind,
      title: "Loading YouTube video…",
      artistLabel: parsed.sourceKind === "youtube-music" ? "YouTube Music" : "YouTube",
      artworkUrl: `https://i.ytimg.com/vi/${encodeURIComponent(parsed.videoId)}/hqdefault.jpg`,
      availability: "unknown",
    });
    if (openRemoteMediaItem(item)) setUrl("");
  };

  return (
    <form className="youtube-url-form" onSubmit={submit} data-testid="youtube-url-form">
      <label htmlFor="youtube-direct-link">
        <Link2 size={16} /> Open a YouTube link
      </label>
      <div className="youtube-url-row">
        <input
          id="youtube-direct-link"
          value={url}
          onChange={event => setUrl(event.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          data-testid="youtube-url-input"
        />
        <button type="submit" className="primary" disabled={!url.trim()} data-testid="youtube-url-submit">
          Open in Now Playing
        </button>
      </div>
      <p className="youtube-form-hint">
        Videos play in YouTube&apos;s official visible embedded player inside Cadence&apos;s main
        Now Playing view. Public playlist and channel links open their catalog pages.
      </p>
      {error ? (
        <p className="field-error" role="alert" data-testid="youtube-url-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
