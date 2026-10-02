import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { NamedSpace } from './core/types';
import { Icon } from './ui';

export function EditingSpaceSelector({ spaces, value, onChange }: {
  spaces: NamedSpace[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const listId = useId();
  const selectedIndex = Math.max(0, spaces.findIndex((space) => space.id === value));
  const selected = spaces[selectedIndex];

  useEffect(() => {
    if (!open) return;
    root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[active]?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open, active]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const navigate = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? spaces.length - 1
        : open ? (active + (event.key === 'ArrowDown' ? 1 : -1) + spaces.length) % spaces.length : selectedIndex;
      setActive(next);
      setOpen(true);
    }
  };

  return (
    <div className="editing-space-selector" ref={root} onKeyDown={navigate}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <span id={labelId}>Editing space</span>
      <button type="button" className="editing-space-trigger" ref={trigger} disabled={!spaces.length}
        aria-label={`Editing space: ${selected?.name ?? 'No spaces'}`} aria-haspopup="listbox"
        aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => { setActive(selectedIndex); setOpen(!open); }}>
        <span>{selected?.name ?? 'No spaces'}</span><Icon name="chevronDown" width={14} height={14} />
      </button>
      {open && <div className="editing-space-list" id={listId} role="listbox" aria-labelledby={labelId}>
        {spaces.map((space, index) => <button type="button" role="option" key={space.id}
          aria-selected={space.id === value} tabIndex={index === active ? 0 : -1}
          onFocus={() => setActive(index)}
          onClick={() => { onChange(space.id); close(); }}>
          <span>{space.name}</span>{space.id === value && <Icon name="check" width={14} height={14} />}
        </button>)}
      </div>}
    </div>
  );
}
