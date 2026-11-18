import { Component, createRef, type ReactNode } from "react";
import { canAnimateLayout, finishMotion, pinToRect } from "../../app/layoutMotion";
import { MOTION_DURATION_MS, MOTION_EASING } from "../../app/motion";

interface Props {
  occurrences: readonly string[];
  open: boolean;
  reducedMotion: boolean;
  children: ReactNode;
}
interface RowBox { id: string; node: HTMLElement; rect: DOMRect; visible: boolean; }
interface Snapshot {
  viewport: DOMRect;
  rows: RowBox[];
  exits: { rect: DOMRect; ghost: HTMLElement; opacity: string }[];
}
const MAX_ROWS = 24;
const MAX_EXITS = 8;

function visibleRows(list: HTMLOListElement, includeEdges = false): RowBox[] {
  const { children, scrollTop, clientHeight } = list;
  const bottom = scrollTop + clientHeight;
  if (!clientHeight) return [];
  // The list isn't virtualized, but its motion is. Find its first visible row without reading
  // every box in a long album/library queue. offsetTop is untransformed and relative to the list.
  let low = 0;
  let high = children.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const row = children[mid] as HTMLElement;
    if (row.offsetTop + row.offsetHeight <= scrollTop) low = mid + 1;
    else high = mid;
  }
  const rows: RowBox[] = [];
  // Sample one row just outside each edge before an edit. If a removal pulls it into view,
  // it can enter from its real position instead of jumping over the last moving row.
  for (let index = Math.max(0, low - Number(includeEdges)); index < children.length && rows.length < MAX_ROWS; index++) {
    const node = children[index] as HTMLElement;
    const below = node.offsetTop >= bottom;
    if (below && !includeEdges) break;
    if (node.dataset.occurrenceId) rows.push({ id: node.dataset.occurrenceId, node, rect: node.getBoundingClientRect(), visible: index >= low && !below });
    if (below) break;
  }
  return rows;
}

/** Occurrence-keyed FLIP for the display only. Zustand and all queue actions still commit first. */
export class QueueMotionList extends Component<Props> {
  private list = createRef<HTMLOListElement>();
  private cancelMotion: (() => void) | undefined;

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const list = this.list.current;
    if (!list || !this.props.open || !previous.open || this.props.reducedMotion ||
      previous.occurrences === this.props.occurrences || !canAnimateLayout()) return null;

    const remaining = new Set(this.props.occurrences);
    const rows = visibleRows(list, true);
    const exits = rows.filter(row => row.visible && !remaining.has(row.id)).slice(0, MAX_EXITS).map(row => {
      const ghost = row.node.cloneNode(true) as HTMLElement;
      for (const attribute of ["id", "data-testid", "data-occurrence-id"]) {
        ghost.removeAttribute(attribute);
        ghost.querySelectorAll(`[${attribute}]`).forEach(child => child.removeAttribute(attribute));
      }
      return { rect: row.rect, ghost, opacity: getComputedStyle(row.node).opacity };
    });
    return { viewport: list.getBoundingClientRect(), rows, exits };
  }

  componentDidUpdate(previous: Props, _state: unknown, before: Snapshot | null) {
    if (!this.props.open || this.props.reducedMotion || before) this.cancelMotion?.();
    const list = this.list.current;
    const panel = list?.parentElement;
    if (!before || !list || !panel) return;

    const after = visibleRows(list);
    const old = new Map(before.rows.map(row => [row.id, row.rect.top]));
    const previousOccurrences = new Set(previous.occurrences);
    const panelRect = panel.getBoundingClientRect();
    const animations: Animation[] = [];
    const timing = { duration: MOTION_DURATION_MS.view, easing: MOTION_EASING.inOut, fill: "both" as const };
    for (const row of after) {
      const top = old.get(row.id);
      if (top !== undefined) {
        const offset = top - row.rect.top;
        if (Math.abs(offset) > 1) animations.push(row.node.animate([
          { transform: `translateY(${offset}px)` }, { transform: "none" },
        ], { ...timing, id: "queue-row-move" }));
      } else if (!previousOccurrences.has(row.id)) {
        animations.push(row.node.animate([
          { opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" },
        ], { ...timing, duration: MOTION_DURATION_MS.surface, easing: MOTION_EASING.out, id: "queue-row-in" }));
      } else {
        // A distant occurrence can land in the viewport on shuffle. Don't manufacture a
        // long travel from an invisible row; fade it into its new slot instead.
        animations.push(row.node.animate([
          { opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 },
        ], { ...timing, id: "queue-row-reveal" }));
      }
    }

    let ghosts: HTMLElement | undefined;
    if (before.exits.length) {
      const { viewport } = before;
      ghosts = document.createElement("div");
      ghosts.className = "queue-motion-exits";
      ghosts.inert = true;
      ghosts.setAttribute("aria-hidden", "true");
      pinToRect(ghosts, new DOMRect(viewport.left - panelRect.left - panel.clientLeft, viewport.top - panelRect.top - panel.clientTop, viewport.width, viewport.height));
      panel.append(ghosts);
      for (const { ghost, opacity, rect } of before.exits) {
        pinToRect(ghost, new DOMRect(rect.left - viewport.left, rect.top - viewport.top, rect.width, rect.height));
        ghosts.append(ghost);
        animations.push(ghost.animate([
          { opacity, transform: "none" }, { opacity: 0, transform: "translateX(8px)" },
        ], { duration: MOTION_DURATION_MS.fast, easing: MOTION_EASING.out, fill: "both", id: "queue-row-out" }));
      }
    }
    const cancel = finishMotion(animations, () => {
      ghosts?.remove();
      list.removeEventListener("scroll", cancel);
    });
    this.cancelMotion = cancel;
    list.addEventListener("scroll", cancel, { passive: true });
  }

  componentWillUnmount() { this.cancelMotion?.(); }

  render() {
    return <ol className="queue-list" ref={this.list}>{this.props.children}</ol>;
  }
}
