import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label: string;
}

interface State {
  error: string | null;
}

/** Keep one malformed view from unmounting the surrounding application. */
export default class RenderBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Preserve a useful trace for the browser console while presenting a
    // recoverable, contained error to the reader.
    console.error(`Unable to render ${this.props.label}`, error, info);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="render-error" role="alert">
        <strong>{this.props.label} could not be displayed.</strong>
        <p>The rest of the project is still available. Try this view again or select another tab.</p>
        <button
          type="button"
          className="button"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
        <details>
          <summary>Technical details</summary>
          <pre>{this.state.error}</pre>
        </details>
      </div>
    );
  }
}
