/**
 * One harness run, end to end:
 *
 *   plan -> design -> scaffold (+ PostgreSQL) -> for each task: build -> verify -> (repair chain)
 *   -> code review (other model family) -> fix -> visual QA rounds (screenshots -> vision
 *   review -> design fix) -> final verify -> migrations -> REPORT.md
 *
 * Every LLM step asks the Router for its model; every call is priced in the
 * Ledger; every step is recorded in Steps. A failure or an exhausted budget
 * stops the run but still writes the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec } from '../agent/exec.js';
import { runAgent } from '../agent/loop.js';
import { mediaTools, type MediaKeys } from '../agent/media.js';
import { Workspace } from '../agent/tools.js';
import type { History } from '../brain/history.js';
import type { Decision, Router } from '../brain/router.js';
import type { HarnessConfig } from '../config.js';
import { BudgetExceededError, type Ledger } from '../cost/ledger.js';
import { PgServer } from '../infra/postgres.js';
import type { Gateway } from '../llm/gateway.js';
import type { ImageInput } from '../llm/types.js';
import { log, usd } from '../log.js';
import { checkDesign, DESIGN_SCHEMA, designDoc, type DesignSpec } from './design.js';
import { checkPlan, PLAN_SCHEMA, REVIEW_SCHEMA, type Plan, type Review } from './plan.js';
import * as P from './prompts.js';
import { scaffoldApp } from './scaffold.js';
import { Steps, type Step } from './steps.js';
import { failureSignature, failureText, verificationLine, verify, type Verification, type VerifyEnv } from './verify.js';
import { blockingProblems, capture, LiveScreens, reviewScreens, type Capture, type Shot, type VisualIssue } from './visual.js';

export type RunStatus = 'verified' | 'failed' | 'budget_exceeded' | 'error';

export interface RunContext {
  config: HarnessConfig;
  gateway: Gateway;
  router: Router;
  history: History;
  ledger: Ledger;
  steps: Steps;
  request: string;
  runDir: string;
  appDir: string;
  options: { review: boolean; visual: boolean };
  /** Stock media API keys (Unsplash, Pexels); missing keys fall back to generation/Openverse. */
  mediaKeys?: MediaKeys;
}

export interface TaskOutcome {
  id: string;
  title: string;
  difficulty: string;
  builtBy: string;
  passedFirstTry: boolean;
  passed: boolean;
  repairs: string[];
  summary: string;
}

export interface VisualRound {
  round: number;
  score: number;
  summary: string;
  strengths: string[];
  issues: VisualIssue[];
  problems: string[];
  shots: Shot[];
  /** This round's fix lowered the score, so the code was restored to the previous round. */
  reverted?: boolean;
}

export interface RunResult {
  status: RunStatus;
  error?: string;
  plan?: Plan;
  design?: DesignSpec;
  tasks: TaskOutcome[];
  review?: Review;
  visual: VisualRound[];
  /** The shipped design's score against limits.visualTargetScore. */
  designTarget?: { target: number; score: number; met: boolean };
  finalVerification?: Verification;
  migrations?: { ok: boolean; detail: string };
  filesWritten: string[];
  commandsRun: number;
  startedAt: number;
  endedAt: number;
}

/** Live state of a run, shared by the phases. */
interface Live {
  ctx: RunContext;
  ws: Workspace;
  venv: VerifyEnv;
  plan: Plan;
  brief: string;
  /** The step an agent is currently running (tools like get_image bill to it). */
  current: { stepId: string; phase: string; taskId?: string };
}

function stepCost(ctx: RunContext, step: Step): string {
  return usd(ctx.ledger.sumWhere((e) => e.stepId === step.id).costUsd);
}

function decisionLine(d: Decision): string {
  return `${d.model}${d.effort ? ` (effort ${d.effort})` : ''} — ${d.reasons[d.reasons.length - 1]}`;
}

async function agentStep(live: Live, step: Step, decision: Decision, prompt: string, images?: ImageInput[]): Promise<string> {
  const { limits } = live.ctx.config.routing;
  live.current = { stepId: step.id, phase: step.phase, taskId: step.taskId };
  const r = await runAgent({
    images,
    gateway: live.ctx.gateway,
    workspace: live.ws,
    model: decision.model,
    effort: decision.effort,
    system: P.builderSystem(live.plan.platform),
    prompt,
    ctx: { stepId: step.id, phase: step.phase, taskId: step.taskId },
    maxTurns: limits.agentMaxTurns,
    maxTokens: limits.maxTokensPerTurn,
  });
  step.turns = r.turns;
  if (r.stop !== 'done') log(`  agent stopped: ${r.stop} after ${r.turns} turns`);
  return r.summary || '(no summary)';
}

