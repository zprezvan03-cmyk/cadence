/**
 * Presence primitive for surfaces that open and close (menus, popovers, modals, toasts,
 * panels). Before this hook every surface unmounted in the same render that closed it, so
 * exits were hard cuts; `usePresence` keeps a closing surface mounted for one short,
 * budgeted exit (120ms — see `EXIT_DURATION_MS`) and reports its phase so the surface can
 * switch to its exit animation instead of vanishing.
 *
 * Usage:
 *   const presence = usePresence(open);
 *   if (!presence.mounted) return null;
 *   return <div data-presence={presence.phase} className={presence.phaseClass}>…</div>;
 *
 * Rapid open/close/open sequences are safe: reopening mid-exit cancels the pending unmount
 * and re-enters, so a surface never unmounts underneath a user who brought it back. Under
 * reduced motion the exit unmounts immediately — the CSS is already collapsed there, and a
 * timer would only delay interactivity for an animation nobody sees.
 *
 * This hook owns mount lifetime and phase only. State changes themselves stay instant:
 * callers flip their boolean exactly as before, and nothing here delays the underlying
 * close action, focus change, or data update.
 */

import { useEffect, useRef, useState } from "react";
import {
  EXIT_DURATION_MS,
  MOTION_DURATION_MS,
  effectiveExitMs,
  prefersReducedMotion,
} from "./motion";

export type PresencePhase = "entering" | "entered" | "exiting" | "exited";

export interface UsePresenceOptions {
  /** Time spent in the `entering` phase before settling to `entered`. */
  enterMs?: number;
  /** Time the surface stays mounted after closing. Capped at the shared exit budget. */
  exitMs?: number;
  /** When false (default), a surface that starts open renders already `entered`. */
  animateOnMount?: boolean;
}

export interface Presence {
  /** Render the surface while this is true; it stays true throughout the exit. */
  mounted: boolean;
  phase: PresencePhase;
  isEntering: boolean;
  isExiting: boolean;
  /** `"open"` while the caller's boolean is on, `"closed"` while exiting — for CSS hooks. */
  dataState: "open" | "closed";
  /** `is-entering` / `is-entered` / `is-exiting`, mirroring the app's class conventions. */
  phaseClass: string;
}

export function usePresence(visible: boolean, options: UsePresenceOptions = {}): Presence {
  const { enterMs = MOTION_DURATION_MS.surface, exitMs = EXIT_DURATION_MS, animateOnMount = false } = options;

  const [mounted, setMounted] = useState(visible);
  const [phase, setPhase] = useState<PresencePhase>(
    visible ? (animateOnMount ? "entering" : "entered") : "exited"
  );

  // Refs mirror the state so the effect below can make mount/phase decisions against the
  // latest values without waiting for a re-render (rapid toggles within one frame).
  const mountedRef = useRef(mounted);
  const phaseRef = useRef(phase);
  const firstRunRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
    clearTimer();

    if (visible) {
      const wasMounted = mountedRef.current;
      const wasExiting = phaseRef.current === "exiting";
      mountedRef.current = true;
      setMounted(true);

      const shouldEnter = !wasMounted || wasExiting || !firstRunRef.current || animateOnMount;
      const wait = prefersReducedMotion() || !Number.isFinite(enterMs) || enterMs <= 0 ? 0 : enterMs;
      if (!shouldEnter || wait === 0) {
        phaseRef.current = "entered";
        setPhase("entered");
      } else {
        phaseRef.current = "entering";
        setPhase("entering");
        timerRef.current = setTimeout(() => {
          timerRef.current = undefined;
          phaseRef.current = "entered";
          setPhase("entered");
        }, wait);
      }
    } else if (!mountedRef.current) {
      phaseRef.current = "exited";
      setPhase("exited");
    } else {
      const wait = effectiveExitMs(exitMs);
      if (wait === 0) {
        mountedRef.current = false;
        phaseRef.current = "exited";
        setMounted(false);
        setPhase("exited");
      } else {
        phaseRef.current = "exiting";
        setPhase("exiting");
        timerRef.current = setTimeout(() => {
          timerRef.current = undefined;
          mountedRef.current = false;
          phaseRef.current = "exited";
          setMounted(false);
          setPhase("exited");
        }, wait);
      }
    }

    firstRunRef.current = false;
    return clearTimer;
  }, [visible, enterMs, exitMs, animateOnMount]);

  return {
    mounted,
    phase,
    isEntering: phase === "entering",
    isExiting: phase === "exiting",
    dataState: visible ? "open" : "closed",
    phaseClass: `is-${phase}`,
  };
}
