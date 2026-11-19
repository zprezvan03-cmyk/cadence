import { prefersReducedMotion } from "./motion";

export function canAnimateLayout(): boolean {
  return typeof Element.prototype.animate === "function" && !document.hidden && !prefersReducedMotion();
}

/** Temporary compositor work must not leave a transform in the layout or a live ghost in the DOM. */
export function finishMotion(animations: Animation[], remove: () => void): () => void {
  let disposed = false;
  const cancel = () => {
    if (disposed) return;
    disposed = true;
    remove();
    for (const animation of animations) animation.cancel();
    window.removeEventListener("resize", cancel);
    document.removeEventListener("visibilitychange", cancel);
  };
  window.addEventListener("resize", cancel);
  document.addEventListener("visibilitychange", cancel);
  void Promise.allSettled(animations.map(animation => animation.finished)).then(cancel);
  return cancel;
}

export function pinToRect(element: HTMLElement, rect: DOMRectReadOnly): void {
  Object.assign(element.style, {
    position: "absolute",
    margin: "0",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    transformOrigin: "0 0",
  });
}
