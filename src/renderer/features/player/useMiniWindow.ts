import { useLayoutEffect, useRef, useState } from "react";
import { MOTION_DURATION_MS } from "../../app/motion";

/** Native window geometry and the React layout are separate. Restore while the compact card is
 * still pinned in place, then measure the expanded destination. In reverse, the card becomes live
 * immediately and the OS window shrinks only once the shared elements have reached it. */
export function useMiniWindow(requested: boolean, reducedMotion: boolean): boolean {
  const app = window.cadence?.app;
  const native = Boolean(app?.setMiniPlayer);
  const [mini, setMini] = useState(requested);
  const nativeMini = useRef(false);
  const nativeResizing = useRef(false);
  const commands = useRef(Promise.resolve());

  useLayoutEffect(() => {
    if (!app?.setMiniPlayer) return;
    let timeout: number | undefined;
    let frame: number | undefined;
    let cancelled = false;
    let cleanupResize: (() => void) | undefined;
    const resizeNative = (value: boolean) => {
      // Coalesce cancelled intents and only restore a size after a compact command actually ran.
      // Sending a redundant restore to Tauri can reset an untouched window to its default size.
      const next = commands.current.then(async () => {
        if (cancelled || nativeMini.current === value) return;
        nativeResizing.current = true;
        try {
          await app.setMiniPlayer?.(value);
          nativeMini.current = value;
        } finally {
          nativeResizing.current = false;
        }
      });
      commands.current = next.catch(() => undefined);
      return next;
    };

    if (requested) {
      setMini(true);
      if (!nativeMini.current || nativeResizing.current) {
        const shrink = () => { void resizeNative(true).catch(() => undefined); };
        if (reducedMotion || document.hidden || typeof Element.prototype.animate !== "function") shrink();
        else timeout = window.setTimeout(shrink, MOTION_DURATION_MS.scene + 24);
      }
    } else if (nativeMini.current || nativeResizing.current) {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const reveal = () => {
        if (cancelled) return;
        cleanupResize?.();
        window.clearTimeout(timeout);
        setMini(false);
      };
      const afterResize = () => {
        if (cancelled) return;
        if (frame !== undefined) window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(reveal);
      };
      const onResize = () => {
        if (window.innerWidth > width || window.innerHeight > height) afterResize();
      };
      window.addEventListener("resize", onResize);
      cleanupResize = () => window.removeEventListener("resize", onResize);
      void resizeNative(false).then(() => {
        if (cancelled) return;
        if (window.innerHeight > 200 || window.innerWidth !== width || window.innerHeight !== height) afterResize();
        else timeout = window.setTimeout(reveal, 220); // Some window managers do not report a resize.
      }, reveal);
    } else {
      setMini(false);
    }

    return () => {
      cancelled = true;
      cleanupResize?.();
      window.clearTimeout(timeout);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [app, requested, reducedMotion]);

  return native ? mini : requested;
}
