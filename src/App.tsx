import { useEffect, useState } from 'react';
import { BuildRoom } from './BuildRoom';
import { PlanRoom } from './PlanRoom';
import { usePlannerStore } from './store';
import { Button, Icon } from './ui';

export default function App() {
  const mode = usePlannerStore((s) => s.mode);
  const setMode = usePlannerStore((s) => s.setMode);
  const rotate = usePlannerStore((s) => s.rotateSelected);
  const remove = usePlannerStore((s) => s.removeSelected);
  const undo = usePlannerStore((s) => s.undo);
  const redo = usePlannerStore((s) => s.redo);
  const saveLocal = usePlannerStore((s) => s.saveLocal);
  const loadLocal = usePlannerStore((s) => s.loadLocal);
  const resetProject = usePlannerStore((s) => s.resetProject);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches('input, textarea, select')) return;
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

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 1800);
  };

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
          <Button variant="ghost" size="icon" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" onClick={undo}><Icon name="undo" /></Button>
          <Button variant="ghost" size="icon" title="Redo (Ctrl/Cmd+Y)" aria-label="Redo" onClick={redo}><Icon name="redo" /></Button>
          <span className="header-divider" />
          <Button variant="ghost" size="sm" onClick={() => { loadLocal(); flash('Saved design loaded'); }}><Icon name="folder" />Load</Button>
          <Button size="sm" onClick={() => { saveLocal(); flash('Design saved locally'); }}><Icon name="save" />Save</Button>
          <Button
            variant="outline"
            size="sm"
            title="Start a new room"
            aria-label="Start a new room"
            onClick={() => { if (window.confirm('Start a new room? Your current unsaved changes will be replaced.')) resetProject(); }}
          ><Icon name="plus" />New</Button>
        </div>
      </header>

      <main className="app-main">
        {mode === 'build' ? <BuildRoom /> : <PlanRoom />}
      </main>

      {notice && <div className="toast" role="status"><Icon name="check" />{notice}</div>}
    </div>
  );
}
