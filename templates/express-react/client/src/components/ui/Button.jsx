import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from './cn.js';

const VARIANTS = {
  primary: 'bg-primary-600 text-white shadow-glow hover:bg-primary-700 active:bg-primary-800',
  secondary: 'bg-surface text-fg border border-line shadow-soft hover:border-primary-300 hover:text-primary-700',
  ghost: 'text-fg hover:bg-ink-100',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  light: 'bg-white/90 text-ink-900 backdrop-blur hover:bg-white',
};
const SIZES = {
  sm: 'h-9 px-3.5 text-sm gap-1.5',
  md: 'h-11 px-5 text-sm gap-2',
  lg: 'h-12 px-7 text-base gap-2.5',
};

/**
 * <Button>Save</Button>  <Button variant="secondary" size="lg" to="/book">Book</Button>
 * <Button loading={saving} icon={Plus}>Add</Button>   (`to` renders a router Link)
 */
export function Button({ variant = 'primary', size = 'md', to, href, loading, icon: Icon, className, children, disabled, ...props }) {
  const classes = cn(
    'inline-flex items-center justify-center whitespace-nowrap rounded-brand font-semibold transition-all duration-200',
    'disabled:pointer-events-none disabled:opacity-60 hover:-translate-y-px active:translate-y-0',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
  const content = (
    <>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
      {children}
    </>
  );
  if (to) return <Link to={to} className={classes} {...props}>{content}</Link>;
  if (href) return <a href={href} className={classes} {...props}>{content}</a>;
  return <button className={classes} disabled={disabled || loading} {...props}>{content}</button>;
}
