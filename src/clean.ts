/**
 * `npm run clean`: free disk space.
 *   - removes node_modules (and build output) from every run except the newest;
 *     reinstall any of them later with `npm install` in its app folder
 *   - removes leftover harness PostgreSQL containers
 *   --all       also clean the newest run
 *   --dry-run   only show what would be removed
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from './config.js';

const all = process.argv.includes('--all');
const dry = process.argv.includes('--dry-run');

function sizeOf(p: string): number {
  try {
    return Number(execFileSync('du', ['-sb', p], { encoding: 'utf8' }).split('\t')[0]) || 0;
  } catch {
    return 0;
  }
}

const runs = fs.existsSync(RUNS_DIR)
  ? fs.readdirSync(RUNS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  : [];
const targets = (all ? runs : runs.slice(0, -1)).flatMap((run) =>
  ['app/node_modules', 'app/server/node_modules', 'app/client/node_modules', 'app/mobile/node_modules', 'app/client/dist', 'app/mobile/dist', 'app/mobile/.expo']
    .map((rel) => path.join(RUNS_DIR, run, rel))
    .filter((p) => fs.existsSync(p)),
);

let freed = 0;
for (const t of targets) {
  const bytes = sizeOf(t);
  freed += bytes;
  console.log(`${dry ? 'would remove' : 'removing'} ${path.relative(process.cwd(), t)} (${(bytes / 1e6).toFixed(0)} MB)`);
  if (!dry) fs.rmSync(t, { recursive: true, force: true });
}

let containers: string[] = [];
try {
  containers = execFileSync('docker', ['ps', '-aq', '--filter', 'name=^harness-pg-'], { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  // docker not available: nothing to clean there
}
if (containers.length) {
  console.log(`${dry ? 'would remove' : 'removing'} ${containers.length} leftover harness PostgreSQL container(s)`);
  if (!dry) execFileSync('docker', ['rm', '-f', '-v', ...containers], { stdio: 'ignore' });
}

console.log(`${dry ? 'would free' : 'freed'} about ${(freed / 1e9).toFixed(2)} GB${all ? '' : ' (the newest run was kept; use --all to include it)'}`);
