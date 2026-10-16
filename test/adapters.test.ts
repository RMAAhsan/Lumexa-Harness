/**
 * The adapters against stub SDK clients: checks the exact request each
 * provider receives and how its response maps back to the neutral types.
 */
import type Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import { findModel, loadConfig } from '../src/config.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { OpenAIProvider } from '../src/llm/openai.js';
import type { ToolSpec } from '../src/llm/types.js';

const config = loadConfig({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' });
const lookup = (id: string) => findModel(config, id);
const TOOL: ToolSpec = {
  name: 'write_file',
  description: 'write',
  schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
};

function anthropicStub(replies: unknown[]) {
  const requests: Record<string, any>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          requests.push(structuredClone(params));
          const reply = replies.shift();
          return { finalMessage: async () => reply };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const anthropicUsage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 };

test('anthropic: agent turn request shape, tool calls, append-only history', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
  const { client, requests } = anthropicStub([
    {
      model: 'claude-sonnet-5-5',
      stop_reason: 'tool_use',
      usage: anthropicUsage,
      content: [thinking, { type: 'text', text: 'Writing.' }, { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'a.js' } }],
    },
    { model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: anthropicUsage, content: [{ type: 'text', text: 'Done.' }] },
  ]);
  const session = new AnthropicProvider(lookup, client).startSession({
    model: 'claude-sonnet-5-5',
    system: 'SYS',
    tools: [TOOL],
    effort: 'medium',
    maxTokens: 32000,
  });

  const t1 = await session.send('build it');
  assert.equal(t1.stop, 'tool_use');
  assert.deepEqual(t1.toolCalls, [{ id: 'tu_1', name: 'write_file', input: { path: 'a.js' } }]);
  assert.equal(t1.text, 'Writing.');
  assert.deepEqual(t1.usage, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 10 });

  const r1 = requests[0];
  assert.equal(r1.system, 'SYS');
  assert.deepEqual(r1.cache_control, { type: 'ephemeral' });
  assert.deepEqual(r1.output_config, { effort: 'medium' });
  assert.equal(r1.tool_choice, undefined, 'forced tool_choice 400s on Sonnet/Opus 5.5');
  assert.equal(r1.thinking, undefined, 'thinking stays at the model default');
  assert.equal(r1.tools[0].eager_input_streaming, true);
  assert.deepEqual(r1.tools[0].input_schema, TOOL.schema);
  assert.equal(r1.fallbacks, 'default');
  assert.deepEqual(r1.betas, ['server-side-fallback-2026-07-01']);

  const t2 = await session.send([{ id: 'tu_1', output: 'Wrote a.js' }]);
  assert.equal(t2.stop, 'done');
  assert.equal(t2.servedModel, 'claude-opus-4-8', 'a server-side fallback is reported');
  const msgs = requests[1].messages;
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[1].content[0], thinking, 'thinking block passed back unchanged');
  assert.deepEqual(msgs[2].content, [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Wrote a.js', is_error: false }]);
});

test('anthropic: models without serverFallback send no fallback params', async () => {
  const { client, requests } = anthropicStub([{ model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: anthropicUsage, content: [] }]);
  await new AnthropicProvider(lookup, client).startSession({ model: 'claude-haiku-5-5', system: 's', tools: [], maxTokens: 1000 }).send('hi');
  assert.equal(requests[0].fallbacks, undefined);
  assert.equal(requests[0].betas, undefined);
});

test('anthropic: max_tokens and refusal map to their stop kinds', async () => {
  const { client } = anthropicStub([
    { model: 'm', stop_reason: 'max_tokens', usage: anthropicUsage, content: [{ type: 'tool_use', id: 't', name: 'write_file', input: { path: 'a' } }] },
    { model: 'm', stop_reason: 'refusal', usage: anthropicUsage, content: [] },
  ]);
  const s = new AnthropicProvider(lookup, client).startSession({ model: 'claude-haiku-5-5', system: 's', tools: [TOOL], maxTokens: 10 });
  assert.equal((await s.send('a')).stop, 'max_tokens');
  assert.equal((await s.send([{ id: 't', output: 'x', isError: true }])).stop, 'refusal');
});

