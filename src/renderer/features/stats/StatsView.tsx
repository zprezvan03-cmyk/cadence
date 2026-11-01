/**
 * Listening statistics: a read-only view over the same persistent history that feeds
 * History and Home's Recently Played shelf. Written for Cadence.
 */

import { useEffect, useMemo, useState } from "react";
import { ChartColumn, Clock3, Flame, History, Music2, Play } from "lucide-react";
import { Artwork } from "../../components/Artwork";
import { useHistory } from "../../state/historyStore";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import {
  computeListeningStats,
  type RankedAlbum,
  type RankedArtist,
  type RankedHistoryTrack,
} from "./listeningStats";

const numberFormat = new Intl.NumberFormat();

function formatCount(value: number): string {
  return numberFormat.format(Math.max(0, Math.round(value)));
}

function formatStartedTime(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${formatCount(days)}d ${remainingHours}h`;
  }
  if (hours > 0) return `${formatCount(hours)}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestamp)
  );
}

function formatFullDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function playLabel(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "play" : "plays"}`;
}

function BarChart({
  values,
  labels,
  testId,
  ariaLabel,
}: {
  values: number[];
  labels: string[];
  testId: string;
  ariaLabel: string;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="stats-chart" data-testid={testId} role="img" aria-label={ariaLabel}>
      <div className="stats-bars">
        {values.map((value, index) => (
          <div className="stats-bar-column" key={`${labels[index]}-${index}`} title={`${labels[index]}: ${playLabel(value)}`}>
            <span
              className={`stats-bar${value === 0 ? " stats-bar-empty" : ""}`}
              style={{ height: `${value === 0 ? 3 : Math.max(7, (value / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="stats-chart-axis">
        <span>{labels[0]}</span>
        <span>{labels[Math.floor(labels.length / 2)]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}

export function StatsView() {
  const snapshot = useLibrary(state => state.snapshot);
  const { entries, loading, error, load } = useHistory(state => state);
  const navigate = useUi(state => state.navigate);
  const playQueue = usePlayer(state => state.playQueue);
  const playTrack = usePlayer(state => state.playTrack);
  const showToast = useUi(state => state.showToast);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    void load();
  }, [load]);

  const tracks = useMemo(() => snapshot?.tracks ?? [], [snapshot?.tracks]);
  const stats = useMemo(
    () => computeListeningStats(entries, tracks, { now, topLimit: 10, days: 30 }),
    [entries, now, tracks]
  );

  const openArtist = (ranked: RankedArtist) => {
    const artist = snapshot?.artists.find(
      candidate => candidate.name.toLocaleLowerCase() === ranked.artist.toLocaleLowerCase()
    );
    if (artist) navigate({ name: "artist", artistId: artist.id });
    else showToast("This artist is no longer in your library.");
  };

  const openAlbum = (ranked: RankedAlbum) => {
    const album = snapshot?.albums.find(
      candidate =>
        candidate.id === ranked.key ||
        (candidate.name.toLocaleLowerCase() === ranked.album.toLocaleLowerCase() &&
          candidate.albumArtist.toLocaleLowerCase() === ranked.albumArtist.toLocaleLowerCase())
    );
    if (album) navigate({ name: "album", albumId: album.id });
    else showToast("This album is no longer in your library.");
  };

  const playRankedTrack = (ranked: RankedHistoryTrack) => {
    if (!ranked.track) {
      showToast("This track is no longer in your library.");
      return;
    }
    void playTrack(ranked.track.id);
  };

  if (loading || !snapshot) {
    return <div className="view-loading">Loading your listening stats…</div>;
  }

  if (error && entries.length === 0) {
    return (
      <div className="empty-state" data-testid="stats-error">
        <p>Unable to load listening statistics.</p>
        <p className="muted">{error}</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="view stats-view" data-testid="stats-view">
        <div className="empty-state stats-empty" data-testid="stats-empty">
          <ChartColumn size={44} aria-hidden="true" />
          <h1>No listening patterns yet</h1>
          <p>Play a few songs and Cadence will chart what you reach for, when you listen, and what keeps coming back.</p>
          {tracks.length > 0 ? (
            <button
              type="button"
              className="primary"
              onClick={() => void playQueue(tracks.map(track => track.id), 0)}
            >
              <Play size={16} fill="currentColor" /> Play your library
            </button>
          ) : (
            <button type="button" className="primary" onClick={() => navigate({ name: "home" })}>
              Add music from Home
            </button>
          )}
        </div>
      </div>
    );
  }

  const historyNote =
    stats.historyPlayCount >= 1000
      ? "Charts and rankings use your latest 1,000 recorded play starts."
      : `Based on ${playLabel(stats.historyPlayCount)} recorded as play starts.`;
  const maxGenrePlays = Math.max(1, ...stats.genres.map(genre => genre.playCount));

  return (
    <div className="view stats-view" data-testid="stats-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">Stats</p>
          <h1>Your listening, at a glance</h1>
          <p className="muted stats-note">{historyNote}</p>
        </div>
        <div className="heading-actions">
          <button type="button" onClick={() => navigate({ name: "history" })}>
            <History size={16} /> History
          </button>
        </div>
      </header>

      {error ? (
        <div className="empty-state stats-error-banner" data-testid="stats-error">
          <p>Some listening history could not be refreshed.</p>
          <p className="muted">{error}</p>
        </div>
      ) : null}

      <section className="stats-summary" data-testid="stats-summary" aria-label="Listening summary">
        <article className="stat-card">
          <Music2 size={19} aria-hidden="true" />
          <span>Recorded plays</span>
          <strong>{formatCount(stats.historyPlayCount)}</strong>
          <em>
            {stats.libraryPlayCount > stats.historyPlayCount
              ? `${formatCount(stats.libraryPlayCount)} all-time library plays`
              : `${playLabel(stats.playsLast7Days)} in the last 7 days`}
          </em>
        </article>
        <article className="stat-card">
          <Clock3 size={19} aria-hidden="true" />
          <span>Started-track time</span>
          <strong>{formatStartedTime(stats.startedTrackSeconds)}</strong>
          <em>Lengths of the tracks you started</em>
        </article>
        <article className="stat-card">
          <ChartColumn size={19} aria-hidden="true" />
          <span>Unique tracks</span>
          <strong>{formatCount(stats.uniqueTrackCount)}</strong>
          <em>from {formatCount(stats.uniqueArtistCount)} artists</em>
        </article>
        <article className="stat-card">
          <Flame size={19} aria-hidden="true" />
          <span>Listening streak</span>
          <strong>
            {formatCount(stats.currentStreakDays)} {stats.currentStreakDays === 1 ? "day" : "days"}
          </strong>
          <em>{playLabel(stats.playsLast30Days)} in the last 30 days</em>
        </article>
      </section>

      <section className="stats-grid stats-grid-charts">
        <article className="stat-panel">
          <div className="stat-panel-heading">
            <div>
              <h2>Plays by day</h2>
              <p>Last 30 days</p>
            </div>
            <strong>{playLabel(stats.playsLast30Days)}</strong>
          </div>
          <BarChart
            testId="stats-day-chart"
            ariaLabel="Bar chart of plays by day for the last 30 days"
            values={stats.playsByDay.map(day => day.count)}
            labels={stats.playsByDay.map(day => formatFullDate(day.date))}
          />
        </article>

        <article className="stat-panel">
          <div className="stat-panel-heading">
            <div>
              <h2>When you listen</h2>
              <p>Plays by hour of day</p>
            </div>
            <strong>
              Peak {String(stats.playsByHour.indexOf(Math.max(...stats.playsByHour))).padStart(2, "0")}:00
            </strong>
          </div>
          <BarChart
            testId="stats-hour-chart"
            ariaLabel="Bar chart of plays by hour of day"
            values={stats.playsByHour}
            labels={stats.playsByHour.map((_, hour) => `${String(hour).padStart(2, "0")}:00`)}
          />
        </article>
      </section>

      <section className="stats-grid stats-grid-rankings">
        <article className="stat-panel">
          <div className="stat-panel-heading">
            <div>
              <h2>Top tracks</h2>
              <p>Most started songs</p>
            </div>
          </div>
          <div className="stats-rank-list" data-testid="stats-top-tracks">
            {stats.topTracks.map((ranked, index) => (
              <button
                type="button"
                className={`stats-rank-row${ranked.track ? "" : " stats-rank-row-unavailable"}`}
                key={ranked.trackId}
                disabled={!ranked.track}
                onClick={() => playRankedTrack(ranked)}
                title={ranked.track ? `Play ${ranked.title}` : "No longer in your library"}
              >
                <span className="stats-rank-number">{index + 1}</span>
                <Artwork src={ranked.artworkUrl} alt={ranked.album || ranked.title} size="xs" />
                <span className="stats-rank-copy">
                  <strong>{ranked.title}</strong>
                  <em>{ranked.artist}</em>
                </span>
                <span className="stats-rank-count">
                  <strong>{playLabel(ranked.playCount)}</strong>
                  <em>{formatDate(ranked.lastPlayedAt)}</em>
                </span>
              </button>
            ))}
          </div>
        </article>

        <article className="stat-panel">
          <div className="stat-panel-heading">
            <div>
              <h2>Top artists</h2>
              <p>Across your recorded plays</p>
            </div>
          </div>
          <div className="stats-rank-list" data-testid="stats-top-artists">
            {stats.topArtists.map((ranked, index) => (
              <button
                type="button"
                className="stats-rank-row"
                key={ranked.artist.toLocaleLowerCase()}
                onClick={() => openArtist(ranked)}
              >
                <span className="stats-rank-number">{index + 1}</span>
                <Artwork src={ranked.artworkUrl} alt={ranked.artist} size="xs" />
                <span className="stats-rank-copy">
                  <strong>{ranked.artist}</strong>
                  <em>
                    {formatCount(ranked.uniqueTrackCount)} tracks · last {formatDate(ranked.lastPlayedAt)}
                  </em>
                </span>
                <span className="stats-rank-count">
                  <strong>{playLabel(ranked.playCount)}</strong>
                </span>
              </button>
            ))}
          </div>
        </article>

        <article className="stat-panel">
          <div className="stat-panel-heading">
            <div>
              <h2>Top albums</h2>
              <p>Records you keep returning to</p>
            </div>
          </div>
          <div className="stats-rank-list" data-testid="stats-top-albums">
            {stats.topAlbums.map((ranked, index) => (
              <button
                type="button"
                className="stats-rank-row"
                key={ranked.key}
                onClick={() => openAlbum(ranked)}
              >
                <span className="stats-rank-number">{index + 1}</span>
                <Artwork src={ranked.artworkUrl} alt={ranked.album} size="xs" />
                <span className="stats-rank-copy">
                  <strong>{ranked.album}</strong>
                  <em>
                    {ranked.albumArtist} · {formatCount(ranked.uniqueTrackCount)} tracks
                  </em>
                </span>
                <span className="stats-rank-count">
                  <strong>{playLabel(ranked.playCount)}</strong>
                  <em>{formatDate(ranked.lastPlayedAt)}</em>
                </span>
              </button>
            ))}
          </div>
        </article>
      </section>

      <section className="stat-panel stats-genres" data-testid="stats-genres">
        <div className="stat-panel-heading">
          <div>
            <h2>Genres</h2>
            <p>From the tags on tracks in your library</p>
          </div>
        </div>
        <div className="stats-genre-list">
          {stats.genres.map(genre => (
            <div className="stats-genre-row" key={genre.genre.toLocaleLowerCase()}>
              <span>{genre.genre}</span>
              <span className="stats-genre-track" aria-hidden="true">
                <span style={{ width: `${Math.max(3, (genre.playCount / maxGenrePlays) * 100)}%` }} />
              </span>
              <strong>{playLabel(genre.playCount)}</strong>
            </div>
          ))}
        </div>
      </section>

      <p className="muted stats-footnote">
        Cadence records when a track starts, not how much of it you heard. “Started-track time” is therefore
        the sum of those tracks’ full lengths, not a measured listening duration.
      </p>
    </div>
  );
}
