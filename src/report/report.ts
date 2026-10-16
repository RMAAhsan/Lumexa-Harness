/**
 * REPORT.md: what the run built, which model did each step and why, and what
 * every step cost. Built only from the ledger, the router's decisions and the
 * step record, so the numbers match ledger.json exactly.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import { findModel } from '../config.js';
import type { Ledger } from '../cost/ledger.js';
import { usd } from '../log.js';
import type { RunResult } from '../pipeline/run.js';
import type { Step, Steps } from '../pipeline/steps.js';
import { testCounts } from '../pipeline/verify.js';

const STATUS_LABEL: Record<RunResult['status'], string> = {
  verified: '✅ VERIFIED — tests pass, client builds, smoke test passes',
  failed: '❌ FAILED — the app did not pass final verification',
  budget_exceeded: '💸 STOPPED — budget exhausted',
  error: '⚠️ STOPPED — harness error',
};

const PHASE_LABEL: Record<Step['phase'], string> = {
  plan: 'Plan',
  design: 'Design',
  scaffold: 'Scaffold',
  build: 'Build',
  repair: 'Repair',
  review: 'Review',
  fix_review: 'Fix review',
  visual_review: 'Visual review',
  design_fix: 'Design fix',
  final_verify: 'Final verify',
  finalize: 'Migrations',
};

const n = (x: number) => x.toLocaleString('en-US');
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Relative to the current directory when inside it, absolute otherwise. */
function shown(p: string): string {
  const rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith('..') ? rel : p;
}
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function stepIcon(s: Step): string {
  return s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'skipped' ? '–' : '…';
}

function mermaid(steps: Step[], ledger: Ledger): string {
  const lines = ['```mermaid', 'flowchart TD'];
  steps.forEach((s, i) => {
    const cost = ledger.sumWhere((e) => e.stepId === s.id);
    const model = s.decision ? `<br/>${s.decision.model}` : '<br/>no LLM';
    const money = cost.calls ? `<br/>${usd(cost.costUsd)}` : '';
    const label = `${stepIcon(s)} ${PHASE_LABEL[s.phase]}: ${s.title}`.replace(/"/g, "'").slice(0, 70);
    lines.push(`  ${s.id}["${label}${model}${money}"]:::${s.status}`);
    if (i > 0) lines.push(`  ${steps[i - 1].id} --> ${s.id}`);
  });
  lines.push(
    '  classDef passed fill:#e7f6ec,stroke:#2f9e44,color:#1b4332',
    '  classDef failed fill:#fdecec,stroke:#e03131,color:#5c1111',
    '  classDef running fill:#fff4e6,stroke:#f08c00,color:#5c3b00',
    '  classDef skipped fill:#f1f3f5,stroke:#adb5bd,color:#495057',
    '```',
  );
  return lines.join('\n');
}

function costTable(title: string, rows: Map<string, { calls: number; costUsd: number; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }; unverified: boolean }>, total: number, extra?: (key: string) => string): string {
  const head = `| ${title} | Calls | Input tok | Cache read | Cache write | Output tok | Cost | Share |\n|---|---:|---:|---:|---:|---:|---:|---:|`;
  const body = [...rows.entries()]
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .map(([k, r]) => {
      const share = total > 0 ? `${((r.costUsd / total) * 100).toFixed(0)}%` : '–';
      return `| ${cell(k)}${extra ? extra(k) : ''} | ${r.calls} | ${n(r.usage.inputTokens)} | ${n(r.usage.cacheReadTokens)} | ${n(r.usage.cacheWriteTokens)} | ${n(r.usage.outputTokens)} | ${usd(r.costUsd)}${r.unverified ? ' *' : ''} | ${share} |`;
    });
  return [head, ...body].join('\n');
}

