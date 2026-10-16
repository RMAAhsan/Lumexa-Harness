/**
 * The design phase: one structured call turns the plan into an art direction
 * (palette, type, shape, layout ideas per page). The harness then writes it
 * into the app as code (client/src/design/theme.css + Google Fonts in
 * index.html) and as a brief (docs/DESIGN.md) that every builder agent reads.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Google Fonts the designer may choose from, with the weights to load. */
export const FONTS: Record<string, string> = {
  Inter: 'wght@400;500;600;700;800',
  'DM Sans': 'wght@400;500;600;700',
  Manrope: 'wght@400;500;600;700;800',
  'Plus Jakarta Sans': 'wght@400;500;600;700;800',
  Outfit: 'wght@400;500;600;700;800',
  Sora: 'wght@400;500;600;700;800',
  'Space Grotesk': 'wght@400;500;600;700',
  'Bricolage Grotesque': 'wght@400;500;600;700;800',
  Syne: 'wght@500;600;700;800',
  Unbounded: 'wght@400;500;600;700;800',
  Archivo: 'wght@400;500;600;700;800',
  'Work Sans': 'wght@400;500;600;700',
  'Nunito Sans': 'wght@400;600;700;800',
  Fraunces: 'wght@400;500;600;700;800',
  'Playfair Display': 'wght@400;500;600;700;800',
  'DM Serif Display': 'wght@400',
  'Instrument Serif': 'wght@400',
  'Cormorant Garamond': 'wght@400;500;600;700',
};

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const RADIUS = { sharp: '0.375rem', soft: '0.875rem', round: '1.5rem' } as const;

export interface DesignSpec {
  brandName: string;
  tagline: string;
  direction: string;
  mood: string[];
  mode: 'light' | 'dark';
  fonts: { display: string; body: string };
  radius: keyof typeof RADIUS;
  palette: { primary: string[]; accent: string[]; ink: string[] };
  typography: string;
  layout: string;
  components: string;
  imagery: string;
  motion: string;
  pages: { route: string; composition: string }[];
}

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: str } as const;
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const fontEnum = { type: 'string', enum: Object.keys(FONTS) };

export const DESIGN_SCHEMA = obj({
  brandName: str,
  tagline: str,
  direction: str,
  mood: strArr,
  mode: { type: 'string', enum: ['light', 'dark'] },
  fonts: obj({ display: fontEnum, body: fontEnum }),
  radius: { type: 'string', enum: Object.keys(RADIUS) },
  palette: obj({ primary: strArr, accent: strArr, ink: strArr }),
  typography: str,
  layout: str,
  components: str,
  imagery: str,
  motion: str,
  pages: { type: 'array', items: obj({ route: str, composition: str }) },
});

const HEX = /^#?([0-9a-f]{6})$/i;

function rgb(hex: string): [number, number, number] {
  const h = HEX.exec(hex.trim())![1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t)) as [number, number, number];
}

/** 11-step scale: the model's own if it is 11 valid hex colors, else derived from its middle color. */
export function toScale(colors: string[], fallbackBase: string): [number, number, number][] {
  const valid = colors.filter((c) => HEX.test(c.trim()));
  if (valid.length === 11) return valid.map(rgb);
  const base = rgb(valid[Math.floor(valid.length / 2)] ?? fallbackBase);
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  const tints = [0.95, 0.88, 0.75, 0.55, 0.3];
  const shades = [0.15, 0.32, 0.48, 0.62, 0.78];
  return [...tints.map((t) => mix(base, white, t)), base, ...shades.map((t) => mix(base, black, t))];
}

