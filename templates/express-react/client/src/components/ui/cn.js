/** Join class names, skipping falsy values: cn('a', cond && 'b'). */
export const cn = (...classes) => classes.filter(Boolean).join(' ');
