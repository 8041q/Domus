import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './ui';
import { createPortal } from 'react-dom';
import { useCompactWorkspace, useMobileBack, useMobileWorkspace, type MobileSheetId, type MobileSheetSize } from './mobileWorkspace';

export function MobileSheet({ id, title, children }: { id: MobileSheetId; title: string; children: ReactNode }) {
  const compact = useCompactWorkspace();
  const active = useMobileWorkspace(s => s.sheet === id);
  const size = useMobileWorkspace(s => s.size);
  const close = useMobileWorkspace(s => s.closeSheet);
  const setSize = useMobileWorkspace(s => s.setSize);
  const drag = useRef<{ id: number; y: number } | null>(null);
  const dragged = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  useMobileBack(close, compact && active);
  useEffect(() => {
    if (!compact || !active) return;
    const escape = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); close(); }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [compact, active, close]);
  useEffect(() => { if (active && body.current) body.current.scrollTop = 0; }, [active]);
  if (!compact || !active) return null;
  const sizes: MobileSheetSize[] = ['peek', 'half', 'expanded'];
  const resize = (next: MobileSheetSize) => {
    // A swipe does not move focus like a button tap. Commit drafts and dismiss
    // the software keyboard before hiding or moving the focused field.
    if (document.activeElement instanceof HTMLElement && body.current?.contains(document.activeElement)) document.activeElement.blur();
    setSize(next);
  };
  const changeSize = () => resize(size === 'peek' ? 'half' : size === 'half' ? 'expanded' : 'peek');
  const sheet = <aside className={`mobile-sheet mobile-sheet-${size}`} role="region" aria-label={`${title} tools`} data-sheet={id}>
    <header className="mobile-sheet-heading">
      <button type="button" className="mobile-sheet-handle" aria-label={`${size === 'expanded' ? 'Collapse' : 'Expand'} ${title} tools`}
        aria-expanded={size !== 'peek'} onClick={event => { if (dragged.current && event.detail !== 0) { dragged.current = false; return; } changeSize(); }}
        onPointerDown={event => { if (event.button !== 0) return; dragged.current = false; drag.current = { id: event.pointerId, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerUp={event => {
          const start = drag.current; drag.current = null;
          if (start?.id !== event.pointerId) return;
          const distance = event.clientY - start.y;
          if (Math.abs(distance) > 24) {
            event.preventDefault();
            dragged.current = true;
            resize(sizes[Math.max(0, Math.min(2, sizes.indexOf(size) + (distance < 0 ? 1 : -1)))]);
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }} onPointerCancel={() => { drag.current = null; dragged.current = false; }}>
        <span className="mobile-sheet-grip" /><strong>{title}</strong><small>{size === 'peek' ? 'Tap for tools' : 'Drag or tap to resize'}</small>
      </button>
      <button type="button" className="mobile-sheet-close" aria-label={`Close ${title} tools`} onClick={close}><Icon name="x" /></button>
    </header>
    <div className="mobile-sheet-body" ref={body} hidden={size === 'peek'}>{children}</div>
  </aside>;
  const host = document.querySelector('.app-shell.is-compact .app-main');
  return host ? createPortal(sheet, host) : sheet;
}
