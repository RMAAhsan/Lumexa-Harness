/**
 * End-to-end run with scripted providers (no API calls, no cost). Everything
 * else is real: PostgreSQL in Docker, Prisma, npm install, tests, Vite build,
 * smoke test, Chromium screenshots, migrations and the final REPORT.md.
 * Includes a forced build failure the repair chain must fix, and a visual
 * review that scores low first and passes after a design fix.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { History } from '../src/brain/history.js';
import { Router } from '../src/brain/router.js';
import { loadConfig } from '../src/config.js';
import { Ledger } from '../src/cost/ledger.js';
import { Gateway } from '../src/llm/gateway.js';
import type { Plan } from '../src/pipeline/plan.js';
import { runHarness } from '../src/pipeline/run.js';
import { Steps } from '../src/pipeline/steps.js';
import type { VisualReview } from '../src/pipeline/visual.js';
import { renderReport } from '../src/report/report.js';
import { FILES_T1, notesRouter, ScriptedProvider, writes } from './fixtures.js';

const PLAN: Plan = {
  appName: 'Notes',
  platform: 'web',
  summary: 'Write and list short notes.',
  entities: [{ name: 'Note', fields: ['id', 'text', 'createdAt'] }],
  endpoints: [
    { method: 'GET', path: '/api/notes', auth: false, purpose: 'list notes' },
    { method: 'POST', path: '/api/notes', auth: false, purpose: 'create a note' },
  ],
  pages: [{ route: '/', name: 'Notes', purpose: 'list and add notes', surface: 'web' }],
  demoAccounts: [],
  tasks: [
    { id: 't1', title: 'Notes API', area: 'backend', difficulty: 'easy', instructions: 'Note model, router, seed, tests', acceptance: ['tests pass'] },
    { id: 't2', title: 'Notes page', area: 'frontend', difficulty: 'medium', instructions: 'notes page', acceptance: ['builds'] },
  ],
};

const VISUAL: VisualReview[] = [
  { score: 6, summary: 'Clean but generic.', strengths: ['Readable'], issues: [{ page: '/', severity: 'medium', problem: 'Headline is weak', fix: 'Use the brand tagline' }] },
  { score: 7, summary: 'Better: real imagery and a stronger headline.', strengths: ['Strong headline'], issues: [{ page: '/', severity: 'medium', problem: 'Add warmth', fix: 'Try a warmer headline' }] },
  // The second fix makes it worse: the harness must undo it and ship the 7/10 version.
  { score: 5, summary: 'Regressed: the headline lost its voice.', strengths: [], issues: [] },
];

const HOME = (headline: string) => `import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, Card, Container, Input, Reveal } from '../components/ui/index.js';

export default function Home() {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState('');
  useEffect(() => { api('/notes').then(setNotes); }, []);
  async function add(e) {
    e.preventDefault();
    const note = await api('/notes', { method: 'POST', body: { text } });
    setNotes([...notes, note]);
    setText('');
  }
  return (
    <Container className="py-20">
      <Reveal><h1 className="text-5xl font-bold">${headline}</h1></Reveal>
      <form onSubmit={add} className="mt-8 flex gap-3"><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a note" /><Button>Add</Button></form>
      <div className="mt-8 grid gap-4">{notes.map((n) => <Card key={n.id}>{n.text}</Card>)}</div>
    </Container>
  );
}
`;

test('full run: plan → design → scaffold+postgres → build → repair → review → visual QA → migrations → report', { timeout: 900_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2e-'));
  // Always free the ~1 GB of installed packages, pass or fail (KEEP_E2E=1 keeps it for inspection).
  t.after(() => (process.env.KEEP_E2E ? console.log(`[e2e] kept: ${tmp}`) : fs.rmSync(tmp, { recursive: true, force: true })));
  const runDir = path.join(tmp, 'run');
  const appDir = path.join(runDir, 'app');
  fs.mkdirSync(runDir, { recursive: true });

  const claude = new ScriptedProvider('anthropic', (_opts, msg) => {
    if (msg.includes('YOUR TASK: t1.')) return writes(FILES_T1);
    if (msg.includes('YOUR TASK: t2.')) return writes({ 'client/src/pages/Home.jsx': HOME('Your notes') });
    if (msg.includes('verification and it FAILED')) {
      return [{ id: 'fix', name: 'write_file', input: { path: 'server/src/routes/notes.js', content: notesRouter('../db.js', 1000) } }];
    }
    if (msg.includes('A code reviewer found these problems')) {
      return [{ id: 'e1', name: 'edit_file', input: { path: 'server/src/routes/notes.js', old_text: 'text.slice(0, 1000)', new_text: 'text.slice(0, 500)' } }];
    }
    if (msg.includes('A principal designer reviewed screenshots') && msg.includes('scored it 7/10')) {
      return [
        { id: 'g2', name: 'get_image', input: { query: 'A worse idea', kind: 'illustration', filename: 'bad-idea', aspect: 'square', variant: 1 } },
        { id: 'd2', name: 'edit_file', input: { path: 'client/src/pages/Home.jsx', old_text: 'Thoughts, kept beautifully.', new_text: 'Worse headline' } },
      ];
    }
    if (msg.includes('A principal designer reviewed screenshots')) {
      return [
        { id: 'g1', name: 'get_image', input: { query: 'Ink pen on warm paper, soft morning light', kind: 'illustration', filename: 'hero-ink', aspect: 'landscape', variant: 1 } },
        { id: 'd1', name: 'edit_file', input: { path: 'client/src/pages/Home.jsx', old_text: 'Your notes', new_text: 'Thoughts, kept beautifully.' } },
        { id: 's1', name: 'screenshot', input: { route: '/', viewport: 'desktop', as: 'visitor' } },
      ];
    }
    return [];
  }, { plan: PLAN, visual: VISUAL });
  const gpt = new ScriptedProvider('openai', () => [], { plan: PLAN, visual: VISUAL });

  const config = loadConfig({ ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test' });
  const ledger = new Ledger(config, 5, path.join(runDir, 'ledger.json'));
  const history = new History(path.join(tmp, 'history.jsonl'));
  const router = new Router(config, history);
  const steps = new Steps();
  const gateway = new Gateway(config, ledger, (p) => (p === 'anthropic' ? claude : gpt));
  const request = 'A tiny notes app.';

  const result = await runHarness({ config, gateway, router, history, ledger, steps, request, runDir, appDir, options: { review: true, visual: true } });
  assert.equal(result.status, 'verified', result.error ?? JSON.stringify(steps.list, null, 2));

  assert.deepEqual(
    steps.list.map((s) => `${s.phase}:${s.decision?.model ?? '-'}:${s.status}`),
    [
      'plan:claude-opus-5-5:passed',
      'design:claude-opus-5-5:passed',
      'scaffold:-:passed',
      'build:claude-haiku-5-5:failed',
      'repair:claude-haiku-5-5:passed',
      'build:claude-opus-5-5:passed',
      'review:gpt-6.1-sol:passed',
      'fix_review:claude-sonnet-5-5:passed',
      'visual_review:claude-opus-5-5:passed',
      'design_fix:claude-opus-5-5:passed',
      'visual_review:claude-opus-5-5:passed',
      'design_fix:claude-opus-5-5:passed',
      'visual_review:claude-opus-5-5:failed',
      'final_verify:-:passed',
      'finalize:-:passed',
    ],
  );

  // Design applied as code.
  const theme = fs.readFileSync(path.join(appDir, 'client/src/design/theme.css'), 'utf8');
  assert.match(theme, /--font-display: 'Fraunces'/);
  assert.match(theme, /--primary-500: 55 104 249;/);
  assert.equal((theme.match(/--accent-\d+:/g) ?? []).length, 11, 'accent scale derived from an invalid palette');
  assert.match(fs.readFileSync(path.join(appDir, 'client/index.html'), 'utf8'), /family=Fraunces:wght@400;500;600;700;800&family=Inter/);
  assert.match(fs.readFileSync(path.join(appDir, 'docs/DESIGN.md'), 'utf8'), /# Design brief: Inkwell/);
  assert.ok(claude.sessions.find((s) => s.firstMessage.includes('YOUR TASK: t2.'))!.firstMessage.includes('DESIGN BRIEF'));

  // Visual QA: real screenshots went to the vision model; 6 -> 7 kept, then 5 reverted.
  const visualCalls = claude.structuredCalls.filter((c) => c.name === 'visual_review');
  assert.equal(visualCalls.length, 3);
  assert.ok(visualCalls.every((c) => c.images === 2), JSON.stringify(visualCalls));
  assert.deepEqual(result.visual.map((r) => `${r.score}${r.reverted ? ' reverted' : ''}`), ['6', '7', '5 reverted']);
  // The fix agent saw the reviewed screenshots, its generated image and its own live screenshot.
  assert.ok(claude.imagesSeen.some((i) => i.where === 'message' && /Reviewed screenshot: \/, desktop/.test(i.label)), JSON.stringify(claude.imagesSeen));
  assert.ok(claude.imagesSeen.some((i) => i.where === 'tool' && /server\/public\/media\/hero-ink\.jpg/.test(i.label)));
  assert.ok(claude.imagesSeen.some((i) => i.where === 'tool' && i.label === '/ desktop'));
  assert.equal(gpt.generated.length, 2);
  // Kept: round-1 fix (image + headline). Undone: round-2 fix.
  assert.ok(fs.existsSync(path.join(appDir, 'server/public/media/hero-ink.jpg')));
  assert.ok(!fs.existsSync(path.join(appDir, 'server/public/media/bad-idea.jpg')), 'media from a reverted round is removed');
  assert.doesNotMatch(fs.readFileSync(path.join(appDir, 'server/public/media/CREDITS.md'), 'utf8'), /bad-idea/);
  assert.equal(ledger.entries.filter((e) => e.servedModel === 'gpt-image-2').length, 2);
  for (const shot of result.visual.flatMap((r) => r.shots)) {
    const file = path.join(runDir, shot.file);
    assert.ok(fs.statSync(file).size > 5000, `${shot.file} looks empty`);
  }
  assert.match(fs.readFileSync(path.join(appDir, 'client/src/pages/Home.jsx'), 'utf8'), /Thoughts, kept beautifully\./);

  // Database: real migrations that apply to a fresh database, and a .env for the user.
  assert.equal(result.migrations?.ok, true, result.migrations?.detail ?? 'no migrations result');
  assert.match(fs.readFileSync(path.join(appDir, 'server/prisma/migrations/0_init/migration.sql'), 'utf8'), /CREATE TABLE "Note"/);
  assert.ok(fs.existsSync(path.join(appDir, 'server/.env')));
  assert.match(fs.readFileSync(path.join(appDir, 'server/src/routes/notes.js'), 'utf8'), /slice\(0, 500\)/);

  // Cost + learning.
  assert.ok(ledger.entries.every((e) => e.costUsd !== null));
  const outcomes = History.parse(fs.readFileSync(path.join(tmp, 'history.jsonl'), 'utf8'));
  assert.deepEqual(outcomes.map((o) => `${o.phase}/${o.kind}/${o.passed}`), [
    'build/easy/false',
    'repair/attempt-1/true',
    'build/ui/true',
    'fix_review/fix_review/true',
    'design_fix/design_fix/true',
    'design_fix/design_fix/true',
  ]);

  const report = renderReport({ request, result, steps, ledger, config, runDir, appDir });
  fs.writeFileSync(path.join(runDir, 'REPORT.md'), report);
  for (const expected of [
    '✅ VERIFIED',
    '| Design score | **6/10** → **7/10** → ~~5/10~~ (fix reverted)',
    '⚠️ Design 7/10: below the 9/10 target',
    '## Media',
    'hero-ink.jpg: generated (gpt-image-2)',
    'PostgreSQL 16 + Prisma ORM · ✓',
    '## Design direction',
    '**Fraunces** (headings)',
    '## Visual QA',
    '![/ desktop](screenshots/r2-home-desktop.jpg)',
    '![/ mobile](screenshots/r2-home-mobile.jpg)',
    'npm run setup',
    '`claude-haiku-5-5`',
    '`gpt-6.1-sol`',
    'tests: 4 passed, 0 failed',
  ]) {
    assert.ok(report.includes(expected), `report is missing: ${expected}`);
  }
});
