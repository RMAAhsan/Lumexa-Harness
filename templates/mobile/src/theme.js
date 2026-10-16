/**
 * Design tokens. The harness's design phase rewrites this file for each app.
 *   colors.primary[600], colors.accent[500], colors.ink[100] ...  (scales 50..950)
 *   colors.canvas (screen bg) .surface (cards) .fg (text) .muted .line (borders)
 *   fonts.display (headings) .body .bodyMedium .bodySemibold  (undefined = system font)
 */
const scale = (hex) => Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((s, i) => [s, hex[i]]));

const primary = scale(['#eef2ff', '#e0e7ff', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81', '#1e1b4b']);
const accent = scale(['#fdf2f8', '#fce7f3', '#fbcfe8', '#f9a8d4', '#f472b6', '#ec4899', '#db2777', '#be185d', '#9d174d', '#831843', '#500724']);
const ink = scale(['#f8fafc', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#334155', '#1e293b', '#0f172a', '#020617']);

export const theme = {
  mode: 'light',
  colors: {
    primary,
    accent,
    ink,
    canvas: ink[50],
    surface: '#ffffff',
    fg: ink[900],
    muted: ink[500],
    line: ink[200],
    onPrimary: '#ffffff',
    danger: '#dc2626',
    success: '#059669',
    warning: '#d97706',
  },
  fonts: { display: undefined, body: undefined, bodyMedium: undefined, bodySemibold: undefined },
  radius: 14,
};

export const space = (n) => n * 4;
