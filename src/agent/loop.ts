/**
 * The provider-neutral agent loop: send, run the tool calls, send the results,
 * until the model stops calling tools (or a limit is hit). One loop = one model.
 */
import type { Effort } from '../config.js';
import type { CallContext } from '../cost/ledger.js';
import type { Gateway } from '../llm/gateway.js';
import { log } from '../log.js';
import type { ImageInput } from '../llm/types.js';
import type { Workspace } from './tools.js';

export interface AgentRun {
  stop: 'done' | 'max_turns' | 'refusal';
  turns: number;
  summary: string;
}

function describeCall(name: string, input: Record<string, unknown>): string {
  const v = input.path ?? input.command ?? '';
  return `${name} ${String(v).slice(0, 100)}`;
}

export async function runAgent(opts: {
  gateway: Gateway;
  workspace: Workspace;
  model: string;
  effort?: Effort;
  system: string;
  prompt: string;
  ctx: CallContext;
  maxTurns: number;
  maxTokens: number;
  /** Images attached to the first message (e.g. the reviewer's screenshots). */
  images?: ImageInput[];
}): Promise<AgentRun> {
  const session = opts.gateway.session({
    model: opts.model,
    effort: opts.effort,
    system: opts.system,
    tools: opts.workspace.specs(),
    maxTokens: opts.maxTokens,
    ctx: opts.ctx,
  });

  let res = await session.send(opts.prompt, opts.images);
  for (let turn = 1; ; turn++) {
    if (res.stop === 'refusal') return { stop: 'refusal', turns: turn, summary: res.text };
    if (res.toolCalls.length === 0) return { stop: 'done', turns: turn, summary: res.text.trim() };
    if (turn >= opts.maxTurns) return { stop: 'max_turns', turns: turn, summary: res.text.trim() };

    const truncated = res.stop === 'max_tokens';
    const results = [];
    for (const call of res.toolCalls) {
      const r = await opts.workspace.execute(call, truncated);
      log(`    ${r.isError ? '✗' : '·'} ${describeCall(call.name, call.input)}`);
      results.push(r);
    }
    res = await session.send(results);
  }
}
