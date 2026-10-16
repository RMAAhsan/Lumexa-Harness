import { cn } from './cn.js';

/** Surface container. `interactive` adds a hover lift for clickable cards. */
export function Card({ className, interactive, padded = true, as: Tag = 'div', children, ...props }) {
  return (
    <Tag
      className={cn(
        'rounded-brand border border-line bg-surface shadow-soft',
        padded && 'p-6',
        interactive && 'transition-all duration-300 hover:-translate-y-1 hover:shadow-lift',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}
