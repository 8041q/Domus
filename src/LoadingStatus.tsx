import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from './ui';

/** Shared feedback for background work and workspace-blocking preparation. */
export function LoadingStatus({ active = true, label, detail, progress, blocking = false, error = false, action, className }: {
  active?: boolean;
  label: string;
  detail?: string;
  progress?: { completed: number; total: number; unit?: string };
  blocking?: boolean;
  error?: boolean;
  action?: ReactNode;
  className?: string;
}) {
  const [visible, setVisible] = useState(active && error);
  const [leaving, setLeaving] = useState(false);
  const lastMessage = useRef({ label, detail, progress, error, action });
  if (active) lastMessage.current = { label, detail, progress, error, action };
  const message = lastMessage.current;
  useEffect(() => {
    if (active) {
      setLeaving(false);
      const timer = setTimeout(() => setVisible(true), error ? 0 : 180);
      return () => clearTimeout(timer);
    }
    setLeaving(true);
    const timer = setTimeout(() => setVisible(false), 160);
    return () => clearTimeout(timer);
  }, [active, error]);

  if (!visible && !(blocking && active)) return null;
  const counted = message.progress && message.progress.total > 1;
  const completed = counted ? Math.max(0, Math.min(message.progress!.completed, message.progress!.total)) : 0;
  return (
    <div className={cn('loading-status', blocking && 'loading-status-blocking', leaving && 'is-leaving', !visible && 'is-pending', className)}
      aria-busy={active && !error}>
      {visible && <div className={cn('loading-status-card', message.error && 'is-error')} role={message.error ? 'alert' : 'status'} aria-atomic="true">
        <span className={cn('loading-status-symbol', !message.error && 'loading-status-spinner')} aria-hidden="true">{message.error ? '!' : null}</span>
        <div className="loading-status-copy">
          <strong>{message.label}</strong>
          {(message.detail || counted) && <span>{message.detail}{message.detail && counted ? ' · ' : ''}{counted ? `${completed} of ${message.progress!.total} ${message.progress!.unit ?? 'items'} ready` : ''}</span>}
          {counted && !message.error && <div className="loading-status-track" aria-hidden="true"><i style={{ width: `${completed / message.progress!.total * 100}%` }} /></div>}
        </div>
        {message.action && <div className="loading-status-action">{message.action}</div>}
      </div>}
    </div>
  );
}
