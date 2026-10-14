import { ViewErrorBoundary } from './ViewErrorBoundary';
import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import { BuildRoom } from './BuildRoom';
import { usePlannerStore } from './store';
import { Button, Icon } from './ui';
import { ProjectControls } from './ProjectControls';
import { handlePlannerShortcut } from './core/plannerShortcuts';
import { LoadingBoundary, LoadingProvider } from './LoadingStatus';

const PlanRoom = lazy(() => import('./PlanRoom').then((module) => ({ default: module.PlanRoom })));

export default function App() {
  const mode = usePlannerStore((s) => s.mode);
  const buildView = usePlannerStore((s) => s.buildView);
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
    const onKey = (e: KeyboardEvent) => {
      handlePlannerShortcut(e, { mode, rotate, remove, undo, redo });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, redo, remove, rotate, undo]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block" aria-label="Domus room planner">
          <div className="brand-mark">D</div>
          <div><strong>Domus</strong><span>Room planning workspace</span></div>
        </div>

        <nav className="mode-stepper" aria-label="Planning workflow">
          <button type="button" className={mode === 'build' ? 'active' : ''} aria-current={mode === 'build' ? 'step' : undefined} onClick={() => setMode('build')}>
            <span className="step-number">1</span>
            <div><strong>Build room</strong><small>Shape & architecture</small></div>
          </button>
          <span className="step-line" aria-hidden="true" />
          <button type="button" className={mode === 'plan' ? 'active' : ''} aria-current={mode === 'plan' ? 'step' : undefined} onClick={() => setMode('plan')}>
            <span className="step-number">2</span>
            <div><strong>Plan room</strong><small>Products & layout</small></div>
          </button>
        </nav>

        <div className="header-actions">
          <div className="history-actions" role="group" aria-label="Edit history">
            <Button variant="ghost" size="icon" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" onClick={undo}><Icon name="undo" /></Button>
            <Button variant="ghost" size="icon" title="Redo (Ctrl/Cmd+Y)" aria-label="Redo" onClick={redo}><Icon name="redo" /></Button>
          </div>
          <ProjectControls canExport={canExport} onExport={mode === 'plan' ? () => { void exportAction.current?.(); } : undefined}
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

    </div>
  );
}
