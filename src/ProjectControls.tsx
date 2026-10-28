import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SavedRoom } from './core/roomProjects';
import type { RoomShapeKind } from './core/types';
import { roomProjects, useRoomProjects } from './roomProjects';
import { Button, Icon, type IconName } from './ui';
import { usePlannerStore } from './store';
import { lockLoadingInteraction } from './core/loadingInteraction';
import { MAX_CLIENT_CONTACTS, normalizeProjectDetails, PROJECT_DETAIL_FIELDS, PROJECT_STATUSES } from './core/projectDetails';
import { useCompactWorkspace, useMobileBack, useMobileWorkspace, type MobileSheetSize } from './mobileWorkspace';

type DialogKind = 'new' | 'save' | 'open' | 'guard' | 'delete' | 'details' | 'storage' | 'import';
function ProjectDialog({ title, onCancel, children, className = '' }: { title: string; onCancel: () => void; children: ReactNode; className?: string }) {
  const compact = useCompactWorkspace();
  useMobileBack(onCancel, compact);
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

export function ProjectControls({ canExport, onExport, onExportPdf }: { canExport: boolean; onExport?: () => Promise<void>; onExportPdf?: () => void }) {
  const compact = useCompactWorkspace();
  const project = useRoomProjects();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuSize, setMenuSize] = useState<MobileSheetSize>('half');
  useMobileBack(() => setMenuOpen(false), compact && menuOpen);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [name, setName] = useState('');
  const [shape, setShape] = useState<Exclude<RoomShapeKind, 'custom'>>('rectangle');
  const [asCopy, setAsCopy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedRoom | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importFromSaved, setImportFromSaved] = useState(false);
  const [details, setDetails] = useState(() => normalizeProjectDetails(null));
  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const contactListRef = useRef<HTMLDivElement>(null);
  const pendingContactFocus = useRef<number | null>(null);
  const pending = useRef<(() => void | Promise<void>) | null>(null);

  useLayoutEffect(() => {
    const index = pendingContactFocus.current;
    if (index === null) return;
    pendingContactFocus.current = null;
    if (index < 0) contactListRef.current?.querySelector<HTMLButtonElement>('.project-contact-add')?.focus();
    else contactListRef.current?.querySelectorAll('input')[index * 3]?.focus();
  }, [details.clientContacts?.length]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!menuOpen) return;
    const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])].filter(item => item.getClientRects().length > 0);
    items()[0]?.focus();
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); menuRef.current?.querySelector<HTMLButtonElement>('.project-menu-trigger')?.focus(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const choices = items(), current = choices.indexOf(document.activeElement as HTMLButtonElement);
      if (!choices.length) { setMenuSize('half'); requestAnimationFrame(() => items()[0]?.focus()); return; }
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
    if (!project.busy && !exporting) return;
    const root = document.querySelector<HTMLElement>('.app-shell');
    if (root) return lockLoadingInteraction(root);
  }, [project.busy, exporting]);

  const cancel = () => {
    if (dialog === 'delete') { setDeleteTarget(null); setDialog('open'); }
    else if (dialog === 'storage' || dialog === 'import' && importFromSaved) { setDialog('open'); }
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
    pending.current = async () => {
      await action();
      if (compact) {
        useMobileWorkspace.getState().setCornerId(null);
        useMobileWorkspace.getState().setTask('room');
      }
    };
    if (roomProjects.getState().dirty) { setError(''); setDialog('guard'); }
    else { void run(finishPending); }
  };
  const save = (copy = false) => {
    setMenuOpen(false); setError('');
    setName(copy ? `${roomProjects.getState().name} copy`.slice(0, 80) : roomProjects.getState().name);
    setAsCopy(copy); setDialog('save');
  };
  const downloadLayout = () => {
    const url = URL.createObjectURL(new Blob([roomProjects.exportFile()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${project.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'room'}.domus.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMenuOpen(false);
  };
  const download = async () => {
    if (exporting) return;
    setExporting(true);
    try { await run(async () => {
      if (onExport) await onExport();
      else {
        const { exportRoomDocument } = await import('./renderer/exportRoom');
        await exportRoomDocument(JSON.parse(roomProjects.exportFile()));
      }
    }); } finally { setExporting(false); }
  };
  const openImport = (fromSaved = false) => { setImportFromSaved(fromSaved); setError(''); setDialog('import'); };
  const bytes = (value: number) => value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
  const menuItem = (icon: IconName, title: string, description: string, action: () => void, disabled = false) => <button type="button" role="menuitem" disabled={disabled} onClick={() => { setMenuOpen(false); setError(''); action(); }}>
    <Icon name={icon} /><span><strong>{title}</strong><small>{description}</small></span>
  </button>;
  const menuContent = <>
    {menuItem('plus', 'New room', 'Choose a name and starting shape', () => { setName('Untitled room'); setShape('rectangle'); setDialog('new'); })}
    {menuItem('folder', 'Project details', 'Company, client and PDF information', () => {
      setDetails(normalizeProjectDetails(usePlannerStore.getState().room.projectDetails)); setDialog('details');
    })}
    {menuItem('save', 'Save', 'Save in this browser · Ctrl/Cmd+S', () => save())}
    {menuItem('folder', 'Open saved room', 'Rooms saved in this browser', () => { void run(async () => { await roomProjects.refreshRooms(); setDialog('open'); }); })}
    <span className="project-menu-divider" role="separator" />
    {menuItem('download', 'Export room', 'GLB · reopen in Domus or other 3D software', () => { void download(); })}

    {menuItem('folder', 'Import room', 'Domus .glb or older .domus / .json files', () => openImport())}
    {onExportPdf && menuItem('download', 'Export to PDF', 'Project summary, furniture and five room views', onExportPdf, !canExport)}
  </>;

  return <>
    <div className="project-status" title={project.name} aria-live="polite"><strong>{project.name}</strong><small>{project.dirty ? 'Unsaved changes' : project.activeId ? 'Saved in this browser' : 'Not saved yet'}</small></div>
    <div className="project-menu-wrap" ref={menuRef}>
      <Button variant="outline" size="sm" className="project-menu-trigger" aria-haspopup="menu" aria-expanded={menuOpen} disabled={!project.initialized}
        onClick={() => { if (!menuOpen) setMenuSize('half'); setMenuOpen(!menuOpen); }}><Icon name="folder" />Project<Icon name="chevronDown" /></Button>
      {menuOpen && (compact ? <section className="project-menu mobile-project-sheet" data-size={menuSize} aria-label="Project tools">
        <header className="mobile-project-heading">
          <button type="button" className="mobile-project-handle" aria-label={`${menuSize === 'expanded' ? 'Collapse' : 'Expand'} Project tools`} aria-expanded={menuSize !== 'peek'}
            onClick={() => setMenuSize(menuSize === 'peek' ? 'half' : menuSize === 'half' ? 'expanded' : 'peek')}>
            <span className="mobile-sheet-grip" /><strong>Project</strong><small>{menuSize === 'peek' ? 'Tap for project actions' : 'Tap to resize'}</small>
          </button>
          <button type="button" className="mobile-project-close" aria-label="Close Project tools" onClick={() => setMenuOpen(false)}><Icon name="x" /></button>
        </header>
        <div className="mobile-project-body" role="menu" aria-label="Project actions" hidden={menuSize === 'peek'}>{menuContent}</div>
      </section> : <div className="project-menu" role="menu" aria-label="Project actions">{menuContent}</div>)}
    </div>
    <input ref={fileRef} type="file" accept=".glb,.domus,.json,model/gltf-binary,application/json,application/zip" hidden aria-label="Import Domus draft" onChange={async (event) => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      try {
        const imported = await roomProjects.readFile(file);
        replace(() => roomProjects.importRoom(imported));
      } catch (failure) { setError(errorMessage(failure)); setDialog('import'); }
    }} />
    {dialog && <ProjectDialog className={dialog === 'details' ? 'project-details-dialog' : ''} title={dialog === 'import' ? 'Import room' : dialog === 'storage' ? 'Storage & recovery' : dialog === 'details' ? 'Project details' : dialog === 'new' ? 'New room' : dialog === 'save' ? 'Save' : dialog === 'open' ? 'Open saved room' : dialog === 'delete' ? 'Delete saved room?' : 'Save your changes?'} onCancel={cancel}>
      {project.busy && <p role="status">{project.busy}</p>}
      {dialog === 'import' ? <>
        <p className="project-import-intro">Choose a room file exported from Domus.</p>
        <dl className="project-import-formats">
          <div><dt>Domus room <span>.glb</span></dt><dd>Editable room with architecture and furniture references.</dd></div>
          <div><dt>Older room files <span>.domus · .json</span></dt><dd>Room files saved by previous versions of Domus.</dd></div>
        </dl>
        <p className="project-import-note">A regular GLB model cannot be imported as a room. It must contain Domus room data. Your current room stays open if a file is rejected.</p>
        <p className="project-import-connection">An internet connection is needed to retrieve furniture.</p>
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={cancel}>Cancel</Button><Button data-project-focus onClick={() => fileRef.current?.click()}><Icon name="folder" />Choose room file</Button></footer>
      </> : dialog === 'storage' ? <>
        <p>Manage data kept in this browser and recover work from other tabs. Use Export room in Project to keep a portable backup.</p>
        <dl className="project-storage"><dt>Browser storage used</dt><dd>{bytes(project.storageBytes)}</dd>
          {project.storageQuota > 0 && <><dt>Browser storage allowance</dt><dd>{bytes(project.storageQuota)}</dd></>}
          <dt>Older model data</dt><dd>{bytes(project.assetBytes)}</dd></dl>
        <p>Clearing browser data removes local saves. Keep a portable room file as a backup.</p>
        {project.recoveries.length > 0 && <><h3>Recovery drafts from other tabs</h3>{project.recoveries.map(draft => <div key={draft.id} className="project-recovery-row"><Button variant="outline" onClick={() => replace(() => roomProjects.restoreDraft(draft.id))}>Recover {draft.document.name}</Button>
          <Button variant="ghost" aria-label={`Discard recovery for ${draft.document.name}`} onClick={() => {
            if (window.confirm(`Discard the recovery draft for ${draft.document.name}? This cannot be undone.`)) void run(() => roomProjects.discardRecovery(draft.id, draft.updatedAt));
          }}>Discard</Button></div>)}</>}
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={() => { void run(() => roomProjects.cleanUnusedAssets()); }}>Remove unused model data</Button><Button onClick={cancel}>Back to saved rooms</Button></footer>
      </> : dialog === 'details' ? <form onSubmit={(event) => {
        event.preventDefault(); setError('');
        try { usePlannerStore.getState().updateProjectDetails(details);
          setDialog(null); setNotice('Project details updated. Use Save to keep your changes.');
        } catch (failure) { setError(errorMessage(failure)); }
      }}>
        <p className="project-details-intro">Optional information for saved rooms and PDF reports.</p>
        <div className="project-details-sections">
        {[
          { title: 'Project', keys: ['reference', 'revision', 'status', 'preparedBy'] },
          { title: 'Room', keys: ['roomPurpose', 'location'] },
          { title: 'Company & client', keys: ['company', 'companyContact', 'client'] },
          { title: 'Notes', keys: ['notes'] },
        ].map(section => <fieldset className="project-details-section" key={section.title}>
          <legend className={section.title === 'Notes' ? 'project-notes-legend' : undefined}>{section.title}</legend>
          <div className="project-details-grid">
          {PROJECT_DETAIL_FIELDS.filter(field => section.keys.includes(field.key)).sort((a, b) => section.keys.indexOf(a.key) - section.keys.indexOf(b.key)).map((field) => <label key={field.key} className={`project-field ${field.key === 'notes' ? 'project-notes' : field.key === 'client' ? 'project-client-field' : ''}`}>{field.label}
            {field.key === 'status' ? <select value={details.status ?? ''} onChange={(event) => setDetails({ ...details, status: event.target.value })}>
              {PROJECT_STATUSES.map((status) => <option key={status} value={status}>{status || 'Not set'}</option>)}
            </select> : field.key === 'notes' ? <textarea rows={3} maxLength={field.maxLength} value={details[field.key]}
              onChange={(event) => setDetails({ ...details, [field.key]: event.target.value })} /> :
              <input data-project-focus={field.key === 'reference' ? true : undefined} maxLength={field.maxLength} placeholder={field.key === 'client' ? 'Company or individual' : undefined}
                value={details[field.key]} onChange={(event) => setDetails({ ...details, [field.key]: event.target.value })} />}
          </label>)}
          </div>
          {section.title === 'Company & client' && <div className="project-client-contacts" ref={contactListRef}>
            <div className="project-contact-heading"><span>Client contacts</span><Button className="project-contact-add" variant="ghost" size="sm" disabled={(details.clientContacts?.length ?? 0) >= MAX_CLIENT_CONTACTS} onClick={() => {
              const count = details.clientContacts?.length ?? 0;
              pendingContactFocus.current = count;
              setDetails({ ...details, clientContacts: [...(details.clientContacts ?? []), { name: '', phone: '', email: '' }] });
            }}><Icon name="plus" />Add contact</Button></div>
            {(details.clientContacts ?? []).map((contact, index) => <div className="project-contact-row" role="group" aria-label={`Client contact ${index + 1}`} key={index}>
              {(['name', 'phone', 'email'] as const).map(key => <label className="project-field" key={key}>{key === 'name' ? 'Contact name' : key === 'phone' ? 'Phone' : 'Email'}
                <input type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'} maxLength={key === 'email' ? 254 : key === 'phone' ? 80 : 180} autoComplete="off"
                  value={contact[key]} onChange={event => setDetails({ ...details, clientContacts: details.clientContacts?.map((value, i) => i === index ? { ...value, [key]: event.target.value } : value) })} />
              </label>)}
              <Button className="project-contact-remove" variant="ghost" size="icon" aria-label={`Remove client contact ${index + 1}`} title="Remove contact" onClick={() => {
                pendingContactFocus.current = -1;
                setDetails({ ...details, clientContacts: details.clientContacts?.filter((_, i) => i !== index) });
              }}><span aria-hidden="true">−</span></Button>
            </div>)}
            {(details.clientContacts?.length ?? 0) >= MAX_CLIENT_CONTACTS && <p>Maximum {MAX_CLIENT_CONTACTS} contacts.</p>}
          </div>}
        </fieldset>)}
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
        {dialog === 'save' && <p>Saved in this browser on this device. To transfer it, use Export room.</p>}
        {dialog === 'new' && <label className="project-field">Starting shape<select value={shape} onChange={(event) => setShape(event.target.value as typeof shape)}>
          <option value="rectangle">Rectangle</option><option value="rounded-rectangle">Rounded rectangle</option><option value="circle">Circle</option><option value="angled-corner">Angled corner</option><option value="l-shape">L shape</option><option value="recess">Recess</option>
        </select></label>}
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer><Button variant="outline" onClick={cancel}>Cancel</Button><Button type="submit"><Icon name={dialog === 'new' ? 'plus' : 'save'} />{dialog === 'new' ? 'Create room' : 'Save'}</Button></footer>
      </form> : dialog === 'open' ? <>
        <p>Choose a room saved on this device, or import a room file from another device.</p>
        <div className="saved-room-list">{project.rooms.length ? [...project.rooms].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((room) => <div key={room.id} className="saved-room-row">
          <button type="button" className="saved-room-select" onClick={() => replace(() => roomProjects.open(room.id))}>
            <Icon name="folder" /><span><strong>{room.name}</strong><small>{new Date(room.updatedAt).toLocaleString()}{room.id === project.activeId ? ' · Current room' : ''}</small></span><span className="saved-room-open">Open<Icon name="chevronRight" /></span>
          </button>
          <Button variant="ghost" size="icon" className="saved-room-delete" aria-label={`Delete ${room.name}`} title={`Delete ${room.name}`}
            onClick={() => { setDeleteTarget(room); setError(''); setDialog('delete'); }}><Icon name="trash" /></Button>
        </div>) : <div className="saved-room-empty"><Icon name="folder" /><strong>No saved rooms yet</strong><span>Use Save to keep your first room.</span></div>}</div>
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer className="saved-room-footer"><Button variant="ghost" onClick={() => { setDialog('storage'); void run(() => roomProjects.storageInfo()); }}><Icon name="settings" />Storage & recovery</Button><Button variant="outline" onClick={() => openImport(true)}>Import room</Button><Button onClick={cancel}>Close</Button></footer>
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
    {!dialog && !menuOpen && (error || project.warning) && <div className="project-warning" role="alert"><span>{error || project.warning}</span><Button variant="outline" size="sm" onClick={downloadLayout}>Download layout</Button>{error && <Button variant="ghost" size="icon" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="x" /></Button>}</div>}
    {(project.busy || exporting) && <div className="project-progress loading-status" role="status" aria-live="polite">{project.busy || 'Preparing room file…'}</div>}
    {notice && <div className="toast" role="status"><Icon name="check" />{notice}</div>}
  </>;
}