export function themeCss(spec: DesignSpec): string {
  const scales = {
    primary: toScale(spec.palette.primary, '#4f46e5'),
    accent: toScale(spec.palette.accent, '#ec4899'),
    ink: toScale(spec.palette.ink, '#64748b'),
  };
  const lines = [
    `/* Design tokens for ${spec.brandName}, written by the harness design phase. Direction: ${spec.direction.replace(/\*\//g, '').slice(0, 300)} */`,
    ':root {',
    `  --font-display: '${spec.fonts.display}';`,
    `  --font-body: '${spec.fonts.body}';`,
    `  --radius: ${RADIUS[spec.radius] ?? RADIUS.soft};`,
  ];
  for (const [name, scale] of Object.entries(scales)) {
    lines.push(`  ${scale.map((c, i) => `--${name}-${STEPS[i]}: ${c.join(' ')};`).join(' ')}`);
  }
  if (spec.mode === 'dark') {
    lines.push('  --canvas: var(--ink-950);', '  --surface: var(--ink-900);', '  --fg: var(--ink-50);', '  --muted: var(--ink-400);', '  --line: var(--ink-800);');
  } else {
    lines.push('  --canvas: var(--ink-50);', '  --surface: 255 255 255;', '  --fg: var(--ink-900);', '  --muted: var(--ink-500);', '  --line: var(--ink-200);');
  }
  lines.push('}', '');
  return lines.join('\n');
}

export function fontLinks(spec: DesignSpec): string {
  const families = [...new Set([spec.fonts.display, spec.fonts.body])]
    .filter((f) => FONTS[f])
    .map((f) => `family=${f.replace(/ /g, '+')}:${FONTS[f]}`)
    .join('&');
  return [
    '<!-- harness:fonts -->',
    '    <link rel="preconnect" href="https://fonts.googleapis.com" />',
    '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
    `    <link href="https://fonts.googleapis.com/css2?${families}&display=swap" rel="stylesheet" />`,
    '    <!-- /harness:fonts -->',
  ].join('\n');
}

/** The brief every builder agent receives. */
export function designDoc(spec: DesignSpec): string {
  const scale = (name: string, colors: string[]) => `${name}: ${colors.filter((c) => HEX.test(c.trim())).join(' ')}`;
  return `# Design brief: ${spec.brandName}

> ${spec.tagline}

**Direction.** ${spec.direction}

**Mood:** ${spec.mood.join(', ')} · **Mode:** ${spec.mode} · **Corners:** ${spec.radius}

**Type.** Headings: ${spec.fonts.display} (font-display). Body: ${spec.fonts.body} (font-sans). ${spec.typography}

**Palette** (Tailwind: primary-*, accent-*, ink-*; semantic: bg-canvas, bg-surface, text-fg, text-muted, border-line)
- ${scale('primary', spec.palette.primary)}
- ${scale('accent', spec.palette.accent)}
- ${scale('ink', spec.palette.ink)}

**Layout.** ${spec.layout}

**Components.** ${spec.components}

**Imagery.** ${spec.imagery}

**Motion.** ${spec.motion}

## Pages
${spec.pages.map((p) => `- \`${p.route}\`: ${p.composition}`).join('\n')}
`;
}

export function checkDesign(spec: DesignSpec): void {
  if (!FONTS[spec.fonts.display]) spec.fonts.display = 'Inter';
  if (!FONTS[spec.fonts.body]) spec.fonts.body = 'Inter';
  if (!(spec.radius in RADIUS)) spec.radius = 'soft';
  if (spec.mode !== 'dark') spec.mode = 'light';
}

/** Write the design into the scaffolded website (client/). */
export function applyDesign(appDir: string, spec: DesignSpec): void {
  const client = path.join(appDir, 'client');
  if (!fs.existsSync(client)) return;
  fs.writeFileSync(path.join(client, 'src', 'design', 'theme.css'), themeCss(spec));
  const indexFile = path.join(client, 'index.html');
  const html = fs
    .readFileSync(indexFile, 'utf8')
    .replace(/<!-- harness:fonts -->[\s\S]*?<!-- \/harness:fonts -->/, fontLinks(spec))
    .replace(/<title>.*<\/title>/, `<title>${spec.brandName.replace(/[<>&]/g, '')}</title>`);
  fs.writeFileSync(indexFile, html);
  fs.mkdirSync(path.join(appDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'docs', 'DESIGN.md'), designDoc(spec));
}

// ---------------------------------------------------------------- mobile (React Native)

const toHex = (c: [number, number, number]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

export interface MobileFonts {
  display?: string;
  body?: string;
  bodyMedium?: string;
  bodySemibold?: string;
}

/** mobile/src/theme.js for the spec. Font names are the loaded @expo-google-fonts export names. */
export function themeJs(spec: DesignSpec, fonts: MobileFonts): string {
  const scales = {
    primary: toScale(spec.palette.primary, '#4f46e5').map(toHex),
    accent: toScale(spec.palette.accent, '#ec4899').map(toHex),
    ink: toScale(spec.palette.ink, '#64748b').map(toHex),
  };
  const dark = spec.mode === 'dark';
  const q = (v: string | undefined) => (v ? `'${v}'` : 'undefined');
  return `/** Design tokens for ${spec.brandName}, written by the harness design phase (see docs/DESIGN.md). */
