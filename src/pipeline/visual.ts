/**
 * Visual QA: open the real, running app in Chromium, screenshot the planned
 * pages (logged in with the plan's demo accounts where a page needs it),
 * record broken images/fonts/scripts and console errors, and have a vision
 * model score the result against the design brief.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { CallContext } from '../cost/ledger.js';
import type { Gateway } from '../llm/gateway.js';
import type { ImageInput } from '../llm/types.js';
import type { Decision } from '../brain/router.js';
import type { Plan } from './plan.js';
import { startApp, type VerifyEnv } from './verify.js';
import { exec } from '../agent/exec.js';
import type { ExtraTool } from '../agent/tools.js';
import type { ToolResult } from '../llm/types.js';

export interface Shot {
  route: string;
  viewport: 'desktop' | 'mobile';
  /** Path relative to the run directory. */
  file: string;
  finalPath: string;
  as: string;
}

export interface Capture {
  shots: Shot[];
  /** Broken resources and runtime errors seen while loading pages. */
  problems: string[];
}

export interface VisualIssue {
  page: string;
  severity: 'high' | 'medium' | 'low';
  problem: string;
  fix: string;
}

export interface VisualReview {
  score: number;
  summary: string;
  strengths: string[];
  issues: VisualIssue[];
}

const str = { type: 'string' } as const;
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const VISUAL_SCHEMA = obj({
  score: { type: 'integer' },
  summary: str,
  strengths: { type: 'array', items: str },
  issues: {
    type: 'array',
    items: obj({ page: str, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, problem: str, fix: str }),
  },
});

export const VISUAL_SYSTEM = `You are a principal product designer reviewing screenshots of a web app before launch. Judge it the way a demanding client would, against the design brief.

Score 1-10:
- 9-10: distinctive, polished, would win a design award; strong hierarchy, rhythm, imagery and detail.
- 7-8: professional and cohesive; a client would ship it.
- 5-6: works but looks generic or template-like, or has noticeable rough edges.
- 1-4: broken or amateur: missing images, unstyled elements, overlapping or cramped layout, unreadable contrast.

Look for: broken or missing images and empty boxes, weak visual hierarchy, cramped or inconsistent spacing, poor contrast, misaligned grids, inconsistent buttons/cards, placeholder or lorem text, raw error messages, unstyled form controls, layouts that break on mobile, pages that feel unfinished or off-brief.

Issues must be specific and fixable in code: name the page and the element, say exactly what to change (Tailwind classes, layout, copy, imagery). Most important first. Do not report things that are fine.`;

const MAX_DESKTOP = 8;
const MAX_HEIGHT = 3200;

function slug(route: string): string {
  return route === '/' ? 'home' : route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'page';
}

/**
 * Make the page look the way a visitor sees it after scrolling: scroll down at
 * a human pace (twice, since content can load during the first pass) so
 * scroll-triggered animations (Reveal / whileInView) play, then bring any
 * element that is still transparent into view. Returns how many visible-size
 * elements stay at opacity 0 (a likely stuck animation).
 */
async function settle(page: Page): Promise<string[]> {
  for (let pass = 0; pass < 2; pass++) {
    await page.evaluate(async () => {
      const step = Math.max(250, Math.floor(window.innerHeight * 0.6));
      for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 250));
      }
    });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  }
  // A string, not a function: tsx/esbuild would inject a __name() helper into named
  // inner functions, and that helper does not exist inside the page.
  const stuck = (await page.evaluate(`(async () => {
    // Invisible content blocks a visitor should see: text, photos/video or a background image.
    // Small elements and icon-only ones are skipped: UIs cross-fade icons (e.g. tab bars) on purpose.
    const hasContent = (e) =>
      (e.innerText || '').trim().length > 0 ||
      e.querySelector('img,video,canvas,picture') !== null ||
      getComputedStyle(e).backgroundImage !== 'none';
    const hidden = () => [...document.querySelectorAll('main *, #root > * *')].filter((e) => {
      const r = e.getBoundingClientRect();
      return getComputedStyle(e).opacity === '0' && r.height > 48 && r.width > 48 && hasContent(e);
    });
    for (const el of hidden().slice(0, 40)) {
      el.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 300));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 900));
    return hidden().map((e) => {
      const text = (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
      return e.tagName.toLowerCase() + (e.getAttribute('aria-hidden') ? '[aria-hidden]' : '') + (getComputedStyle(e).position === 'fixed' ? '[fixed]' : '') + (text ? ' "' + text + '"' : ' (empty)');
    });
  })()`)) as string[];
  return stuck;
}