export function renderReport(opts: {
  request: string;
  result: RunResult;
  steps: Steps;
  ledger: Ledger;
  config: HarnessConfig;
  runDir: string;
  appDir: string;
}): string {
  const { request, result, steps, ledger, config, runDir, appDir } = opts;
  const total = ledger.totalUsd;
  const allUsage = ledger.sumWhere(() => true);
  const plan = result.plan;
  const firstTry = result.tasks.filter((t) => t.passedFirstTry).length;
  const repairs = steps.list.filter((s) => s.phase === 'repair').length;
  const unverifiedModels = [...new Set(ledger.entries.filter((e) => !e.priceVerified).map((e) => e.servedModel))];
  const fallbacks = ledger.entries.filter((e) => e.servedModel !== e.requestedModel && !e.servedModel.startsWith(`${e.requestedModel}-`));
  const appRel = shown(appDir);
  const out: string[] = [];

  out.push(`# Harness report — ${plan?.appName ?? 'run'}`, '');
  out.push(`**${STATUS_LABEL[result.status]}**`, '');
  if (result.designTarget) {
    const t = result.designTarget;
    out.push(t.met ? `**🎨 Design ${t.score}/10: meets the ${t.target}/10 target**` : `**⚠️ Design ${t.score}/10: below the ${t.target}/10 target.** See Visual QA for what the reviewer still wants.`, '');
  }
  out.push('> ' + request.trim().split('\n').join('\n> '), '');

  out.push('## Summary', '');
  out.push('| | |', '|---|---|');
  out.push(`| Total cost | **${usd(total)}**${unverifiedModels.length ? ' (includes estimated prices, see note)' : ''} |`);
  out.push(`| Budget | ${usd(ledger.budgetUsd)} |`);
  out.push(`| Duration | ${duration(result.endedAt - result.startedAt)} |`);
  out.push(`| LLM calls | ${allUsage.calls} (${n(allUsage.usage.inputTokens + allUsage.usage.cacheReadTokens + allUsage.usage.cacheWriteTokens)} input tokens, ${n(allUsage.usage.outputTokens)} output tokens) |`);
  out.push(`| Prompt cache | ${n(allUsage.usage.cacheReadTokens)} tokens read from cache |`);
  if (plan) {
    const platform = { web: 'Website (React + Vite + Tailwind)', mobile: 'iOS + Android app (Expo + React Native)', both: 'Website + iOS/Android app (one API)' }[plan.platform];
    out.push(`| Platform | ${platform} · API: Express + Prisma + PostgreSQL |`);
  }
  if (plan) out.push(`| Plan | ${plural(plan.tasks.length, 'task')}, ${plural(plan.endpoints.length, 'API endpoint')}, ${plural(plan.pages.length, 'page')} |`);
  if (result.tasks.length) out.push(`| Tasks passing first try | ${firstTry} / ${result.tasks.length} (${plural(repairs, 'repair attempt')}) |`);
  if (result.finalVerification) {
    const tc = testCounts(result.finalVerification);
    out.push(`| Final checks | ${result.finalVerification.checks.map((c) => `${c.name} ${c.ok ? '✓' : '✗'}`).join(' · ')}${tc ? ` (tests: ${tc})` : ''} |`);
  }
  if (result.visual.length) {
    out.push(`| Design score | ${result.visual.map((r) => (r.reverted ? `~~${r.score}/10~~ (fix reverted)` : `**${r.score}/10**`)).join(' → ')} (vision review of real screenshots${result.visual.length > 1 ? ', after each fix round' : ''}) |`);
  }
  out.push(`| Database | PostgreSQL 16 + Prisma ORM${result.migrations ? ` · ${result.migrations.ok ? '✓' : '✗'} ${cell(result.migrations.detail.split('\n')[0])}` : ''} |`);
  out.push(`| Files written by agents | ${result.filesWritten.length} (${plural(result.commandsRun, 'shell command')}) |`);
  out.push(`| App | \`${appRel}\` |`, '');
  if (result.error) out.push('```', result.error.slice(0, 3000), '```', '');

  if (result.status === 'verified' || result.status === 'failed') {
    out.push(
      '### Run the app',
      '',
      '```bash',
      `cd ${appRel}`,
      'npm run setup     # PostgreSQL in Docker (port 5433), apply migrations, seed demo data',
      'npm test          # API tests (separate test database)',
      'npm run build     # build the React UI',
      'npm start         # http://localhost:3001',
      '```',
      '',
    );
    if (plan && plan.platform !== 'web') {
      out.push(
        `The iOS/Android app${plan.platform === 'both' ? ' (its web build is also at http://localhost:3001/app)' : ' (its web build is at http://localhost:3001)'}:`,
        '',
        '```bash',
        `cd ${appRel}`,
        'npm run dev:server                                   # API on :3001',
        'echo "EXPO_PUBLIC_API_URL=http://<your-computer-ip>:3001" > mobile/.env',
        'npm run dev:mobile                                   # scan the QR code with the Expo Go app (iOS/Android)',
        '```',
        '',
        'Store builds: `cd mobile && npx eas build -p ios` / `-p android` (Expo account; iOS needs an Apple developer account).',
        '',
      );
    }
    if (plan?.demoAccounts?.length) {
      out.push('Demo accounts (created by the seed):', '', ...plan.demoAccounts.map((a) => `- ${a.role}: \`${a.email}\` / \`${a.password}\``), '');
    }
  }

  out.push('## Workflow', '', mermaid(steps.list, ledger), '');

  if (result.design) {
    const d = result.design;
    const swatch = (name: string, colors: string[]) => `${name} ${[1, 5, 6, 9].map((i) => colors[i]).filter(Boolean).map((c) => `\`${c}\``).join(' ')}`;
    out.push('## Design direction', '');
    out.push(`**${d.brandName}** — _${d.tagline}_`, '');
    out.push(d.direction, '');
    out.push(`- Mood: ${d.mood.join(', ')} · ${d.mode} mode · ${d.radius} corners`);
    out.push(`- Type: **${d.fonts.display}** (headings) + **${d.fonts.body}** (body)`);
    out.push(`- Palette: ${swatch('primary', d.palette.primary)} · ${swatch('accent', d.palette.accent)} · ${swatch('ink', d.palette.ink)}`);
    out.push('- Full brief: `app/docs/DESIGN.md`', '');
  }

  if (result.visual.length) {
    out.push('## Visual QA', '');
    out.push('Each round: the harness starts the real app, opens every page in Chromium (logged in with the demo accounts where needed), takes screenshots, and a vision model scores them against the design brief. Below the target score, an agent fixes the issues and the next round re-checks.', '');
    out.push('| Round | Score | Issues (high) | Browser problems | Cost |', '|---|---:|---:|---:|---:|');
    for (const r of result.visual) {
      const reviewCost = ledger.sumWhere((e) => e.phase === 'visual_review' && e.taskId === `visual-${r.round}`).costUsd;
      const fixCost = ledger.sumWhere((e) => e.phase === 'design_fix' && e.taskId === `visual-${r.round}`).costUsd;
      out.push(`| ${r.round} | **${r.score}/10**${r.reverted ? ' (worse: fixes reverted)' : ''} | ${r.issues.length} (${r.issues.filter((i) => i.severity === 'high').length}) | ${r.problems.length} | review ${usd(reviewCost)}${fixCost ? ` + fix ${usd(fixCost)}` : ''} |`);
    }
    // The shipped version: the last round whose code was kept.
    const last = [...result.visual].reverse().find((r) => !r.reverted) ?? result.visual[result.visual.length - 1];
    out.push('', `**Final review:** ${last.summary}`, '');
    if (last.strengths.length) out.push(...last.strengths.map((x) => `- ✓ ${x}`), '');
    if (last.issues.length) {
      out.push('<details><summary>Remaining design notes</summary>', '', ...last.issues.map((i) => `- **${i.severity}** \`${i.page}\`: ${i.problem}`), '', '</details>', '');
    }
    out.push('### Screenshots (final round)', '');
    for (const shot of last.shots) {
      out.push(`**${shot.route}**${shot.finalPath !== shot.route ? ` → ${shot.finalPath}` : ''} · ${shot.viewport} · as ${shot.as}`, '', `![${shot.route} ${shot.viewport}](${shot.file})`, '');
    }
    if (result.visual.length > 1) {
      const first = result.visual[0].shots.find((x) => x.route === '/' && x.viewport === 'desktop');
      const final = last.shots.find((x) => x.route === '/' && x.viewport === 'desktop');
      if (first && final) {
        out.push('<details><summary>Home page: first round vs final</summary>', '', `Round 1 (${result.visual[0].score}/10)`, '', `![first](${first.file})`, '', `Final (${last.score}/10)`, '', `![final](${final.file})`, '', '</details>', '');
      }
    }
  }

  out.push('## Models it followed, step by step', '');
  out.push('| # | Phase | Step | Model | Provider | Effort | Why this model | Turns | Cost | Result |');
  out.push('|---|---|---|---|---|---|---|---:|---:|---|');
  steps.list.forEach((s, i) => {
    const c = ledger.sumWhere((e) => e.stepId === s.id);
    const d = s.decision;
    out.push(
      `| ${i + 1} | ${PHASE_LABEL[s.phase]} | ${cell(s.title)} | ${d ? `\`${d.model}\`` : '— (no LLM)'} | ${d?.provider ?? '—'} | ${d?.effort ?? '—'} | ${d ? cell(d.reasons.join(' → ')) : '—'} | ${s.turns ?? (c.calls || '—')} | ${c.calls ? usd(c.costUsd) : '$0'} | ${stepIcon(s)} ${cell(s.detail ?? s.status)} |`,
    );
  });
  out.push('');

  out.push('## Cost', '');
  out.push('### By model', '', costTable('Model', ledger.groupBy((e) => e.servedModel), total, (k) => {
    const m = findModel(config, k);
    return m ? ` (${m.provider}, ${m.tier})` : ' (unpriced)';
  }), '');
  out.push('### By phase', '', costTable('Phase', ledger.groupBy((e) => e.phase), total), '');
  out.push('### By provider', '', costTable('Provider', ledger.groupBy((e) => e.provider), total), '');
  if (result.tasks.length) {
    out.push('### By task (build + its repairs)', '', costTable('Task', ledger.groupBy((e) => e.taskId ?? `(${e.phase})`), total), '');
  }
  const priceRows = [...new Set(ledger.entries.map((e) => e.servedModel))].flatMap((id) => {
    const m = findModel(config, id);
    return m ? [`| \`${m.id}\` | $${m.price.input} | $${m.price.cacheRead} | $${m.price.cacheWrite} | $${m.price.output} | ${m.priceVerified ? 'yes' : '**no — placeholder**'} |`] : [];
  });
  if (priceRows.length) {
    out.push('Prices used (USD per 1M tokens, from `config/models.json`):', '');
    out.push('| Model | Input | Cache read | Cache write | Output | Verified |', '|---|---:|---:|---:|---:|---|', ...priceRows, '');
  }
  if (unverifiedModels.length) {
    out.push(`\\* Estimated: ${unverifiedModels.map((m) => `\`${m}\``).join(', ')} ${unverifiedModels.length > 1 ? 'have' : 'has'} a placeholder price in \`config/models.json\`. Set the real price there for exact numbers.`, '');
  }
  if (fallbacks.length) {
    out.push(`Server-side fallback: ${fallbacks.length} call(s) were served by a different model than requested (${[...new Set(fallbacks.map((e) => `${e.requestedModel} → ${e.servedModel}`))].join(', ')}); each is priced at the model that served it.`, '');
  }

  if (result.tasks.length) {
    out.push('## Tasks', '');
    out.push('| Task | Difficulty | Built by | First try | Repairs | Final |', '|---|---|---|---|---|---|');
    for (const t of result.tasks) {
      out.push(`| ${t.id}. ${cell(t.title)} | ${t.difficulty} | \`${t.builtBy}\` | ${t.passedFirstTry ? '✓' : '✗'} | ${t.repairs.length ? cell(t.repairs.join('; ')) : '—'} | ${t.passed ? '✓' : '✗'} |`);
    }
    out.push('');
    for (const t of result.tasks) out.push(`- **${t.id}** — ${t.summary.replace(/\s+/g, ' ').slice(0, 500)}`);
    out.push('');
  }

  if (result.review) {
    out.push('## Code review', '', result.review.summary, '');
    if (result.review.issues.length) {
      out.push('| Severity | File | Problem | Fixed in pass? |', '|---|---|---|---|');
      for (const i of result.review.issues) {
        out.push(`| ${i.severity} | \`${cell(i.file)}\` | ${cell(i.problem)} | ${i.severity === 'low' ? 'not attempted (low)' : 'sent to fix pass'} |`);
      }
      out.push('');
    }
  }

  const credits = path.join(appDir, 'server', 'public', 'media', 'CREDITS.md');
  const media = fs.existsSync(credits) ? fs.readFileSync(credits, 'utf8').split('\n').filter((l) => l.startsWith('- ')) : [];
  if (media.length) {
    const count = (re: RegExp) => media.filter((l) => re.test(l)).length;
    out.push('## Media', '');
    out.push(`${plural(media.length, 'file')} in \`server/public/media\`: ${count(/Unsplash/)} Unsplash, ${count(/on Pexels/)} Pexels, ${count(/generated/)} generated, ${count(/Openverse|CC|PDM/)} Openverse.`, '');
    out.push('<details><summary>Credits</summary>', '', ...media, '', '</details>', '');
  }

  if (result.finalVerification && !result.finalVerification.ok) {
    out.push('## Final verification output', '');
    for (const c of result.finalVerification.checks.filter((c) => !c.ok)) {
      out.push(`<details><summary>${c.name} ✗</summary>`, '', '```', c.output.slice(-6000), '```', '</details>', '');
    }
  }

  if (plan) {
    out.push('## What was planned', '');
    out.push(`**${plan.appName}** — ${plan.summary}`, '');
    out.push('API:', '', ...plan.endpoints.map((e) => `- \`${e.method} ${e.path}\`${e.auth ? ' (auth)' : ''} — ${e.purpose}`), '');
    out.push('Pages:', '', ...plan.pages.map((p) => `- \`${p.route}\` ${p.name} — ${p.purpose}`), '');
  }

  if (result.filesWritten.length) {
    out.push('<details><summary>Files written by agents</summary>', '', ...result.filesWritten.map((f) => `- \`${f}\``), '', '</details>', '');
  }

  out.push('## Artifacts', '');
  out.push(`All in \`${shown(runDir)}\`: \`app/\` (the generated app), \`screenshots/\` (every visual QA round), \`plan.json\`, \`design.json\`, \`ledger.json\` (every LLM call with tokens and cost), \`decisions.json\` (every routing decision), \`review.json\`, \`visual.json\`, \`run.log\`.`);
  out.push('');
  return out.join('\n');
}
