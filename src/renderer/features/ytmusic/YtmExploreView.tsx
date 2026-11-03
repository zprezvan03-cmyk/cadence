/**
 * YouTube Music discovery surfaces inside Cadence: Explore (new releases, moods & genres),
 * Charts and the moods/genres grid. All browsed through the InnerTube provider's music-specific
 * browse ids — not generic YouTube channels.
 */

import { useEffect } from "react";
import { Compass, ListMusic, Loader2, ChartColumn } from "lucide-react";
import { useYtm } from "../../state/ytmusicStore";
import { useUi } from "../../state/uiStore";
import { YtmCardGrid } from "./YtmItems";
import { YtmShelfSection } from "./YtmHomeView";

export function YtmExploreView() {
  const explore = useYtm(state => state.explore);
  const charts = useYtm(state => state.charts);
  const moods = useYtm(state => state.moods);
  const loadExplore = useYtm(state => state.loadExplore);
  const loadCharts = useYtm(state => state.loadCharts);
  const loadMoods = useYtm(state => state.loadMoods);
  const navigate = useUi(state => state.navigate);

  useEffect(() => {
    void loadExplore();
    void loadCharts();
    void loadMoods();
  }, [loadExplore, loadCharts, loadMoods]);

  const loading = explore.status === "loading" && charts.status === "loading" && moods.status === "loading";

  return (
    <div className="view ytm-view" data-testid="ytm-explore-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">YouTube Music</p>
          <h1>Explore</h1>
        </div>
      </header>

      {loading ? (
        <div className="view-loading"><Loader2 size={16} className="spin" /> Loading discovery…</div>
      ) : null}

      {explore.status === "error" || charts.status === "error" || moods.status === "error" ? (
        <div className="empty-state" data-testid="ytm-explore-error">
          <p>Some discovery sections could not load.</p>
          <p className="muted">{explore.error ?? charts.error ?? moods.error}</p>
        </div>
      ) : null}

      {explore.status === "ready" && explore.data?.newReleaseAlbums.length ? (
        <section className="shelf" data-testid="ytm-new-releases">
          <div className="shelf-heading"><h2>New releases</h2></div>
          <YtmCardGrid items={explore.data.newReleaseAlbums.map(album => ({ type: "album" as const, album }))} />
        </section>
      ) : null}

      {explore.status === "ready" && explore.data?.shelves.map((shelf, index) => (
        <YtmShelfSection key={`explore-${index}`} shelf={shelf} />
      ))}

      {charts.status === "ready" && charts.data?.shelves.map((shelf, index) => (
        <section className="shelf" key={`charts-${index}`} data-testid="ytm-charts-shelf">
          <div className="shelf-heading">
            <h2><ChartColumn size={16} /> {shelf.title ?? "Charts"}</h2>
          </div>
          <YtmShelfSection shelf={{ ...shelf, title: null }} />
        </section>
      ))}

      {moods.status === "ready" && moods.data && moods.data.length > 0 ? (
        <section className="shelf" data-testid="ytm-moods">
          <div className="shelf-heading"><h2>Moods &amp; genres</h2></div>
          <div className="ytm-chip-row">
            {moods.data.map(mood => (
              <button
                key={mood.browseId ?? mood.title}
                type="button"
                className="ytm-chip"
                onClick={() => {
                  if (!mood.browseId) return;
                  void useYtm.getState().provider().browseShelves(mood.browseId, mood.params).then(page =>
                    useYtm.setState({ charts: { status: "ready", data: page, continuation: page.continuation, error: null, loadingMore: false } }),
                  );
                }}
              >
                <Compass size={12} /> {mood.title}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="shelf">
        <div className="shelf-heading"><h2><ListMusic size={16} /> Go to</h2></div>
        <div className="ytm-chip-row">
          <button type="button" className="ytm-chip" onClick={() => navigate({ name: "ytm-home" })}>YouTube Music home</button>
        </div>
      </section>
    </div>
  );
}
