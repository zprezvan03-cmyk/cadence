/**
 * YouTube Music home feed inside Cadence: chips (home filters), shelves (Quick Picks, Keep
 * Listening, new releases, charts, moods…) with continuation-based "load more". Guest mode works
 * with no account; nothing here prompts for login.
 */

import { useEffect, useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { YtmShelf, YtmTrack } from "../../../shared/ytmusic";
import { useYtm } from "../../state/ytmusicStore";
import { usePlayer } from "../../state/playerStore";
import { currentSource } from "../../state/playerStore";
import { YtmCardGrid, YtmShelfActions, YtmTrackList, trackToItem } from "./YtmItems";
import { useUi } from "../../state/uiStore";

function shelfTracks(shelf: YtmShelf): YtmTrack[] {
  return shelf.items
    .filter((item): item is { type: "song" | "video"; track: YtmTrack } => item.type === "song" || item.type === "video")
    .map(item => item.track);
}

export function YtmHomeView() {
  const home = useYtm(state => state.home);
  const loadHome = useYtm(state => state.loadHome);
  const loadMoreHome = useYtm(state => state.loadMoreHome);
  const navigate = useUi(state => state.navigate);
  const currentVideoId = usePlayer(state => {
    const source = currentSource(state);
    return source && source.kind === "youtube-music" ? source.remoteId : null;
  });
  const isPlaying = usePlayer(state => state.isPlaying);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

  const sections = useMemo(() => home.data?.sections ?? [], [home.data]);

  return (
    <div className="view ytm-view" data-testid="ytm-home-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">YouTube Music</p>
          <h1>Home</h1>
        </div>
        <div className="heading-actions">
          <button type="button" className="icon-button" onClick={() => void loadHome(true)} aria-label="Refresh home" title="Refresh">
            <RefreshCw size={16} />
          </button>
          <button type="button" className="ghost-button" onClick={() => navigate({ name: "ytm-explore" })}>
            Explore &amp; charts
          </button>
        </div>
      </header>

      {home.data?.chips && home.data.chips.length > 0 ? (
        <div className="ytm-chip-row" data-testid="ytm-home-chips">
          {home.data.chips.map(chip => (
            <button
              key={chip.title}
              type="button"
              className={`ytm-chip${chip.selected ? " selected" : ""}`}
              onClick={() => {
                // Chips carry the home-section params; they re-browse the home feed.
                void useYtm.getState().provider().homeParams(chip.params ?? "").then(page =>
                  useYtm.setState({ home: { status: "ready", data: page, continuation: page.continuation, error: null, loadingMore: false } }),
                );
              }}
            >
              {chip.title}
            </button>
          ))}
        </div>
      ) : null}

      {home.status === "loading" && sections.length === 0 ? (
        <div className="view-loading" data-testid="ytm-home-loading">
          <Loader2 size={16} className="spin" /> Loading YouTube Music home…
        </div>
      ) : null}

      {home.status === "error" ? (
        <div className="empty-state" data-testid="ytm-home-error">
          <p>Could not load YouTube Music.</p>
          <p className="muted">{home.error}</p>
          <button type="button" className="primary" onClick={() => void loadHome(true)}>Retry</button>
        </div>
      ) : null}

      {sections.map((shelf, index) => {
        const tracks = shelfTracks(shelf);
        const cards = shelf.items.filter(item => item.type !== "song" && item.type !== "video");
        return (
          <section className="shelf" key={`${shelf.title ?? "shelf"}-${index}`} data-testid="ytm-shelf">
            <div className="shelf-heading">
              <h2>{shelf.title ?? "Recommended"}</h2>
              <YtmShelfActions
                tracks={tracks}
                moreLabel={shelf.moreBrowseId ? "More" : undefined}
                onMore={
                  shelf.moreBrowseId
                    ? () => navigate({ name: "ytm-explore" })
                    : undefined
                }
              />
            </div>
            {cards.length > 0 ? <YtmCardGrid items={cards} /> : null}
            {tracks.length > 0 ? (
              <YtmTrackList tracks={tracks} activeVideoId={currentVideoId} playingVideoId={isPlaying ? currentVideoId : null} />
            ) : null}
            {shelf.continuation ? (
              <button type="button" className="link" onClick={() => void loadMoreHome()}>
                Load more
              </button>
            ) : null}
          </section>
        );
      })}

      {home.status === "ready" && home.continuation ? (
        <button type="button" className="ghost-button" disabled={home.loadingMore} onClick={() => void loadMoreHome()} data-testid="ytm-home-more">
          {home.loadingMore ? <Loader2 size={14} className="spin" /> : null} Load more
        </button>
      ) : null}
    </div>
  );
}

/** Small helper used by detail views to render one shelf of tracks. */
export function YtmShelfSection({ shelf }: { shelf: YtmShelf }) {
  const tracks = shelfTracks(shelf);
  const cards = shelf.items.filter(item => item.type !== "song" && item.type !== "video");
  const currentVideoId = usePlayer(state => {
    const source = currentSource(state);
    return source && source.kind === "youtube-music" ? source.remoteId : null;
  });
  const isPlaying = usePlayer(state => state.isPlaying);
  if (tracks.length === 0 && cards.length === 0) return null;
  return (
    <section className="shelf" data-testid="ytm-shelf">
      <div className="shelf-heading">
        <h2>{shelf.title ?? "More"}</h2>
        <YtmShelfActions tracks={tracks} />
      </div>
      {cards.length > 0 ? <YtmCardGrid items={cards} /> : null}
      {tracks.length > 0 ? (
        <YtmTrackList tracks={tracks} activeVideoId={currentVideoId} playingVideoId={isPlaying ? currentVideoId : null} />
      ) : null}
    </section>
  );
}

export { trackToItem };
