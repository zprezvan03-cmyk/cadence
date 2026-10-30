/**
 * First-launch onboarding: Welcome → Music Library Setup → ✨ Fetch All Lyrics ✨ →
 * Preferences → Ready. Optional steps can be skipped, progress is persisted in settings, and
 * starting Fetch All advances immediately while the background job continues on its own.
 */

import { useEffect } from "react";
import { ArrowLeft, ArrowRight, Check, FolderPlus, Music2, Sparkles } from "lucide-react";
import type { LyricsFetchConcurrency } from "../../../shared/types";
import { useLibrary } from "../../state/libraryStore";
import { ONBOARDING_STEPS, useOnboarding } from "../../state/onboardingStore";
import { useFetchAll } from "../../state/fetchAllStore";
import { useSettings } from "../../state/settingsStore";

const STEP_TITLES = ["Welcome", "Music Library Setup", "✨ Fetch All Lyrics ✨", "Preferences", "Ready"] as const;

export function Onboarding() {
  const visible = useOnboarding(state => state.visible);
  const step = useOnboarding(state => state.step);
  const next = useOnboarding(state => state.next);
  const back = useOnboarding(state => state.back);
  const finish = useOnboarding(state => state.finish);

  const settings = useSettings(state => state.settings);
  const patchSettings = useSettings(state => state.patch);
  const snapshot = useLibrary(state => state.snapshot);
  const scanning = useLibrary(state => state.scanning);
  const addFolder = useLibrary(state => state.addFolder);

  const stats = useFetchAll(state => state.stats);
  const jobState = useFetchAll(state => state.snapshot.state);
  const initFetchAll = useFetchAll(state => state.init);
  const refreshStats = useFetchAll(state => state.refreshStats);
  const startFetchAll = useFetchAll(state => state.start);

  useEffect(() => {
    if (!visible) return;
    initFetchAll();
    if (ONBOARDING_STEPS[step] === "fetch-all") void refreshStats();
  }, [visible, step, initFetchAll, refreshStats]);

  if (!visible) return null;

  const stepName = ONBOARDING_STEPS[step];
  const trackCount = snapshot?.counts.tracks ?? 0;
  const folderCount = snapshot?.folders.length ?? 0;
  const lyrics = settings?.lyrics;

  const startFetchAndContinue = () => {
    // Explicit user action only: start the persistent background job, then advance at once —
    // onboarding never waits for fetching to finish.
    void startFetchAll();
    next();
  };

  return (
    <div className="onboarding-overlay" data-testid="onboarding" role="dialog" aria-label="Cadence setup">
      <div className="onboarding-card">
        <ol className="onboarding-steps" aria-label="Setup progress">
          {STEP_TITLES.map((title, index) => (
            <li key={title} className={index === step ? "active" : index < step ? "done" : ""}>
              <span>{index < step ? <Check size={12} /> : index + 1}</span>
              {title}
            </li>
          ))}
        </ol>

        {stepName === "welcome" ? (
          <section className="onboarding-page" data-testid="onboarding-welcome">
            <Music2 size={40} className="onboarding-icon" />
            <h2>Welcome to Cadence</h2>
            <p>
              A local music player with the Better Lyrics engine: synced, word-timed lyrics with
              translation and romanization for your own library. A couple of quick steps and
              you&apos;re listening.
            </p>
          </section>
        ) : null}

        {stepName === "library" ? (
          <section className="onboarding-page" data-testid="onboarding-library">
            <h2>Music Library Setup</h2>
            <p>Add the folder (or folders) where your music lives. Cadence scans tags, artwork and any lyrics files sitting next to your songs.</p>
            <p className="onboarding-stat" data-testid="onboarding-library-stats">
              {folderCount} {folderCount === 1 ? "folder" : "folders"} · {trackCount}{" "}
              {trackCount === 1 ? "track" : "tracks"}
              {scanning ? " · Scanning…" : ""}
            </p>
            <button type="button" className="primary" onClick={() => void addFolder()} disabled={scanning}>
              <FolderPlus size={16} /> Add music folder
            </button>
          </section>
        ) : null}

        {stepName === "fetch-all" ? (
          <section className="onboarding-page" data-testid="onboarding-fetch-all">
            <Sparkles size={40} className="onboarding-icon" />
            <h2>✨ FETCH ALL LYRICS ✨</h2>
            <p>
              Cadence can search for lyrics across your entire music library now, in the
              background — recently played songs first. Everything found is cached per provider,
              so lyrics are simply there when a song plays. You can keep using Cadence while it
              works, and pause or cancel any time from the top bar.
            </p>
            {stats ? (
              <dl className="onboarding-stats" data-testid="onboarding-fetch-stats">
                <div>
                  <dt>Total tracks</dt>
                  <dd>{stats.totalTracks}</dd>
                </div>
                <div>
                  <dt>Already have lyrics</dt>
                  <dd>{stats.withLyrics}</dd>
                </div>
                <div>
                  <dt>To search</dt>
                  <dd>{stats.needsSearch}</dd>
                </div>
                <div>
                  <dt>Fully processed</dt>
                  <dd>{stats.fullyProcessed}</dd>
                </div>
              </dl>
            ) : (
              <p className="onboarding-stat">Checking your library…</p>
            )}
            <div className="onboarding-actions-inline">
              <button
                type="button"
                className="primary"
                data-testid="onboarding-fetch-all-start"
                onClick={startFetchAndContinue}
              >
                <Sparkles size={16} /> Fetch All Lyrics
              </button>
              <button type="button" data-testid="onboarding-fetch-all-skip" onClick={next}>
                Skip for now
              </button>
            </div>
            {jobState === "running" || jobState === "paused" ? (
              <p className="onboarding-stat">Fetching has started — progress lives in the top bar.</p>
            ) : null}
          </section>
        ) : null}

        {stepName === "preferences" ? (
          <section className="onboarding-page" data-testid="onboarding-preferences">
            <h2>Preferences</h2>
            <p>Defaults are sensible — change anything later in Settings.</p>
            {lyrics ? (
              <>
                <label className="setting-row">
                  <span>
                    <strong>Autofetch Lyrics</strong>
                    <em>Look up lyrics automatically whenever a track starts playing.</em>
                  </span>
                  <input
                    type="checkbox"
                    checked={lyrics.autoFetch}
                    onChange={event =>
                      void patchSettings({ lyrics: { autoFetch: event.target.checked } })
                    }
                  />
                </label>
                <div className="setting-row">
                  <span>
                    <strong>Lyrics Fetch Concurrency</strong>
                    <em>How many provider requests run at once in the background.</em>
                  </span>
                  <select
                    value={lyrics.fetchConcurrency}
                    onChange={event =>
                      void patchSettings({
                        lyrics: { fetchConcurrency: event.target.value as LyricsFetchConcurrency },
                      })
                    }
                  >
                    <option value="low">Low</option>
                    <option value="balanced">Balanced</option>
                    <option value="high">High</option>
                  </select>
                </div>
                <label className="setting-row range-row">
                  <span>
                    <strong>Not Found cooldown</strong>
                    <em>Days before a track with no lyrics is searched again automatically.</em>
                  </span>
                  <span className="range-control">
                    <input
                      type="range"
                      min={1}
                      max={30}
                      step={1}
                      value={lyrics.notFoundCooldownDays}
                      onChange={event =>
                        void patchSettings({
                          lyrics: { notFoundCooldownDays: Number(event.target.value) },
                        })
                      }
                    />
                    <output>{lyrics.notFoundCooldownDays} days</output>
                  </span>
                </label>
              </>
            ) : null}
          </section>
        ) : null}

        {stepName === "ready" ? (
          <section className="onboarding-page" data-testid="onboarding-ready">
            <Check size={40} className="onboarding-icon" />
            <h2>Ready</h2>
            <p>
              {trackCount > 0
                ? `Your ${trackCount} tracks are ready. `
                : "You can add music any time from the top bar. "}
              Lyrics fetch automatically as songs play
              {jobState === "running" || jobState === "paused"
                ? ", and Fetch All keeps working in the background"
                : ""}
              . Enjoy!
            </p>
          </section>
        ) : null}

        <footer className="onboarding-nav">
          <button type="button" className="ghost-button" data-testid="onboarding-skip-all" onClick={finish}>
            Skip setup
          </button>
          <span className="onboarding-nav-main">
            {step > 0 ? (
              <button type="button" onClick={back}>
                <ArrowLeft size={15} /> Back
              </button>
            ) : null}
            {stepName === "ready" ? (
              <button type="button" className="primary" data-testid="onboarding-finish" onClick={finish}>
                Start listening
              </button>
            ) : stepName === "fetch-all" ? null : (
              <button type="button" className="primary" data-testid="onboarding-next" onClick={next}>
                {stepName === "library" && folderCount === 0 ? "Skip for now" : "Next"}{" "}
                <ArrowRight size={15} />
              </button>
            )}
          </span>
        </footer>
      </div>
    </div>
  );
}
