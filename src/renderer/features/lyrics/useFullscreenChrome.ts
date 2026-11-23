/**
 * Idle visibility for the fullscreen Now Playing chrome. Written for Cadence after Better Lyrics.
 *
 * In Better Lyrics' fullscreen player the transport, the song-info actions, the player bar and
 * the lyrics dock appear together as soon as the pointer moves and fade again once it has been
 * still for three seconds (YouTube Music's own `show-fullscreen-controls` behaviour, which the
 * extension's controls and dock follow), unless the pointer is resting on one of them. Once the
 * chrome is hidden the cursor hides too (`cursor-hidden`), so nothing but artwork, song info and
 * lyrics remains on screen. A pinned state (an open popover, the queue, the Studio preview) keeps
 * it up regardless, as does keyboard focus inside the chrome — a mouse click does not, because
 * the reference hides the controls after a click as readily as after any other pointer activity.
 *
 * React state changes only when visibility flips; the position test runs per pointer move but
 * touches no layout. Listeners exist only while fullscreen is active.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

/** How long the pointer may rest before the chrome and the cursor hide. */
export const CHROME_IDLE_MS = 3000;
/** Elements marked with this class keep the chrome up while they are under the pointer or tabbed to. */
export const CHROME_CLASS = "fs-chrome";

function insideChrome(target: EventTarget | null, hot: HTMLElement | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(`.${CHROME_CLASS}`)) || Boolean(hot?.contains(target));
}

/** True when the focus arrived from the keyboard, which is what should keep the chrome reachable. */
function focusedByKeyboard(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const active = target.matches(":focus-visible") || target.closest(":focus-visible") !== null;
  return active;
}

/**
 * Returns whether the fullscreen chrome should be shown. Always `true` when `active` is false.
 * `hotRef` is an extra region (the player-bar footer) that counts as chrome for pointer position.
 */
export function useFullscreenChrome(
  active: boolean,
  pinned: boolean,
  hotRef: RefObject<HTMLElement | null>
): boolean {
  const [idle, setIdle] = useState(false);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  useEffect(() => {
    if (!active) {
      setIdle(false);
      return;
    }

    let timer: number | null = null;
    let overChrome = false;
    let focusInChrome = false;
    let pointerDown = false;

    const blocked = () => pinnedRef.current || overChrome || focusInChrome || pointerDown;
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      clearTimer();
      if (blocked()) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (blocked()) return;
        setIdle(true);
      }, CHROME_IDLE_MS);
    };
    /** Any pointer or key activity reveals the chrome and restarts the idle window. */
    const wake = () => {
      clearTimer();
      setIdle(false);
      arm();
    };

    const onPointerMove = (event: PointerEvent) => {
      overChrome = insideChrome(event.target, hotRef.current);
      wake();
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDown = true;
      overChrome = insideChrome(event.target, hotRef.current);
      wake();
    };
    const onPointerUp = () => {
      pointerDown = false;
      arm();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (insideChrome(event.target, hotRef.current) && focusedByKeyboard(event.target)) {
        focusInChrome = true;
        wake();
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      if (insideChrome(event.relatedTarget, hotRef.current) && focusedByKeyboard(event.relatedTarget)) return;
      focusInChrome = false;
      arm();
    };
    const onKeyDown = () => {
      // Keyboard use means the user is driving the chrome; keep it (and the cursor) available.
      focusInChrome = true;
      wake();
    };
    const onPointerLeaveWindow = () => {
      overChrome = false;
      arm();
    };
    const onVisibility = () => {
      if (document.hidden) {
        pointerDown = false;
        overChrome = false;
        setIdle(true);
      } else {
        wake();
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
    // Entering fullscreen shows the chrome at once, then lets it rest away if nothing happens.
    wake();
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
  }, [active, hotRef]);

  return !active || pinned || !idle;
}
