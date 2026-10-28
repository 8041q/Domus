import { ViewErrorBoundary } from './ViewErrorBoundary';
import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import { BuildRoom } from './BuildRoom';
import { usePlannerStore } from './store';
import { Button, Icon } from './ui';
import { ProjectControls } from './ProjectControls';
import { handlePlannerShortcut } from './core/plannerShortcuts';
import { LoadingBoundary, LoadingProvider } from './LoadingStatus';
import { useCompactWorkspace, useMobileWorkspace, type MobileTask } from './mobileWorkspace';

const PlanRoom = lazy(() => import('./PlanRoom').then((module) => ({ default: module.PlanRoom })));

export default function App() {
  const mode = usePlannerStore((s) => s.mode);
  const buildView = usePlannerStore((s) => s.buildView);
  const planView = usePlannerStore((s) => s.planView);
  const compact = useCompactWorkspace();
  const mobileTask = useMobileWorkspace(s => s.task);
  const setMobileTask = useMobileWorkspace(s => s.setTask);
  const setMode = usePlannerStore((s) => s.setMode);
  const rotate = usePlannerStore((s) => s.rotateSelected);
  const remove = usePlannerStore((s) => s.removeSelected);
  const undo = usePlannerStore((s) => s.undo);
  const redo = usePlannerStore((s) => s.redo);
  const [canExport, setCanExport] = useState(false);
  const exportAction = useRef<(() => Promise<void>) | null>(null);
  const pdfAction = useRef<(() => Promise<void>) | null>(null);
  const registerPdfExport = useCallback((handler: (() => Promise<void>) | null) => { pdfAction.current = handler; }, []);

  const registerExport = useCallback((handler: (() => Promise<void>) | null) => {
    exportAction.current = handler;
    setCanExport(Boolean(handler));
  }, []);

  useEffect(() => {
    if (!compact) return;
    // New/Open/Import and the existing view buttons can also change workspace.
    // Synchronize chrome without issuing editor commands or resetting a camera.
    const task: MobileTask = mode === 'build' ? 'room' : planView === 'walk' ? 'explore'
      : mobileTask === 'finishes' || mobileTask === 'explore' ? mobileTask : 'furniture';
    if (task !== mobileTask) useMobileWorkspace.setState({ task,
      sheet: task === 'room' ? 'room' : task === 'furniture' ? 'catalogue' : task === 'finishes' ? 'finishes' : null, size: 'peek', cornerId: null });
  }, [compact, mode, planView, mobileTask]);

  useEffect(() => {
    if (!compact) return;
    const root = document.documentElement;
    const measure = () => {
      root.style.setProperty('--workspace-height', `${window.visualViewport?.height ?? window.innerHeight}px`);
      root.style.setProperty('--workspace-offset-top', `${window.visualViewport?.offsetTop ?? 0}px`);
    };
    measure();
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      root.style.removeProperty('--workspace-height'); root.style.removeProperty('--workspace-offset-top');
    };
  }, [compact]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const state = usePlannerStore.getState();
      if (state.mode === 'plan' && state.planView === 'walk') return;
      handlePlannerShortcut(e, { mode, rotate, remove, undo, redo });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, redo, remove, rotate, undo]);

  return (
    <div className={`app-shell${compact ? ' is-compact' : ''}`} data-mobile-task={compact ? mobileTask : undefined}>
      <header className="app-header">
        <div className="brand-block" aria-label="Domus room planner">
          <div className="brand-mark">D</div>
          <div><strong>Domus</strong></div>
        </div>

        <nav className="mode-stepper" aria-label="Planning workflow">
          <button type="button" className={mode === 'build' ? 'active' : ''} aria-current={mode === 'build' ? 'step' : undefined} onClick={() => setMode('build')}>
            <Icon name="ruler" /><strong>Build room</strong>
          </button>
          <button type="button" className={mode === 'plan' ? 'active' : ''} aria-current={mode === 'plan' ? 'step' : undefined} onClick={() => setMode('plan')}>
            <Icon name="cube" /><strong>Plan room</strong>
          </button>
        </nav>

        <div className="header-actions">
          <div className="history-actions" role="group" aria-label="Edit history">
            <Button variant="ghost" size="icon" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" onClick={undo}><Icon name="undo" /></Button>
            <Button variant="ghost" size="icon" title="Redo (Ctrl/Cmd+Y)" aria-label="Redo" onClick={redo}><Icon name="redo" /></Button>
          </div>
          <ProjectControls canExport={canExport} onExport={mode === 'plan' && canExport ? () => exportAction.current!() : undefined}
            onExportPdf={mode === 'plan' ? () => { void pdfAction.current?.(); } : undefined} />
        </div>
      </header>

      <main className="app-main">
        <LoadingProvider key={`${mode}-${buildView}`}>
        <ViewErrorBoundary key={`${mode}-${buildView}`}>
          {mode === 'build' ? <BuildRoom /> : (
            <LoadingBoundary label="Opening room planner…" detail="Getting your workspace ready">
              <PlanRoom onExportReady={registerExport} onPdfExportReady={registerPdfExport} />
            </LoadingBoundary>
          )}
        </ViewErrorBoundary>
        </LoadingProvider>
      </main>

      {compact && <nav className="mobile-task-nav" aria-label="Phone workspace">
        {([
          ['room', 'Room', 'ruler'], ['furniture', 'Furniture', 'cube'],
          ['finishes', 'Finishes', 'palette'], ['explore', 'Explore', 'eye']
        ] as const).map(([task, label, icon]) => <button type="button" key={task}
          aria-current={mobileTask === task ? 'page' : undefined} onClick={() => setMobileTask(task)}>
          <Icon name={icon} /><span>{label}</span>
        </button>)}
      </nav>}

    </div>
  );
}
