/**
 * Run a shell command inside the generated app's directory, with a timeout that
 * kills the whole process group (so a stray `npm run dev` cannot hang a run).
 */
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  timedOut: boolean;
  output: string;
}

/** Keep the end of long output: errors are almost always at the bottom. */
export function tail(text: string, max: number): string {
  return text.length <= max ? text : `[...${text.length - max} earlier characters cut...]\n${text.slice(-max)}`;
}

export function exec(
  command: string,
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string>; maxOutput?: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: opts.cwd,
      env: childEnv(opts.env),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, opts.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output: tail(output, opts.maxOutput ?? 12_000) });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, timedOut, output: String(err) });
    });
  });
}

/**
 * Environment for the generated app's processes. NODE_TEST_CONTEXT is dropped:
 * if the harness itself runs under `node --test`, an inherited value makes the
 * app's own `node --test` report to the wrong parent and exit 0 on failures.
 */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}
