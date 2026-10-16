/**
 * The gateway: the single door every LLM call goes through. It picks the
 * provider for a model, checks the budget before each request, and records
 * every response in the ledger with the step it belongs to.
 */
import { findModel, type Effort, type HarnessConfig, type Provider } from '../config.js';
import type { CallContext, Ledger } from '../cost/ledger.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { BilledCallError, type AgentSession, type ImageInput, type LLMProvider, type ToolResult, type ToolSpec, type TurnResult } from './types.js';

export type ProviderFactory = (provider: Provider) => LLMProvider;

export class Gateway {
  private readonly providers = new Map<Provider, LLMProvider>();
  private readonly factory: ProviderFactory;

  constructor(
    private readonly config: HarnessConfig,
    readonly ledger: Ledger,
    /** Tests inject scripted providers here. */
    factory?: ProviderFactory,
  ) {
    const lookup = (id: string) => findModel(config, id);
    this.factory =
      factory ?? ((p) => (p === 'anthropic' ? new AnthropicProvider(lookup) : new OpenAIProvider(lookup)));
  }

  private providerFor(model: string): { name: Provider; impl: LLMProvider } {
    const info = findModel(this.config, model);
    if (!info) throw new Error(`model "${model}" is not in config/models.json`);
    let impl = this.providers.get(info.provider);
    if (!impl) {
      impl = this.factory(info.provider);
      this.providers.set(info.provider, impl);
    }
    return { name: info.provider, impl };
  }

  session(opts: { model: string; effort?: Effort; system: string; tools: ToolSpec[]; maxTokens: number; ctx: CallContext }): AgentSession {
    const { name, impl } = this.providerFor(opts.model);
    const inner = impl.startSession(opts);
    return {
      send: async (message: string | ToolResult[], images?: ImageInput[]): Promise<TurnResult> => {
        this.ledger.assertBudget();
        const started = Date.now();
        const res = await inner.send(message, images);
        this.ledger.record({
          ...opts.ctx,
          requestedModel: opts.model,
          servedModel: res.servedModel || opts.model,
          provider: name,
          usage: res.usage,
          durationMs: Date.now() - started,
        });
        return res;
      },
    };
  }

  /** The image model available with the configured keys, if any. */
  imageModel(): string | undefined {
    return this.config.models.find((m) => m.kind === 'image' && this.config.available.has(m.provider))?.id;
  }

  /** Generate an image (budget-checked, priced in the ledger). Returns base64 JPEG. */
  async image(opts: { prompt: string; size: '1024x1024' | '1536x1024' | '1024x1536'; ctx: CallContext }): Promise<string> {
    const model = this.imageModel();
    if (!model) throw new Error('no image model available (needs OPENAI_API_KEY)');
    const { name, impl } = this.providerFor(model);
    if (!impl.generateImage) throw new Error(`${name} cannot generate images`);
    this.ledger.assertBudget();
    const started = Date.now();
    const res = await impl.generateImage({ model, prompt: opts.prompt, size: opts.size });
    this.ledger.record({ ...opts.ctx, requestedModel: model, servedModel: model, provider: name, usage: res.usage, durationMs: Date.now() - started });
    return res.data;
  }

  async structured<T>(opts: {
    model: string;
    effort?: Effort;
    system: string;
    prompt: string;
    schemaName: string;
    schema: Record<string, unknown>;
    maxTokens: number;
    images?: ImageInput[];
    ctx: CallContext;
  }): Promise<T> {
    const { name, impl } = this.providerFor(opts.model);
    this.ledger.assertBudget();
    const started = Date.now();
    const res = await impl.structured(opts).catch((err: unknown) => {
      // Billed even though it failed: charge it, then let the caller see the error.
      if (err instanceof BilledCallError) {
        this.ledger.record({
          ...opts.ctx,
          requestedModel: opts.model,
          servedModel: err.servedModel || opts.model,
          provider: name,
          usage: err.usage,
          durationMs: Date.now() - started,
        });
      }
      throw err;
    });
    this.ledger.record({
      ...opts.ctx,
      requestedModel: opts.model,
      servedModel: res.servedModel || opts.model,
      provider: name,
      usage: res.usage,
      durationMs: Date.now() - started,
    });
    return res.data as T;
  }
}
