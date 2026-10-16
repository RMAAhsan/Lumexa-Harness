/**
 * The brain: which model runs each step, and why.
 *
 * Decision order for every step:
 *   1. the phase's entry in config/routing.json (build: by task difficulty);
 *   2. learning: if runs/history.jsonl shows this model failing this kind of
 *      task (rate < minSuccessRate over >= minSamples), step up to the next
 *      stronger routable model of the same provider;
 *   3. availability: if the model's provider has no API key, use the entry's
 *      `fallback`, else the closest-tier model of a provider that has a key.
 *
 * Every decision carries a human-readable reason; REPORT.md prints them all.
 * Deterministic: no LLM call is spent on routing.
 */
import { findModel, TIER_RANK, type Difficulty, type Effort, type HarnessConfig, type ModelInfo, type RouteEntry } from '../config.js';
import type { History } from './history.js';

export interface Decision {
  phase: string;
  /** The history category this decision is learned under (difficulty, 'ui', 'attempt-2'...). */
  kind: string;
  taskId?: string;
  model: string;
  provider: string;
  effort?: Effort;
  /** Why this model, in order: config reason, then any learning/availability adjustments. */
  reasons: string[];
}

export class Router {
  readonly decisions: Decision[] = [];

  constructor(
    private readonly config: HarnessConfig,
    private readonly history: History,
  ) {}

  private info(id: string): ModelInfo {
    const m = findModel(this.config, id);
    if (!m) throw new Error(`model "${id}" is not in config/models.json`);
    return m;
  }

  /** Next stronger routable model of the same provider, if any. */
  private stepUp(model: ModelInfo): ModelInfo | undefined {
    return this.config.models
      .filter((m) => m.provider === model.provider && m.routable !== false && TIER_RANK[m.tier] > TIER_RANK[model.tier])
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])[0];
  }

  /** Closest-tier routable model from a provider that has a key. */
  private substitute(model: ModelInfo): ModelInfo | undefined {
    return this.config.models
      .filter((m) => m.routable !== false && this.config.available.has(m.provider) && m.tier !== 'max')
      .sort((a, b) => Math.abs(TIER_RANK[a.tier] - TIER_RANK[model.tier]) - Math.abs(TIER_RANK[b.tier] - TIER_RANK[model.tier]))[0];
  }

  private resolve(phase: string, kind: string, entry: RouteEntry, taskId?: string): Decision {
    const reasons = [entry.why];
    let model = this.info(entry.model);

    const { minSamples, minSuccessRate } = this.config.routing.learning;
    for (;;) {
      const s = this.history.stats(phase, kind, model.id);
      if (s.n < minSamples || s.rate >= minSuccessRate) break;
      const up = this.stepUp(model);
      if (!up) break;
      reasons.push(
        `learned: ${model.id} passed ${s.passed}/${s.n} past ${phase}/${kind} tasks (< ${Math.round(minSuccessRate * 100)}%), stepped up to ${up.id}`,
      );
      model = up;
    }

    if (!this.config.available.has(model.provider)) {
      const fb = entry.fallback ? this.info(entry.fallback) : undefined;
      const sub = fb && this.config.available.has(fb.provider) ? fb : this.substitute(model);
      if (!sub) throw new Error(`no API key for any provider that can run ${phase} (wanted ${model.id})`);
      reasons.push(`no ${model.provider.toUpperCase()} key: ${model.id} unavailable, using ${sub.id}`);
      model = sub;
    }

    const d: Decision = { phase, kind, taskId, model: model.id, provider: model.provider, effort: entry.effort, reasons };
    this.decisions.push(d);
    return d;
  }

  plan(): Decision {
    return this.resolve('plan', 'plan', this.config.routing.phases.plan);
  }

  /** Backend tasks by difficulty; UI tasks (frontend/fullstack) on the `ui` entry when configured. */
  build(taskId: string, difficulty: Difficulty, area: 'backend' | 'frontend' | 'fullstack' = 'backend'): Decision {
    const { ui, byDifficulty } = this.config.routing.phases.build;
    if (ui && area !== 'backend') return this.resolve('build', 'ui', ui, taskId);
    return this.resolve('build', difficulty, byDifficulty[difficulty], taskId);
  }

  /** Repair chain position `attempt` (0-based), or undefined when the chain is exhausted. */
  repair(taskId: string, attempt: number): Decision | undefined {
    const entry = this.config.routing.phases.repair.chain[attempt];
    return entry ? this.resolve('repair', `attempt-${attempt + 1}`, entry, taskId) : undefined;
  }

  repairChainLength(): number {
    return this.config.routing.phases.repair.chain.length;
  }

  /**
   * The attempt after `attempt`. A repair that left the failure exactly as it
   * was skips the rest of the middle of the chain: the next cheap model is
   * unlikely to do better, so the strongest one gets the next try.
   */
  nextRepairAttempt(attempt: number, unchanged: boolean): number {
    const last = this.repairChainLength() - 1;
    return unchanged ? Math.max(attempt + 1, last) : attempt + 1;
  }

  review(): Decision {
    return this.resolve('review', 'review', this.config.routing.phases.review);
  }

  design(): Decision {
    return this.resolve('design', 'design', this.config.routing.phases.design);
  }

  visualReview(round: number): Decision {
    return this.resolve('visual_review', 'visual_review', this.config.routing.phases.visual_review, `visual-${round}`);
  }

  designFix(round: number): Decision {
    return this.resolve('design_fix', 'design_fix', this.config.routing.phases.design_fix, `visual-${round}`);
  }

  fixReview(): Decision {
    return this.resolve('fix_review', 'fix_review', this.config.routing.phases.fix_review, 'review-fixes');
  }
}
