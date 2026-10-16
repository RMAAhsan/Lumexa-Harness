import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDesign, fontLinks, themeCss, toScale, type DesignSpec } from '../src/pipeline/design.js';

const spec = (overrides: Partial<DesignSpec> = {}): DesignSpec => ({
  brandName: 'Kite', tagline: 't', direction: 'd', mood: ['m'], mode: 'light',
  fonts: { display: 'Syne', body: 'DM Sans' }, radius: 'round',
  palette: { primary: [], accent: [], ink: [] },
  typography: '', layout: '', components: '', imagery: '', motion: '', pages: [], ...overrides,
});

test('a valid 11-color scale is used as given', () => {
  const s = toScale(['#000000', '#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#999999', '#aaaaaa'], '#ff0000');
  assert.deepEqual(s[5], [0x55, 0x55, 0x55]);
});

test('an invalid scale is derived from its middle color (tints lighter, shades darker)', () => {
  const s = toScale(['#0ea5e9', 'nope'], '#ff0000');
  assert.equal(s.length, 11);
  assert.deepEqual(s[5], [0x0e, 0xa5, 0xe9]);
  assert.ok(s[0].every((v, i) => v > s[5][i]) && s[10].every((v, i) => v < s[5][i]));
  assert.deepEqual(toScale([], '#ff0000')[5], [255, 0, 0]);
});

test('dark mode maps the semantic roles to the dark end of the ink scale', () => {
  const css = themeCss(spec({ mode: 'dark' }));
  assert.match(css, /--canvas: var\(--ink-950\);/);
  assert.match(css, /--fg: var\(--ink-50\);/);
  assert.match(css, /--radius: 1.5rem;/);
});

test('unknown fonts and radius fall back to safe defaults; font links load both families', () => {
  const s = spec({ fonts: { display: 'Comic Sans MS', body: 'DM Sans' }, radius: 'blobby' as never });
  checkDesign(s);
  assert.equal(s.fonts.display, 'Inter');
  assert.equal(s.radius, 'soft');
  assert.match(fontLinks(s), /family=Inter:wght@400;500;600;700;800&family=DM\+Sans:wght@400;500;600;700&display=swap/);
});
