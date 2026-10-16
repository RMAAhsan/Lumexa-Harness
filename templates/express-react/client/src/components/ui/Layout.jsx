import { motion } from 'framer-motion';
import { cn } from './cn.js';

/** Centered page-width wrapper. */
export function Container({ className, children }) {
  return <div className={cn('mx-auto w-full max-w-content px-5 sm:px-8', className)}>{children}</div>;
}

/** Vertical page section with optional eyebrow/title/subtitle header. */
export function Section({ eyebrow, title, subtitle, className, children, id }) {
  return (
    <section id={id} className={cn('py-16 sm:py-24', className)}>
      <Container>
        {(eyebrow || title || subtitle) && (
          <div className="mx-auto mb-12 max-w-2xl text-center">
            {eyebrow && <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-primary-600">{eyebrow}</p>}
            {title && <h2 className="text-3xl font-bold sm:text-4xl">{title}</h2>}
            {subtitle && <p className="mt-4 text-lg text-muted">{subtitle}</p>}
          </div>
        )}
        {children}
      </Container>
    </section>
  );
}

/** Title row for app pages (dashboards, lists, forms). */
export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-2 text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}

/** Fade-and-rise when scrolled into view. `delay` in seconds for staggering. */
export function Reveal({ delay = 0, className, children }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
