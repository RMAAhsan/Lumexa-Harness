/**
 * `npm test -w server`: point Prisma at TEST_DATABASE_URL, sync the schema
 * there (`prisma db push`, never a reset), then run every test/*.test.js
 * file one at a time. Each test file empties the tables before every test and
 * again when it finishes (see test/helpers.js), so the test database is always
 * empty between runs and schema changes apply without data-loss prompts.
 */
import { spawnSync } from 'node:child_process';
import '../src/env.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('TEST_DATABASE_URL is not set (copy server/.env.example to server/.env).');
  process.exit(1);
}
if (url === process.env.DATABASE_URL) {
  console.error('TEST_DATABASE_URL must differ from DATABASE_URL: tests empty their database.');
  process.exit(1);
}

const env = { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' };
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', env });

for (const args of [['prisma', 'generate'], ['prisma', 'db', 'push', '--skip-generate']]) {
  const r = run('npx', args);
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const tests = run(process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', 'test/**/*.test.js']);
process.exit(tests.status ?? 1);
