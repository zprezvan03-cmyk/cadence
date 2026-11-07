/**
 * First-launch onboarding visibility + progress.
 *
 * Durable state (completed flag, step to resume) lives in the existing persisted settings
 * (`general.onboardingCompleted/onboardingStep`); this store only owns the session-level
 * "is the flow on screen" latch. Auto-show is deliberately conservative: settings must say
 * onboarding never completed *and* no music folder is configured yet, so existing installs
 * upgrading to this version never get a surprise first-run flow. Replay (Settings) forces it.
 */

import { create } from "zustand";
import { useSettings } from "./settingsStore";

export const ONBOARDING_STEPS = ["welcome", "library", "fetch-all", "preferences", "ready"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Pure auto-show decision, kept separate so it can be unit-tested without the stores. */
export function shouldAutoShowOnboarding(args: {
  settingsLoaded: boolean;
  onboardingCompleted: boolean;
  folderCount: number;
  trackCount: number;
  replayRequested: boolean;
}): boolean {
  if (args.replayRequested) return true;
  // A genuine first launch has a completely untouched library. Requiring zero tracks as well
  // as zero folders keeps existing installs (and test harnesses with scanned fixtures but no
  // registered folder) from ever seeing a surprise first-run flow.
  return (
    args.settingsLoaded &&
    !args.onboardingCompleted &&
    args.folderCount === 0 &&
    args.trackCount === 0
  );
}

export function clampOnboardingStep(step: number): number {
  if (!Number.isFinite(step)) return 0;
  return Math.min(ONBOARDING_STEPS.length - 1, Math.max(0, Math.round(step)));
}

interface OnboardingState {
  visible: boolean;
  step: number;
  /** One-time latch from bootstrap state; never re-evaluates mid-session. */
  maybeAutoShow: (folderCount: number, trackCount: number) => void;
  replay: () => void;
  goTo: (step: number) => void;
  next: () => void;
  back: () => void;
  finish: () => void;
}

function persistStep(step: number): void {
  void useSettings
    .getState()
    .patch({ general: { onboardingStep: clampOnboardingStep(step) } })
    .catch(() => undefined);
}

export const useOnboarding = create<OnboardingState>()((set, get) => ({
  visible: false,
  step: 0,

  maybeAutoShow: (folderCount, trackCount) => {
    if (get().visible) return;
    const settings = useSettings.getState();
    const show = shouldAutoShowOnboarding({
      settingsLoaded: settings.loaded && settings.settings !== null,
      // Optional-chained throughout: settings objects from older bridges/harnesses may not
      // carry the `general` section yet (the real bridge always backfills it via defaults).
      onboardingCompleted: Boolean(settings.settings?.general?.onboardingCompleted),
      folderCount,
      trackCount,
      replayRequested: false,
    });
    if (show) {
      set({
        visible: true,
        step: clampOnboardingStep(settings.settings?.general?.onboardingStep ?? 0),
      });
    }
  },

  replay: () => set({ visible: true, step: 0 }),

  goTo: step => {
    const nextStep = clampOnboardingStep(step);
    set({ step: nextStep });
    persistStep(nextStep);
  },

  next: () => get().goTo(get().step + 1),
  back: () => get().goTo(get().step - 1),

  finish: () => {
    set({ visible: false, step: 0 });
    void useSettings
      .getState()
      .patch({ general: { onboardingCompleted: true, onboardingStep: 0 } })
      .catch(() => undefined);
  },
}));
