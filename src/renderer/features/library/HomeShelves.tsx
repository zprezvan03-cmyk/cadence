/** One-row artwork shelves for Home. */
import { useId, useRef, type ReactNode, type Ref } from "react";
import { Heart, MoreHorizontal, Pause, Play } from "lucide-react";
import { Artwork } from "../../components/Artwork";
import { MarqueeText } from "../../components/MarqueeText";
import { useTrackMenu } from "../../components/useTrackMenu";
import { formatTime } from "../../player/queue";
import { useLibrary } from "../../state/libraryStore";
import { currentTrackId, usePlayer } from "../../state/playerStore";
import type { DiscoveryTrack } from "../stats/listeningStats";

interface HomeShelfProps {
  title: string;
  aside?: ReactNode;
  className?: string;
  testId?: string;
}

export function HomeShelf({ title, aside, className = "", testId, viewportRef, children }: HomeShelfProps & {
  viewportRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section className={`shelf home-shelf ${className}`} data-testid={testId}>
      <div className="shelf-heading">
        <h2 id={heading}>{title}</h2>
        {aside}
      </div>
      <div
        className="card-grid home-shelf-track"
        role="region"
        aria-labelledby={heading}
        tabIndex={0}
        ref={viewportRef}
        onKeyDown={event => {
          // The playback shortcuts also use arrow keys. When the shelf itself is focused,
          // leave the browser's default horizontal scrolling in charge instead.
          if (event.target === event.currentTarget && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            event.stopPropagation();
          }
        }}
      >
        {children}
      </div>
    </section>
  );
}

export function HomeTrackShelf({ items, rankedQueue, ...shelf }: HomeShelfProps & {
  items: DiscoveryTrack[];
  rankedQueue?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const { surface, menuTrackId, openMenu } = useTrackMenu(viewport);
  const currentId = usePlayer(state => rankedQueue ? currentTrackId(state) : null);
  const playing = usePlayer(state => Boolean(rankedQueue && state.isPlaying));
  const setFavorite = useLibrary(state => state.setFavorite);

  return (
    <>
      <HomeShelf {...shelf} viewportRef={viewport}>
        {items.map(({ track, recentPlayCount }, index) => {
          const active = track.id === currentId;
          const pause = active && playing;
          const detail = rankedQueue ? formatTime(track.duration) : `${recentPlayCount} plays`;
          const subtitle = `${track.artist} · ${detail}`;
          const play = () => {
            const player = usePlayer.getState();
            if (!rankedQueue) void player.playTrack(track.id);
            else if (active) void player.toggle();
            else void player.playQueue(items.map(item => item.track.id), index);
          };
          return (
            <article key={track.id} className="media-card home-track-card" data-testid={rankedQueue ? "top-track-item" : "on-repeat-item"} data-track-id={track.id}>
              <button type="button" className="card-open" aria-label={`${pause ? "Pause" : "Play"} ${track.title}`} onClick={play}>
                <Artwork src={track.artworkUrl} alt="" size="md" />
                <MarqueeText as="strong" className="card-title" title={track.title}>{track.title}</MarqueeText>
                <MarqueeText className="card-subtitle" title={subtitle}>{subtitle}</MarqueeText>
                <span className="card-overlay" aria-hidden="true">
                  <span className="card-play">{pause ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</span>
                </span>
              </button>
              {rankedQueue ? (
                <div className="home-card-tools" data-menu-open={menuTrackId === track.id}>
                  <button
                    type="button"
                    className={`icon-button heart ${track.favorite ? "active" : ""}`}
                    aria-pressed={track.favorite}
                    aria-label={track.favorite ? "Remove from favourites" : "Add to favourites"}
                    onClick={() => void setFavorite(track.id, !track.favorite)}
                  ><Heart size={15} fill={track.favorite ? "currentColor" : "none"} /></button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="More actions"
                    aria-expanded={menuTrackId === track.id}
                    onClick={event => openMenu(track, event.currentTarget)}
                  ><MoreHorizontal size={18} /></button>
                </div>
              ) : null}
            </article>
          );
        })}
      </HomeShelf>
      {surface}
    </>
  );
}