/**
 * Verify (unless a fresh result is passed in); on failure walk the repair
 * chain (cheap model first, escalating) until verification passes or the
 * chain is exhausted. A repair that changes nothing (identical failure
 * signature) jumps straight to the last model, which is told what didn't work.
 */
async function verifyAndRepair(live: Live, taskId: string, what: string, initial?: Verification): Promise<{ v: Verification; repairs: string[] }> {
  const { ctx } = live;
  let v = initial ?? (await verify(ctx.appDir, live.plan, live.venv));
  if (!initial) log(`  verify: ${verificationLine(v)}`);
  const repairs: string[] = [];
  let noProgress: { model: string; summary: string } | undefined;
  for (let attempt = 0; !v.ok && attempt < ctx.router.repairChainLength(); ) {
    const d = ctx.router.repair(taskId, attempt)!;
    const step = ctx.steps.start('repair', `Repair ${taskId} (attempt ${attempt + 1})`, { taskId, decision: d });
    log(`  repair attempt ${attempt + 1} → ${decisionLine(d)}`);
    const before = failureSignature(v);
    const summary = await agentStep(live, step, d, P.repairPrompt(live.plan, what, failureText(v), live.ws.listFiles('.'), noProgress));
    v = await verify(ctx.appDir, live.plan, live.venv);
    const unchanged = !v.ok && failureSignature(v) === before;
    ctx.history.record({ phase: 'repair', kind: `attempt-${attempt + 1}`, model: d.model, passed: v.ok });
    ctx.steps.end(step, v.ok ? 'passed' : 'failed', `${verificationLine(v)}${unchanged ? ' (no change)' : ''}`);
    log(`  verify: ${verificationLine(v)}${unchanged ? '  — no change' : ''}  (${stepCost(ctx, step)})`);
    repairs.push(`${d.model}: ${v.ok ? 'fixed' : unchanged ? 'no change' : 'still failing'}`);
    noProgress = unchanged ? { model: d.model, summary } : undefined;
    const next = ctx.router.nextRepairAttempt(attempt, unchanged);
    if (next > attempt + 1 && !v.ok) log(`  no progress: skipping to repair attempt ${next + 1}`);
    attempt = next;
  }
  return { v, repairs };
}

async function planPhase(ctx: RunContext): Promise<Plan> {
  const d = ctx.router.plan();
  const step = ctx.steps.start('plan', 'Write spec and task plan', { decision: d });
  log(`PLAN → ${decisionLine(d)}`);
  const plan = await ctx.gateway.structured<Plan>({
    model: d.model,
    effort: d.effort,
    system: P.PLANNER_SYSTEM,
    prompt: P.plannerPrompt(ctx.request),
    schemaName: 'build_plan',
    schema: PLAN_SCHEMA,
    // A long PRD (tens of pages, many modules) needs more than 32k: a 77k-char
    // spec was cut off there. Opus 5.5 allows far more; the ledger charges what is used.
    maxTokens: 64000,
    ctx: { stepId: step.id, phase: 'plan' },
  });
  checkPlan(plan);
  fs.writeFileSync(path.join(ctx.runDir, 'plan.json'), JSON.stringify(plan, null, 2));
  ctx.steps.end(step, 'passed', `${plan.tasks.length} task(s), ${plan.endpoints.length} endpoint(s), ${plan.pages.length} page(s)`);
  log(`  "${plan.appName}": ${plan.tasks.map((t) => `${t.id} [${t.difficulty}]`).join(', ')}  (${stepCost(ctx, step)})`);
  return plan;
}

