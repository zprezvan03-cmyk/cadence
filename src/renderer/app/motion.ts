/**
 * JavaScript mirrors of the CSS motion tokens in `styles/global.css`.
 *
 * CSS owns the actual animation work; these constants exist only for the small number of
 * places where JavaScript must agree with the stylesheet (keeping a closing surface mounted
 * just long enough to exit, capping stagger delays, honouring reduced motion in timers).
 * If a value changes here, change the matching `--dur-*` / `--ease-*` custom property too —
 * the animation audit (`tests/browser/animation-audit.ts`) reads the live computed tokens
 * and fails if the scale drifts.
 */

export const MOTION_DURATION_MS = {
  /** Active press dips only. CSS `--dur-0`. */
  press: 70,
  /** Hover, press and exit feedback. CSS `--dur-1`. */
  fast: 120,
  /** Small surfaces: menus, toasts, toggles. CSS `--dur-2`. */
  surface: 180,
  /** Views, panels, the sidebar indicator. CSS `--dur-3`. */
  view: 240,
  /** Major layout: sidebar width, buffered-fill catch-up. CSS `--dur-4`. */
  layout: 320,
} as const;

export type MotionDurationName = keyof typeof MOTION_DURATION_MS;

/**
 * The shared exit budget. Exits are deliberately the fastest motion in the app: a surface
 * the user has already dismissed must never make them wait, and 120ms fits the strictest
 * dismissal budgets the animation audit enforces (menus ≤150ms, modals ≤120ms).
 */
export const EXIT_DURATION_MS = MOTION_DURATION_MS.fast;

/** Per-item delay step for capped grid entrances. CSS `--stagger-step`. */
export const STAGGER_STEP_MS = 24;

/** Only this many leading items may stagger; large/virtualized lists never animate per-row. */
export const STAGGER_CAP = 12;

export const MOTION_EASING = {
  /** Entrances. CSS `--ease-out`. */
  out: "cubic-bezier(0.22, 0.61, 0.36, 1)",
  /** Exits. CSS `--ease-in`. */
  in: "cubic-bezier(0.55, 0.06, 0.68, 0.19)",
  /** State changes that stay on screen. CSS `--ease-in-out`. */
  inOut: "cubic-bezier(0.45, 0.05, 0.55, 0.95)",
  /** Restrained confirmation moments only. CSS `--ease-spring`. */
  spring: "cubic-bezier(0.34, 1.3, 0.64, 1)",
} as const;

/**
 * True when motion is currently collapsed, by the in-app setting
 * (`documentElement.dataset.reduceMotion`, applied in `useBootstrap`) or the OS preference.
 * Timer-driven motion (presence exits) consults this so reduced-motion users never wait on
 * an unmount delay for an animation they cannot see.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (document.documentElement.dataset.reduceMotion === "true") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Entrance delay for item `index` in a staggered group. The cap keeps a large grid from
 * cascading forever and — more importantly — means only the first handful of visible items
 * ever animate; the rest appear already settled. Negative and non-finite indices clamp to 0.
 */
export function staggerDelayMs(index: number, cap = STAGGER_CAP): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  const clamped = Math.min(Math.floor(index), Math.max(0, cap));
  return clamped * STAGGER_STEP_MS;
}

/**
 * The effective wait before a closing surface unmounts: the requested exit duration, or
 * zero under reduced motion (the CSS is already collapsed to near-instant there, so a timer
 * would only delay interactivity and state changes for no visible benefit).
 */
export function effectiveExitMs(requestedMs: number = EXIT_DURATION_MS, reduced = prefersReducedMotion()): number {
  if (reduced) return 0;
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) return 0;
  return Math.min(requestedMs, EXIT_DURATION_MS);
}
