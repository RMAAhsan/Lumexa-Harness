/**
 * The coding agent's tools. Every path is confined to the app directory and
 * every input is validated here (streamed tool inputs are not validated by the
 * API). This is a workspace boundary, not a security sandbox: commands run as
 * your user. Run the harness inside a container if prompts are untrusted.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ToolCall, ToolResult, ToolSpec } from '../llm/types.js';
import { exec } from './exec.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'data', '.vite']);
const MAX_READ = 60_000;
const COMMAND_TIMEOUT_MS = 240_000;

/** Commands that would leave the workspace, need root, or never exit. */
const BLOCKED: [RegExp, string][] = [
  [/\bsudo\b/, 'sudo is not allowed'],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/, 'removing / or home is not allowed'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, 'piping downloads into a shell is not allowed'],
  [/\bgit\s+push\b/, 'git push is not allowed'],
  [/prisma\s+migrate\s+(reset|dev)\b/, 'the harness creates migrations itself at the end; to sync the dev database use `npx prisma db push` in server/'],
  [/--force-reset|--accept-data-loss|\bdropdb\b|\bDROP\s+(DATABASE|SCHEMA|TABLE)\b/i, 'destructive database commands are not allowed (tests empty their own tables)'],
  [/\bnpm\s+(run\s+)?(dev|start)\b|\bvite(\s+dev)?\s*$|node\s+(--watch\s+)?server\/src\/index\.js/, 'long-running servers are not allowed here; the harness starts the app itself during verification'],
];

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_files',
    description: 'List files under a directory of the app (recursive; skips node_modules, dist, data).',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory relative to the app root, e.g. "." or "server/src".' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file of the app.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the app root.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the full content. Parent directories are created. Prefer files under ~300 lines.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the app root.' },
        content: { type: 'string', description: 'Complete file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'Replace one exact occurrence of old_text with new_text in a file. old_text must match exactly once.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the app root (bash, 4 minute timeout). Use it for `npm test -w server`, `npm run build -w client`, ' +
      '`npm install <pkg> -w server|client`. Do not start dev servers.',
    schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

/** An extra tool a phase plugs in (get_image, screenshot). */
export interface ExtraTool {
  spec: ToolSpec;
  run(input: Record<string, unknown>): Promise<Omit<ToolResult, 'id'>>;
}

export class Workspace {
  readonly root: string;
  private readonly extras = new Map<string, ExtraTool>();
  /** Files the agents wrote, relative to root (for the report). */
  readonly written = new Set<string>();
  commandsRun = 0;

  constructor(
    root: string,
    /** Extra environment for commands (DATABASE_URL, TEST_DATABASE_URL...). */
    readonly env: Record<string, string> = {},
  ) {
    this.root = fs.realpathSync(root);
  }

  addTool(tool: ExtraTool): void {
    this.extras.set(tool.spec.name, tool);
  }

  removeTool(name: string): void {
    this.extras.delete(name);
  }

  /** The tools an agent session gets: the file/shell tools plus any extras plugged in. */
  specs(): ToolSpec[] {
    return [...TOOL_SPECS, ...[...this.extras.values()].map((t) => t.spec)];
  }

  /** Resolve a model-supplied path; null if it escapes the app root. */
  resolve(p: string): string | null {
    const target = path.resolve(this.root, p);
    const rel = path.relative(this.root, target);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    // Canonicalize the nearest existing ancestor so a symlink cannot point outside.
    let probe = target;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + path.sep)) return null;
    return target;
  }

  listFiles(dir: string): string[] {
    const start = this.resolve(dir);
    if (!start || !fs.existsSync(start)) return [];
    const out: string[] = [];
    const walk = (abs: string) => {
      for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (ent.isDirectory()) {
          if (!IGNORED_DIRS.has(ent.name)) walk(path.join(abs, ent.name));
        } else if (ent.name !== 'package-lock.json') {
          out.push(path.relative(this.root, path.join(abs, ent.name)));
        }
        if (out.length >= 500) return;
      }
    };
    walk(start);
    return out;
  }

  async execute(call: ToolCall, truncated: boolean): Promise<ToolResult> {
    const fail = (output: string): ToolResult => ({ id: call.id, output, isError: true });
    if (truncated) {
      return fail('Your previous response hit the output limit and this call was cut off, so it was not run. Write smaller files or split the work.');
    }
    const input = call.input;
    if ('__invalid_json__' in input) return fail('Tool arguments were not valid JSON. Send the call again.');
    const str = (k: string): string | null => (typeof input[k] === 'string' ? (input[k] as string) : null);
    const need = (...keys: string[]): string | null => {
      const missing = keys.filter((k) => str(k) === null);
      return missing.length ? `Missing or non-string field(s): ${missing.join(', ')}. Send the complete call again.` : null;
    };

    switch (call.name) {
      case 'list_files': {
        const err = need('path');
        if (err) return fail(err);
        const files = this.listFiles(str('path')!);
        return { id: call.id, output: files.length ? files.join('\n') : '(no files)' };
      }
      case 'read_file': {
        const err = need('path');
        if (err) return fail(err);
        const abs = this.resolve(str('path')!);
        if (!abs) return fail('Path is outside the app directory.');
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return fail(`No such file: ${str('path')}`);
        const text = fs.readFileSync(abs, 'utf8');
        return { id: call.id, output: text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n[...file truncated at ${MAX_READ} chars...]` : text };
      }
      case 'write_file': {
        const err = need('path', 'content');
        if (err) return fail(err);
        const abs = this.resolve(str('path')!);
        if (!abs) return fail('Path is outside the app directory.');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, str('content')!);
        this.written.add(path.relative(this.root, abs));
        return { id: call.id, output: `Wrote ${str('path')} (${str('content')!.split('\n').length} lines).` };
      }
      case 'edit_file': {
        const err = need('path', 'old_text', 'new_text');
        if (err) return fail(err);
        const abs = this.resolve(str('path')!);
        if (!abs) return fail('Path is outside the app directory.');
        if (!fs.existsSync(abs)) return fail(`No such file: ${str('path')}`);
        const text = fs.readFileSync(abs, 'utf8');
        const oldText = str('old_text')!;
        const count = oldText ? text.split(oldText).length - 1 : 0;
        if (count !== 1) return fail(`old_text must match exactly once; it matched ${count} times. Read the file and retry.`);
        fs.writeFileSync(abs, text.replace(oldText, () => str('new_text')!));
        this.written.add(path.relative(this.root, abs));
        return { id: call.id, output: `Edited ${str('path')}.` };
      }
      case 'run_command': {
        const err = need('command');
        if (err) return fail(err);
        const command = str('command')!;
        const blocked = BLOCKED.find(([re]) => re.test(command));
        if (blocked) return fail(`Command refused: ${blocked[1]}.`);
        this.commandsRun++;
        const r = await exec(command, { cwd: this.root, timeoutMs: COMMAND_TIMEOUT_MS, env: this.env });
        const status = r.timedOut ? 'TIMED OUT (killed)' : `exit code ${r.code}`;
        return { id: call.id, output: `${status}\n${r.output}`, isError: r.timedOut || r.code !== 0 };
      }
      default: {
        const extra = this.extras.get(call.name);
        if (!extra) return fail(`Unknown tool: ${call.name}`);
        try {
          return { id: call.id, ...(await extra.run(input)) };
        } catch (err) {
          return fail(`${call.name} failed: ${(err as Error).message}`);
        }
      }
    }
  }
}
