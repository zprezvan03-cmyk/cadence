/**
 * Single-line label that scrolls itself when the text does not fit.
 *
 * The wrapper keeps the original tag/class so all existing typography rules still apply; the
 * inner span is the moving layer. Overflow is measured (never guessed) so short labels stay
 * still and long ones animate only when activated (hover by default, `auto` for the few surfaces
 * that should scroll on their own). One shared ResizeObserver serves every instance because the
 * virtualised track list can mount hundreds of these at once.
 *
 * Movement is driven by the Web Animations API rather than a CSS keyframe so the 2s pause at each
 * end stays exactly 2s regardless of line length, while the travel itself remains a constant px/s.
 * When a hover-only label is released it rewinds in 200ms instead of snapping back instantly.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ElementType, ReactNode } from "react";

type MarqueeTag = "span" | "strong" | "em" | "div" | "h1" | "h2" | "h3" | "p";

interface MarqueeTextProps {
  as?: MarqueeTag;
  id?: string;
  className?: string;
  children: ReactNode;
  /** Scroll speed in pixels per second. */
  speed?: number;
  /** Start scrolling without hover. Off by default so ordinary menus stay still until hovered. */
  auto?: boolean;
  title?: string;
  /** Keeps the Tauri window drag region on surfaces that had one before the wrapper was added. */
  draggable?: boolean;
  "data-testid"?: string;
}

/** Shared by every label so a long title and a short one crawl at exactly the same px/s. */
const MARQUEE_SPEED_PX_PER_SEC = 42;
const MARQUEE_END_DELAY_MS = 2000;
const MARQUEE_RETURN_MS = 200;

/** Row/card surfaces whose hover should activate a label, even over a sibling of the text. */
const MARQUEE_HOST_SELECTOR = [
  "button",
  "a",
  "label",
  ".nav-item",
  ".track-row",
  ".media-card",
  ".quick-track",
  ".queue-track",
  ".history-row",
  ".stats-rank-row",
  ".modal-row",
  ".cache-row-main",
  ".folder-row",
  ".player-track",
  ".player-track-meta",
  ".detail-hero",
  ".spotlight-feature",
  ".decode-row",
  ".duplicate-track-row",
  ".mini-player-main",
  ".mini-player-deck",
  ".playlist-option",
].join(", ");

const updaters = new WeakMap<Element, () => void>();
const animations = new WeakMap<HTMLElement, {
  distance: number;
  speed: number;
  active: boolean;
  animation: Animation | null;
  returning: Animation | null;
}>();
let sharedObserver: ResizeObserver | null = null;

function getObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  if (!sharedObserver) {
    sharedObserver = new ResizeObserver(entries => {
      for (const entry of entries) updaters.get(entry.target)?.();
    });
  }
  return sharedObserver;
}

function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.reduceMotion === "true") return true;
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function readTransformOffset(inner: HTMLElement): number {
  const transform = getComputedStyle(inner).transform;
  if (!transform || transform === "none") return 0;
  const matrix = transform.match(/^matrix\(([^)]+)\)$/);
  if (matrix) return Number(matrix[1].split(",")[4]) || 0;
  const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (matrix3d) return Number(matrix3d[1].split(",")[12]) || 0;
  return 0;
}

function syncAnimation(inner: HTMLElement, distance: number, speed: number, active: boolean): void {
  const state = animations.get(inner) ?? {
    distance: 0,
    speed: 0,
    active: false,
    animation: null,
    returning: null,
  };
  const wasActive = state.active;
  const reduced = prefersReducedMotion();
  const canAnimate = typeof inner.animate === "function";
  const shouldRun = active && distance > 1 && !reduced && canAnimate;

  if (shouldRun) {
    // Re-hovering interrupts the rewind and starts the normal loop again.
    state.returning?.cancel();
    state.returning = null;
    if (!state.animation || state.distance !== distance || state.speed !== speed) {
      state.animation?.cancel();
      const travelMs = (distance / speed) * 1000;
      const totalMs = travelMs * 2 + MARQUEE_END_DELAY_MS * 2;
      state.animation = inner.animate([
        { transform: "translateX(0)", offset: 0 },
        { transform: `translateX(${-distance}px)`, offset: travelMs / totalMs },
        { transform: `translateX(${-distance}px)`, offset: (travelMs + MARQUEE_END_DELAY_MS) / totalMs },
        { transform: "translateX(0)", offset: (travelMs * 2 + MARQUEE_END_DELAY_MS) / totalMs },
        { transform: "translateX(0)", offset: 1 },
      ], { duration: totalMs, iterations: Infinity, easing: "linear" });
    }
  } else {
    // Read the current offset before cancelling the loop, then glide back from exactly there.
    const offset = state.animation ? readTransformOffset(inner) : 0;
    state.animation?.cancel();
    state.animation = null;

    const shouldReturn = wasActive && !active && canAnimate && !reduced && Math.abs(offset) > 0.5;
    if (shouldReturn) {
      state.returning?.cancel();
      const returning = inner.animate(
        [{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }],
        { duration: MARQUEE_RETURN_MS, easing: "ease-out", fill: "forwards" },
      );
      state.returning = returning;
      returning.onfinish = () => {
        returning.cancel();
        if (state.returning === returning) state.returning = null;
      };
    } else if (active || reduced || !canAnimate) {
      // Repeated inactive measurements must not abort a rewind that is already in flight.
      state.returning?.cancel();
      state.returning = null;
    }
  }

  state.distance = distance;
  state.speed = speed;
  state.active = active;
  animations.set(inner, state);
}

