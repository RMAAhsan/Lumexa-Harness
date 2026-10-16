/**
 * The cost ledger: one entry per LLM call, priced at the model that actually
 * served it. Every number in REPORT.md comes from here.
 */
import fs from 'node:fs';
import { findModel, type HarnessConfig, type Provider } from '../config.js';
import type { Usage } from '../llm/types.js';

export interface CallContext {
  /** Workflow step this call belongs to (see pipeline/steps.ts). */
  stepId: string;
  phase: string;
  taskId?: string;
}

export interface LedgerEntry extends CallContext {
  seq: number;
  at: string;
  requestedModel: string;
  servedModel: string;
  provider: Provider;
  usage: Usage;
  /** null when the served model has no price in config/models.json. */
  costUsd: number | null;
  priceVerified: boolean;
  durationMs: number;
}

export class BudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(`budget exhausted: spent $${spent.toFixed(4)} of $${budget.toFixed(2)}`);
  }
}

/** Cost of one call in USD, or null if the model is not priced. */
export function priceCall(config: HarnessConfig, modelId: string, usage: Usage): { costUsd: number | null; priceVerified: boolean } {
  const model = findModel(config, modelId);
  if (!model) return { costUsd: null, priceVerified: false };
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const p = model.longContext && promptTokens > model.longContext.aboveTokens ? model.longContext.price : model.price;
  const costUsd =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000;
  return { costUsd, priceVerified: model.priceVerified };
}

export class Ledger {
  readonly entries: LedgerEntry[] = [];

  constructor(
    private readonly config: HarnessConfig,
    readonly budgetUsd: number,
    private readonly file?: string,
  ) {}

  get totalUsd(): number {
    return this.entries.reduce((s, e) => s + (e.costUsd ?? 0), 0);
  }

  /** Called before every LLM request. */
  assertBudget(): void {
    if (this.totalUsd >= this.budgetUsd) throw new BudgetExceededError(this.totalUsd, this.budgetUsd);
  }

  record(e: Omit<LedgerEntry, 'seq' | 'at' | 'costUsd' | 'priceVerified'>): LedgerEntry {
    const entry: LedgerEntry = {
      ...e,
      seq: this.entries.length + 1,
      at: new Date().toISOString(),
      ...priceCall(this.config, e.servedModel, e.usage),
    };
    this.entries.push(entry);
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
    return entry;
  }

  sumWhere(pred: (e: LedgerEntry) => boolean): { calls: number; costUsd: number; usage: Usage } {
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let costUsd = 0;
    let calls = 0;
    for (const e of this.entries) {
      if (!pred(e)) continue;
      calls++;
      costUsd += e.costUsd ?? 0;
      usage.inputTokens += e.usage.inputTokens;
      usage.outputTokens += e.usage.outputTokens;
      usage.cacheReadTokens += e.usage.cacheReadTokens;
      usage.cacheWriteTokens += e.usage.cacheWriteTokens;
    }
    return { calls, costUsd, usage };
  }

  /** Totals grouped by a key (model, phase, provider...). */
  groupBy(key: (e: LedgerEntry) => string): Map<string, { calls: number; costUsd: number; usage: Usage; unverified: boolean }> {
    const out = new Map<string, { calls: number; costUsd: number; usage: Usage; unverified: boolean }>();
    for (const k of new Set(this.entries.map(key))) {
      const sum = this.sumWhere((e) => key(e) === k);
      out.set(k, { ...sum, unverified: this.entries.some((e) => key(e) === k && !e.priceVerified) });
    }
    return out;
  }
}
