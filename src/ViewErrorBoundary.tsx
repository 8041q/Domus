import { Component, type ErrorInfo, type ReactNode } from 'react';
import { usePlannerStore } from './store';
import { ViewRecovery } from './ViewRecovery';

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
    return <ViewRecovery title="Could not open this view"
      description="Your layout is still available. Return to 2D to continue editing." onReturn={returnToLayout} />;
  }
}
