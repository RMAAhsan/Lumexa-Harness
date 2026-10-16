/**
 * OpenAI adapter (Responses API).
 *
 * - Function tools; the model's output items (reasoning, messages, calls) are
 *   appended back to `input` unchanged, so the session is append-only like the
 *   Anthropic one.
 * - `reasoning.effort` is sent only to models marked `reasoning` in models.json:
 *   a non-reasoning model rejects it with a 400.
 * - Usage: `input_tokens` includes cached tokens, so cached ones are split out
 *   to be priced at the cache-read rate.
 */
import OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputContent,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import type { Effort, ModelInfo } from '../config.js';
import type {
  AgentSession,
  GeneratedImage,
  ImageInput,
  LLMProvider,
  SessionOptions,
  StopKind,
  StructuredOptions,
  StructuredResult,
  ToolCall,
  ToolResult,
  TurnResult,
  Usage,
} from './types.js';
import { BilledCallError } from './types.js';

type OpenAIEffort = 'low' | 'medium' | 'high';

function mapEffort(e: Effort | undefined): OpenAIEffort | undefined {
  if (!e) return undefined;
  return e === 'xhigh' || e === 'max' ? 'high' : e;
}

function usageOf(res: Response): Usage {
  const cached = res.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: (res.usage?.input_tokens ?? 0) - cached,
    outputTokens: res.usage?.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** Each image as a label text part followed by the image as a data URL. */
function imageParts(images: ImageInput[]): ResponseInputContent[] {
  return images.flatMap((img): ResponseInputContent[] => [
    { type: 'input_text', text: img.label },
    { type: 'input_image', image_url: `data:${img.mediaType};base64,${img.data}`, detail: 'high' },
  ]);
}

function refused(res: Response): boolean {
  return res.output.some((item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal'));
}

export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;

  constructor(
    private readonly lookup: (id: string) => ModelInfo | undefined,
    /** Tests pass a stub client; normally the SDK reads the key from the environment. */
    client?: OpenAI,
  ) {
    this.client = client ?? new OpenAI();
  }

  private reasoningParams(model: string, effort: Effort | undefined): Pick<ResponseCreateParamsNonStreaming, 'reasoning'> {
    const e = mapEffort(effort);
    return this.lookup(model)?.reasoning && e ? { reasoning: { effort: e } } : {};
  }

  startSession(opts: SessionOptions): AgentSession {
    const input: ResponseInputItem[] = [];
    const tools = opts.tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.schema,
      strict: false,
    }));

    const send = async (message: string | ToolResult[], images?: ImageInput[]): Promise<TurnResult> => {
      if (typeof message === 'string') {
        input.push({ role: 'user', content: images?.length ? [...imageParts(images), { type: 'input_text', text: message }] : message });
      } else {
        for (const r of message) {
          const text = r.isError ? `ERROR: ${r.output}` : r.output;
          input.push({
            type: 'function_call_output',
            call_id: r.id,
            output: r.images?.length ? [{ type: 'input_text', text }, ...imageParts(r.images)] : text,
          });
        }
      }

      const res = await this.client.responses.create({
        model: opts.model,
        instructions: opts.system,
        input,
        tools,
        max_output_tokens: opts.maxTokens,
        ...this.reasoningParams(opts.model, opts.effort),
      });
      input.push(...(res.output as ResponseInputItem[]));

      const toolCalls: ToolCall[] = [];
      for (const item of res.output) {
        if (item.type !== 'function_call') continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(item.arguments) as Record<string, unknown>;
        } catch {
          // Let tools.ts report the bad input back to the model.
          parsed = { __invalid_json__: item.arguments };
        }
        toolCalls.push({ id: item.call_id, name: item.name, input: parsed });
      }

      let stop: StopKind = toolCalls.length > 0 ? 'tool_use' : 'done';
      if (res.status === 'incomplete' && res.incomplete_details?.reason === 'max_output_tokens') stop = 'max_tokens';
      if (refused(res)) stop = 'refusal';
      return { text: res.output_text ?? '', toolCalls, stop, usage: usageOf(res), servedModel: res.model };
    };

    return { send };
  }

  async generateImage(opts: { model: string; prompt: string; size: '1024x1024' | '1536x1024' | '1024x1536' }): Promise<GeneratedImage> {
    const res = await this.client.images.generate({
      model: opts.model,
      prompt: opts.prompt,
      size: opts.size,
      quality: 'medium',
      output_format: 'jpeg',
      output_compression: 85,
      n: 1,
    });
    const data = res.data?.[0]?.b64_json;
    if (!data) throw new Error('image generation returned no image');
    return {
      data,
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }

  async structured(opts: StructuredOptions): Promise<StructuredResult> {
    const res = await this.client.responses.create({
      model: opts.model,
      instructions: opts.system,
      input: opts.images?.length ? [{ role: 'user', content: [...imageParts(opts.images), { type: 'input_text', text: opts.prompt }] }] : opts.prompt,
      max_output_tokens: opts.maxTokens,
      text: { format: { type: 'json_schema', name: opts.schemaName, schema: opts.schema, strict: true } },
      ...this.reasoningParams(opts.model, opts.effort),
    });
    if (refused(res)) throw new BilledCallError(`${res.model} declined the ${opts.schemaName} request`, usageOf(res), res.model);
    if (res.status === 'incomplete') {
      throw new BilledCallError(
        `${opts.schemaName} output incomplete (${res.incomplete_details?.reason ?? 'unknown'})`,
        usageOf(res),
        res.model,
      );
    }
    return { data: JSON.parse(res.output_text), usage: usageOf(res), servedModel: res.model };
  }
}
