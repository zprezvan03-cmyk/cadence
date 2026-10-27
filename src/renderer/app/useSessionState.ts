/**
 * View state that should survive navigating away and back.
 *
 * Views remount when the route changes (each one replays its entering animation), which would
 * otherwise throw away a sort order, a filter or the selected Settings tab every time the user
 * looked at something else. This keeps those few values in memory for the session — nothing is
 * written to disk, so a restart starts clean and no state can outlive its data.
 */

import { useCallback, useRef, useState } from "react";

const sessionValues = new Map<string, unknown>();

export function useSessionState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (sessionValues.has(key) ? (sessionValues.get(key) as T) : initial));
  const keyRef = useRef(key);
  keyRef.current = key;

  const update = useCallback((next: T) => {
    sessionValues.set(keyRef.current, next);
    setValue(next);
  }, []);

  return [value, update];
}

/** Test helper: forget every remembered value without reloading the bundle. */
export function clearSessionState(): void {
  sessionValues.clear();
}
