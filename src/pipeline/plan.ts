/** The plan: spec + ordered tasks, produced by one structured call. */
import type { Difficulty } from '../config.js';

export interface PlanTask {
  id: string;
  title: string;
  area: 'backend' | 'frontend' | 'fullstack';
  difficulty: Difficulty;
  instructions: string;
  acceptance: string[];
}

export type Platform = 'web' | 'mobile' | 'both';

export interface Plan {
  appName: string;
  /** web = Express + React website; mobile = Express + React Native (Expo) app; both = website + app on one API. */
  platform: Platform;
  summary: string;
  entities: { name: string; fields: string[] }[];
  endpoints: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; auth: boolean; purpose: string }[];
  /** surface: which client the page/screen belongs to (always 'web' for web, 'mobile' for mobile). */
  pages: { route: string; name: string; purpose: string; surface: 'web' | 'mobile' }[];
  /** Accounts the seed must create; the visual review logs in with them. Empty if the app has no login. */
  demoAccounts: { role: string; email: string; password: string }[];
  tasks: PlanTask[];
}

const str = { type: 'string' } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** Strict JSON Schema (valid for both Anthropic structured outputs and OpenAI strict mode). */
export const PLAN_SCHEMA = obj({
  appName: str,
  platform: { type: 'string', enum: ['web', 'mobile', 'both'] },
  summary: str,
  entities: { type: 'array', items: obj({ name: str, fields: { type: 'array', items: str } }) },
  endpoints: {
    type: 'array',
    items: obj({
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: str,
      auth: { type: 'boolean' },
      purpose: str,
    }),
  },
  pages: { type: 'array', items: obj({ route: str, name: str, purpose: str, surface: { type: 'string', enum: ['web', 'mobile'] } }) },
  demoAccounts: { type: 'array', items: obj({ role: str, email: str, password: str }) },
  tasks: {
    type: 'array',
    items: obj({
      id: str,
      title: str,
      area: { type: 'string', enum: ['backend', 'frontend', 'fullstack'] },
      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
      instructions: str,
      acceptance: { type: 'array', items: str },
    }),
  },
});

/** Reject a plan the pipeline cannot execute. */
export function checkPlan(plan: Plan): void {
  if (!plan.tasks?.length) throw new Error('plan has no tasks');
  if (plan.tasks.length > 10) plan.tasks = plan.tasks.slice(0, 10);
  plan.demoAccounts ??= [];
  if (!['web', 'mobile', 'both'].includes(plan.platform)) plan.platform = 'web';
  for (const p of plan.pages) {
    if (plan.platform === 'web') p.surface = 'web';
    else if (plan.platform === 'mobile') p.surface = 'mobile';
    else if (p.surface !== 'mobile') p.surface = 'web';
  }
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) throw new Error(`plan has duplicate task id ${t.id}`);
    ids.add(t.id);
    if (!['easy', 'medium', 'hard'].includes(t.difficulty)) t.difficulty = 'medium';
  }
}

export interface ReviewIssue {
  severity: 'high' | 'medium' | 'low';
  file: string;
  problem: string;
  fix: string;
}

export interface Review {
  summary: string;
  issues: ReviewIssue[];
}

export const REVIEW_SCHEMA = obj({
  summary: str,
  issues: {
    type: 'array',
    items: obj({
      severity: { type: 'string', enum: ['high', 'medium', 'low'] },
      file: str,
      problem: str,
      fix: str,
    }),
  },
});
