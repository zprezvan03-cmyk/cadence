import { Component, createRef, type ReactNode } from "react";
import { canAnimateLayout, finishMotion, pinToRect } from "../../app/layoutMotion";
import { MOTION_DURATION_MS, MOTION_EASING } from "../../app/motion";

interface Props {
  occurrences: readonly string[];
  open: boolean;
  reducedMotion: boolean;
  children: ReactNode;
}
interface Row { id: string; node: HTMLElement; top: number; visible: boolean; }
interface Snapshot {
  viewport: DOMRect;
  tops: Map<string, number>;
  removed: { node: HTMLElement; rect: DOMRect }[];
}
const MAX_ROWS = 16;
const MAX_EXITS = 2;

function visibleRows(list: HTMLOListElement, count: number, withEdge = false): Row[] {
  const { children, scrollTop, clientHeight } = list;
  if (!clientHeight) return [];
  const bottom = scrollTop + clientHeight;
  let low = 0;
  let high = count;
  // Binary search in the untransformed layout. The only reads of live transformed geometry
  // are for the visible neighbors and one edge row that can enter when a row disappears.
  while (low < high) {
    const mid = (low + high) >>> 1;
    const row = children[mid] as HTMLElement;
    if (row.offsetTop + row.offsetHeight <= scrollTop) low = mid + 1;
    else high = mid;
  }
  const rows: Row[] = [];
  for (let i = low; i < count && rows.length < MAX_ROWS; i++) {
    const node = children[i] as HTMLElement;
    const top = node.offsetTop;
    const visible = top < bottom;
    if (!visible && !withEdge) break;
    if (node.dataset.occurrenceId) rows.push({ id: node.dataset.occurrenceId, node, top, visible });
    if (!visible) break;
  }
  return rows;
}

/** Only present rows move. The store commits immediately; a removed row is detached from
 * React and reused, inert, for its exit (never a clone or a second actionable row). */
export class QueueMotionList extends Component<Props> {
  private list = createRef<HTMLOListElement>();
  private cancelMotion?: () => void;

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const list = this.list.current;
    if (!list || !previous.open || !this.props.open || this.props.reducedMotion ||
        previous.occurrences === this.props.occurrences || !canAnimateLayout()) return null;
    const remaining = new Set(this.props.occurrences);
    const tops = new Map<string, number>();
    const removed: Snapshot["removed"] = [];
    const viewport = list.getBoundingClientRect();
    const origin = viewport.top + list.clientTop - list.scrollTop;
    for (const { id, node, top, visible } of visibleRows(list, previous.occurrences.length, true)) {
      if (remaining.has(id)) tops.set(id, this.cancelMotion ? node.getBoundingClientRect().top - origin : top);
      else if (visible && removed.length < MAX_EXITS) removed.push({ node, rect: node.getBoundingClientRect() });
    }
    return { viewport, tops, removed };
  }

  componentDidUpdate(previous: Props, _state: unknown, before: Snapshot | null) {
    if (!this.props.open || this.props.reducedMotion || before) this.cancelMotion?.();
    const list = this.list.current;
    if (!before || !list) return;
    const prior = new Set(previous.occurrences);
    const rowCount = this.props.occurrences.length;
    // Batch all geometry reads before the first animate()/DOM write. Reading offsetTop
    // between WAAPI starts forces style/layout again for each of the following rows.
    const rows = visibleRows(list, rowCount);
    const panel = before.removed.length ? list.parentElement : null;
    const panelRect = panel?.getBoundingClientRect();
    const bounds = before.viewport;
    const clip = panel && panelRect ? new DOMRect(
      bounds.left - panelRect.left - panel.clientLeft,
      bounds.top - panelRect.top - panel.clientTop,
      bounds.width,
      bounds.height,
    ) : null;

    const animations: Animation[] = [];
    const timing = { duration: MOTION_DURATION_MS.view, easing: MOTION_EASING.settle, fill: "both" as const };
    for (const { id, node, top } of rows) {
      const old = before.tops.get(id);
      if (old !== undefined) {
        const dy = old - top;
        if (Math.abs(dy) > 1) animations.push(node.animate([
          { transform: `translateY(${dy}px)` }, { transform: "none" },
        ], { ...timing, easing: before.removed.length ? MOTION_EASING.inOut : timing.easing, id: "queue-row-move" }));
      } else if (!prior.has(id)) {
        animations.push(node.animate([
          { opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" },
        ], { ...timing, duration: MOTION_DURATION_MS.surface, id: "queue-row-in" }));
      } else {
        animations.push(node.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, id: "queue-row-reveal" }));
      }
    }

    // Keep the exits outside the scrollport so their transform cannot affect its overflow or
    // scroll anchoring. The same clipping applies when the empty state replaces the list.
    let exitList: HTMLOListElement | undefined;
    for (const { node, rect } of before.removed) {
      if (!panel || !clip || node.isConnected) continue;
      if (!exitList) {
        exitList = document.createElement("ol");
        exitList.className = "queue-row-exits";
        exitList.inert = true;
        exitList.setAttribute("aria-hidden", "true");
        pinToRect(exitList, clip);
        panel.append(exitList);
      }
      node.inert = true;
      node.setAttribute("aria-hidden", "true");
      node.removeAttribute("data-testid");
      node.removeAttribute("data-occurrence-id");
      node.dataset.queueExiting = "true";
      node.querySelectorAll("[data-testid]").forEach(child => child.removeAttribute("data-testid"));
      pinToRect(node, new DOMRect(rect.left - bounds.left, rect.top - bounds.top, rect.width, rect.height));
      exitList.append(node);
      animations.push(node.animate([
        { opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(10px)" },
      ], { ...timing, duration: MOTION_DURATION_MS.fast, easing: MOTION_EASING.out, id: "queue-row-out" }));
    }
    if (!animations.length) return;
    const cancel = finishMotion(animations, () => {
      exitList?.remove();
      list.removeEventListener("scroll", cancel);
      this.cancelMotion = undefined;
    });
    this.cancelMotion = cancel;
    list.addEventListener("scroll", cancel, { passive: true });
  }

  componentWillUnmount() { this.cancelMotion?.(); }

  render() {
    return <ol className="queue-list" ref={this.list}>{this.props.children}</ol>;
  }
}
