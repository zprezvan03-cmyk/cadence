/**
 * First-launch onboarding: Welcome → Music Library Setup → Preferences → Ready.
 * Optional steps can be skipped and progress is persisted in settings.
 */

import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, FolderPlus, Music2 } from "lucide-react";
import type { LyricsFetchConcurrency } from "../../../shared/types";
import { useLibrary } from "../../state/libraryStore";
import { ONBOARDING_STEPS, useOnboarding } from "../../state/onboardingStore";
import { useSettings } from "../../state/settingsStore";

const STEP_TITLES = ["Welcome", "Music Library Setup", "Preferences", "Ready"] as const;

/** An explicit two-state choice for an optional preference. */
function OptIn({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  testId: string;
}) {
  return (
    <div className="setting-row onboarding-opt-in" data-testid={testId} data-value={checked ? "on" : "off"}>
      <span>
        <strong>{label}</strong>
        <em>{hint}</em>
      </span>
      <span className="segmented" role="group" aria-label={label}>
        <button
          type="button"
          data-testid={`${testId}-off`}
          aria-pressed={!checked}
          onClick={() => onChange(false)}
        >
          Off
        </button>
        <button
          type="button"
          data-testid={`${testId}-on`}
          aria-pressed={checked}
          onClick={() => onChange(true)}
        >
          On
        </button>
      </span>
    </div>
  );
}

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

  // Direction of the last step change, so pages slide in from the side the
  // user is travelling towards. Adjusted during render (React's recommended
  // pattern for deriving state from a changed value) so the entering page
  // already carries the right direction on its first frame.
  const [lastStep, setLastStep] = useState(step);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  if (step !== lastStep) {
    setLastStep(step);
    setDirection(step > lastStep ? "forward" : "back");
  }

  if (!visible) return null;

  const stepName = ONBOARDING_STEPS[step];
  const trackCount = snapshot?.counts.tracks ?? 0;
  const folderCount = snapshot?.folders.length ?? 0;
  const lyrics = settings?.lyrics;
  // The shader preference is optional: leaving it alone keeps the shipped default (off) and the
  // Next button never depends on it.
  const shaderBackground = settings?.shaders.globalBackground ?? false;

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

        <div key={stepName} className={`onboarding-page-wrap is-${direction}`} data-direction={direction}>
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
            {settings ? (
              <OptIn
                label="Shader background"
                hint="A slow, audio-reactive colour wash behind the whole app. Off by default — you can change it any time in Settings."
                checked={shaderBackground}
                onChange={value => void patchSettings({ shaders: { globalBackground: value } })}
                testId="onboarding-shader-background"
              />
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
                : "You can add music any time from the sidebar. "}
              Lyrics fetch automatically as songs play. Enjoy!
            </p>
          </section>
        ) : null}
        </div>

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
            ) : (
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
