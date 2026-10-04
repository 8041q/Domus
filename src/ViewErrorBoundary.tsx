import { Component, type ErrorInfo, type ReactNode } from 'react';
import { usePlannerStore } from './store';

export function returnToLayout() {
  const state = usePlannerStore.getState();
  state.setBuildView('plan');
  state.setMode('build');
}

/** Keep navigation and the project alive if a lazy view or its mount effect fails. */
export class ViewErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Could not open planner view', error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="view-error" role="alert">
      <h2>Could not open this view</h2>
      <p>Your layout is still available. Return to 2D to continue editing.</p>
      <button type="button" className="primary-button" onClick={returnToLayout}>Return to 2D</button>
    </div>;
  }
}
