/**
 * End-to-end run for a MOBILE plan with scripted providers (no API cost):
 * real Expo + React Native scaffold, brand fonts installed from
 * @expo-google-fonts, the app's web build verified and served by Express,
 * phone-size screenshots, Stripe simulated mode, migrations.
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
import { renderReport } from '../src/report/report.js';
import { FILES_T1, notesRouter, ScriptedProvider, writes } from './fixtures.js';

const PLAN: Plan = {
  appName: 'Pocket Notes',
  platform: 'mobile',
  summary: 'A notes app for iOS and Android.',
  entities: [{ name: 'Note', fields: ['id', 'text', 'createdAt'] }],
  endpoints: [
    { method: 'GET', path: '/api/notes', auth: false, purpose: 'list notes' },
    { method: 'POST', path: '/api/notes', auth: false, purpose: 'create a note' },
  ],
  pages: [{ route: '/', name: 'Notes', purpose: 'list and add notes', surface: 'mobile' }],
  demoAccounts: [],
  tasks: [
    { id: 't1', title: 'Notes API', area: 'backend', difficulty: 'medium', instructions: 'Note model, router, seed, tests', acceptance: ['tests pass'] },
    { id: 't2', title: 'Notes screen', area: 'frontend', difficulty: 'medium', instructions: 'notes tab', acceptance: ['builds'] },
  ],
};

const NOTES_SCREEN = `import { useEffect, useState } from 'react';
import { api } from '../../src/api.js';
import { Button, Card, Eyebrow, H1, Input, Muted, Screen, Stack } from '../../src/ui/index.js';

export default function NotesScreen() {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState('');
  useEffect(() => { api('/notes').then(setNotes).catch(() => {}); }, []);
  async function add() {
    const note = await api('/notes', { method: 'POST', body: { text } });
    setNotes([...notes, note]);
    setText('');
  }
  return (
    <Screen>
      <Stack gap={16}>
        <Eyebrow>Pocket Notes</Eyebrow>
        <H1>Thoughts, kept beautifully.</H1>
        <Input placeholder="Write a note" value={text} onChangeText={setText} />
        <Button onPress={add} block>Add note</Button>
        {notes.length === 0 ? <Muted>No notes yet.</Muted> : notes.map((n) => <Card key={n.id}><Muted>{n.text}</Muted></Card>)}
      </Stack>
    </Screen>
  );
}
`;

test('mobile run: Expo app scaffolded, themed, built, served, screenshotted', { timeout: 1_200_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2e-mobile-'));
  // Always free the ~1 GB of installed packages, pass or fail (KEEP_E2E=1 keeps it for inspection).
  t.after(() => (process.env.KEEP_E2E ? console.log(`[e2e] kept: ${tmp}`) : fs.rmSync(tmp, { recursive: true, force: true })));
  const runDir = path.join(tmp, 'run');
  const appDir = path.join(runDir, 'app');
  fs.mkdirSync(runDir, { recursive: true });
  const visual = [{ score: 9, summary: 'Native-feeling and on brief.', strengths: ['Clear hierarchy'], issues: [] }];

  const claude = new ScriptedProvider(
    'anthropic',
    (_opts, msg) => {
      if (msg.includes('YOUR TASK: t1.')) return writes({ ...FILES_T1, 'server/src/routes/notes.js': notesRouter('../db.js', 500) });
      if (msg.includes('YOUR TASK: t2.')) return writes({ 'mobile/app/(tabs)/index.js': NOTES_SCREEN });
      return [];
    },
    { plan: PLAN, visual },
  );
  const config = loadConfig({ ANTHROPIC_API_KEY: 'test' });
  const ledger = new Ledger(config, 5);
  const history = new History(path.join(tmp, 'history.jsonl'));
  const router = new Router(config, history);
  const steps = new Steps();
  const gateway = new Gateway(config, ledger, () => claude);

  const result = await runHarness({ config, gateway, router, history, ledger, steps, request: 'Notes app for iPhone and Android', runDir, appDir, options: { review: false, visual: true } });
  assert.equal(result.status, 'verified', result.error ?? JSON.stringify(steps.list, null, 2));

  // Platform: server + mobile, no website.
  assert.ok(fs.existsSync(path.join(appDir, 'mobile', 'app', '_layout.js')));
  assert.ok(!fs.existsSync(path.join(appDir, 'client')));
  const root = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  assert.deepEqual(root.workspaces, ['server', 'mobile']);
  const expo = JSON.parse(fs.readFileSync(path.join(appDir, 'mobile', 'app.json'), 'utf8')).expo;
  assert.equal(expo.name, 'Pocket Notes');
  assert.equal(expo.ios.bundleIdentifier, 'com.pocketnotes.app');
  assert.equal(expo.experiments.baseUrl, '');

  // Design: theme + real brand font files wired in.
  const theme = fs.readFileSync(path.join(appDir, 'mobile/src/theme.js'), 'utf8');
  assert.match(theme, /display: 'Fraunces_700Bold'/);
  assert.match(theme, /body: 'Inter_400Regular'/);
  assert.match(fs.readFileSync(path.join(appDir, 'mobile/src/fonts.js'), 'utf8'), /from '@expo-google-fonts\/fraunces'/);

  // Verification covered the mobile build and served the app's web build.
  const checks = result.finalVerification!.checks;
  assert.deepEqual(checks.map((c) => `${c.name}:${c.ok}`), ['server tests:true', 'mobile build:true', 'smoke:true']);
  assert.match(checks[2].output, /GET \/ -> 200 \(mobile app \(web build\)\)/);

  // Visual QA saw the app at phone size, with no browser errors.
  const shots = result.visual[0].shots;
  assert.deepEqual(shots.map((s) => `${s.route}:${s.viewport}`), ['/:mobile']);
  assert.deepEqual(result.visual[0].problems, []);
  assert.ok(fs.statSync(path.join(runDir, shots[0].file)).size > 10_000);

  const report = renderReport({ request: 'Notes app', result, steps, ledger, config, runDir, appDir });
  fs.writeFileSync(path.join(runDir, 'REPORT.md'), report);
  for (const expected of ['iOS + Android app (Expo + React Native)', 'npm run dev:mobile', 'Expo Go', 'mobile build ✓']) {
    assert.ok(report.includes(expected), `report is missing: ${expected}`);
  }
});
