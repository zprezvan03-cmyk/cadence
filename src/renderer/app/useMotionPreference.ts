import { useSyncExternalStore } from "react";
import { useSettings } from "../state/settingsStore";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(listener: () => void) {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** CSS handles ordinary transitions; subscribe only when an effect also needs to stand down. */
export function useReducedMotion(): boolean {
  const setting = useSettings(state => state.settings?.appearance.reduceMotion ?? false);
  const system = useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
  return setting || system;
}