export function MarqueeText({
  as = "span",
  id,
  className,
  children,
  speed = MARQUEE_SPEED_PX_PER_SEC,
  auto,
  title,
  draggable,
  "data-testid": testId,
}: MarqueeTextProps) {
  const outerRef = useRef<HTMLElement | null>(null);
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const [selfHovered, setSelfHovered] = useState(false);
  const [hostHovered, setHostHovered] = useState(false);
  const [selfFocused, setSelfFocused] = useState(false);
  const [hostFocused, setHostFocused] = useState(false);
  const hoveredHosts = useRef(new Set<Element>());
  const focusedHosts = useRef(new Set<Element>());
  const effectiveSpeed = Math.max(1, speed);

  // A callback ref keeps the element type generic: each intrinsic tag accepts a callback whose
  // parameter is a supertype of its own element type.
  const setOuterRef = useCallback((node: HTMLElement | null) => {
    outerRef.current = node;
  }, []);

  const tooltip = title ?? (typeof children === "string" ? children : undefined);
  const active = auto || selfHovered || hostHovered || selfFocused || hostFocused;

  // Hovering a related row/card (or any of its ancestors) should start the label, not only the
  // exact text box. Listen on every matching ancestor: a button nested in a card is not enough,
  // because hovering the card's artwork or overlay button should still move its title.
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;

    const hosts = new Set<Element>();
    const parent = outer.parentElement;
    if (parent) hosts.add(parent);
    if (parent?.parentElement) hosts.add(parent.parentElement);
    for (let node: Element | null = outer.parentElement; node && node !== document.body; node = node.parentElement) {
      if (node.matches(MARQUEE_HOST_SELECTOR)) hosts.add(node);
    }
    if (hosts.size === 0) return;

    hoveredHosts.current.clear();
    focusedHosts.current.clear();
    const onEnter = (event: Event) => {
      hoveredHosts.current.add(event.currentTarget as Element);
      setHostHovered(true);
    };
    const onLeave = (event: Event) => {
      hoveredHosts.current.delete(event.currentTarget as Element);
      if (hoveredHosts.current.size === 0) setHostHovered(false);
    };
    const onFocus = (event: Event) => {
      focusedHosts.current.add(event.currentTarget as Element);
      setHostFocused(true);
    };
    const onBlur = (event: Event) => {
      focusedHosts.current.delete(event.currentTarget as Element);
      if (focusedHosts.current.size === 0) setHostFocused(false);
    };

    for (const host of hosts) {
      host.addEventListener("pointerenter", onEnter);
      host.addEventListener("pointerleave", onLeave);
      host.addEventListener("focusin", onFocus);
      host.addEventListener("focusout", onBlur);
    }
    return () => {
      for (const host of hosts) {
        host.removeEventListener("pointerenter", onEnter);
        host.removeEventListener("pointerleave", onLeave);
        host.removeEventListener("focusin", onFocus);
        host.removeEventListener("focusout", onBlur);
      }
      hoveredHosts.current.clear();
      focusedHosts.current.clear();
    };
  }, []);

  // Cancel only on unmount; the measurement effect below deliberately re-runs after every render.
  useEffect(() => {
    const inner = innerRef.current;
    return () => {
      if (!inner) return;
      const state = animations.get(inner);
      state?.animation?.cancel();
      state?.returning?.cancel();
      animations.delete(inner);
    };
  }, []);

  // No dependency list: re-measure after every render so a changed title or artist is picked up
  // even when the wrapper's own width did not change (fixed table columns, for example).
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const update = () => {
      if (!outer.isConnected) return;
      const available = outer.clientWidth;
      const full = inner.scrollWidth;
      if (available <= 0 || full <= 0) {
        delete outer.dataset.marquee;
        syncAnimation(inner, 0, effectiveSpeed, active);
        return;
      }
      const distance = full - available;
      if (distance > 1) {
        outer.style.setProperty("--marquee-distance", `${distance}px`);
        outer.dataset.marquee = "on";
        syncAnimation(inner, distance, effectiveSpeed, active);
      } else {
        delete outer.dataset.marquee;
        outer.style.removeProperty("--marquee-distance");
        syncAnimation(inner, 0, effectiveSpeed, active);
      }
    };

    updaters.set(outer, update);
    updaters.set(inner, update);
    update();

    const observer = getObserver();
    observer?.observe(outer);
    observer?.observe(inner);
    return () => {
      updaters.delete(outer);
      updaters.delete(inner);
      observer?.unobserve(outer);
      observer?.unobserve(inner);
    };
  });

  const Component = as as ElementType;
  return (
    <Component
      ref={setOuterRef}
      id={id}
      data-testid={testId}
      data-marquee-auto={auto || undefined}
      data-tauri-drag-region={draggable || undefined}
      className={`marquee${className ? ` ${className}` : ""}`}
      title={tooltip}
      onPointerEnter={() => setSelfHovered(true)}
      onPointerLeave={() => setSelfHovered(false)}
      onFocus={() => setSelfFocused(true)}
      onBlur={() => setSelfFocused(false)}
    >
      <span ref={innerRef} className="marquee__inner">{children}</span>
    </Component>
  );
}
