import { Component, type ReactNode } from "react";
import { canAnimateLayout, finishMotion } from "../../app/layoutMotion";
import { MOTION_DURATION_MS, MOTION_EASING } from "../../app/motion";

export type PlayerLayout = "mini" | "now-playing" | "fullscreen" | "library";
interface Props {
  layout: PlayerLayout;
  reducedMotion: boolean;
  children: ReactNode;
}

const parts = ["artwork", "metadata", "transport"] as const;
type Part = typeof parts[number];
type Box = { node: HTMLElement; rect: DOMRect; anchor: DOMRect };
type Scene = Partial<Record<Part, Box>>;

function measure(root: HTMLElement, layout: PlayerLayout, arriving = false): Scene {
  // Windowed Now Playing has no header artwork. Its existing player bar is the destination,
  // not an artwork slot invented for this transition. Fullscreen already has its own slots.
  const surface = root.querySelector(layout === "mini" ? ".mini-player" :
    layout === "fullscreen" ? ".lyrics-view.is-fullscreen" : ".player-bar");
  const scene: Scene = {};
  for (const part of parts) {
    const node = surface?.querySelector<HTMLElement>(`[data-player-part="${part}"]`);
    if (!node || (!arriving && node.closest(".is-concealed") && !surface?.hasAttribute("data-player-moving"))) continue;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const anchor = part === "metadata" ? node.querySelector('[data-track-layer="current"] :is(h1, .player-title, .mini-player-title)') :
      part === "transport" ? node.querySelector('[data-testid="play-toggle"]') : null;
    scene[part] = { node, rect, anchor: anchor?.getBoundingClientRect() ?? rect };
  }
  return scene;
}

function displacement(part: Part, from: Box, to: Box) {
  const a = from.anchor;
  const b = to.anchor;
  const ratio = b.height > 0 ? a.height / b.height : 1;
  // Windowed metadata uses the same type size in both modes. Leave it crisp instead of
  // scaling a large flex container. Match the title size when the fullscreen typography differs.
  const sy = part === "metadata" && Math.abs(a.height - b.height) < 2 ? 1 : ratio;
  const sx = part === "artwork" ? from.rect.width / to.rect.width : sy;
  const centerX = part === "transport" ? (a.width - b.width * sx) / 2 : 0;
  const x = a.x - to.rect.x - (b.x - to.rect.x) * sx + centerX;
  const y = a.y - to.rect.y - (b.y - to.rect.y) * sy;
  return `translate(${x}px, ${y}px) scale(${sx}, ${sy})`;
}

/** Measure the live slots once on either side of the layout commit. The real arriving cover,
 * title and controls animate; no snapshot layers, computed-style copies, or per-frame JS. */
export class PlayerLayoutMotion extends Component<Props> {
  private cancelFlight?: () => void;

  getSnapshotBeforeUpdate({ layout: previous }: Props): Scene | null {
    const { layout, reducedMotion } = this.props;
    if (previous === layout || reducedMotion || !canAnimateLayout()) return null;
    if (![previous, layout].some(value => value === "mini" || value === "fullscreen")) return null;
    const root = document.getElementById("root");
    return root ? measure(root, previous) : null;
  }

  componentDidUpdate(previous: Props, _state: unknown, from: Scene | null) {
    if (previous.layout === this.props.layout) {
      if (this.props.reducedMotion) this.cancelFlight?.();
      return;
    }
    // The previous measure, including during a reversal, reflects what was actually on screen.
    this.cancelFlight?.();
    const root = document.getElementById("root");
    if (!root || !from || !Object.keys(from).length) return;
    const bar = root.querySelector<HTMLElement>(".player-bar");
    const lyrics = root.querySelector(".lyrics-view");
    // No second, full-surface fade of the artwork background underneath the flying controls.
    for (const animation of lyrics?.getAnimations() ?? []) {
      if (["view-in", "fs-in"].includes((animation as CSSAnimation).animationName)) animation.cancel();
    }
    const to = measure(root, this.props.layout, true);
    const miniHandoff = previous.layout === "mini" || this.props.layout === "mini";
    const animations: Animation[] = [];
    const sharedHeadingAndCover = from.artwork && to.artwork && from.metadata && to.metadata;
    const duration = MOTION_DURATION_MS.scene;
    for (const part of parts) {
      const start = from[part];
      const end = to[part];
      if (!start || !end) continue;
      const { x, y, width, height } = end.anchor;
      if (Math.abs(start.anchor.x - x) < 1 && Math.abs(start.anchor.y - y) < 1 &&
          Math.abs(start.anchor.width - width) < 1 && Math.abs(start.anchor.height - height) < 1) continue;
      // The fullscreen title sits below rather than beside its cover. Give the leading part a
      // small head start so the large artwork doesn't run over the title as they change slots.
      const delay = sharedHeadingAndCover && (this.props.layout === "fullscreen" && part === "metadata" ||
        previous.layout === "fullscreen" && part === "artwork") ? 48 : 0;
      animations.push(end.node.animate([
        { transform: displacement(part, start, end), transformOrigin: "0 0" },
        { transform: "translate(0px, 0px) scale(1)", transformOrigin: "0 0" },
      ], {
        id: `player-${part}-handoff`, duration: duration - delay, delay,
        easing: miniHandoff ? MOTION_EASING.out : MOTION_EASING.settle, fill: "both",
      }));
    }
    if (!animations.length) return;

    // Settle the small compact title strip with the handoff. On expansion leave the large
    // masked lyrics surface and its filtered backdrop still; only the shared player moves.
    const miniChrome = this.props.layout === "mini" ? root.querySelector(".mini-player-chrome") : null;
    if (miniChrome) {
      animations.push(miniChrome.animate([{ opacity: 0.65 }, { opacity: 1 }], {
        id: "player-surroundings", duration: MOTION_DURATION_MS.surface, delay: duration - MOTION_DURATION_MS.surface,
        easing: MOTION_EASING.out, fill: "backwards",
      }));
    }
    const movingSurface = bar ?? (this.props.layout === "fullscreen" ? lyrics as HTMLElement | null : null);
    if (movingSurface) movingSurface.dataset.playerMoving = "true";
    this.cancelFlight = finishMotion(animations, () => {
      if (movingSurface) delete movingSurface.dataset.playerMoving;
      this.cancelFlight = undefined;
    });
  }

  componentWillUnmount() { this.cancelFlight?.(); }

  render() { return this.props.children; }
}
