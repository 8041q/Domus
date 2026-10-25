import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SavedRoom } from './core/roomProjects';
import type { RoomShapeKind } from './core/types';
import { roomProjects, useRoomProjects } from './roomProjects';
import { Button, Icon, type IconName } from './ui';
import { usePlannerStore } from './store';
import { lockLoadingInteraction } from './core/loadingInteraction';
import { normalizeProjectDetails, PROJECT_DETAIL_FIELDS, PROJECT_STATUSES } from './core/projectDetails';

type DialogKind = 'new' | 'save' | 'open' | 'guard' | 'delete' | 'details' | 'storage';
function ProjectDialog({ title, onCancel, children, className = '' }: { title: string; onCancel: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); (previousFocus?.isConnected ? previousFocus : document.querySelector<HTMLElement>('.project-menu-trigger'))?.focus(); };
  }, []);
  useEffect(() => {
    const dialog = ref.current;
    (dialog?.querySelector<HTMLElement>('[data-project-focus]') ?? dialog?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [title]);
  return <dialog ref={ref} className={`project-dialog ${className}`} aria-labelledby="project-dialog-title" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <header><h2 id="project-dialog-title">{title}</h2><Button variant="ghost" size="icon" aria-label="Close dialog" onClick={onCancel}><Icon name="x" /></Button></header>
    {children}
  </dialog>;
}
function errorMessage(error: unknown) {
  if (error instanceof DOMException) return 'Browser storage is unavailable or full. Download a draft to keep your work, or free storage and try again.';
  return error instanceof Error ? error.message : 'The action could not be completed. Your current room has been kept.';
}

export function ProjectControls({ canExport, onExport, onExportPdf }: { canExport: boolean; onExport?: () => void; onExportPdf?: () => void }) {
  const project = useRoomProjects();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [name, setName] = useState('');
  const [shape, setShape] = useState<Exclude<RoomShapeKind, 'custom'>>('rectangle');
  const [asCopy, setAsCopy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedRoom | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [details, setDetails] = useState(() => normalizeProjectDetails(null));
  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = useRef<(() => void | Promise<void>) | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!menuOpen) return;
    const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    items()[0]?.focus();
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); menuRef.current?.querySelector<HTMLButtonElement>('.project-menu-trigger')?.focus(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const choices = items(), current = choices.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      choices[index]?.focus();
    };
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

  const run = async (action: () => void | Promise<unknown>) => {
    try { await action(); } catch (failure) { setError(errorMessage(failure)); }
  };
  useEffect(() => {
    if (!project.busy) return;
    const root = document.querySelector<HTMLElement>('.app-shell');
    if (root) return lockLoadingInteraction(root);
  }, [project.busy]);

  const cancel = () => {
    if (dialog === 'delete') { setDeleteTarget(null); setDialog('open'); }
    else { pending.current = null; setDialog(null); }
    setError('');
  };
  const finishPending = async () => {
    await pending.current?.();
    pending.current = null;
    setDialog(null);
    setError('');
  };
  const replace = (action: () => void | Promise<void>) => {
    roomProjects.changed();
    pending.current = action;
    if (roomProjects.getState().dirty) { setError(''); setDialog('guard'); }
    else { void run(finishPending); }
  };
  const save = (copy = false) => {
    setMenuOpen(false); setError('');
    setName(copy ? `${roomProjects.getState().name} copy`.slice(0, 80) : roomProjects.getState().name);
    setAsCopy(copy); setDialog('save'); void run(() => roomProjects.inspect());
  };
  const downloadLayout = () => {
    const url = URL.createObjectURL(new Blob([roomProjects.exportFile()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${project.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'room'}.domus.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMenuOpen(false);
  };
  const download = async () => {
    await run(async () => {
      const blob = await roomProjects.exportArchive();
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `${project.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'room'}.domus`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000); setMenuOpen(false);
    });
  };
  const bytes = (value: number) => value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
  const menuItem = (icon: IconName, title: string, description: string, action: () => void, disabled = false) => <button type="button" role="menuitem" disabled={disabled} onClick={() => { setMenuOpen(false); setError(''); action(); }}>
    <Icon name={icon} /><span><strong>{title}</strong><small>{description}</small></span>
  </button>;

  return <>
    <div className="project-status" title={project.name} aria-live="polite"><strong>{project.name}</strong><small>{project.dirty ? 'Unsaved changes' : project.activeId ? 'Saved in this browser' : 'Not saved yet'}</small></div>
    <div className="project-menu-wrap" ref={menuRef}>
      <Button variant="outline" size="sm" className="project-menu-trigger" aria-haspopup="menu" aria-expanded={menuOpen} disabled={!project.initialized}
        onClick={() => setMenuOpen(!menuOpen)}><Icon name="folder" />Project<Icon name="chevronDown" /></Button>
      {menuOpen && <div className="project-menu" role="menu" aria-label="Project actions">
        {menuItem('plus', 'New room', 'Choose a name and starting shape', () => { setName('Untitled room'); setShape('rectangle'); setDialog('new'); })}
        {menuItem('folder', 'Project details', 'Company, client and PDF information', () => {
          setDetails(normalizeProjectDetails(usePlannerStore.getState().room.projectDetails)); setDialog('details');
        })}
        {menuItem('save', 'Save as', 'Save or name a copy · Ctrl/Cmd+S', () => save())}
        {menuItem('folder', 'Open room', 'Choose a saved room', () => { void run(async () => { await roomProjects.refreshRooms(); setDialog('open'); }); })}
        <span className="project-menu-divider" role="separator" />
        {menuItem('download', 'Download room', 'Editable backup with compact models', () => { setDialog('storage'); void run(() => roomProjects.inspect()); })}
        {menuItem('download', 'Download layout only', 'Small JSON file without model assets', downloadLayout)}
        {menuItem('folder', 'Room storage', 'Usage, recovery drafts and unused assets', () => { setDialog('storage'); void run(() => roomProjects.storageInfo()); })}
        {menuItem('folder', 'Import room', 'Open a Domus room or legacy layout', () => fileRef.current?.click())}
        {onExport && <><span className="project-menu-divider" role="separator" />{menuItem('cube', 'Export Room', 'Download the complete 3D room as GLB', onExport, !canExport)}</>}
        {onExportPdf && menuItem('download', 'Export to PDF', 'Project summary, furniture and five room views', onExportPdf, !canExport)}
      </div>}
    </div>
    <input ref={fileRef} type="file" accept=".domus,.json,application/json,application/zip" hidden aria-label="Import Domus draft" onChange={async (event) => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      try {
        const imported = await roomProjects.readFile(file);
        replace(() => roomProjects.importRoom(imported));
      } catch (failure) { setError(errorMessage(failure)); }
    }} />
    {dialog && <ProjectDialog className={dialog === 'details' ? 'project-details-dialog' : ''} title={dialog === 'storage' ? 'Room storage and backup' : dialog === 'details' ? 'Project details' : dialog === 'new' ? 'New room' : dialog === 'save' ? 'Save as' : dialog === 'open' ? 'Open room' : dialog === 'delete' ? 'Delete saved room?' : 'Save your changes?'} onCancel={cancel}>
      {project.busy && <p role="status">{project.busy}</p>}
      {dialog === 'storage' ? <>
        <p>Compact models are shared across saved rooms. Portable backups include each used model once.</p>
        <dl className="project-storage"><dt>Saved model assets</dt><dd>{bytes(project.assetBytes)}</dd><dt>Browser storage used</dt><dd>{bytes(project.storageBytes)}</dd>
          {project.storageQuota > 0 && <><dt>Browser storage allowance</dt><dd>{bytes(project.storageQuota)}</dd></>}
          <dt>Additional model storage for this room</dt><dd>{bytes(project.additionalBytes)}</dd><dt>Portable room estimate</dt><dd>{bytes(project.packageBytes)}</dd></dl>
        <p>Clearing browser data removes local saves. Keep a portable room file as a backup.</p>
        {project.recoveries.length > 0 && <><h3>Recovery drafts from other tabs</h3>{project.recoveries.map(draft => <div key={draft.id} className="project-recovery-row"><Button variant="outline" onClick={() => replace(() => roomProjects.restoreDraft(draft.id))}>Recover {draft.document.name}</Button>
          <Button variant="ghost" aria-label={`Discard recovery for ${draft.document.name}`} onClick={() => {
            if (window.confirm(`Discard the recovery draft for ${draft.document.name}? This cannot be undone.`)) void run(() => roomProjects.discardRecovery(draft.id, draft.updatedAt));
          }}>Discard</Button></div>)}</>}
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={() => { void run(() => roomProjects.cleanUnusedAssets()); }}>Clean unused models</Button><Button variant="outline" onClick={cancel}>Close</Button><Button onClick={() => { void download(); }}>Download room</Button></footer>
      </> : dialog === 'details' ? <form onSubmit={(event) => {
        event.preventDefault(); setError('');
        try { usePlannerStore.getState().updateProjectDetails(details);
          setDialog(null); setNotice('Project details updated. Use Save as to save the room.');
        } catch (failure) { setError(errorMessage(failure)); }
      }}>
        <p>Optional details included in the shared PDF and saved with this room.</p>
        <div className="project-details-grid">
          {PROJECT_DETAIL_FIELDS.map((field) => <label key={field.key} className={`project-field ${field.key === 'notes' ? 'project-notes' : ''}`}>{field.label}
            {field.key === 'status' ? <select value={details.status ?? ''} onChange={(event) => setDetails({ ...details, status: event.target.value })}>
              {PROJECT_STATUSES.map((status) => <option key={status} value={status}>{status || 'Not set'}</option>)}
            </select> : field.key === 'notes' ? <textarea rows={3} maxLength={field.maxLength} value={details[field.key]}
              onChange={(event) => setDetails({ ...details, [field.key]: event.target.value })} /> :
              <input data-project-focus={field.key === 'company' ? true : undefined} maxLength={field.maxLength}
                value={details[field.key]} onChange={(event) => setDetails({ ...details, [field.key]: event.target.value })} />}
          </label>)}
        </div>
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={cancel}>Cancel</Button><Button type="submit">Apply details</Button></footer>
      </form> : dialog === 'new' || dialog === 'save' ? <form onSubmit={(event) => {
        event.preventDefault(); setError('');
        if (dialog === 'new') { const roomName = name.trim(); if (!roomName) { setError('Enter a room name.'); return; } replace(() => roomProjects.newRoom(roomName, shape)); }
        else { void run(async () => { await roomProjects.save(name, asCopy || name.trim() !== roomProjects.getState().name); setNotice('Room saved in this browser'); await finishPending(); }); }
      }}>
        <p>{dialog === 'new' ? 'Choose a name and starting shape. Adjust dimensions in the 2D builder.' : 'Keep the current name to update this room, or choose a new name to save a separate copy.'}</p>
        <label className="project-field">Room name<input data-project-focus autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Living room" /></label>
        {dialog === 'save' && <p>Compact model assets: {bytes(project.additionalBytes)} additional storage · Portable room: approximately {bytes(project.packageBytes)}.</p>}
        {dialog === 'new' && <label className="project-field">Starting shape<select value={shape} onChange={(event) => setShape(event.target.value as typeof shape)}>
          <option value="rectangle">Rectangle</option><option value="rounded-rectangle">Rounded rectangle</option><option value="circle">Circle</option><option value="angled-corner">Angled corner</option><option value="l-shape">L shape</option><option value="recess">Recess</option>
        </select></label>}
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={cancel}>Cancel</Button><Button type="submit"><Icon name={dialog === 'new' ? 'plus' : 'save'} />{dialog === 'new' ? 'Create room' : 'Save as'}</Button></footer>
      </form> : dialog === 'open' ? <>
        <p>Rooms saved in this browser. Import a draft to open a backup.</p>
        <div className="saved-room-list">{project.rooms.length ? [...project.rooms].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((room) => <div key={room.id} className="saved-room-row">
          <button type="button" className="saved-room-select" onClick={() => replace(() => roomProjects.open(room.id))}>
            <Icon name="folder" /><span><strong>{room.name}</strong><small>{new Date(room.updatedAt).toLocaleString()}{room.id === project.activeId ? ' · Current room' : ''}</small></span><span className="saved-room-open">Open<Icon name="chevronRight" /></span>
          </button>
          <Button variant="ghost" size="icon" className="saved-room-delete" aria-label={`Delete ${room.name}`} title={`Delete ${room.name}`}
            onClick={() => { setDeleteTarget(room); setError(''); setDialog('delete'); }}><Icon name="trash" /></Button>
        </div>) : <div className="saved-room-empty"><Icon name="folder" /><strong>No saved rooms yet</strong><span>Use Save as to keep your first room.</span></div>}</div>
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={() => fileRef.current?.click()}>Import room</Button><Button onClick={cancel}>Close</Button></footer>
      </> : dialog === 'delete' && deleteTarget ? <>
        <p>Delete <strong>{deleteTarget.name}</strong> from this browser's saved rooms? This cannot be undone.</p>
        {deleteTarget.id === project.activeId && <p>The room you're editing will stay open as an unsaved room.</p>}
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button data-project-focus variant="outline" onClick={cancel}>Cancel</Button><Button variant="destructive" onClick={() => {
          void run(async () => {
            await roomProjects.remove(deleteTarget.id, deleteTarget.revision);
            setDeleteTarget(null); setError(''); setDialog('open'); setNotice('Saved room deleted');
          });
        }}><Icon name="trash" />Delete room</Button></footer>
      </> : <>
        <p><strong>{project.name}</strong> has unsaved changes. Save them before opening another room?</p>
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={cancel}>Cancel</Button><Button variant="secondary" onClick={() => { void run(finishPending); }}>Discard changes</Button><Button onClick={() => save()}>Save changes</Button></footer>
      </>}
    </ProjectDialog>}
    {!dialog && (error || project.warning) && <div className="project-warning" role="alert"><span>{error || project.warning}</span><Button variant="outline" size="sm" onClick={downloadLayout}>Download layout</Button>{error && <Button variant="ghost" size="icon" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="x" /></Button>}</div>}
    {project.busy && <div className="project-progress loading-status" role="status" aria-live="polite">{project.busy}</div>}
    {notice && <div className="toast" role="status"><Icon name="check" />{notice}</div>}
  </>;
}
