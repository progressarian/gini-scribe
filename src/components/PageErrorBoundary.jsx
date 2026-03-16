import { Component } from "react";
import "./PageErrorBoundary.css";

export default class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error(`Page error in ${this.props.name || "unknown"}:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="page-error">
          <div className="page-error__card">
            <div className="page-error__icon">⚠️</div>
            <div className="page-error__title">This section encountered an error</div>
            <div className="page-error__msg">{this.state.error?.message || "Unexpected error"}</div>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="page-error__btn"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