async function designPhase(ctx: RunContext, plan: Plan): Promise<DesignSpec> {
  const d = ctx.router.design();
  const step = ctx.steps.start('design', 'Art direction: palette, type, layouts', { decision: d });
  log(`DESIGN → ${decisionLine(d)}`);
  const spec = await ctx.gateway.structured<DesignSpec>({
    model: d.model,
    effort: d.effort,
    system: P.DESIGNER_SYSTEM,
    prompt: P.designerPrompt(plan, ctx.request),
    schemaName: 'design_direction',
    schema: DESIGN_SCHEMA,
    maxTokens: 16000,
    ctx: { stepId: step.id, phase: 'design' },
  });
  checkDesign(spec);
  fs.writeFileSync(path.join(ctx.runDir, 'design.json'), JSON.stringify(spec, null, 2));
  ctx.steps.end(step, 'passed', `${spec.mode}, ${spec.fonts.display} + ${spec.fonts.body}, ${spec.mood.slice(0, 3).join(' / ')}`);
  log(`  "${spec.brandName}": ${spec.mood.join(', ')}; ${spec.fonts.display} / ${spec.fonts.body}  (${stepCost(ctx, step)})`);
  return spec;
}

async function scaffoldPhase(ctx: RunContext, plan: Plan, design: DesignSpec | undefined, pg: PgServer): Promise<Workspace> {
  const step = ctx.steps.start('scaffold', `Template (${plan.platform}) + design tokens + PostgreSQL + npm install`);
  log(`SCAFFOLD ${plan.platform} (no LLM)`);
  try {
    const notes = await scaffoldApp({ appDir: ctx.appDir, plan, design, env: pg.appEnv() });
    ctx.steps.end(step, 'passed', [...notes, `PostgreSQL in ${pg.container}`].join('; '));
    log(`  ${notes.join('; ')}`);
  } catch (err) {
    ctx.steps.end(step, 'failed', (err as Error).message.split('\n')[0]);
    throw err;
  }
  return new Workspace(ctx.appDir, pg.appEnv());
}

async function buildPhase(live: Live, outcomes: TaskOutcome[]): Promise<void> {
  const { ctx, plan, ws } = live;
  for (const task of plan.tasks) {
    const d = ctx.router.build(task.id, task.difficulty, task.area);
    const step = ctx.steps.start('build', `${task.id}. ${task.title}`, { taskId: task.id, decision: d });
    log(`BUILD ${task.id} "${task.title}" [${task.difficulty}] → ${decisionLine(d)}`);
    const done = outcomes.map((o) => ({ id: o.id, summary: o.summary }));
    // UI tasks can look at what they build.
    const screens = task.area !== 'backend' && ctx.options.visual ? new LiveScreens({ appDir: ctx.appDir, runDir: ctx.runDir, venv: live.venv, plan, tag: task.id }) : undefined;
    if (screens) ws.addTool(screens.tool());
    let summary: string;
    try {
      summary = await agentStep(live, step, d, P.taskPrompt(plan, task, done, ws.listFiles('.'), live.brief, Boolean(screens)));
    } finally {
      ws.removeTool('screenshot');
      await screens?.dispose();
    }

    const first = await verify(ctx.appDir, plan, live.venv);
    ctx.history.record({ phase: 'build', kind: d.kind, model: d.model, passed: first.ok });
    ctx.steps.end(step, first.ok ? 'passed' : 'failed', verificationLine(first));
    log(`  verify: ${verificationLine(first)}  (${stepCost(ctx, step)})`);

    let passed = first.ok;
    let repairs: string[] = [];
    if (!first.ok) {
      const r = await verifyAndRepair(live, task.id, `task ${task.id}. ${task.title}`, first);
      passed = r.v.ok;
      repairs = r.repairs;
    }
    outcomes.push({ id: task.id, title: task.title, difficulty: task.difficulty, builtBy: d.model, passedFirstTry: first.ok, passed, repairs, summary });
  }
}

const SOURCE_RE = /^(server\/(src|test|prisma)|client\/src)\/.*\.(js|jsx|prisma)$/;

function collectSources(ws: Workspace, maxChars = 160_000): string {
  let out = '';
  for (const f of ws.listFiles('.').filter((f) => SOURCE_RE.test(f) && !f.startsWith('client/src/components/ui/'))) {
    const block = `=== ${f} ===\n${fs.readFileSync(path.join(ws.root, f), 'utf8')}\n\n`;
    if (out.length + block.length > maxChars) {
      out += '=== (remaining files omitted: size limit) ===\n';
      break;
    }
    out += block;
  }
  return out;
}

