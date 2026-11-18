import { Component, createRef, type ReactNode } from "react";
import { canAnimateLayout, finishMotion, pinToRect } from "../../app/layoutMotion";
import { MOTION_DURATION_MS, MOTION_EASING } from "../../app/motion";

export type PlayerLayout = "mini" | "now-playing" | "fullscreen" | "library";
type Part = "artwork" | "metadata" | "transport";
interface Props {
  layout: PlayerLayout;
  reducedMotion: boolean;
  children: ReactNode;
}
interface PartBox {
  node: HTMLElement;
  rect: DOMRect;
}
interface PartImage extends PartBox {
  clone?: HTMLElement;
  coverUrl?: string;
  radius?: number;
  titleRect?: DOMRect;
}
type Scene = Partial<Record<Part, PartImage>>;
const PARTS: Part[] = ["artwork", "metadata", "transport"];
const timing: KeyframeAnimationOptions = { duration: MOTION_DURATION_MS.scene, easing: MOTION_EASING.settle, fill: "both" };
const still = "translate(0px, 0px) scale(1)";

function visible(node: HTMLElement): PartBox | null {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight &&
    rect.right > 0 && rect.left < window.innerWidth &&
    getComputedStyle(node).visibility === "visible" ? { node, rect } : null;
}

function findPart(root: HTMLElement, part: Part): PartBox | null {
  // Prefer the hero/heading in Now Playing; a profile can hide them. The persistent bar is the
  // fallback in that case, and the only source on ordinary library pages.
  const selector = `[data-player-part="${part}"]`;
  for (const scope of [".lyrics-view", ".mini-player", ".player-bar"]) {
    const node = root.querySelector<HTMLElement>(`${scope} ${selector}`);
    const box = node && visible(node);
    if (box) return box;
  }
  return null;
}

// Only artwork and text need a ghost: their real nodes sit in clipped scrollports. Copy the few
// visual styles scoped to their original slot, not the computed stylesheet or the rest of the page.
const FROZEN_STYLES = [
  "display", "position", "inset", "box-sizing", "width", "height", "margin", "padding", "gap",
  "align-items", "justify-content", "place-items", "flex-direction", "font-family", "font-size", "font-style", "font-weight", "line-height",
  "letter-spacing", "text-transform", "text-overflow", "white-space", "overflow-wrap", "text-shadow",
  "color", "background", "border", "border-radius", "box-shadow", "overflow", "opacity", "transform",
  "object-fit",
];

function freeze(box: PartBox, part: Part): PartImage {
  if (part === "transport") return box; // The real, interactive transport makes the trip.
  const clone = box.node.cloneNode(true) as HTMLElement;
  const originals = [box.node, ...box.node.querySelectorAll<HTMLElement | SVGElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<HTMLElement | SVGElement>("*")];
  for (let index = 0; index < originals.length; index++) {
    const copy = copies[index];
    const computed = getComputedStyle(originals[index]);
    for (const property of FROZEN_STYLES) copy.style.setProperty(property, computed.getPropertyValue(property));
    copy.style.setProperty("animation", "none", "important");
    copy.style.setProperty("transition", "none", "important");
    for (const attr of ["id", "data-testid", "data-player-part", "data-tauri-drag-region"]) copy.removeAttribute(attr);
  }
  Object.assign(clone.style, { position: "relative", inset: "auto", width: "100%", height: "100%", margin: "0", transform: "none", opacity: "1" });
  return {
    ...box,
    clone,
    coverUrl: part === "artwork" && !box.node.querySelector('[data-cover-layer="outgoing"]')
      ? box.node.querySelector("img")?.src ?? "fallback"
      : undefined,
    radius: part === "artwork" ? Number.parseFloat(getComputedStyle(box.node).borderTopLeftRadius) || 0 : undefined,
    titleRect: part === "metadata"
      ? box.node.querySelector('[data-track-layer="current"] :is(h1, .mini-player-title, .player-title)')?.getBoundingClientRect()
      : undefined,
  };
}

function move(source: PartImage, target: PartImage, part: Part): string {
  const from = source.rect;
  const to = target.rect;
  if (part === "metadata" && source.titleRect && target.titleRect) {
    return `translate(${target.titleRect.x - source.titleRect.x}px, ${target.titleRect.y - source.titleRect.y}px) scale(1)`;
  }
  const transport = part === "transport";
  const scaleX = part === "artwork" ? to.width / from.width : transport ? to.height / from.height : 1;
  const scaleY = part === "artwork" ? to.height / from.height : scaleX;
  const x = to.left - from.left + (transport ? (to.width - from.width * scaleX) / 2 : 0);
  return `translate(${x}px, ${to.top - from.top}px) scale(${scaleX}, ${scaleY})`;
}

/** A small FLIP handoff at React's before/after-commit boundary. It also runs for keyboard and
 * native-window actions; there is no requirement for View Transitions support in the webview. */
export class PlayerLayoutMotion extends Component<Props> {
  private root = createRef<HTMLDivElement>();
  private flight: HTMLElement | null = null;
  private cancelFlight: (() => void) | undefined;

  getSnapshotBeforeUpdate(previous: Props): Scene | null {
    if (previous.layout === this.props.layout || this.props.reducedMotion || !canAnimateLayout() || !this.root.current) return null;
    const layoutPair = [previous.layout, this.props.layout];
    if (!layoutPair.includes("mini") && !layoutPair.includes("fullscreen")) return null;
    const scene: Scene = {};
    for (const part of PARTS) {
      // A reversal starts at the visible position of the in-flight part, not at its last endpoint.
      const copies = Array.from(this.flight?.querySelectorAll<HTMLElement>(`[data-player-flight="${part}"]`) ?? []);
      copies.sort((a, b) => Number(getComputedStyle(b).opacity) - Number(getComputedStyle(a).opacity));
      const ghost = copies[0]?.firstElementChild as HTMLElement | undefined;
      const box = (ghost && visible(ghost)) || findPart(this.root.current, part);
      if (box) scene[part] = freeze(box, part);
    }
    return scene;
  }

