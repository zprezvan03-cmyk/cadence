import { useEffect, useState } from "react";

export interface VisualLayer<T> {
  key: string;
  value: T;
}

export interface Dissolve<T> {
  front: VisualLayer<T>;
  back: VisualLayer<T> | null;
}

/**
 * Retains just one outgoing layer. While a dissolve is running, the latest ready target wins
 * the next beat rather than cancelling the visible blend or queuing every intermediate target.
 * Pass a memoized target; null means the next visual is not ready to reveal yet.
 */
export function useDissolve<T>(
  target: VisualLayer<T> | null,
  initial: VisualLayer<T>,
  duration: number,
  animate: boolean
): Dissolve<T> {
  const [layers, setLayers] = useState<Dissolve<T>>(() => ({ front: target ?? initial, back: null }));
  if (target && target !== layers.front && (target.key === layers.front.key || !layers.back || !animate)) {
    setLayers({
      front: target,
      back: !animate ? null : target.key === layers.front.key ? layers.back : layers.front,
    });
  } else if (!animate && layers.back) {
    setLayers({ front: layers.front, back: null });
  }

  const back = layers.back;
  useEffect(() => {
    if (!back) return;
    const finish = () => setLayers(current => current.back === back ? { ...current, back: null } : current);
    const timer = window.setTimeout(finish, duration + 24); // allow the initial style/paint before cleanup
    const onVisibility = () => { if (document.hidden) finish(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [back, duration]);
  return layers;
}