async function login(base: string, plan: Plan, account: Plan['demoAccounts'][number]): Promise<string | null> {
  const ep = plan.endpoints.find((e) => e.method === 'POST' && /login|signin|sign-in|session/i.test(e.path));
  if (!ep) return null;
  try {
    const res = await fetch(`${base}${ep.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const token = body?.token ?? (body?.data as Record<string, unknown> | undefined)?.token ?? body?.accessToken;
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

/** Screenshot one page into `file` (JPEG); records browser problems. Returns where the page ended up. */
export async function shootPage(opts: {
  browser: Browser;
  base: string;
  route: string;
  viewport: Shot['viewport'];
  token?: string;
  file: string;
  problems: Set<string>;
}): Promise<{ finalPath: string }> {
  const { route, problems } = opts;
  const context = await opts.browser.newContext(
    opts.viewport === 'desktop' ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true },
  );
  try {
    if (opts.token) await context.addInitScript((t) => window.localStorage.setItem('token', t), opts.token);
    const page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && problems.add(`console error on ${route}: ${m.text().slice(0, 200)}`));
    page.on('pageerror', (e) => problems.add(`uncaught error on ${route}: ${e.message.slice(0, 200)}`));
    page.on('requestfailed', (r) => problems.add(`failed to load ${r.resourceType()} ${r.url().slice(0, 160)} on ${route} (${r.failure()?.errorText ?? 'error'})`));
    page.on('response', (r) => {
      const type = r.request().resourceType();
      if (r.status() >= 400 && ['image', 'media', 'font', 'stylesheet', 'script'].includes(type)) {
        problems.add(`broken ${type} (HTTP ${r.status()}) ${r.url().slice(0, 160)} on ${route}`);
      }
    });
    await page.goto(`${opts.base}${route}`, { waitUntil: 'networkidle', timeout: 25_000 }).catch(() => undefined);
    const stuck = await settle(page);
    if (stuck.length) problems.add(`note: on ${route}, ${stuck.length} element(s) stay invisible (opacity 0) even after scrolling to them - likely a stuck animation: ${stuck.slice(0, 3).join('; ')}`);
    const height = Math.min(MAX_HEIGHT, await page.evaluate(() => document.documentElement.scrollHeight));
    const width = opts.viewport === 'desktop' ? 1440 : 390;
    await page.screenshot({ path: opts.file, type: 'jpeg', quality: 72, fullPage: true, clip: { x: 0, y: 0, width, height } });
    return { finalPath: new URL(page.url()).pathname };
  } finally {
    await context.close();
  }
}

/** Website pages (desktop) and app screens (phone), as the plan describes them. */
function targetsFor(plan: Plan): [string, Shot['viewport']][] {
  const plain = (r: string) => r.startsWith('/') && !/[:*[\]]/.test(r);
  const routes = [...new Set(['/', ...plan.pages.filter((p) => p.surface === 'web').map((p) => p.route)])]
    .filter(plain)
    .slice(0, plan.platform === 'mobile' ? 0 : MAX_DESKTOP);
  const screens = [...new Set(['/', ...plan.pages.filter((p) => p.surface === 'mobile').map((p) => p.route.replace(/\/\([^)]*\)/g, '') || '/')])]
    .filter(plain)
    .slice(0, plan.platform === 'web' ? 0 : MAX_DESKTOP)
    .map((r) => (plan.platform === 'both' ? `/app${r === '/' ? '/' : r}` : r));
  return [
    ...routes.map((r) => [r, 'desktop'] as [string, Shot['viewport']]),
    ...screens.map((r) => [r, 'mobile'] as [string, Shot['viewport']]),
    // The website on a phone too (the app screens are already phone-sized).
    ...(routes.length ? [['/', 'mobile'] as [string, Shot['viewport']]] : []),
  ];
}

async function demoTokens(base: string, plan: Plan): Promise<{ as: string; token: string }[]> {
  const tokens: { as: string; token: string }[] = [];
  for (const account of plan.demoAccounts ?? []) {
    const token = await login(base, plan, account);
    if (token) tokens.push({ as: account.role, token });
  }
  return tokens;
}

export async function capture(opts: { appDir: string; runDir: string; venv: VerifyEnv; plan: Plan; tag: string }): Promise<Capture> {
  const outDir = path.join(opts.runDir, 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const app = await startApp(opts.appDir, opts.venv, 'visual');
  const problems = new Set<string>();
  const shots: Shot[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const tokens = await demoTokens(app.base, opts.plan);
    const seen = new Set<string>();
    for (const [route, viewport] of targetsFor(opts.plan)) {
      const shoot = async (auth?: { as: string; token: string }): Promise<Shot> => {
        const name = `${opts.tag}-${slug(route)}${auth ? `-${auth.as.toLowerCase().replace(/[^a-z0-9]+/g, '')}` : ''}-${viewport}.jpg`;
        const { finalPath } = await shootPage({ browser: browser!, base: app.base, route, viewport, token: auth?.token, file: path.join(outDir, name), problems });
        return { route, viewport, file: `screenshots/${name}`, finalPath, as: auth?.as ?? 'visitor' };
      };
      let shot = await shoot();
      // Redirected (e.g. to /login)? Try again as each demo account.
      for (const t of tokens) {
        if (shot.finalPath === route || shot.finalPath === `${route}/`) break;
        fs.rmSync(path.join(opts.runDir, shot.file), { force: true });
        shot = await shoot(t);
      }
      const key = `${shot.finalPath}|${shot.as}|${viewport}`;
      if (seen.has(key)) {
        fs.rmSync(path.join(opts.runDir, shot.file), { force: true });
        continue;
      }
      seen.add(key);
      shots.push(shot);
    }
  } finally {
    await browser?.close();
    app.stop();
  }
  return { shots, problems: [...problems].slice(0, 30) };
}

/** Problems that count against "good enough" (not the advisory notes). */
export const blockingProblems = (problems: string[]) => problems.filter((p) => !p.startsWith('note:'));

/**
 * A live screenshot tool for an agent: the first call starts the app; every
 * call rebuilds the UI from the current code, so the agent sees its own changes.
 */
export class LiveScreens {
  private app?: Awaited<ReturnType<typeof startApp>>;
  private browser?: Browser;
  private tokens: { as: string; token: string }[] = [];
  private count = 0;

  constructor(private readonly opts: { appDir: string; runDir: string; venv: VerifyEnv; plan: Plan; tag: string }) {}

  tool(): ExtraTool {
    const roles = (this.opts.plan.demoAccounts ?? []).map((a) => a.role);
    return {
      spec: {
        name: 'screenshot',
        description:
          'Rebuild the UI from the current code and take a screenshot of a page of the running app, to check your changes. ' +
          'Returns the image plus any broken images or console errors. Website pages: desktop or mobile; app screens: mobile' +
          (this.opts.plan.platform === 'both' ? ' (app routes start with /app)' : '') + '.',
        schema: {
          type: 'object',
          properties: {
            route: { type: 'string', description: 'e.g. "/" or "/courses"' },
            viewport: { type: 'string', enum: ['desktop', 'mobile'] },
            as: { type: 'string', enum: ['visitor', ...roles], description: 'Log in as a demo account first (default visitor).' },
          },
          required: ['route', 'viewport', 'as'],
          additionalProperties: false,
        },
      },
      run: (input) => this.shoot(input),
    };
  }

  private async rebuild(): Promise<string | null> {
    for (const [dir, cmd] of [['client', 'npm run build -w client'], ['mobile', 'npm run build:web -w mobile']]) {
      if (!fs.existsSync(path.join(this.opts.appDir, dir))) continue;
      const r = await exec(cmd, { cwd: this.opts.appDir, timeoutMs: 420_000, maxOutput: 3000, env: this.opts.venv.env });
      if (r.code !== 0) return `${cmd} failed, fix this first:\n${r.output}`;
    }
    return null;
  }

  private async shoot(input: Record<string, unknown>): Promise<Omit<ToolResult, 'id'>> {
    const route = typeof input.route === 'string' && input.route.startsWith('/') ? input.route : '/';
    const viewport = input.viewport === 'mobile' ? 'mobile' : 'desktop';
    const buildError = await this.rebuild();
    if (buildError) return { output: buildError, isError: true };
    if (!this.app) {
      this.app = await startApp(this.opts.appDir, this.opts.venv, 'live');
      this.browser = await chromium.launch();
      this.tokens = await demoTokens(this.app.base, this.opts.plan);
    }
    const auth = this.tokens.find((t) => t.as === input.as);
    const dir = path.join(this.opts.runDir, 'screenshots', 'live');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.opts.tag}-${++this.count}-${slug(route)}-${viewport}.jpg`);
    const problems = new Set<string>();
    const { finalPath } = await shootPage({ browser: this.browser!, base: this.app.base, route, viewport, token: auth?.token, file, problems });
    const notes = [
      finalPath !== route ? `Redirected to ${finalPath}.` : '',
      problems.size ? `Browser problems:\n${[...problems].map((p) => `- ${p}`).join('\n')}` : 'No broken resources or console errors.',
    ].filter(Boolean);
    return {
      output: `Screenshot of ${route} (${viewport}, as ${auth?.as ?? 'visitor'}). ${notes.join(' ')}`,
      images: [{ mediaType: 'image/jpeg', data: fs.readFileSync(file).toString('base64'), label: `${route} ${viewport}` }],
    };
  }

  async dispose(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.app?.stop();
    this.browser = undefined;
    this.app = undefined;
  }
}

