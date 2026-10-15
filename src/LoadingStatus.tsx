import { createContext, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './ui';
import { createLoadingCoordinator, type LoadingPhase, type LoadingTask } from './core/loadingCoordinator';
import { lockLoadingInteraction } from './core/loadingInteraction';

type Coordinator = ReturnType<typeof createLoadingCoordinator<ReactNode>>;
const LoadingContext = createContext<{ coordinator: Coordinator; setSurface: (surface: HTMLElement | null) => void } | null>(null);

export function LoadingProvider({ children }: { children: ReactNode }) {
  const coordinator = useMemo(() => createLoadingCoordinator<ReactNode>(), []);
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const context = useMemo(() => ({ coordinator, setSurface }), [coordinator]);
  useEffect(() => () => coordinator.dispose(), [coordinator]);
  const presenter = <LoadingPresenter coordinator={coordinator} />;
  return <LoadingContext.Provider value={context}>{children}{surface ? createPortal(presenter, surface) : presenter}</LoadingContext.Provider>;
}

/** The active work area owns positioning; every phase shares this one surface. */
export function useLoadingSurface() { return useContext(LoadingContext)?.setSurface; }

export function useCancelLoading() {
  const context = useContext(LoadingContext);
  useLayoutEffect(() => { context?.coordinator.clear(); }, [context]);
}

/** Reports an operation's actual lifetime. It does not own a popup or timer. */
export function LoadingStatus({ active = true, label, detail, progress, blocking = false, error = false, action, phase = 'view' }: Omit<LoadingTask<ReactNode>, 'phase'> & { active?: boolean; phase?: LoadingPhase }) {
  const context = useContext(LoadingContext);
  if (!context) throw new Error('Loading operations require a LoadingProvider.');
  const { coordinator } = context;
  const task = { phase, label, detail, progress, blocking, error, action };
  const latest = useRef(task);
  latest.current = task;
  const lease = useRef<ReturnType<Coordinator['start']> | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const current = coordinator.start(latest.current);
    lease.current = current;
    return () => { current.finish(); lease.current = null; };
  }, [active, coordinator]);
  useLayoutEffect(() => {
    lease.current?.update(latest.current);
  }, [coordinator, phase, label, detail, progress?.completed, progress?.total, progress?.unit, blocking, error, action]);
  return null;
}

function LoadingPresenter({ coordinator }: { coordinator: Coordinator }) {
  const state = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
  const message = state.message;
  const locked = state.visible && !message?.error;
  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>('.app-shell');
    if (locked && root) return lockLoadingInteraction(root);
  }, [locked]);
  if (!state.visible || !message) return null;
  const counted = message.progress && message.progress.total > 1;
  const completed = counted ? Math.max(0, Math.min(message.progress!.completed, message.progress!.total)) : 0;
  return <div className={cn('loading-status', locked && 'loading-status-blocking', state.leaving && 'is-leaving')}
    aria-busy={state.pending > 0}>
    <div className={cn('loading-status-card', message.error && 'is-error')} role={message.error ? 'alert' : 'status'} aria-atomic="true">
      <span className={cn('loading-status-symbol', !message.error && 'loading-status-spinner')} aria-hidden="true">{message.error ? '!' : null}</span>
      <div className="loading-status-copy">
        <strong>{message.label}</strong>
        {(message.detail || counted) && <span>{message.detail}{message.detail && counted ? ' · ' : ''}{counted ? `${completed} of ${message.progress!.total} ${message.progress!.unit ?? 'items'} ready` : ''}</span>}
        {counted && !message.error && <div className="loading-status-track" aria-hidden="true"><i style={{ width: `${completed / message.progress!.total * 100}%` }} /></div>}
      </div>
      {message.action && <div className="loading-status-action">{message.action}</div>}
    </div>
  </div>;
}

function PendingContent({ label, detail, phase }: { label: string; detail?: string; phase: LoadingPhase }) {
  return <LoadingStatus label={label} detail={detail} phase={phase} blocking={phase === 'view'} />;
}

/** Suspense reports only the module-load lifetime. Mounted views then report
 * scene preparation and asset work to the same coordinator. */
export function LoadingBoundary({ children, label, detail, phase = 'view' }: {
  children: ReactNode; label: string; detail?: string; phase?: LoadingPhase;
}) {
  return <Suspense fallback={<PendingContent label={label} detail={detail} phase={phase} />}>{children}</Suspense>;
}
