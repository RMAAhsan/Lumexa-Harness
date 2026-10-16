/**
 * Colors and fonts come from CSS variables in src/design/theme.css, which the
 * harness's design phase writes for each app. Use the semantic names in code:
 *   bg-canvas (page)  bg-surface (cards)  text-fg  text-muted  border-line
 *   primary-50..950  accent-50..950  ink-50..950 (neutral)
 *   font-display (headings)  font-sans (body)  rounded-brand
 */
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const scale = (name) => Object.fromEntries(STEPS.map((s) => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]));
const semantic = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: scale('primary'),
        accent: scale('accent'),
        ink: scale('ink'),
        canvas: semantic('canvas'),
        surface: semantic('surface'),
        fg: semantic('fg'),
        muted: semantic('muted'),
        line: semantic('line'),
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-serif', 'Georgia', 'serif'],
        sans: ['var(--font-body)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: { brand: 'var(--radius)' },
      boxShadow: {
        soft: '0 1px 2px rgb(15 23 42 / 0.04), 0 12px 32px -12px rgb(15 23 42 / 0.18)',
        lift: '0 2px 4px rgb(15 23 42 / 0.06), 0 24px 48px -16px rgb(15 23 42 / 0.28)',
        glow: '0 12px 40px -12px rgb(var(--primary-500) / 0.55)',
      },
      maxWidth: { content: '76rem' },
    },
  },
  plugins: [],
};
