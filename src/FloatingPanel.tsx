import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Icon } from './ui';

type Position = { x: number; y: number };

/** A movable workspace panel with its own remembered position. */
export function FloatingPanel({ id, title, side = 'left', className = '', onClose, children }: {
  id: string;
  title: string;
  side?: 'left' | 'right';
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const positionRef = useRef<Position | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; start: Position } | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const storageKey = `domus-panel-position:${id}`;

  const move = (next: Position, save = false) => {
    const panel = panelRef.current, parent = panel?.parentElement;
    if (!panel || !parent) return;
    const clamped = {
      x: Math.max(12, Math.min(next.x, parent.clientWidth - panel.offsetWidth - 12)),
      y: Math.max(12, Math.min(next.y, parent.clientHeight - panel.offsetHeight - 12))
    };
    positionRef.current = clamped;
    setPosition(clamped);
    if (save) {
      try { localStorage.setItem(storageKey, JSON.stringify(clamped)); } catch { /* The panel still moves when storage is unavailable. */ }
    }
  };

  useLayoutEffect(() => {
    const panel = panelRef.current, parent = panel?.parentElement;
    if (!panel || !parent) return;
    let saved: Position | null = null;
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) saved = value;
    } catch { /* Ignore obsolete or malformed preferences. */ }
    move(saved ?? { x: side === 'right' ? parent.clientWidth - panel.offsetWidth - 12 : 12, y: 58 });
    const observer = new ResizeObserver(() => {
      if (positionRef.current) move(positionRef.current);
    });
    observer.observe(parent);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [storageKey, side]);

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (positionRef.current) move(positionRef.current, true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <aside ref={panelRef} className={`floating-panel ${className}`} aria-label={title}
    style={position ? { left: position.x, top: position.y } : { top: 58, [side]: 12 }}>
    <div className="floating-panel-heading">
      <button type="button" className="floating-panel-handle" aria-label={`Move ${title} panel`}
        onPointerDown={(event) => {
          if (event.button !== 0 || !positionRef.current) return;
          event.preventDefault();
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: positionRef.current };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag?.pointerId === event.pointerId) move({ x: drag.start.x + event.clientX - drag.x, y: drag.start.y + event.clientY - drag.y });
        }}
        onPointerUp={finishDrag} onPointerCancel={finishDrag}
        onKeyDown={(event) => {
          const directions: Record<string, Position> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
          const direction = directions[event.key], current = positionRef.current;
          if (!direction || !current) return;
          event.preventDefault();
          const step = event.shiftKey ? 40 : 10;
          move({ x: current.x + direction.x * step, y: current.y + direction.y * step }, true);
        }}><h2>{title}</h2><span>Drag to move</span></button>
      <button type="button" className="floating-panel-close" onClick={onClose} aria-label={`Close ${title}`}><Icon name="x" /></button>
    </div>
    <div className="floating-panel-content">{children}</div>
  </aside>;
}
