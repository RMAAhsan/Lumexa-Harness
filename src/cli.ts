/**
 * Usage:
 *   ./run.sh "Build a recipe manager where users can save and search recipes"
 *   ./run.sh --file idea.txt --budget 5 --name recipes --no-review
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { History } from './brain/history.js';
import { Router } from './brain/router.js';
import { loadConfig, loadEnv, RUNS_DIR } from './config.js';
import { Ledger } from './cost/ledger.js';
import { PgServer } from './infra/postgres.js';
import { Gateway } from './llm/gateway.js';
import { log, setLogFile, usd } from './log.js';
import { runHarness } from './pipeline/run.js';
import { Steps } from './pipeline/steps.js';
import { renderReport } from './report/report.js';

const HELP = `Lumexa harness: prompt in, verified Node/Express + React app out.

  ./run.sh "<what to build>" [options]

Options:
  --file <path>     read the request from a file (.txt, .md or .pdf); a lone file path also works
  --budget <usd>    stop when spend reaches this (default 10)
  --name <slug>     run folder name (default: from the request)
  --no-review       skip the cross-model code review
  --no-visual       skip the design phase and the screenshot/vision review rounds
  -h, --help        this help

Output: runs/<timestamp>-<name>/  (app/, REPORT.md, screenshots/, ledger.json, plan.json, design.json, run.log)
Needs Docker (PostgreSQL runs in a container for the duration of the run).`;

/** Text of a request file: .pdf via pdftotext (poppler-utils), anything else as UTF-8 text. */
function readRequestFile(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  if (path.extname(file).toLowerCase() !== '.pdf') return fs.readFileSync(file, 'utf8');
  const r = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 50_000_000 });
  if (r.error || r.status !== 0) {
    throw new Error(`could not read the PDF (needs pdftotext: sudo apt install poppler-utils): ${r.error?.message ?? r.stderr}`);
  }
  if (!r.stdout.trim()) throw new Error(`the PDF has no extractable text (scanned image?): ${file}`);
  return r.stdout;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 5)
      .join('-') || 'app'
  );
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      budget: { type: 'string', default: '10' },
      name: { type: 'string' },
      'no-review': { type: 'boolean', default: false },
      'no-visual': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  // A lone argument that is an existing file is read as the request (same as --file).
  const file = values.file ?? (positionals.length === 1 && fs.existsSync(positionals[0]) && fs.statSync(positionals[0]).isFile() ? positionals[0] : undefined);
  let request: string;
  try {
    request = (file ? readRequestFile(file) : positionals.join(' ')).trim();
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (file) console.log(`request read from ${file} (${request.split(/\s+/).filter(Boolean).length} words)`);
  if (!request) {
    console.error(HELP);
    return 2;
  }
  const budget = Number(values.budget);
  if (!Number.isFinite(budget) || budget <= 0) {
    console.error('--budget must be a positive number of USD');
    return 2;
  }

  // A run installs 0.4-1 GB of packages (more for mobile apps); fail now rather than halfway through.
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const free = fs.statfsSync(RUNS_DIR);
  const freeGb = (free.bavail * free.bsize) / 1e9;
  if (freeGb < 2) {
    console.error(`Only ${freeGb.toFixed(1)} GB of disk space is free; a run needs about 2 GB. Free space first (npm run clean removes old runs' node_modules).`);
    return 2;
  }

  loadEnv();
  const config = loadConfig();
  if (!config.available.has('anthropic') && !config.available.has('openai')) {
    console.error('No API key found. Copy .env.example to .env and set ANTHROPIC_API_KEY (and optionally OPENAI_API_KEY).');
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const runDir = path.join(RUNS_DIR, `${stamp}-${values.name ? slugify(values.name) : slugify(request)}`);
  const appDir = path.join(runDir, 'app');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'request.txt'), `${request}\n`);
  setLogFile(path.join(runDir, 'run.log'));

  const ledger = new Ledger(config, budget, path.join(runDir, 'ledger.json'));
  const history = new History(path.join(RUNS_DIR, 'history.jsonl'));
  const router = new Router(config, history);
  const steps = new Steps();
  const gateway = new Gateway(config, ledger);

  log(`run: ${path.relative(process.cwd(), runDir)}`);
  const mediaKeys = { unsplash: process.env.UNSPLASH_ACCESS_KEY?.trim() || undefined, pexels: process.env.PEXELS_API_KEY?.trim() || undefined };
  log(`providers with keys: ${[...config.available].join(', ')}   budget: ${usd(budget)}`);
  log(`media: ${[mediaKeys.unsplash ? 'Unsplash photos' : '', mediaKeys.pexels ? 'Pexels photos + videos' : '', config.available.has('openai') ? 'generated images' : '', 'Openverse'].filter(Boolean).join(', ')}`);

  // Ctrl+C: still write what was spent and which steps ran.
  const startedAt = Date.now();
  process.once('SIGINT', () => {
    const planFile = path.join(runDir, 'plan.json');
    const partial = {
      status: 'error' as const,
      error: 'Interrupted (Ctrl+C). Costs below are everything spent up to that point.',
      plan: fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : undefined,
      tasks: [],
      visual: [],
      filesWritten: [],
      commandsRun: 0,
      startedAt,
      endedAt: Date.now(),
    };
    for (const s of steps.list) if (s.status === 'running') steps.end(s, 'failed', 'interrupted');
    fs.writeFileSync(path.join(runDir, 'decisions.json'), JSON.stringify(router.decisions, null, 2));
    fs.writeFileSync(path.join(runDir, 'REPORT.md'), renderReport({ request, result: partial, steps, ledger, config, runDir, appDir }));
    PgServer.stopAllSync();
    console.log(`\ninterrupted — spent ${usd(ledger.totalUsd)}; partial report: ${path.relative(process.cwd(), path.join(runDir, 'REPORT.md'))}`);
    process.exit(130);
  });

  const result = await runHarness({
    config,
    gateway,
    router,
    history,
    ledger,
    steps,
    request,
    runDir,
    appDir,
    options: { review: !values['no-review'], visual: !values['no-visual'] },
    mediaKeys,
  });

  fs.writeFileSync(path.join(runDir, 'decisions.json'), JSON.stringify(router.decisions, null, 2));
  const reportFile = path.join(runDir, 'REPORT.md');
  fs.writeFileSync(reportFile, renderReport({ request, result, steps, ledger, config, runDir, appDir }));

  log('');
  log(`status: ${result.status}   cost: ${usd(ledger.totalUsd)}   time: ${Math.round((result.endedAt - result.startedAt) / 1000)}s`);
  log(`report: ${path.relative(process.cwd(), reportFile)}`);
  if (result.status === 'verified') log(`app:    ${path.relative(process.cwd(), appDir)}  (npm start → http://localhost:3001)`);
  return result.status === 'verified' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    PgServer.stopAllSync();
    process.exit(1);
  },
);
