import { cn } from './cn.js';

const TONES = {
  neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
  primary: 'bg-primary-50 text-primary-700 ring-primary-200',
  accent: 'bg-accent-50 text-accent-700 ring-accent-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
};

export function Badge({ tone = 'neutral', className, children }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', TONES[tone], className)}>
      {children}
    </span>
  );
}
