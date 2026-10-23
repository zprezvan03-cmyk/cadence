/**
 * Auto-hide for the fullscreen Now Playing controls. Written for Cadence.
 *
 * While `active` (fullscreen), the controls hide after `idleMs` without user activity and show again
 * on the next interaction. Activity is recorded as a timestamp, so pointer movement costs no timer
 * work: one timer is armed at a time and re-armed only when it fires. React state changes only when
 * visibility actually flips. Listeners and the timer are removed when `active` turns off or the
 * component unmounts. While `pinned` (a popover or the queue is open) the controls stay visible.
 */

import { useEffect, useRef, useState } from "react";

export const CONTROLS_IDLE_MS = 3000;

const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "touchmove"] as const;

/** Returns whether the controls should be shown. Always `true` when `active` is false. */
export function useAutoHideControls(active: boolean, pinned: boolean, idleMs: number = CONTROLS_IDLE_MS): boolean {
  const [visible, setVisible] = useState(true);
  const visibleRef = useRef(true);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  useEffect(() => {
    if (!active) return;

    // Entering fullscreen always starts with the controls shown.
    visibleRef.current = true;
    setVisible(true);

    let lastActivity = performance.now();
    let timer: number | null = null;

    const reveal = () => {
      if (!visibleRef.current) {
        visibleRef.current = true;
        setVisible(true);
      }
    };

    const conceal = () => {
      visibleRef.current = false;
      setVisible(false);
    };

    const arm = (delay: number) => {
      timer = window.setTimeout(check, delay);
    };

    function check() {
      timer = null;
      if (pinnedRef.current) {
        arm(idleMs);
        return;
      }
      const idle = performance.now() - lastActivity;
      if (idle >= idleMs) conceal();
      else arm(idleMs - idle);
    }

    const onActivity = () => {
      lastActivity = performance.now();
      reveal();
      if (timer === null) arm(idleMs);
    };

    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { passive: true });
    arm(idleMs);

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity);
    };
  }, [active, idleMs]);

  return !active || pinned || visible;
}
