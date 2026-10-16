/**
 * The verifier. No LLM: it runs the app's own checks and decides pass/fail.
 *   1. server tests     npm test -w server (against the run's test database)
 *   2. builds           npm run build -w client (website) / npm run build:web -w mobile (Expo app)
 *   3. smoke            new empty database -> prisma db push -> seed -> start the
 *                       production server -> GET /api/health (includes a DB query),
 *                       GET / (built UI), and every planned GET endpoint without
 *                       path params must not 5xx
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { childEnv, exec, killGroup, tail } from '../agent/exec.js';
import type { Plan } from './plan.js';

export interface Check {
  name: string;
  ok: boolean;
  output: string;
}

export interface Verification {
  ok: boolean;
  checks: Check[];
}

/** What the verifier needs from the run: the app's env and a way to get a new database. */
export interface VerifyEnv {
  env: Record<string, string>;
  freshDatabase: (prefix: string) => Promise<string>;
}

export interface RunningApp {
  base: string;
  log: () => string;
  stop: () => void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function get(url: string, timeoutMs = 5000): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  }
}

/**
 * Start the built app on a new empty database (schema pushed, seed applied).
 * Throws with the relevant output if any of that fails.
 */
export async function startApp(appDir: string, venv: VerifyEnv, dbPrefix: string): Promise<RunningApp> {
  const dbUrl = await venv.freshDatabase(dbPrefix);
  const env = { ...venv.env, DATABASE_URL: dbUrl };
  const push = await exec('npx prisma db push --skip-generate', { cwd: path.join(appDir, 'server'), timeoutMs: 120_000, env, maxOutput: 3000 });
  if (push.code !== 0) throw new Error(`prisma db push failed:\n${push.output}`);
  const seed = await exec('npm run db:seed -w server', { cwd: appDir, timeoutMs: 120_000, env, maxOutput: 3000 });
  if (seed.code !== 0) throw new Error(`seed failed (npm run db:seed -w server):\n${seed.output}`);

  const port = await freePort();
  const child = spawn('node', ['server/src/index.js'], {
    cwd: appDir,
    env: childEnv({ ...env, NODE_ENV: 'production', PORT: String(port) }),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));
  const app: RunningApp = { base: `http://127.0.0.1:${port}`, log: () => tail(serverLog, 4000), stop: () => killGroup(child.pid) };

  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) break;
    const health = await get(`${app.base}/api/health`, 1000);
    if (health?.status === 200) return app;
    await new Promise((r) => setTimeout(r, 500));
  }
  app.stop();
  throw new Error(`server did not answer GET /api/health with 200 (exit code ${child.exitCode ?? 'still running'})\n--- server log ---\n${app.log()}`);
}

async function smoke(appDir: string, plan: Plan | undefined, venv: VerifyEnv): Promise<Check> {
  let app: RunningApp;
  try {
    app = await startApp(appDir, venv, 'smoke');
  } catch (err) {
    return { name: 'smoke', ok: false, output: `FAIL: ${(err as Error).message}` };
  }
  const problems: string[] = [];
  const lines: string[] = ['GET /api/health -> 200 (database reachable)'];
  try {
    const uis = [
      ...(fs.existsSync(path.join(appDir, 'client')) ? [['/', 'website']] : []),
      ...(fs.existsSync(path.join(appDir, 'mobile')) ? [[fs.existsSync(path.join(appDir, 'client')) ? '/app/' : '/', 'mobile app (web build)']] : []),
    ];
    for (const [route, what] of uis) {
      const page = await get(`${app.base}${route}`);
      if (!page || page.status !== 200 || !page.body.includes('id="root"')) {
        problems.push(`GET ${route} did not return the built ${what} (status ${page?.status ?? 'no response'})`);
      } else {
        lines.push(`GET ${route} -> 200 (${what})`);
      }
    }
    for (const ep of plan?.endpoints ?? []) {
      if (ep.method !== 'GET' || ep.path.includes(':') || ep.path.includes('{')) continue;
      const r = await get(`${app.base}${ep.path}`);
      const status = r?.status ?? 0;
      lines.push(`GET ${ep.path} -> ${status || 'no response'}`);
      if (!r || status >= 500) problems.push(`GET ${ep.path} returned ${status || 'no response'} (must not 5xx, even without auth or data)`);
    }
  } finally {
    app.stop();
  }
  const ok = problems.length === 0;
  const output = [...lines, ...problems.map((p) => `FAIL: ${p}`), ...(ok ? [] : ['--- server log ---', app.log()])].join('\n');
  return { name: 'smoke', ok, output };
}

export async function verify(appDir: string, plan: Plan | undefined, venv: VerifyEnv): Promise<Verification> {
  const checks: Check[] = [];
  const tests = await exec('npm test -w server', { cwd: appDir, timeoutMs: 300_000, maxOutput: 8000, env: venv.env });
  checks.push({ name: 'server tests', ok: tests.code === 0 && !tests.timedOut, output: tests.timedOut ? `TIMED OUT\n${tests.output}` : tests.output });
  const builds: [string, string, string][] = [
    ['client', 'client build', 'npm run build -w client'],
    ['mobile', 'mobile build', 'npm run build:web -w mobile'],
  ];
  for (const [dir, name, cmd] of builds) {
    if (!fs.existsSync(path.join(appDir, dir))) continue;
    const r = await exec(cmd, { cwd: appDir, timeoutMs: 420_000, maxOutput: 6000, env: venv.env });
    checks.push({ name, ok: r.code === 0 && !r.timedOut, output: r.timedOut ? `TIMED OUT\n${r.output}` : r.output });
  }
  if (checks.every((c) => c.ok)) checks.push(await smoke(appDir, plan, venv));
  return { ok: checks.every((c) => c.ok), checks };
}

/** The failing checks' output, for a repair prompt. */
export function failureText(v: Verification): string {
  return v.checks
    .filter((c) => !c.ok)
    .map((c) => `### ${c.name} FAILED\n${c.output}`)
    .join('\n\n');
}

/**
 * The failure with run-to-run noise removed (colours, timings, ports, database
 * names, ids), so two runs of the same failure compare equal. A repair whose
 * failure signature didn't change made no progress at all.
 */
export function failureSignature(v: Verification): string {
  return failureText(v)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#');
}

/** One line per check, for logs and the report. */
export function verificationLine(v: Verification): string {
  return v.checks.map((c) => `${c.name} ${c.ok ? '✓' : '✗'}`).join(', ');
}

/** "N passed, M failed" from node:test output, if present. */
export function testCounts(v: Verification): string | null {
  const out = v.checks.find((c) => c.name === 'server tests')?.output ?? '';
  const pass = /# pass (\d+)/.exec(out)?.[1];
  const fail = /# fail (\d+)/.exec(out)?.[1];
  return pass ? `${pass} passed, ${fail ?? 0} failed` : null;
}
