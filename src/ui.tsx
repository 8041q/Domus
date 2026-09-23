import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, SVGProps } from 'react';

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
type ButtonSize = 'default' | 'sm' | 'icon';

export function Button({
  className,
  variant = 'default',
  size = 'default',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={cn('ui-button', `ui-button-${variant}`, `ui-button-${size}`, className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ui-card', className)} {...props} />;
}

export function Badge({ className, children, tone = 'default', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: 'default' | 'muted' | 'outline' }) {
  return <span className={cn('ui-badge', `ui-badge-${tone}`, className)} {...props}>{children}</span>;
}

export function Separator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="separator" className={cn('ui-separator', className)} {...props} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  };
  const paths: Record<IconName, ReactNode> = {
    undo: <><path d="M9 7H5v-4"/><path d="M5 7c2.2-2.5 5-3.7 8-3.2 4 .7 6.9 4.4 6.4 8.5-.5 4-3.9 7.1-8 7.1-3.1 0-5.8-1.6-7.3-4"/></>,
    redo: <><path d="M15 7h4v-4"/><path d="M19 7c-2.2-2.5-5-3.7-8-3.2-4 .7-6.9 4.4-6.4 8.5.5 4 3.9 7.1 8 7.1 3.1 0 5.8-1.6 7.3-4"/></>,
    save: <><path d="M5 4h12l2 2v14H5z"/><path d="M8 4v6h8V4"/><path d="M8 20v-6h8v6"/></>,
    folder: <><path d="M3 6h7l2 2h9v10H3z"/></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
    search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.5 1a7 7 0 0 0-1.7-1L14.4 3h-4.8L9 6a7 7 0 0 0-1.7 1L4.8 6 2.8 9.4 5 11a7 7 0 0 0 0 2l-2.2 1.6 2 3.4 2.5-1a7 7 0 0 0 1.7 1l.6 3h4.8l.6-3a7 7 0 0 0 1.7-1l2.5 1 2-3.4-2.2-1.6c.1-.3.1-.7.1-1z"/></>,
    palette: <><path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4h-1a1.5 1.5 0 0 1 0-3H15a6 6 0 0 0 0-12z"/><circle cx="7.5" cy="10" r=".8" fill="currentColor" stroke="none"/><circle cx="10" cy="6.8" r=".8" fill="currentColor" stroke="none"/><circle cx="14" cy="6.8" r=".8" fill="currentColor" stroke="none"/><circle cx="17" cy="10" r=".8" fill="currentColor" stroke="none"/></>,
    ruler: <><path d="M4 15 15 4l5 5L9 20H4z"/><path d="m13 6 2 2M10 9l2 2M7 12l2 2"/></>,
    cube: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    x: <><path d="m6 6 12 12M18 6 6 18"/></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
    rotateLeft: <><path d="M7 7H3V3"/><path d="M3 7a9 9 0 1 1 1.8 9"/></>,
    rotateRight: <><path d="M17 7h4V3"/><path d="M21 7a9 9 0 1 0-1.8 9"/></>,
    chevronRight: <><path d="m9 6 6 6-6 6"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    arrowLeft: <><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></>,
    eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.5"/></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
    box: <><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16"/></>
  };
  return <svg {...common} {...props}>{paths[name]}</svg>;
}

export type IconName =
  | 'undo' | 'redo' | 'save' | 'folder' | 'more' | 'search' | 'settings' | 'palette'
  | 'ruler' | 'cube' | 'plus' | 'x' | 'copy' | 'rotateLeft' | 'rotateRight'
  | 'chevronRight' | 'check' | 'arrowLeft' | 'eye' | 'grid' | 'box';