test('anthropic: structured output uses output_config.format json_schema', async () => {
  const { client, requests } = anthropicStub([
    { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: anthropicUsage, content: [{ type: 'text', text: '{"a":1}' }] },
  ]);
  const res = await new AnthropicProvider(lookup, client).structured({
    model: 'claude-opus-5-5', system: 's', prompt: 'p', schemaName: 'x', schema: { type: 'object' }, effort: 'high', maxTokens: 100,
  });
  assert.deepEqual(res.data, { a: 1 });
  assert.deepEqual(requests[0].output_config, { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'high' });
});

function openaiStub(replies: unknown[]) {
  const requests: Record<string, any>[] = [];
  const client = {
    responses: {
      async create(params: Record<string, unknown>) {
        requests.push(structuredClone(params));
        return replies.shift();
      },
    },
  };
  return { client: client as unknown as OpenAI, requests };
}

const openaiUsage = { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 600 } };

test('openai: function calls, call outputs, reasoning effort, cached-token split', async () => {
  const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [] };
  const { client, requests } = openaiStub([
    {
      model: 'gpt-6.1-sol', status: 'completed', usage: openaiUsage, output_text: '',
      output: [reasoningItem, { type: 'function_call', call_id: 'call_1', name: 'write_file', arguments: '{"path":"b.js"}' }],
    },
    {
      model: 'gpt-6.1-sol', status: 'completed', usage: openaiUsage, output_text: 'Done.',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }],
    },
  ]);
  const s = new OpenAIProvider(lookup, client).startSession({ model: 'gpt-6.1-sol', system: 'SYS', tools: [TOOL], effort: 'xhigh', maxTokens: 5000 });

  const t1 = await s.send('build');
  assert.deepEqual(t1.toolCalls, [{ id: 'call_1', name: 'write_file', input: { path: 'b.js' } }]);
  assert.equal(t1.stop, 'tool_use');
  assert.deepEqual(t1.usage, { inputTokens: 400, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 0 });
  assert.equal(requests[0].instructions, 'SYS');
  assert.deepEqual(requests[0].reasoning, { effort: 'high' }, 'xhigh maps to high');
  assert.deepEqual(requests[0].tools[0], { type: 'function', name: 'write_file', description: 'write', parameters: TOOL.schema, strict: false });

  const t2 = await s.send([{ id: 'call_1', output: 'boom', isError: true }]);
  assert.equal(t2.stop, 'done');
  assert.equal(t2.text, 'Done.');
  const input = requests[1].input;
  assert.deepEqual(input[1], reasoningItem, 'reasoning item passed back');
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'call_1', output: 'ERROR: boom' });
});

test('openai: non-reasoning models get no reasoning param; bad JSON args are flagged', async () => {
  const { client, requests } = openaiStub([
    { model: 'gpt-4o-mini', status: 'completed', usage: openaiUsage, output_text: '', output: [{ type: 'function_call', call_id: 'c', name: 'write_file', arguments: '{bad' }] },
  ]);
  const t = await new OpenAIProvider(lookup, client).startSession({ model: 'gpt-4o-mini', system: 's', tools: [TOOL], effort: 'high', maxTokens: 10 }).send('x');
  assert.equal(requests[0].reasoning, undefined);
  assert.deepEqual(t.toolCalls[0].input, { __invalid_json__: '{bad' });
});

test('openai: structured output uses strict json_schema text format', async () => {
  const { client, requests } = openaiStub([
    { model: 'gpt-6.1-sol', status: 'completed', usage: openaiUsage, output_text: '{"issues":[]}', output: [] },
  ]);
  const res = await new OpenAIProvider(lookup, client).structured({
    model: 'gpt-6.1-sol', system: 's', prompt: 'p', schemaName: 'code_review', schema: { type: 'object' }, maxTokens: 100,
  });
  assert.deepEqual(res.data, { issues: [] });
  assert.deepEqual(requests[0].text, { format: { type: 'json_schema', name: 'code_review', schema: { type: 'object' }, strict: true } });
});

