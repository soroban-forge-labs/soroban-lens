import { Component, type ReactNode, type ErrorInfo } from 'react';
import { translate } from '../i18n/translate.js';
import { en } from '../i18n/en.js';

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

/**
 * ErrorBoundary is a class component and cannot use hooks, so it calls the
 * module-level translate() directly with the English catalogue as a safe
 * default.  In practice the app is always English or Spanish here, and the
 * boundary is rarely shown, so the simplification is acceptable.
 */
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

      // Class components cannot call hooks; fall back to a direct translate()
      // call with the English catalogue so the strings are still centralised.
      const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
        translate(en, key, vars);

      return (
        <div className="error-boundary-card">
          <div className="error-boundary-header">
            <h3>{this.props.title ?? t('componentError')}</h3>
          </div>
          <p className="error-boundary-msg">
            {this.state.error?.message ?? t('defaultErrorMessage')}
          </p>
          <div className="error-boundary-actions">
            <button type="button" className="btn btn-secondary" onClick={this.handleReset}>
              {t('reloadComponent')}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