async function reviewPhase(live: Live): Promise<Review> {
  const { ctx, plan, ws } = live;
  const d = ctx.router.review();
  const step = ctx.steps.start('review', 'Cross-model code review', { decision: d });
  log(`REVIEW → ${decisionLine(d)}`);
  const review = await ctx.gateway.structured<Review>({
    model: d.model,
    effort: d.effort,
    system: P.REVIEWER_SYSTEM,
    prompt: P.reviewPrompt(plan, collectSources(ws)),
    schemaName: 'code_review',
    schema: REVIEW_SCHEMA,
    maxTokens: 16000,
    ctx: { stepId: step.id, phase: 'review' },
  });
  fs.writeFileSync(path.join(ctx.runDir, 'review.json'), JSON.stringify(review, null, 2));
  const counts = ['high', 'medium', 'low'].map((s) => `${review.issues.filter((i) => i.severity === s).length} ${s}`).join(', ');
  ctx.steps.end(step, 'passed', counts);
  log(`  ${counts}  (${stepCost(ctx, step)})`);

  const actionable = review.issues.filter((i) => i.severity !== 'low').slice(0, ctx.config.routing.limits.maxReviewFixes);
  if (actionable.length === 0) return review;

  const fd = ctx.router.fixReview();
  const fixStep = ctx.steps.start('fix_review', `Fix ${actionable.length} review findings`, { taskId: 'review-fixes', decision: fd });
  log(`FIX REVIEW (${actionable.length} findings) → ${decisionLine(fd)}`);
  const issues = actionable.map((i, n) => `${n + 1}. [${i.severity}] ${i.file}: ${i.problem}\n   Suggested fix: ${i.fix}`).join('\n');
  await agentStep(live, fixStep, fd, P.fixReviewPrompt(plan, issues, ws.listFiles('.')));
  const v = await verify(ctx.appDir, plan, live.venv);
  ctx.history.record({ phase: 'fix_review', kind: 'fix_review', model: fd.model, passed: v.ok });
  ctx.steps.end(fixStep, v.ok ? 'passed' : 'failed', verificationLine(v));
  log(`  verify: ${verificationLine(v)}  (${stepCost(ctx, fixStep)})`);
  if (!v.ok) await verifyAndRepair(live, 'review-fixes', 'fixes for code review findings', v);
  return review;
}

/** The UI source folders a design fix may change (snapshotted so a bad round can be undone). */
const UI_PATHS = ['client/src', 'client/public', 'client/index.html', 'mobile/app', 'mobile/src', 'mobile/assets', 'server/public/media'];

function snapshotUi(appDir: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const rel of UI_PATHS) {
    const src = path.join(appDir, rel);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, rel), { recursive: true });
  }
}

function restoreUi(appDir: string, from: string): void {
  for (const rel of UI_PATHS) {
    const saved = path.join(from, rel);
    const live = path.join(appDir, rel);
    if (!fs.existsSync(saved)) continue;
    fs.rmSync(live, { recursive: true, force: true });
    fs.cpSync(saved, live, { recursive: true });
  }
}

function shotImages(runDir: string, cap: Capture): ImageInput[] {
  return cap.shots.map((s) => ({
    mediaType: 'image/jpeg' as const,
    data: fs.readFileSync(path.join(runDir, s.file)).toString('base64'),
    label: `Reviewed screenshot: ${s.route}, ${s.viewport}, as ${s.as}`,
  }));
}

/**
 * Screenshot -> vision review -> design fix, until the score reaches the
 * target or the configured number of fix rounds is used up. The fix agent sees
 * the reviewed screenshots and can take its own. A fix that lowers the score
 * is undone, so the run always ships its best-scoring version.
 */
