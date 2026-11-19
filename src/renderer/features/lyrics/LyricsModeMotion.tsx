/**
 * FLIP handoff for the Lyrics On/Off tabs inside fullscreen Now Playing.
 *
 * The mode swap unmounts the artwork, title and transport from one slot and mounts them in
 * another. Measure the live slots before React commits, then animate the arriving nodes from
 * the old rects: the same real elements keep playing their cover dissolve and hover states.
 * The lyrics renderer itself stays mounted; only its paint is faded in/out.
 */

import { Component, type ReactNode } from "react";
import { canAnimateLayout, finishMotion } from "../../app/layoutMotion";
import { MOTION_DURATION_MS, MOTION_EASING } from "../../app/motion";

export type LyricsMode = "on" | "off";

interface Props {
  mode: LyricsMode;
  active: boolean;
  children: ReactNode;
}

type Part = "artwork" | "metadata" | "transport";
type Box = { node: HTMLElement; rect: DOMRect; anchor: DOMRect };
type Scene = Partial<Record<Part, Box>>;
type Snapshot = { from: Scene; lyrics: HTMLElement | null };

const parts: readonly Part[] = ["artwork", "metadata", "transport"];
const viewSelector = ".lyrics-view.is-fullscreen:not(.is-preview)";

function box(node: HTMLElement, anchor?: Element | null): Box {
  const rect = node.getBoundingClientRect();
  return { node, rect, anchor: (anchor ?? node).getBoundingClientRect() };
}

function measure(view: HTMLElement): Scene {
  const scene: Scene = {};
  const artwork = view.querySelector<HTMLElement>(':is(.fs-artwork, .fs-panel-art) > [data-player-part="artwork"]');
  if (artwork?.getBoundingClientRect().width) scene.artwork = box(artwork);

  const heading = [...view.querySelectorAll<HTMLElement>('.lyrics-heading[data-player-part="metadata"]')]
    .find(node => node.getBoundingClientRect().width > 0);
  if (heading) scene.metadata = box(heading, heading.querySelector('[data-track-layer="current"] h1'));

  const transport = view.querySelector<HTMLElement>('.fs-controls [data-player-part="transport"]');
  if (transport?.getBoundingClientRect().width) {
    scene.transport = box(transport, transport.querySelector('[data-testid="play-toggle"]'));
  }
  return scene;
}

function displacement(part: Part, from: Box, to: Box) {
  const a = from.anchor;
  const b = to.anchor;
  const ratio = b.height > 0 ? a.height / b.height : 1;
  // Keep a same-size title crisp; scale the artwork and centre the transport on its play button.
  const sy = part === "metadata" && Math.abs(a.height - b.height) < 2 ? 1 : ratio;
  const sx = part === "artwork" ? from.rect.width / to.rect.width : sy;
  const centerX = part === "transport" ? (a.width - b.width * sx) / 2 : 0;
  const x = a.x - to.rect.x - (b.x - to.rect.x) * sx + centerX;
  const y = a.y - to.rect.y - (b.y - to.rect.y) * sy;
  return `translate(${x}px, ${y}px) scale(${sx}, ${sy})`;
}

export class LyricsModeMotion extends Component<Props> {
  private cancelFlight?: () => void;

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    // Only a tab swap in the live fullscreen view. Entering/leaving fullscreen and the studio
    // preview have their own motion paths, and reduced motion collapses this one entirely.
    if (!previous.active || !this.props.active || previous.mode === this.props.mode || !canAnimateLayout()) return null;
    this.cancelFlight?.();
    const view = document.querySelector<HTMLElement>(viewSelector);
    if (!view) return null;
    const body = view.querySelector<HTMLElement>(".lyrics-body");
    return {
      from: measure(view),
      lyrics: body?.getBoundingClientRect().width ? body : null,
    };
  }

  componentDidUpdate(previous: Props, _state: unknown, snapshot: Snapshot | null) {
    if (!snapshot || previous.mode === this.props.mode) return;
    const view = document.querySelector<HTMLElement>(viewSelector);
    if (!view) return;
    const to = measure(view);
    const animations: Animation[] = [];
    const cleanups: Array<() => void> = [];
    const duration = MOTION_DURATION_MS.scene;

    for (const part of parts) {
      const start = snapshot.from[part];
      const end = to[part];
      if (!start || !end) continue;
      const { x, y, width, height } = end.anchor;
      if (Math.abs(start.anchor.x - x) < 1 && Math.abs(start.anchor.y - y) < 1 &&
          Math.abs(start.anchor.width - width) < 1 && Math.abs(start.anchor.height - height) < 1) continue;
      // A second click can land while the first handoff is still in flight. Drop the stale
      // transform so the new displacement is measured against the settled slot.
      for (const animation of end.node.getAnimations()) {
        if (animation.id.startsWith("player-") || animation.id.startsWith("lyrics-mode-")) animation.cancel();
      }
      const delay = part === "metadata" ? 40 : 0;
      animations.push(end.node.animate([
        { transform: displacement(part, start, end), transformOrigin: "0 0" },
        { transform: "translate(0px, 0px) scale(1)", transformOrigin: "0 0" },
      ], {
        id: `lyrics-mode-${part}-handoff`, duration: duration - delay, delay,
        easing: MOTION_EASING.settle, fill: "both",
      }));
    }

    const body = view.querySelector<HTMLElement>(".lyrics-body");
    if (snapshot.lyrics && body === snapshot.lyrics) {
      const goingOff = this.props.mode === "off";
      // The off state hides the renderer with `visibility: hidden`, which would cut the fade
      // before it starts. Pin it visible inline for the 120ms exit, then hand it back to CSS.
      const previousStyle = goingOff ? {
        visibility: body.style.visibility,
        opacity: body.style.opacity,
        transform: body.style.transform,
      } : null;
      if (goingOff) body.style.visibility = "visible";
      animations.push(body.animate(
        goingOff
          ? [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(12px)" }]
          : [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "translateY(0)" }],
        {
          id: "lyrics-mode-body",
          duration: goingOff ? MOTION_DURATION_MS.fast : MOTION_DURATION_MS.surface,
          delay: goingOff ? 0 : 60,
          easing: goingOff ? MOTION_EASING.in : MOTION_EASING.out,
          fill: "both",
        }
      ));
      if (previousStyle) cleanups.push(() => Object.assign(body.style, previousStyle));
    }

    if (!animations.length) {
      cleanups.forEach(restore => restore());
      return;
    }
    this.cancelFlight = finishMotion(animations, () => {
      cleanups.forEach(restore => restore());
      this.cancelFlight = undefined;
    });
  }

  componentWillUnmount() { this.cancelFlight?.(); }

  render() { return this.props.children; }
}
