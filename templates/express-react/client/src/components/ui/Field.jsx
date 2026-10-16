import { cn } from './cn.js';

const control =
  'w-full rounded-brand border border-line bg-surface px-3.5 py-2.5 text-sm text-fg placeholder:text-muted ' +
  'shadow-sm transition focus:border-primary-500 focus:outline-none focus:ring-4 focus:ring-primary-500/15 ' +
  'disabled:opacity-60';

function Wrap({ label, hint, error, children, className }) {
  return (
    <label className={cn('block space-y-1.5', className)}>
      {label && <span className="text-sm font-medium text-fg">{label}</span>}
      {children}
      {error ? <span className="block text-sm text-red-600">{error}</span> : hint ? <span className="block text-sm text-muted">{hint}</span> : null}
    </label>
  );
}

/** <Input label="Email" type="email" value={v} onChange={...} error={err} /> */
export function Input({ label, hint, error, className, ...props }) {
  return (
    <Wrap label={label} hint={hint} error={error} className={className}>
      <input className={cn(control, error && 'border-red-400')} {...props} />
    </Wrap>
  );
}

export function Textarea({ label, hint, error, className, rows = 4, ...props }) {
  return (
    <Wrap label={label} hint={hint} error={error} className={className}>
      <textarea rows={rows} className={cn(control, error && 'border-red-400')} {...props} />
    </Wrap>
  );
}

/** <Select label="Status" options={[{ value: 'open', label: 'Open' }]} ... /> */
export function Select({ label, hint, error, options = [], className, ...props }) {
  return (
    <Wrap label={label} hint={hint} error={error} className={className}>
      <select className={cn(control, 'pr-9', error && 'border-red-400')} {...props}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </Wrap>
  );
}
