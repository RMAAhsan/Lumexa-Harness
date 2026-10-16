/** Scripted models and shared files for the end-to-end tests (no API calls). */
import type { Provider } from '../src/config.js';
import type { GeneratedImage, LLMProvider, SessionOptions, StructuredOptions, ToolCall, ToolResult, TurnResult } from '../src/llm/types.js';
import type { DesignSpec } from '../src/pipeline/design.js';
import type { Plan, Review } from '../src/pipeline/plan.js';
import type { VisualReview } from '../src/pipeline/visual.js';

const scale = (hexes: string) => hexes.split(' ');
/** A real 48x32 JPEG (returned by the scripted image generator). */
export const TINY_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAgADADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAQIE/8QAFRABAQAAAAAAAAAAAAAAAAAAAAH/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/EABYRAQEBAAAAAAAAAAAAAAAAAAADBP/aAAwDAQACEQMRAD8AYYIYWuAzqiomKga53OqGCGB7nszPDBDFjdCZ1RUTFQNc7nVDBDA9z2Z//9k=';

export const DESIGN: DesignSpec = {
  brandName: 'Inkwell',
  tagline: 'Thoughts, kept beautifully.',
  direction: 'Quiet editorial notebook: warm paper tones, ink-blue accents, serif headlines.',
  mood: ['calm', 'editorial', 'warm'],
  mode: 'light',
  fonts: { display: 'Fraunces', body: 'Inter' },
  radius: 'soft',
  palette: {
    primary: scale('#eef4ff #dae6ff #bdd3ff #90b7ff #5c8ffd #3768f9 #2149ee #1a37db #1c2fb1 #1d2d8b #161d55'),
    accent: scale('#fff7ed #ffedd5'), // invalid length: the harness derives a scale
    ink: scale('#fafaf9 #f5f5f4 #e7e5e4 #d6d3d1 #a8a29e #78716c #57534e #44403c #292524 #1c1917 #0c0a09'),
  },
  typography: 'Large serif headlines, generous line height.',
  layout: 'Single column, wide margins.',
  components: 'Cards with hairline borders.',
  imagery: 'No photos; subtle gradient wash.',
  motion: 'Gentle fade-up on scroll.',
  pages: [{ route: '/', composition: 'Headline, add form, list of note cards.' }],
};

export const REVIEW: Review = {
  summary: 'Small API, one validation gap.',
  issues: [{ severity: 'medium', file: 'server/src/routes/notes.js', problem: 'text length is unbounded', fix: 'cap at 500 chars' }],
};

export const SCHEMA = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Note {
  id        Int      @id @default(autoincrement())
  text      String
  createdAt DateTime @default(now())
}
`;

export const notesRouter = (dbImport: string, max: number) => `import { Router } from 'express';
import { prisma } from '${dbImport}';
import { asyncHandler, HttpError } from '../errors.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await prisma.note.findMany({ orderBy: { id: 'asc' } }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) throw new HttpError(400, 'text is required');
  res.status(201).json(await prisma.note.create({ data: { text: text.slice(0, ${max}) } }));
}));

export default router;
`;

export const FILES_T1: Record<string, string> = {
  'server/prisma/schema.prisma': SCHEMA,
  // Bug on purpose: wrong db import path, so the first verification fails.
  'server/src/routes/notes.js': notesRouter('../database.js', 1000),
  'server/src/routes/index.js': `import { Router } from 'express';
import notesRouter from './notes.js';

const router = Router();
router.use('/notes', notesRouter);

export default router;
`,
  'server/prisma/seed.js': `import '../src/env.js';
import { prisma } from '../src/db.js';

async function main() {
  if ((await prisma.note.count()) === 0) await prisma.note.create({ data: { text: 'Welcome to Inkwell' } });
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
`,
  'server/test/notes.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { useTestDb } from './helpers.js';

useTestDb();

test('POST then GET /api/notes', async () => {
  const app = createApp();
  const created = await request(app).post('/api/notes').send({ text: 'hello' });
  assert.equal(created.status, 201);
  const list = await request(app).get('/api/notes');
  assert.deepEqual(list.body.map((n) => n.text), ['hello']);
});

test('POST /api/notes rejects empty text', async () => {
  const res = await request(createApp()).post('/api/notes').send({ text: ' ' });
  assert.equal(res.status, 400);
});
`,
};

/** A fake model: on the first turn it emits the scripted tool calls, then says it is done. */
export class ScriptedProvider implements LLMProvider {
  readonly sessions: { model: string; firstMessage: string }[] = [];
  readonly structuredCalls: { name: string; model: string; images: number }[] = [];
  /** Images the model was shown: in first messages and in tool results. */
  readonly imagesSeen: { where: 'message' | 'tool'; label: string }[] = [];
  readonly generated: string[] = [];
  private visualCalls = 0;
  constructor(
    readonly name: Provider,
    private readonly script: (opts: SessionOptions, firstMessage: string) => ToolCall[],
    private readonly answers: { plan?: Plan; visual?: VisualReview[] } = {},
  ) {}

  startSession(opts: SessionOptions) {
    let turn = 0;
    const send = async (message: string | ToolResult[], images?: { label: string }[]): Promise<TurnResult> => {
      turn++;
      for (const img of images ?? []) this.imagesSeen.push({ where: 'message', label: img.label });
      if (Array.isArray(message)) for (const r of message) for (const img of r.images ?? []) this.imagesSeen.push({ where: 'tool', label: img.label });
      const usage = { inputTokens: 2000, outputTokens: 800, cacheReadTokens: turn > 1 ? 1500 : 0, cacheWriteTokens: turn === 1 ? 1500 : 0 };
      if (turn === 1) {
        this.sessions.push({ model: opts.model, firstMessage: message as string });
        const calls = this.script(opts, message as string);
        return { text: '', toolCalls: calls, stop: calls.length ? 'tool_use' : 'done', usage, servedModel: opts.model };
      }
      return { text: `Done by ${opts.model}.`, toolCalls: [], stop: 'done', usage, servedModel: opts.model };
    };
    return { send };
  }

  async generateImage(opts: { model: string; prompt: string }): Promise<GeneratedImage> {
    this.generated.push(opts.prompt);
    return { data: TINY_JPEG, usage: { inputTokens: 60, outputTokens: 1056, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }

  async structured(opts: StructuredOptions) {
    this.structuredCalls.push({ name: opts.schemaName, model: opts.model, images: opts.images?.length ?? 0 });
    const data =
      opts.schemaName === 'build_plan' ? structuredClone(this.answers.plan)
      : opts.schemaName === 'design_direction' ? structuredClone(DESIGN)
      : opts.schemaName === 'visual_review' ? structuredClone(this.answers.visual![Math.min(this.visualCalls++, this.answers.visual!.length - 1)])
      : REVIEW;
    return { data, usage: { inputTokens: 3000, outputTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0 }, servedModel: opts.model };
  }
}

export const writes = (files: Record<string, string>): ToolCall[] =>
  Object.entries(files).map(([p, content], i) => ({ id: `w${i}`, name: 'write_file', input: { path: p, content } }));