async function visualPhase(live: Live): Promise<VisualRound[]> {
  const { ctx, plan, ws } = live;
  const { visualRounds, visualTargetScore } = ctx.config.routing.limits;
  const rounds: VisualRound[] = [];
  const snapshotDir = path.join(ctx.runDir, '.ui-snapshot');
  let lastCapture: Capture | undefined;
  for (let round = 1; round <= visualRounds + 1; round++) {
    const d = ctx.router.visualReview(round);
    const step = ctx.steps.start('visual_review', `Screenshot + design review (round ${round})`, { taskId: `visual-${round}`, decision: d });
    log(`VISUAL REVIEW ${round} → ${decisionLine(d)}`);
    const shots = await capture({ appDir: ctx.appDir, runDir: ctx.runDir, venv: live.venv, plan, tag: `r${round}` });
    const review = await reviewScreens({
      gateway: ctx.gateway,
      decision: d,
      runDir: ctx.runDir,
      capture: shots,
      plan,
      brief: live.brief,
      ctx: { stepId: step.id, phase: 'visual_review', taskId: `visual-${round}` },
    });
    const high = review.issues.filter((i) => i.severity === 'high').length;
    const previous = rounds[rounds.length - 1];
    if (previous && review.score < previous.score && fs.existsSync(snapshotDir)) {
      // The last fix made it worse: put the previous round's code back.
      restoreUi(ctx.appDir, snapshotDir);
      rounds.push({ round, ...review, problems: shots.problems, shots: shots.shots, reverted: true });
      ctx.steps.end(step, 'failed', `score ${review.score}/10 < ${previous.score}/10: design fixes reverted`);
      log(`  score ${review.score}/10 is lower than ${previous.score}/10: reverted the round ${round - 1} fixes  (${stepCost(ctx, step)})`);
      break;
    }
    rounds.push({ round, ...review, problems: shots.problems, shots: shots.shots });
    lastCapture = shots;
    ctx.steps.end(step, 'passed', `score ${review.score}/10, ${review.issues.length} issue(s) (${high} high), ${shots.shots.length} screenshots`);
    log(`  score ${review.score}/10, ${review.issues.length} issues, ${shots.problems.length} browser problems  (${stepCost(ctx, step)})`);

    const good = review.score >= visualTargetScore && high === 0 && blockingProblems(shots.problems).length === 0;
    if (good || round > visualRounds) break;

    snapshotUi(ctx.appDir, snapshotDir);
    const fd = ctx.router.designFix(round);
    const fixStep = ctx.steps.start('design_fix', `Design fixes (round ${round})`, { taskId: `visual-${round}`, decision: fd });
    log(`DESIGN FIX ${round} → ${decisionLine(fd)}`);
    const issues = review.issues
      .filter((i) => i.severity !== 'low')
      .concat(review.issues.filter((i) => i.severity === 'low').slice(0, 4))
      .map((i, n) => `${n + 1}. [${i.severity}] ${i.page}: ${i.problem}\n   Fix: ${i.fix}`)
      .join('\n');
    const screens = new LiveScreens({ appDir: ctx.appDir, runDir: ctx.runDir, venv: live.venv, plan, tag: `fix${round}` });
    ws.addTool(screens.tool());
    try {
      await agentStep(
        live,
        fixStep,
        fd,
        P.designFixPrompt(plan, live.brief, review.score, review.summary, issues, shots.problems, ws.listFiles('.')),
        shotImages(ctx.runDir, lastCapture),
      );
    } finally {
      ws.removeTool('screenshot');
      await screens.dispose();
    }
    const v = await verify(ctx.appDir, plan, live.venv);
    ctx.history.record({ phase: 'design_fix', kind: 'design_fix', model: fd.model, passed: v.ok });
    ctx.steps.end(fixStep, v.ok ? 'passed' : 'failed', verificationLine(v));
    log(`  verify: ${verificationLine(v)}  (${stepCost(ctx, fixStep)})`);
    if (!v.ok) {
      const r = await verifyAndRepair(live, `visual-${round}`, `design fixes, round ${round}`, v);
      if (!r.v.ok) {
        restoreUi(ctx.appDir, snapshotDir);
        log('  design fixes broke the build and could not be repaired: reverted them');
        break;
      }
    }
  }
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(ctx.runDir, 'visual.json'), JSON.stringify(rounds, null, 2));
  return rounds;
}

/**
 * Ship real migrations: generate the SQL from the final schema (read-only
 * `prisma migrate diff`), then prove it applies cleanly to a brand-new database.
 */
