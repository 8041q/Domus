import { ViewErrorBoundary } from './ViewErrorBoundary';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { BuildRoom } from './BuildRoom';
import { usePlannerStore } from './store';
import { Button, Icon } from './ui';
import { ProjectControls } from './ProjectControls';

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

  const registerExport = useCallback((handler: (() => Promise<void>) | null) => {
    exportAction.current = handler;
    setCanExport(Boolean(handler));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches('input, textarea, select') || document.querySelector('dialog[open]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      if (mode === 'plan' && e.key.toLowerCase() === 'r') rotate();
      if (mode === 'plan' && (e.key === 'Delete' || e.key === 'Backspace')) remove();
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
          <button type="button" className={mode === 'build' ? 'active' : ''} onClick={() => setMode('build')}>
            <span className="step-number">1</span>
            <div><strong>Build room</strong><small>Shape & architecture</small></div>
          </button>
          <span className="step-line" aria-hidden="true" />
          <button type="button" className={mode === 'plan' ? 'active' : ''} onClick={() => setMode('plan')}>
            <span className="step-number">2</span>
            <div><strong>Plan room</strong><small>Products & layout</small></div>
          </button>
        </nav>

        <div className="header-actions">
          <div className="history-actions" role="group" aria-label="Edit history">
            <Button variant="ghost" size="icon" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" onClick={undo}><Icon name="undo" /></Button>
            <Button variant="ghost" size="icon" title="Redo (Ctrl/Cmd+Y)" aria-label="Redo" onClick={redo}><Icon name="redo" /></Button>
          </div>
          <ProjectControls canExport={canExport} onExport={mode === 'plan' ? () => { void exportAction.current?.(); } : undefined} />
        </div>
      </header>

      <main className="app-main">
        <ViewErrorBoundary key={`${mode}-${buildView}`}>
          {mode === 'build' ? <BuildRoom /> : (
            <Suspense fallback={<div className="mode-loading">Loading room planner…</div>}>
              <PlanRoom onExportReady={registerExport} />
            </Suspense>
          )}
        </ViewErrorBoundary>
      </main>

    </div>
  );
}
