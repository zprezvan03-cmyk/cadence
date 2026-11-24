/**
 * Hover-only visibility for the fullscreen Now Playing chrome. Written for Cadence after Better
 * Lyrics.
 *
 * The playbar, the floating dock and the top-right page actions (mode tabs, exit) are one set: they
 * appear when the pointer enters the surface's own area and fade out again two seconds after it
 * leaves. Nothing else reveals them — moving over the artwork or the lyrics leaves the page clean,
 * which is what the reference's player page looks like at rest.
 *
 * The hidden chrome takes no pointer input (`pointer-events: none`) but keeps its box, so the area
 * test reads the rects of the chrome elements themselves: the pointer finds the bar along the bottom
 * edge and the tabs in the top-right corner even though nothing is drawn there. A little slack
 * around each rect means the bar appears as the pointer approaches it instead of a frame later.
 *
 * Keyboard use and focus still bring the chrome back, a pinned state (an open popover, the queue,
 * the Studio preview) holds it up, and entering fullscreen reveals it once before it rests away.
 *
 * React state changes only when visibility flips; the area test runs per pointer move and reads
 * rects, touching no layout that a frame could observe. Listeners exist only while fullscreen is
 * active.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

/** How long the pointer may rest off the chrome before it hides. */
export const CHROME_IDLE_MS = 2000;
/** Elements marked with this class are the chrome: each one is a hover target. */
export const CHROME_CLASS = "fs-chrome";
/** Slack around a chrome surface that still counts as hovering it, so approaching it reveals it. */
const HOVER_SLOP_PX = 8;

/** True when the pointer sits on (or just next to) one of the chrome surfaces inside `container`. */
function overChrome(container: HTMLElement | null, x: number, y: number): boolean {
  if (!container) return false;
  const zones = container.querySelectorAll<HTMLElement>(`.${CHROME_CLASS}`);
  for (const zone of zones) {
    const rect = zone.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    if (
      x >= rect.left - HOVER_SLOP_PX &&
      x <= rect.right + HOVER_SLOP_PX &&
      y >= rect.top - HOVER_SLOP_PX &&
      y <= rect.bottom + HOVER_SLOP_PX
    ) {
      return true;
    }
  }
  return false;
}

/** True when the focus arrived from the keyboard, which is what should keep the chrome reachable. */
function focusedByKeyboard(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const active = target.matches(":focus-visible") || target.closest(":focus-visible") !== null;
  return active;
}

/**
 * Returns whether the fullscreen chrome should be shown. Always `true` when `active` is false.
 * `zoneRef` is the view that holds the chrome: its `.fs-chrome` descendants are the hover targets.
 */
export function useFullscreenChrome(
  active: boolean,
  pinned: boolean,
  zoneRef: RefObject<HTMLElement | null>
): boolean {
  const [hidden, setHidden] = useState(false);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  useEffect(() => {
    if (!active) {
      setHidden(false);
      return;
    }

    let timer: number | null = null;
    let hovering = false;
    let focusInChrome = false;
    let pointerDown = false;

    const blocked = () => pinnedRef.current || hovering || focusInChrome || pointerDown;
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    /** Starts the hide countdown; anything that holds the chrome up cancels it instead. */
    const arm = () => {
      clearTimer();
      if (blocked()) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (blocked()) return;
        setHidden(true);
      }, CHROME_IDLE_MS);
    };
    /** Hovering the chrome shows it and keeps it up while the pointer stays there. */
    const reveal = () => {
      clearTimer();
      setHidden(false);
      arm();
    };
    /** Records whether the pointer is on the chrome; the answer decides reveal or countdown. */
    const track = (event: PointerEvent) => {
      hovering = overChrome(zoneRef.current, event.clientX, event.clientY);
      return hovering;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (track(event)) reveal();
      else arm();
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDown = true;
      if (track(event)) reveal();
      else arm();
    };
    const onPointerUp = () => {
      pointerDown = false;
      arm();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest(`.${CHROME_CLASS}`) && focusedByKeyboard(event.target)) {
        focusInChrome = true;
        reveal();
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest(`.${CHROME_CLASS}`) && focusedByKeyboard(event.relatedTarget)) {
        return;
      }
      focusInChrome = false;
      arm();
    };
    const onKeyDown = () => {
      // Keyboard use means the user is driving the chrome; keep it (and the cursor) available.
      focusInChrome = true;
      reveal();
    };
    const onPointerLeaveWindow = () => {
      hovering = false;
      arm();
    };
    const onVisibility = () => {
      if (document.hidden) {
        pointerDown = false;
        hovering = false;
        setHidden(true);
      } else {
        arm();
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.documentElement.addEventListener("pointerleave", onPointerLeaveWindow);
    document.addEventListener("visibilitychange", onVisibility);
    // Entering fullscreen shows the chrome once, then it rests away if the pointer does not find it.
    reveal();
    return () => {
      clearTimer();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.documentElement.removeEventListener("pointerleave", onPointerLeaveWindow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, zoneRef]);

  return !active || pinned || !hidden;
}