const scale = (hex) => Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((s, i) => [s, hex[i]]));

const primary = scale(${JSON.stringify(scales.primary)});
const accent = scale(${JSON.stringify(scales.accent)});
const ink = scale(${JSON.stringify(scales.ink)});

export const theme = {
  mode: '${dark ? 'dark' : 'light'}',
  colors: {
    primary,
    accent,
    ink,
    canvas: ink[${dark ? 950 : 50}],
    surface: ${dark ? 'ink[900]' : "'#ffffff'"},
    fg: ink[${dark ? 50 : 900}],
    muted: ink[${dark ? 400 : 500}],
    line: ink[${dark ? 800 : 200}],
    onPrimary: '#ffffff',
    danger: '#dc2626',
    success: '#059669',
    warning: '#d97706',
  },
  fonts: { display: ${q(fonts.display)}, body: ${q(fonts.body)}, bodyMedium: ${q(fonts.bodyMedium)}, bodySemibold: ${q(fonts.bodySemibold)} },
  radius: ${{ sharp: 8, soft: 14, round: 22 }[spec.radius] ?? 14},
};

export const space = (n) => n * 4;
`;
}

/** Pick the closest available weight export, e.g. Fraunces_700Bold. */
export function pickWeight(exportsList: string[], family: string, prefer: string[]): string | undefined {
  const prefix = `${family.replace(/[^A-Za-z0-9]/g, '')}_`;
  for (const w of prefer) {
    const hit = exportsList.find((e) => e === `${prefix}${w}`);
    if (hit) return hit;
  }
  return exportsList.find((e) => e.startsWith(prefix) && !e.includes('Italic'));
}

export const fontPackage = (family: string) => `@expo-google-fonts/${family.toLowerCase().replace(/\s+/g, '-')}`;

/** mobile/src/fonts.js: import each chosen font file so useFonts() loads it. */
export function fontsJs(fonts: MobileFonts, families: { display: string; body: string }): string {
  const byPkg = new Map<string, Set<string>>();
  const add = (family: string, name?: string) => {
    if (!name) return;
    const pkg = fontPackage(family);
    if (!byPkg.has(pkg)) byPkg.set(pkg, new Set());
    byPkg.get(pkg)!.add(name);
  };
  add(families.display, fonts.display);
  add(families.body, fonts.body);
  add(families.body, fonts.bodyMedium);
  add(families.body, fonts.bodySemibold);
  const imports = [...byPkg].map(([pkg, names]) => `import { ${[...names].sort().join(', ')} } from '${pkg}';`);
  const all = [...byPkg.values()].flatMap((n) => [...n]).sort();
  return `/** Font files to load at startup (written by the harness design phase). */\n${imports.join('\n')}\n\nexport const fontAssets = { ${all.join(', ')} };\n`;
}

export function applyMobileTheme(appDir: string, spec: DesignSpec, fonts: MobileFonts): void {
  const mobile = path.join(appDir, 'mobile');
  fs.writeFileSync(path.join(mobile, 'src', 'theme.js'), themeJs(spec, fonts));
  const hasFonts = Object.values(fonts).some(Boolean);
  fs.writeFileSync(path.join(mobile, 'src', 'fonts.js'), hasFonts ? fontsJs(fonts, spec.fonts) : '/** System fonts (the brand fonts could not be installed). */\nexport const fontAssets = {};\n');
  fs.mkdirSync(path.join(appDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'docs', 'DESIGN.md'), designDoc(spec));
}
