import { Component, type ReactNode, type ErrorInfo } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  title?: string; // Optional error title
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[Soroban Lens] Uncaught error in UI component:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  public override render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return typeof this.props.fallback === 'function'
          ? this.props.fallback(this.state.error!, this.handleReset)
          : this.props.fallback;
      }

      return (
        <div className="error-boundary-card">
          <div className="error-boundary-header">
            <h3>{this.props.title || 'Component Error'}</h3>
          </div>
          <p className="error-boundary-msg">
            {this.state.error?.message || 'An unexpected rendering error occurred.'}
          </p>
          <div className="error-boundary-actions">
            <button type="button" className="btn btn-secondary" onClick={this.handleReset}>
              Reload Component
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
