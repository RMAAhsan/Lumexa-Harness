import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { History } from '../src/brain/history.js';
import { Router } from '../src/brain/router.js';
import { loadConfig, validateRouting } from '../src/config.js';
import { BudgetExceededError, Ledger, priceCall } from '../src/cost/ledger.js';
import { failureSignature, type Verification } from '../src/pipeline/verify.js';

const bothKeys = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };

test('build routes by difficulty from config/routing.json', () => {
  const r = new Router(loadConfig(bothKeys), new History());
  assert.equal(r.build('t1', 'easy').model, 'claude-haiku-5-5');
  assert.equal(r.build('t2', 'medium').model, 'claude-sonnet-5-5');
  assert.equal(r.build('t3', 'hard').model, 'claude-opus-5-5');
  assert.equal(r.plan().model, 'claude-opus-5-5');
  assert.equal(r.decisions.length, 4);
  assert.ok(r.decisions.every((d) => d.reasons.length >= 1));
});

test('UI tasks go to the build.ui model whatever their difficulty; backend tasks by difficulty', () => {
  const r = new Router(loadConfig(bothKeys), new History());
  assert.equal(r.build('t1', 'easy', 'frontend').model, 'claude-opus-5-5');
  assert.equal(r.build('t2', 'easy', 'fullstack').model, 'claude-opus-5-5');
  assert.equal(r.build('t3', 'easy', 'backend').model, 'claude-haiku-5-5');
  assert.match(r.decisions[0].reasons[0], /9\/10/);
});

test('review goes to OpenAI when its key is present, falls back to Claude when not', () => {
  const withOpenAI = new Router(loadConfig(bothKeys), new History()).review();
  assert.equal(withOpenAI.model, 'gpt-6.1-sol');
  assert.equal(withOpenAI.provider, 'openai');

  const claudeOnly = new Router(loadConfig({ ANTHROPIC_API_KEY: 'a' }), new History()).review();
  assert.equal(claudeOnly.model, 'claude-sonnet-5-5');
  assert.match(claudeOnly.reasons.at(-1)!, /no OPENAI key/);
});

test('without an Anthropic key, Claude phases move to the closest-tier OpenAI model', () => {
  const r = new Router(loadConfig({ OPENAI_API_KEY: 'o' }), new History());
  assert.equal(r.plan().provider, 'openai');
  assert.equal(r.build('t1', 'easy').model, 'gpt-4o-mini');
});

test('learning: a model that keeps failing a kind of task is stepped up', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'history.jsonl');
  const h = new History(file);
  for (let i = 0; i < 4; i++) h.record({ phase: 'build', kind: 'easy', model: 'claude-haiku-5-5', passed: i === 0 });
  // Reload from disk: learning survives across runs.
  const r = new Router(loadConfig(bothKeys), new History(file));
  const d = r.build('t1', 'easy');
  assert.equal(d.model, 'claude-sonnet-5-5');
  assert.match(d.reasons.at(-1)!, /learned: claude-haiku-5-5 passed 1\/4/);
  // A different difficulty is unaffected.
  assert.equal(r.build('t2', 'medium').model, 'claude-sonnet-5-5');
});

test('learning needs minSamples before acting', () => {
  const h = new History();
  for (let i = 0; i < 3; i++) h.record({ phase: 'build', kind: 'easy', model: 'claude-haiku-5-5', passed: false });
  assert.equal(new Router(loadConfig(bothKeys), h).build('t', 'easy').model, 'claude-haiku-5-5');
});

test('repair chain escalates cheap → standard → frontier, then ends', () => {
  const r = new Router(loadConfig(bothKeys), new History());
  assert.deepEqual(
    [0, 1, 2].map((i) => r.repair('t1', i)!.model),
    ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  );
  assert.equal(r.repair('t1', 3), undefined);
});

test('pricing: per-token rates, cache rates, Haiku long-context tier, unknown model', () => {
  const config = loadConfig(bothKeys);
  const sonnet = priceCall(config, 'claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
  assert.equal(sonnet.costUsd, 2 + 10 + 0.1 + 2.5);
  assert.equal(sonnet.priceVerified, true);

  const haikuSmall = priceCall(config, 'claude-haiku-5-5', { inputTokens: 50_000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.ok(Math.abs(haikuSmall.costUsd! - (50_000 * 0.1 + 1000 * 0.5) / 1e6) < 1e-12);
  const haikuLong = priceCall(config, 'claude-haiku-5-5', { inputTokens: 150_000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.ok(Math.abs(haikuLong.costUsd! - (150_000 * 0.5 + 1000 * 2.5) / 1e6) < 1e-12);

  const gptLong = priceCall(config, 'gpt-6.1-sol', { inputTokens: 300_000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.ok(Math.abs(gptLong.costUsd! - (300_000 * 4 + 1000 * 15) / 1e6) < 1e-12, 'GPT 6.1 Sol bills above 272K tokens at its long-context rate');
  assert.deepEqual(priceCall(config, 'mystery-model', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), { costUsd: null, priceVerified: false });
});

test('ledger enforces the budget and groups costs', () => {
  const config = loadConfig(bothKeys);
  const ledger = new Ledger(config, 0.01);
  const usage = { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  ledger.record({ stepId: 's1', phase: 'plan', requestedModel: 'claude-opus-5-5', servedModel: 'claude-opus-5-5', provider: 'anthropic', usage, durationMs: 1 });
  assert.equal(ledger.totalUsd, 0.024);
  assert.throws(() => ledger.assertBudget(), BudgetExceededError);
  assert.equal(ledger.groupBy((e) => e.phase).get('plan')!.calls, 1);
});

test('config validation rejects a routing entry naming an unknown model', () => {
  const config = loadConfig(bothKeys);
  const routing = structuredClone(config.routing);
  routing.phases.plan.model = 'nope-1';
  assert.throws(() => validateRouting(config.models, routing), /plan: model "nope-1"/);
});

test('a repair that changes nothing skips to the strongest model in the chain', () => {
  const r = new Router(loadConfig(bothKeys), new History());
  const last = r.repairChainLength() - 1;
  assert.equal(r.nextRepairAttempt(0, false), 1);
  assert.equal(r.nextRepairAttempt(0, true), last);
  assert.equal(r.nextRepairAttempt(last, true), last + 1, 'the last model making no progress ends the chain');
});

test('failure signature ignores timings, ports and ids, but not the failure itself', () => {
  const fail = (output: string): Verification => ({ ok: false, checks: [{ name: 'smoke', ok: false, output }, { name: 'server tests', ok: true, output: 'fine' }] });
  const a = failureSignature(fail('\x1b[31mFAIL\x1b[0m GET /api/courses → 500 (port 41233, db app_smoke_3, req 9f8e7d6c5b4a, 12.5ms)'));
  const b = failureSignature(fail('FAIL GET /api/courses → 500 (port 39001, db app_smoke_4, req 0a1b2c3d4e5f, 9.1ms)'));
  const c = failureSignature(fail('FAIL GET /api/bookings → 500 (port 39001, db app_smoke_4, req 0a1b2c3d4e5f, 9.1ms)'));
  assert.equal(a, b);
  assert.notEqual(a, c);
});
