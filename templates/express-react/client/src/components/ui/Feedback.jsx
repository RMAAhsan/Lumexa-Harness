import { Inbox, Loader2 } from 'lucide-react';
import { cn } from './cn.js';

export function Spinner({ className, label = 'Loading…' }) {
  return (
    <div className={cn('flex items-center justify-center gap-3 py-16 text-muted', className)} role="status">
      <Loader2 className="h-5 w-5 animate-spin text-primary-600" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

/** Placeholder block while data loads: <Skeleton className="h-40" /> */
export function Skeleton({ className }) {
  return <div className={cn('animate-pulse rounded-brand bg-ink-200/60', className)} />;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }) {
  return (
    <div className="flex flex-col items-center rounded-brand border border-dashed border-line bg-surface/60 px-6 py-14 text-center">
      <div className="mb-4 rounded-full bg-primary-50 p-3 text-primary-600">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return <div className="rounded-brand border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{children}</div>;
}
