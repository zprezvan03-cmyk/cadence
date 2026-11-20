/** One-row artwork shelves for Home. */
import { Children, useCallback, useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode, type Ref } from "react";
import { ChevronLeft, ChevronRight, Heart, MoreHorizontal, Pause, Play } from "lucide-react";
import { prefersReducedMotion } from "../../app/motion";
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const childCount = Children.count(children);

  const assignViewport = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    if (typeof viewportRef === "function") viewportRef(node);
    else if (viewportRef) (viewportRef as MutableRefObject<HTMLDivElement | null>).current = node;
  }, [viewportRef]);

  const measure = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const max = Math.max(0, node.scrollWidth - node.clientWidth);
    setAtStart(node.scrollLeft <= 1);
    setAtEnd(node.scrollLeft >= max - 1);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, childCount]);

  const scrollByCard = (direction: -1 | 1) => {
    const node = scrollRef.current;
    if (!node) return;
    const cards = [...node.children] as HTMLElement[];
    const first = cards[0]?.getBoundingClientRect();
    const second = cards[1]?.getBoundingClientRect();
    const step = first && second ? second.left - first.left : Math.max(1, node.clientWidth * 0.8);
    node.scrollBy({ left: direction * step, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  return (
    <section className={`shelf home-shelf ${className}`} data-testid={testId}>
      <div className="shelf-heading">
        <h2 id={heading}>{title}</h2>
        <div className="shelf-heading-actions">
          <div className="shelf-scroll-controls">
            <button
              type="button"
              className="icon-button"
              data-testid="shelf-scroll-prev"
              aria-label={`Scroll ${title} left`}
              disabled={atStart}
              onClick={() => scrollByCard(-1)}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              data-testid="shelf-scroll-next"
              aria-label={`Scroll ${title} right`}
              disabled={atEnd}
              onClick={() => scrollByCard(1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          {aside}
        </div>
      </div>
      <div
        className="card-grid home-shelf-track"
        role="region"
        aria-labelledby={heading}
        tabIndex={0}
        ref={assignViewport}
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
