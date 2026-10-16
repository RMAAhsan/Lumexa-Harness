/**
 * Anthropic adapter (Messages API, streamed).
 *
 * - Tool use runs on tool_choice "auto": Opus 5.5 / Sonnet 5.5 reject forced tool choice.
 * - Thinking is left at the model default (adaptive); depth is set with output_config.effort.
 * - Top-level cache_control caches the growing conversation prefix on every turn.
 * - Models marked serverFallback send `fallbacks: "default"`, so a safety
 *   decline is re-run server-side; the ledger prices whichever model served.
 * - History is append-only: response.content (thinking blocks included) is
 *   pushed back unchanged.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaImageBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ModelInfo } from '../config.js';
import type {
  AgentSession,
  ImageInput,
  LLMProvider,
  SessionOptions,
  StopKind,
  StructuredOptions,
  StructuredResult,
  ToolResult,
  TurnResult,
  Usage,
} from './types.js';
import { BilledCallError } from './types.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Re-issue a turn whose streamed tool input could not be parsed at all. */
const MAX_JSON_RETRIES = 2;

function usageOf(msg: BetaMessage): Usage {
  return {
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
  };
}

function stopOf(msg: BetaMessage): StopKind {
  switch (msg.stop_reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'done';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

/** Each image as a label text block followed by the base64 image block. */
function imageBlocks(images: ImageInput[]): (BetaTextBlockParam | BetaImageBlockParam)[] {
  return images.flatMap((img) => [
    { type: 'text' as const, text: img.label },
    { type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } },
  ]);
}

function textOf(content: BetaContentBlock[]): string {
  return content
    .filter((b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;

  constructor(
    private readonly lookup: (id: string) => ModelInfo | undefined,
    /** Tests pass a stub client; normally the SDK reads the key from the environment. */
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  private fallbackParams(model: string): Pick<MessageCreateParamsNonStreaming, 'betas' | 'fallbacks'> {
    return this.lookup(model)?.serverFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {};
  }

  /** One streamed request; retries only the "tool input was not valid JSON" case. */
  private async complete(params: MessageCreateParamsNonStreaming): Promise<BetaMessage> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.beta.messages.stream(params).finalMessage();
      } catch (err) {
        if (err instanceof Anthropic.APIError || attempt >= MAX_JSON_RETRIES) throw err;
      }
    }
  }

  startSession(opts: SessionOptions): AgentSession {
    const messages: BetaMessageParam[] = [];
    const tools: BetaTool[] = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema as BetaTool['input_schema'],
      // Large file writes stream as they are generated. The server no longer
      // validates these inputs, so agent/tools.ts validates every one.
      eager_input_streaming: true,
    }));

    const send = async (message: string | ToolResult[], images?: ImageInput[]): Promise<TurnResult> => {
      if (typeof message === 'string') {
        messages.push({ role: 'user', content: images?.length ? [...imageBlocks(images), { type: 'text', text: message }] : message });
      } else {
        const results: BetaToolResultBlockParam[] = message.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.images?.length ? [{ type: 'text', text: r.output }, ...imageBlocks(r.images)] : r.output,
          is_error: r.isError ?? false,
        }));
        messages.push({ role: 'user', content: results });
      }

      const msg = await this.complete({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        tools,
        messages,
        cache_control: { type: 'ephemeral' },
        ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
        ...this.fallbackParams(opts.model),
      });
      messages.push({ role: 'assistant', content: msg.content });

      const toolCalls = msg.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : [],
      );
      let stop = stopOf(msg);
      if (stop === 'done' && toolCalls.length > 0) stop = 'tool_use';
      return { text: textOf(msg.content), toolCalls, stop, usage: usageOf(msg), servedModel: msg.model };
    };

    return { send };
  }

  async structured(opts: StructuredOptions): Promise<StructuredResult> {
    const msg = await this.complete({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: 'user', content: opts.images?.length ? [...imageBlocks(opts.images), { type: 'text', text: opts.prompt }] : opts.prompt }],
      output_config: {
        format: { type: 'json_schema', schema: opts.schema },
        ...(opts.effort ? { effort: opts.effort } : {}),
      },
      ...this.fallbackParams(opts.model),
    });
    const stop = stopOf(msg);
    if (stop === 'refusal') throw new BilledCallError(`${msg.model} declined the ${opts.schemaName} request`, usageOf(msg), msg.model);
    if (stop === 'max_tokens') {
      throw new BilledCallError(`${opts.schemaName} output was cut off at max_tokens (${opts.maxTokens})`, usageOf(msg), msg.model);
    }
    return { data: JSON.parse(textOf(msg.content)), usage: usageOf(msg), servedModel: msg.model };
  }
}
