/**
 * Containment for the wallpaper. Written for Cadence.
 *
 * The global shader is the one part of the UI that depends on a GPU, a WebGL context and a driver
 * that a user's machine may not offer. A render-time exception there used to take the whole tree
 * down: React unmounts the root, `#root` goes empty, and the window shows nothing but the platform
 * background — a grey or blank screen the user has no way out of, because the Settings toggle that
 * would turn the shader off lives inside the UI that just disappeared.
 *
 * This boundary keeps a shader failure contained to the background: the offending subtree is
 * unmounted (leaving the app's own canvas colour behind it) and the rest of the application keeps
 * rendering, so the user can still open Settings and switch the shader off.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Rendered instead of the children after a failure. Usually nothing — a plain background. */
  fallback?: ReactNode;
  /** Distinguishes shader failures in the log. */
  label?: string;
}

interface State {
  failed: boolean;
}

export class ShaderBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Never rethrow: the point of the boundary is that the app survives a broken wallpaper.
    console.error(`[Cadence] ${this.props.label ?? "Shader"} background failed and was disabled:`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
