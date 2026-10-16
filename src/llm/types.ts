/**
 * The provider-neutral contract. The agent loop and the pipeline only see these
 * types; src/llm/anthropic.ts and src/llm/openai.ts translate to each wire format.
 *
 * A session keeps its provider's native history internally (Anthropic thinking
 * blocks, OpenAI reasoning items) and is always append-only, so one task never
 * switches model mid-conversation: the router picks per task, not per turn.
 */
import type { Effort } from '../config.js';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  output: string;
  isError?: boolean;
  /** e.g. a screenshot the tool took, shown to the model after the text. */
  images?: ImageInput[];
}

export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopKind = 'done' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stop: StopKind;
  usage: Usage;
  /** The model that actually answered (differs from the requested one after a server-side fallback). */
  servedModel: string;
}

export interface SessionOptions {
  model: string;
  system: string;
  tools: ToolSpec[];
  effort?: Effort;
  maxTokens: number;
}

export interface AgentSession {
  /** A user message (first turn) or the results of the previous turn's tool calls. */
  send(message: string | ToolResult[], images?: ImageInput[]): Promise<TurnResult>;
}

export interface ImageInput {
  mediaType: 'image/png' | 'image/jpeg';
  /** base64, no data: prefix */
  data: string;
  /** Text placed right before the image (e.g. "Home page, desktop"). */
  label: string;
}

export interface StructuredOptions {
  model: string;
  system: string;
  prompt: string;
  schemaName: string;
  /** Strict JSON Schema: every object lists all properties in `required` and sets additionalProperties: false. */
  schema: Record<string, unknown>;
  effort?: Effort;
  maxTokens: number;
  /** Screenshots etc., sent before the prompt. */
  images?: ImageInput[];
}

/**
 * A call that failed AFTER the provider billed it (output cut off at the token
 * limit, a refusal, an incomplete answer). The gateway records its usage in the
 * ledger before rethrowing, so the run's cost stays honest.
 */
export class BilledCallError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
    readonly servedModel: string,
  ) {
    super(message);
    this.name = 'BilledCallError';
  }
}

export interface StructuredResult {
  data: unknown;
  usage: Usage;
  servedModel: string;
}

export interface GeneratedImage {
  /** base64 JPEG */
  data: string;
  usage: Usage;
}

export interface LLMProvider {
  startSession(opts: SessionOptions): AgentSession;
  structured(opts: StructuredOptions): Promise<StructuredResult>;
  /** Only providers with an image model implement this. */
  generateImage?(opts: { model: string; prompt: string; size: '1024x1024' | '1536x1024' | '1024x1536' }): Promise<GeneratedImage>;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
