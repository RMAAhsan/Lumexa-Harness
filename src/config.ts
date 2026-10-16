/**
 * Loads .env, config/models.json and config/routing.json. Everything the
 * harness decides comes from these two files, so routing can be changed
 * without touching code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS_DIR = path.join(HARNESS_ROOT, 'runs');
export const TEMPLATE_DIR = path.join(HARNESS_ROOT, 'templates', 'express-react');

export type Provider = 'anthropic' | 'openai';
export type Tier = 'fast' | 'standard' | 'frontier' | 'max';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelInfo {
  id: string;
  provider: Provider;
  tier: Tier;
  price: Price;
  priceVerified: boolean;
  /** Prompts above this many tokens bill at the long-context price. */
  longContext?: { aboveTokens: number; price: Price };
  /** Send Anthropic's server-side refusal fallback (`fallbacks: "default"`). */
  serverFallback?: boolean;
  /** OpenAI: accepts `reasoning.effort`. */
  reasoning?: boolean;
  /** false = never chosen by the router (priced only because it can appear as a fallback). */
  routable?: boolean;
  /** 'image' = an image generation model (used by the get_image tool, never routed for text). */
  kind?: 'image';
  note: string;
}

export interface RouteEntry {
  model: string;
  effort?: Effort;
  why: string;
  fallback?: string;
}

export interface RoutingConfig {
  phases: {
    plan: RouteEntry;
    /** byDifficulty for backend tasks; ui (if set) for every frontend/fullstack task. */
    build: { byDifficulty: Record<Difficulty, RouteEntry>; ui?: RouteEntry };
    repair: { chain: RouteEntry[] };
    review: RouteEntry;
    fix_review: RouteEntry;
    design: RouteEntry;
    visual_review: RouteEntry;
    design_fix: RouteEntry;
  };
  learning: { minSamples: number; minSuccessRate: number };
  limits: {
    agentMaxTurns: number;
    maxTokensPerTurn: number;
    maxReviewFixes: number;
    /** Screenshot -> vision review -> fix rounds. 0 disables the visual review. */
    visualRounds: number;
    /** Stop the visual rounds once the design scores at least this (1-10). */
    visualTargetScore: number;
    /** get_image calls per run (generated images cost money). */
    maxImages: number;
    /** get_video calls per run (each is 5-40 MB in the app). */
    maxVideos: number;
  };
}

export interface HarnessConfig {
  models: ModelInfo[];
  routing: RoutingConfig;
  /** Providers with an API key present. */
  available: Set<Provider>;
}

export const TIER_RANK: Record<Tier, number> = { fast: 0, standard: 1, frontier: 2, max: 3 };

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function loadEnv(): void {
  const envFile = path.join(HARNESS_ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const { models } = readJson<{ models: ModelInfo[] }>(path.join(HARNESS_ROOT, 'config', 'models.json'));
  const routing = readJson<RoutingConfig>(path.join(HARNESS_ROOT, 'config', 'routing.json'));
  const available = new Set<Provider>();
  if (env.ANTHROPIC_API_KEY?.trim()) available.add('anthropic');
  if (env.OPENAI_API_KEY?.trim()) available.add('openai');
  validateRouting(models, routing);
  return { models, routing, available };
}

/** Fail fast on a routing entry that names a model the catalog does not price. */
export function validateRouting(models: ModelInfo[], routing: RoutingConfig): void {
  const known = new Set(models.map((m) => m.id));
  const p = routing.phases;
  const entries: [string, RouteEntry][] = [
    ['plan', p.plan],
    ['review', p.review],
    ['fix_review', p.fix_review],
    ['design', p.design],
    ['visual_review', p.visual_review],
    ['design_fix', p.design_fix],
    ...Object.entries(p.build.byDifficulty).map(([d, e]) => [`build.${d}`, e] as [string, RouteEntry]),
    ...(p.build.ui ? [['build.ui', p.build.ui] as [string, RouteEntry]] : []),
    ...p.repair.chain.map((e, i) => [`repair[${i}]`, e] as [string, RouteEntry]),
  ];
  for (const [where, e] of entries) {
    if (!known.has(e.model)) throw new Error(`config/routing.json ${where}: model "${e.model}" is not in config/models.json`);
    if (e.fallback && !known.has(e.fallback)) {
      throw new Error(`config/routing.json ${where}: fallback "${e.fallback}" is not in config/models.json`);
    }
  }
}

export function findModel(config: HarnessConfig, id: string): ModelInfo | undefined {
  return config.models.find((m) => m.id === id) ?? config.models.find((m) => id.startsWith(`${m.id}-`));
}
