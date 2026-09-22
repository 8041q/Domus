import { useEffect, useState } from 'react';
import { BuildRoom } from './BuildRoom';
import { FurnishRoom } from './FurnishRoom';
import { usePlannerStore } from './store';

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
      if (mode === 'furnish' && e.key.toLowerCase() === 'r') rotate();
      if (mode === 'furnish' && (e.key === 'Delete' || e.key === 'Backspace')) remove();
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
        <div className="brand-block">
          <div className="brand-mark">S</div>
          <div><strong>Domus</strong><span>Room planner prototype</span></div>
        </div>

        <nav className="mode-stepper" aria-label="Design steps">
          <button type="button" className={mode === 'build' ? 'active' : ''} onClick={() => setMode('build')}>
            <span>1</span><div><strong>Build room</strong><small>Shape & dimensions</small></div>
          </button>
          <span className="step-line" />
          <button type="button" className={mode === 'furnish' ? 'active' : ''} onClick={() => setMode('furnish')}>
            <span>2</span><div><strong>Furnish</strong><small>Products & layout</small></div>
          </button>
        </nav>

        <div className="header-actions">
          <button type="button" title="Undo" onClick={undo}>↶ <span>Undo</span></button>
          <button type="button" title="Redo" onClick={redo}>↷ <span>Redo</span></button>
          <span className="header-divider" />
          <button type="button" onClick={() => { loadLocal(); flash('Saved design loaded'); }}>Load</button>
          <button type="button" className="save-button" onClick={() => { saveLocal(); flash('Design saved locally'); }}>Save</button>
          <button
            type="button"
            className="more-button"
            title="Start a new room"
            onClick={() => { if (window.confirm('Start a new room? Your current unsaved changes will be replaced.')) resetProject(); }}
          >•••</button>
        </div>
      </header>

      <main className="app-main">
        {mode === 'build' ? <BuildRoom /> : <FurnishRoom />}
      </main>

      {notice && <div className="toast" role="status">✓ {notice}</div>}
    </div>
  );
}
