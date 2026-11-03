/**
 * Catches render errors in routed views. Without it, any exception while rendering a page
 * (e.g. a conditional-hook violation) unmounts the whole React tree and the window goes black
 * with no way back. The fallback shows the error and offers Retry / Back instead.
 */
import { Component, type ReactNode } from "react";
import { useUi } from "../state/uiStore";

export class ViewErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("View render error:", error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="empty-state" data-testid="view-error" role="alert">
          <p>Something failed to render this page.</p>
          <p className="muted">{this.state.error.message}</p>
          <div className="heading-actions">
            <button type="button" className="primary" onClick={() => this.setState({ error: null })}>
              Retry
            </button>
            <button type="button" className="ghost-button" onClick={() => useUi.getState().goBack()}>
              Back
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
