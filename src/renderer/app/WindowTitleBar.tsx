/**
 * Integrated window title bar. Written for Cadence.
 *
 * On Windows the main window is created undecorated (see `src-tauri/tauri.windows.conf.json`) so the
 * OS frame cannot paint a differently coloured caption strip over the app. This bar takes its place:
 * it continues the sidebar and top bar surfaces, keeps the drag region, and draws the minimize,
 * maximize/restore and close controls at the top-right corner. Platforms that keep their native
 * decorations never see it, because the window reports `undecorated: false`.
 */

import { useEffect, useState } from "react";
import { Copy, Minus, Music2, Square, X } from "lucide-react";
import type { WindowAction, WindowChromeState } from "../../shared/types";

const NATIVE_CHROME: WindowChromeState = {
  undecorated: false,
  maximized: false,
  fullscreen: false,
  focused: true,
};

const app = () => window.cadence?.app;

/**
 * Tracks the native frame state. Starts from the synchronous snapshot captured by the bridge so the
 * title bar is present on the very first frame, then follows native resize/focus events.
 */
export function useWindowChrome(): WindowChromeState {
  const [chrome, setChrome] = useState<WindowChromeState>(
    () => app()?.initialWindowChrome ?? NATIVE_CHROME
  );

  useEffect(() => {
    const bridge = app();
    if (!bridge?.onWindowChromeChange) return undefined;
    let active = true;
    const apply = (next: WindowChromeState) => {
      if (active) setChrome(next);
    };
    // Subscribing refreshes the state once immediately, so no extra round trip is needed here.
    const unsubscribe = bridge.onWindowChromeChange(apply);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return chrome;
}

function runWindowAction(action: WindowAction): void {
  const bridge = app();
  if (!bridge?.window) return;
  void bridge.window(action).catch(() => undefined);
}

export function WindowTitleBar({ chrome }: { chrome: WindowChromeState }) {
  // In native fullscreen the OS owns the whole screen: no caption, no controls, no drag region.
  if (!chrome.undecorated || chrome.fullscreen) return null;

  return (
    <div
      className={`window-title-bar ${chrome.focused ? "" : "is-blurred"}`}
      data-tauri-drag-region
    >
      <div className="title-bar-brand" data-tauri-drag-region>
        <span className="title-bar-mark" aria-hidden="true">
          <Music2 size={11} strokeWidth={2.2} />
        </span>
        <span className="title-bar-text" data-tauri-drag-region>
          Cadence
        </span>
      </div>

      <div className="title-bar-drag" data-tauri-drag-region />

      <div className="window-controls" role="group" aria-label="Window controls">
        <button
          type="button"
          className="window-control"
          title="Minimize"
          aria-label="Minimize"
          onClick={() => runWindowAction("minimize")}
        >
          <Minus size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-control"
          title={chrome.maximized ? "Restore down" : "Maximize"}
          aria-label={chrome.maximized ? "Restore down" : "Maximize"}
          onClick={() => runWindowAction(chrome.maximized ? "restore" : "maximize")}
        >
          {chrome.maximized ? (
            <Copy size={12} strokeWidth={1.9} aria-hidden="true" />
          ) : (
            <Square size={11} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="window-control is-close"
          title="Close"
          aria-label="Close"
          onClick={() => runWindowAction("close")}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