  componentDidUpdate(previous: Props, _state: unknown, scene: Scene | null) {
    if (previous.layout === this.props.layout) {
      if (this.props.reducedMotion) this.cancelFlight?.();
      return;
    }
    this.cancelFlight?.();
    const root = this.root.current;
    if (!root) return;
    delete root.dataset.playerHandoff;
    if (!scene || !Object.keys(scene).length) return;

    // This suppresses the mount-keyed parent transforms before measuring the final layout. It
    // stays set until the next layout so removing it doesn't replay a second entrance on landing.
    root.dataset.playerHandoff = this.props.layout;
    root.dataset.playerMoving = "true";
    const destination: Scene = {};
    for (const part of PARTS) {
      const box = scene[part] && findPart(root, part);
      if (box) destination[part] = freeze(box, part);
    }

    const flight = document.createElement("div");
    flight.className = "player-flight";
    flight.inert = true;
    flight.setAttribute("aria-hidden", "true");
    const animations: Animation[] = [];
    const hidden: HTMLElement[] = [];
    const portal = (part: Part, image: PartImage) => {
      const carrier = document.createElement("div");
      carrier.dataset.playerFlight = part;
      pinToRect(carrier, image.rect);
      carrier.append(image.clone!);
      flight.append(carrier);
      return carrier;
    };
    document.body.append(flight);
    this.flight = flight;

    for (const part of PARTS) {
      const from = scene[part];
      const to = destination[part];
      if (!from || !to) continue;
      if (part === "transport") {
        if (Math.abs(from.rect.x - to.rect.x) < 1 && Math.abs(from.rect.y - to.rect.y) < 1 &&
          Math.abs(from.rect.height - to.rect.height) < 1) continue;
        animations.push(to.node.animate([
          { transform: move(to, from, part), transformOrigin: "0 0" },
          { transform: still, transformOrigin: "0 0" },
        ], { ...timing, id: "player-transport-handoff" }));
        continue;
      }

      if (from.node === to.node && Math.abs(from.rect.x - to.rect.x) < 1 && Math.abs(from.rect.y - to.rect.y) < 1) continue;
      to.node.dataset.inFlight = "true";
      hidden.push(to.node);
      const incoming = portal(part, to);
      animations.push(incoming.animate([{ transform: move(to, from, part) }, { transform: still }], { ...timing, id: `player-${part}-handoff` }));
      if (part === "artwork" && from.coverUrl && from.coverUrl === to.coverUrl) {
        // One unbroken cover, with the mini player's corner geometry at the start.
        animations.push(to.clone!.animate([
          { borderRadius: `${(from.radius ?? 0) * to.rect.width / from.rect.width}px` },
          { borderRadius: `${to.radius ?? 0}px` },
        ], timing));
      } else {
        const outgoing = portal(part, from);
        animations.push(outgoing.animate([{ transform: still }, { transform: move(from, to, part) }], timing));
        const isText = part === "metadata";
        // Stagger the text dissolve so unlike font sizes/line wrapping don't double-print.
        const fadeOut = isText ? 0.47 : 0.8;
        const fadeIn = isText ? 0.31 : 0.04;
        animations.push(outgoing.animate([{ opacity: 1 }, { opacity: 0, offset: fadeOut }, { opacity: 0 }], { ...timing, easing: "linear" }));
        animations.push(incoming.animate([{ opacity: 0 }, { opacity: 0, offset: fadeIn }, { opacity: 1, offset: 0.78 }, { opacity: 1 }], { ...timing, easing: "linear" }));
      }
    }

    // Reveal the new chrome around the flight. The secondary player-bar cover/title should
    // not flash a second copy while the hero is making the trip from Mini.
    const fade = (node: Element, duration: number, from = 0.15) => animations.push(node.animate(
      [{ opacity: from }, { opacity: 1 }], { duration, easing: MOTION_EASING.out, fill: "both", id: "player-surroundings" }
    ));
    for (const node of root.querySelectorAll(".lyrics-view > .np-bg")) fade(node, MOTION_DURATION_MS.layout, 0.32);
    for (const node of root.querySelectorAll(".lyrics-view > .lyrics-body:not(.is-hidden)")) {
      // Let the live controls clear the lyric text before bringing it up to full emphasis.
      animations.push(node.animate([{ opacity: 0.15 }, { opacity: 0.24, offset: 0.35 }, { opacity: 1 }], {
        duration: MOTION_DURATION_MS.scene, easing: "linear", fill: "both", id: "player-surroundings",
      }));
    }
    if (previous.layout === "mini" || previous.layout === "fullscreen") {
      for (const node of root.querySelectorAll(".sidebar, .top-bar, .player-bar .player-track [data-player-part]:not([data-in-flight])")) {
        fade(node, MOTION_DURATION_MS.view);
      }
    }
    for (const node of root.querySelectorAll(".mini-player-chrome, .mini-player > .seek-row")) {
      fade(node, MOTION_DURATION_MS.surface);
    }
    this.cancelFlight = finishMotion(animations, () => {
      for (const node of hidden) delete node.dataset.inFlight;
      delete root.dataset.playerMoving;
      flight.remove();
      this.flight = null;
    });
  }

  componentWillUnmount() { this.cancelFlight?.(); }

  render() {
    return <div ref={this.root} className="player-scene">{this.props.children}</div>;
  }
}