export async function reviewScreens(opts: {
  gateway: Gateway;
  decision: Decision;
  runDir: string;
  capture: Capture;
  plan: Plan;
  brief: string;
  ctx: CallContext;
}): Promise<VisualReview> {
  const images: ImageInput[] = opts.capture.shots.map((s) => ({
    mediaType: 'image/jpeg',
    data: fs.readFileSync(path.join(opts.runDir, s.file)).toString('base64'),
    label: `Screenshot: route ${s.route}${s.finalPath !== s.route ? ` (redirected to ${s.finalPath})` : ''}, ${s.viewport}, viewed as ${s.as}`,
  }));
  const problems = opts.capture.problems.length ? opts.capture.problems.map((p) => `- ${p}`).join('\n') : '- none detected';
  const review = await opts.gateway.structured<VisualReview>({
    model: opts.decision.model,
    effort: opts.decision.effort,
    system: VISUAL_SYSTEM,
    prompt: `${opts.brief}\n\nApp: ${opts.plan.appName}. ${opts.plan.summary}\n\nProblems the browser recorded while loading the pages (treat broken images as high severity):\n${problems}\n\nReview the screenshots above.`,
    schemaName: 'visual_review',
    schema: VISUAL_SCHEMA,
    maxTokens: 16000,
    images,
    ctx: opts.ctx,
  });
  review.score = Math.max(1, Math.min(10, Math.round(Number(review.score) || 1)));
  return review;
}