async function migrationsPhase(live: Live): Promise<{ ok: boolean; detail: string }> {
  const { ctx } = live;
  const step = ctx.steps.start('finalize', 'Generate + check database migrations, write .env');
  log('MIGRATIONS (no LLM)');
  const server = path.join(ctx.appDir, 'server');
  const dir = path.join(server, 'prisma', 'migrations', '0_init');
  const diff = await exec('npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script', {
    cwd: server,
    timeoutMs: 120_000,
    env: live.venv.env,
    maxOutput: 2_000_000,
  });
  let result: { ok: boolean; detail: string };
  if (diff.code !== 0) {
    result = { ok: false, detail: `prisma migrate diff failed:\n${diff.output.slice(-2000)}` };
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'migration.sql'), diff.output.trimStart());
    fs.writeFileSync(path.join(server, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
    const url = await live.venv.freshDatabase('migrate_check');
    const deploy = await exec('npx prisma migrate deploy', { cwd: server, timeoutMs: 120_000, env: { ...live.venv.env, DATABASE_URL: url } });
    const tables = (diff.output.match(/CREATE TABLE/g) ?? []).length;
    result = deploy.code === 0
      ? { ok: true, detail: `prisma/migrations/0_init: ${tables} tables, applied cleanly to a fresh database` }
      : { ok: false, detail: `migration did not apply:\n${deploy.output.slice(-2000)}` };
  }
  const example = path.join(server, '.env.example');
  if (fs.existsSync(example) && !fs.existsSync(path.join(server, '.env'))) fs.copyFileSync(example, path.join(server, '.env'));
  ctx.steps.end(step, result.ok ? 'passed' : 'failed', result.detail.split('\n')[0]);
  log(`  ${result.detail.split('\n')[0]}`);
  return result;
}

export async function runHarness(ctx: RunContext): Promise<RunResult> {
  const startedAt = Date.now();
  const outcomes: TaskOutcome[] = [];
  const result: RunResult = { status: 'failed', tasks: outcomes, visual: [], filesWritten: [], commandsRun: 0, startedAt, endedAt: startedAt };
  let ws: Workspace | undefined;
  let pg: PgServer | undefined;

  try {
    const plan = await planPhase(ctx);
    result.plan = plan;
    if (ctx.options.visual) result.design = await designPhase(ctx, plan);
    pg = await PgServer.start(path.basename(ctx.runDir).replace(/[^a-z0-9-]/gi, '').slice(0, 40));
    ws = await scaffoldPhase(ctx, plan, result.design, pg);
    const server = pg;
    const live: Live = {
      ctx,
      ws,
      plan,
      brief: result.design ? designDoc(result.design) : '',
      venv: { env: server.appEnv(), freshDatabase: (prefix) => server.freshDatabase(prefix) },
      current: { stepId: 'scaffold', phase: 'build' },
    };
    const { maxImages, maxVideos } = ctx.config.routing.limits;
    for (const tool of mediaTools({
      gateway: ctx.gateway,
      workspace: ws,
      keys: ctx.mediaKeys ?? {},
      ctx: () => live.current,
      limits: { images: maxImages, videos: maxVideos },
      counter: { images: 0, videos: 0 },
    })) {
      ws.addTool(tool);
    }

    await buildPhase(live, outcomes);
    if (ctx.options.review) result.review = await reviewPhase(live);
    if (ctx.options.visual && ctx.config.routing.limits.visualRounds >= 0) {
      result.visual = await visualPhase(live);
      const shipped = [...result.visual].reverse().find((r) => !r.reverted);
      if (shipped) {
        const target = ctx.config.routing.limits.visualTargetScore;
        result.designTarget = { target, score: shipped.score, met: shipped.score >= target };
        if (!result.designTarget.met) log(`  design shipped at ${shipped.score}/10, below the ${target}/10 target`);
      }
    }

    const step = ctx.steps.start('final_verify', 'Final verification (tests, build, smoke)');
    log('FINAL VERIFY');
    const first = await verify(ctx.appDir, plan, live.venv);
    log(`  verify: ${verificationLine(first)}`);
    ctx.steps.end(step, first.ok ? 'passed' : 'failed', verificationLine(first));
    const r = first.ok ? { v: first } : await verifyAndRepair(live, 'final', 'final verification of the whole app', first);
    result.finalVerification = r.v;
    if (r.v.ok) result.migrations = await migrationsPhase(live);
    result.status = r.v.ok ? 'verified' : 'failed';
  } catch (err) {
    for (const s of ctx.steps.list) if (s.status === 'running') ctx.steps.end(s, 'failed', 'interrupted');
    if (err instanceof BudgetExceededError) {
      result.status = 'budget_exceeded';
      result.error = err.message;
    } else {
      result.status = 'error';
      result.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    }
    log(`STOPPED: ${result.error.split('\n')[0]}`);
  } finally {
    await pg?.stop();
  }

  result.filesWritten = ws ? [...ws.written].sort() : [];
  result.commandsRun = ws?.commandsRun ?? 0;
  result.endedAt = Date.now();
  return result;
}
