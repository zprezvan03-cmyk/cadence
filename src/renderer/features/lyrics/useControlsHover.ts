/**
 * Hover visibility for the fullscreen playbar. Written for Cadence.
 *
 * The controls show while the pointer is over their band and fade out when it leaves. The band spans the
 * full viewport width — only its vertical limits come from the footer's children — so hovering anywhere
 * along the bottom edge reveals the bar instead of just the centred strip under the lyrics. Hidden
 * controls take no pointer input (pointer-events: none), so the pointer is tracked by position on the
 * window and the lyrics under hidden controls stay clickable. React state changes only when the pointer
 * crosses the band's edge. Listeners exist only while fullscreen is active.
 */

import { useEffect, useState, type RefObject } from "react";

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The footer's vertical band, widened to the whole viewport and down to its bottom edge. */
function footerBounds(footer: HTMLElement): Bounds | null {
  let bounds: Bounds | null = null;
  for (const child of Array.from(footer.children)) {
    const rect = child.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    bounds = bounds
      ? {
          left: Math.min(bounds.left, rect.left),
          top: Math.min(bounds.top, rect.top),
          right: Math.max(bounds.right, rect.right),
          bottom: Math.max(bounds.bottom, rect.bottom),
        }
      : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  if (!bounds) return null;
  return { left: 0, top: bounds.top, right: window.innerWidth, bottom: window.innerHeight };
}

/** Returns whether the controls should be shown. Always `true` when `active` is false. */
export function useControlsHover(active: boolean, pinned: boolean, footerRef: RefObject<HTMLElement | null>): boolean {
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!active) {
      setHovered(false);
      return;
    }

    let inside = false;
    const update = (next: boolean) => {
      if (next === inside) return;
      inside = next;
      setHovered(next);
    };

    const onPointerMove = (event: PointerEvent) => {
      const footer = footerRef.current;
      const bounds = footer ? footerBounds(footer) : null;
      update(
        bounds !== null &&
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          event.clientY >= bounds.top &&
          event.clientY <= bounds.bottom
      );
    };
    const onPointerLeaveWindow = () => update(false);

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeaveWindow);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeaveWindow);
    };
  }, [active, footerRef]);

  return !active || pinned || hovered;
}
