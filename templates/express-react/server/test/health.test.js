import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { useTestDb } from './helpers.js';

useTestDb();

test('GET /api/health reports the database is up', async () => {
  const res = await request(createApp()).get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, db: 'up' });
});

test('unknown /api route returns JSON 404', async () => {
  const res = await request(createApp()).get('/api/does-not-exist');
  assert.equal(res.status, 404);
});