const IMG = { mediaType: 'image/jpeg' as const, data: 'QUJD', label: 'Home, desktop' };

test('anthropic: screenshots are sent as labelled base64 image blocks before the prompt', async () => {
  const { client, requests } = anthropicStub([
    { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: anthropicUsage, content: [{ type: 'text', text: '{"score":7}' }] },
  ]);
  await new AnthropicProvider(lookup, client).structured({
    model: 'claude-opus-5-5', system: 's', prompt: 'Review.', schemaName: 'visual_review', schema: { type: 'object' }, maxTokens: 100, images: [IMG],
  });
  assert.deepEqual(requests[0].messages[0].content, [
    { type: 'text', text: 'Home, desktop' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    { type: 'text', text: 'Review.' },
  ]);
});

test('openai: screenshots are sent as input_image data URLs before the prompt', async () => {
  const { client, requests } = openaiStub([
    { model: 'gpt-6.1-sol', status: 'completed', usage: openaiUsage, output_text: '{"score":7}', output: [] },
  ]);
  await new OpenAIProvider(lookup, client).structured({
    model: 'gpt-6.1-sol', system: 's', prompt: 'Review.', schemaName: 'visual_review', schema: { type: 'object' }, maxTokens: 100, images: [IMG],
  });
  assert.deepEqual(requests[0].input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Home, desktop' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD', detail: 'high' },
        { type: 'input_text', text: 'Review.' },
      ],
    },
  ]);
});

test('anthropic: images on the first message and inside tool results', async () => {
  const { client, requests } = anthropicStub([
    { model: 'claude-sonnet-5-5', stop_reason: 'tool_use', usage: anthropicUsage, content: [{ type: 'tool_use', id: 't1', name: 'screenshot', input: {} }] },
    { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: anthropicUsage, content: [{ type: 'text', text: 'ok' }] },
  ]);
  const s = new AnthropicProvider(lookup, client).startSession({ model: 'claude-sonnet-5-5', system: 's', tools: [TOOL], maxTokens: 100 });
  await s.send('Fix these.', [IMG]);
  await s.send([{ id: 't1', output: 'Screenshot of /', images: [IMG] }]);
  assert.deepEqual(requests[0].messages[0].content, [
    { type: 'text', text: 'Home, desktop' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    { type: 'text', text: 'Fix these.' },
  ]);
  assert.deepEqual(requests[1].messages[2].content[0].content, [
    { type: 'text', text: 'Screenshot of /' },
    { type: 'text', text: 'Home, desktop' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
  ]);
});

test('openai: images inside function call outputs; image generation maps usage', async () => {
  const { client, requests } = openaiStub([
    { model: 'gpt-6.1-sol', status: 'completed', usage: openaiUsage, output_text: '', output: [{ type: 'function_call', call_id: 'c1', name: 'screenshot', arguments: '{}' }] },
    { model: 'gpt-6.1-sol', status: 'completed', usage: openaiUsage, output_text: 'ok', output: [] },
  ]);
  const s = new OpenAIProvider(lookup, client).startSession({ model: 'gpt-6.1-sol', system: 's', tools: [TOOL], maxTokens: 100 });
  await s.send('go');
  await s.send([{ id: 'c1', output: 'Screenshot of /', images: [IMG] }]);
  assert.deepEqual(requests[1].input[2].output, [
    { type: 'input_text', text: 'Screenshot of /' },
    { type: 'input_text', text: 'Home, desktop' },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD', detail: 'high' },
  ]);

  const calls: Record<string, unknown>[] = [];
  const imgClient = { images: { async generate(p: Record<string, unknown>) { calls.push(p); return { data: [{ b64_json: 'SU1H' }], usage: { input_tokens: 40, output_tokens: 1056 } }; } } };
  const out = await new OpenAIProvider(lookup, imgClient as unknown as OpenAI).generateImage({ model: 'gpt-image-2', prompt: 'p', size: '1536x1024' });
  assert.deepEqual(out, { data: 'SU1H', usage: { inputTokens: 40, outputTokens: 1056, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  assert.equal(calls[0].output_format, 'jpeg');
});
