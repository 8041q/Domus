import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SavedRoom } from './core/roomProjects';
import type { RoomShapeKind } from './core/types';
import { roomProjects, useRoomProjects } from './roomProjects';
import { Button, Icon, type IconName } from './ui';

type DialogKind = 'new' | 'save' | 'open' | 'guard' | 'delete';
function ProjectDialog({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previousFocus?.focus(); };
  }, []);
  useEffect(() => {
    const dialog = ref.current;
    (dialog?.querySelector<HTMLElement>('[data-project-focus]') ?? dialog?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [title]);
  return <dialog ref={ref} className="project-dialog" aria-labelledby="project-dialog-title" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <header><h2 id="project-dialog-title">{title}</h2><Button variant="ghost" size="icon" aria-label="Close dialog" onClick={onCancel}><Icon name="x" /></Button></header>
    {children}
  </dialog>;
}
function errorMessage(error: unknown) {
  if (error instanceof DOMException) return 'Browser storage is unavailable or full. Download a room file to keep your work, or free storage and try again.';
  return error instanceof Error ? error.message : 'The action could not be completed. Your current room has been kept.';
}

export function ProjectControls({ canExport, onExport }: { canExport: boolean; onExport?: () => void }) {
  const project = useRoomProjects();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [name, setName] = useState('');
  const [shape, setShape] = useState<Exclude<RoomShapeKind, 'custom'>>('rectangle');
  const [asCopy, setAsCopy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedRoom | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (!document.querySelector('dialog[open]')) {
        // Numeric controls commit on blur; include the currently typed value.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        save(event.shiftKey);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const cancel = () => {
    if (dialog === 'delete') { setDeleteTarget(null); setDialog('open'); }
    else { pending.current = null; setDialog(null); }
    setError('');
  };
  const finishPending = () => {
    pending.current?.();
    pending.current = null;
    setDialog(null);
    setError('');
  };
  const replace = (action: () => void) => {
    roomProjects.changed();
    pending.current = action;
    if (roomProjects.getState().dirty) { setError(''); setDialog('guard'); }
    else { try { finishPending(); } catch (failure) { setError(errorMessage(failure)); } }
  };
  const save = (copy = false) => {
    setMenuOpen(false); setError('');
    if (copy || !roomProjects.getState().activeId) {
      setName(copy ? `${roomProjects.getState().name} copy`.slice(0, 80) : roomProjects.getState().name);
      setAsCopy(copy); setDialog('save'); return;
    }
    try {
      roomProjects.save();
      setNotice('Room saved in this browser');
      if (pending.current) finishPending();
    } catch (failure) { setError(errorMessage(failure)); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([roomProjects.exportFile()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${project.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'room'}.domus.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMenuOpen(false);
  };
  const menuItem = (icon: IconName, title: string, description: string, action: () => void, disabled = false) => <button type="button" role="menuitem" disabled={disabled} onClick={() => { setMenuOpen(false); setError(''); action(); }}>
    <Icon name={icon} /><span><strong>{title}</strong><small>{description}</small></span>
  </button>;

  return <>
    <div className="project-status" title={project.name} aria-live="polite"><strong>{project.name}</strong><small>{project.dirty ? 'Unsaved changes' : project.activeId ? 'Saved in this browser' : 'Not saved yet'}</small></div>
    <div className="project-menu-wrap" ref={menuRef}>
      <Button variant="outline" size="sm" className="project-menu-trigger" aria-haspopup="menu" aria-expanded={menuOpen} disabled={!project.initialized}
        onClick={() => setMenuOpen(!menuOpen)}><Icon name="folder" />Project<Icon name="chevronDown" /></Button>
      {menuOpen && <div className="project-menu" role="menu" aria-label="Project actions">
        {menuItem('plus', 'New room', 'Start an empty room', () => { setName('Untitled room'); setShape('rectangle'); setDialog('new'); })}
        {menuItem('save', 'Save room', 'Save changes · Ctrl/Cmd+S', () => save())}
        {menuItem('copy', 'Save as', 'Keep a separate named copy', () => save(true))}
        {menuItem('folder', 'Open room', 'Choose a saved room', () => { try { roomProjects.refreshRooms(); setDialog('open'); } catch (failure) { setError(errorMessage(failure)); } })}
        <span className="project-menu-divider" role="separator" />
        {menuItem('download', 'Download room file', 'Keep a backup or move to another browser', download)}
        {menuItem('folder', 'Import room file', 'Open a Domus JSON backup', () => fileRef.current?.click())}
        {onExport && <><span className="project-menu-divider" role="separator" />{menuItem('cube', 'Export GLB', 'Download the complete 3D room', onExport, !canExport)}</>}
      </div>}
    </div>
    <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-label="Import Domus room file" onChange={async (event) => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      try {
        const imported = roomProjects.readFile(await file.text(), file.name.replace(/(?:\.domus)?\.json$/i, '').slice(0, 80) || 'Imported room');
        replace(() => roomProjects.importRoom(imported));
      } catch (failure) { setError(errorMessage(failure)); }
    }} />
    {dialog && <ProjectDialog title={dialog === 'new' ? 'New room' : dialog === 'save' ? asCopy ? 'Save room as' : 'Save room' : dialog === 'open' ? 'Open room' : dialog === 'delete' ? 'Delete saved room?' : 'Save your changes?'} onCancel={cancel}>
      {dialog === 'new' || dialog === 'save' ? <form onSubmit={(event) => {
        event.preventDefault(); setError('');
        if (dialog === 'new') { const roomName = name.trim(); if (!roomName) { setError('Enter a room name.'); return; } replace(() => roomProjects.newRoom(roomName, shape)); }
        else { try { roomProjects.save(name, asCopy); setNotice('Room saved in this browser'); finishPending(); } catch (failure) { setError(errorMessage(failure)); } }
      }}>
        <p>{dialog === 'new' ? 'Choose a name and starting shape. Adjust dimensions in the 2D builder.' : 'Named rooms are stored in this browser. Download a room file for a portable backup.'}</p>
        <label className="project-field">Room name<input data-project-focus autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Living room" /></label>
        {dialog === 'new' && <label className="project-field">Starting shape<select value={shape} onChange={(event) => setShape(event.target.value as typeof shape)}>
          <option value="rectangle">Rectangle</option><option value="angled-corner">Angled corner</option><option value="l-shape">L shape</option><option value="recess">Recess</option>
        </select></label>}
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={cancel}>Cancel</Button><Button type="submit"><Icon name={dialog === 'new' ? 'plus' : 'save'} />{dialog === 'new' ? 'Create room' : 'Save room'}</Button></footer>
      </form> : dialog === 'open' ? <>
        <p>Rooms saved in this browser. Import a room file to open a backup.</p>
        <div className="saved-room-list">{project.rooms.length ? [...project.rooms].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((room) => <div key={room.id} className="saved-room-row">
          <button type="button" className="saved-room-select" onClick={() => replace(() => roomProjects.open(room.id))}>
            <Icon name="folder" /><span><strong>{room.name}</strong><small>{new Date(room.updatedAt).toLocaleString()}{room.id === project.activeId ? ' · Current room' : ''}</small></span><span className="saved-room-open">Open<Icon name="chevronRight" /></span>
          </button>
          <Button variant="ghost" size="icon" className="saved-room-delete" aria-label={`Delete ${room.name}`} title={`Delete ${room.name}`}
            onClick={() => { setDeleteTarget(room); setError(''); setDialog('delete'); }}><Icon name="trash" /></Button>
        </div>) : <div className="saved-room-empty"><Icon name="folder" /><strong>No saved rooms yet</strong><span>Use Save room to keep your first room.</span></div>}</div>
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={() => fileRef.current?.click()}>Import room file</Button><Button onClick={cancel}>Close</Button></footer>
      </> : dialog === 'delete' && deleteTarget ? <>
        <p>Delete <strong>{deleteTarget.name}</strong> from this browser's saved rooms? This cannot be undone.</p>
        {deleteTarget.id === project.activeId && <p>The room you're editing will stay open as an unsaved room.</p>}
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button data-project-focus variant="outline" onClick={cancel}>Cancel</Button><Button variant="destructive" onClick={() => {
          try {
            roomProjects.remove(deleteTarget.id, deleteTarget.revision);
            setDeleteTarget(null); setError(''); setDialog('open'); setNotice('Saved room deleted');
          } catch (failure) { setError(errorMessage(failure)); }
        }}><Icon name="trash" />Delete room</Button></footer>
      </> : <>
        <p><strong>{project.name}</strong> has unsaved changes. Save them before opening another room?</p>
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={cancel}>Cancel</Button><Button variant="secondary" onClick={() => { try { finishPending(); } catch (failure) { setError(errorMessage(failure)); } }}>Discard changes</Button><Button onClick={() => save()}>Save changes</Button></footer>
      </>}
    </ProjectDialog>}
    {!dialog && (error || project.warning) && <div className="project-warning" role="alert"><span>{error || project.warning}</span><Button variant="outline" size="sm" onClick={download}>Download room file</Button>{error && <Button variant="ghost" size="icon" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="x" /></Button>}</div>}
    {notice && <div className="toast" role="status"><Icon name="check" />{notice}</div>}
  </>;
}
