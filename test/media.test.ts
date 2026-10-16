/** Media tools against a stubbed network: Unsplash/Pexels parsing, fallbacks, variants, files and credits. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { mediaTools, searchPexelsVideos, type MediaToolOptions } from '../src/agent/media.js';
import { Workspace } from '../src/agent/tools.js';
import type { Gateway } from '../src/llm/gateway.js';
import { TINY_JPEG } from './fixtures.js';

const realFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const JPEG = Buffer.from(TINY_JPEG, 'base64');
const BIG = Buffer.concat([JPEG, Buffer.alloc(30_000)]);

/** Route table: URL substring -> response. Records every URL fetched. */
function stubFetch(routes: [string, () => Response][]): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const hit = routes.find(([k]) => url.includes(k));
    return hit ? hit[1]() : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return seen;
}
const json = (body: unknown) => () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const bytes = (b: Buffer, type = 'image/jpeg') => () => new Response(new Uint8Array(b), { headers: { 'content-type': type, 'content-length': String(b.length) } });

function setup(keys: MediaToolOptions['keys'], canGenerate = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  roots.push(root);
  const ws = new Workspace(root);
  const generated: string[] = [];
  const gateway = {
    imageModel: () => (canGenerate ? 'gpt-image-2' : undefined),
    image: async (o: { prompt: string }) => {
      generated.push(o.prompt);
      return TINY_JPEG;
    },
  } as unknown as Gateway;
  const tools = mediaTools({ gateway, workspace: ws, keys, ctx: () => ({ stepId: 's', phase: 'build' }), limits: { images: 2, videos: 1 }, counter: { images: 0, videos: 0 } });
  const tool = (name: string) => tools.find((t) => t.spec.name === name)!;
  return { root, ws, tools, tool, generated };
}

const unsplashResults = {
  results: [
    { urls: { raw: 'https://images.unsplash.com/photo-1?ixid=x' }, user: { name: 'Ana' }, links: { html: 'https://unsplash.com/p/1', download_location: 'https://api.unsplash.com/photos/1/download' } },
    { urls: { raw: 'https://images.unsplash.com/photo-2?ixid=y' }, user: { name: 'Ben' }, links: { html: 'https://unsplash.com/p/2', download_location: 'https://api.unsplash.com/photos/2/download' } },
  ],
};

test('get_image: Unsplash photo saved to server/public/media with credit, download ping, and shown to the agent', async () => {
  const seen = stubFetch([
    ['api.unsplash.com/search/photos', json(unsplashResults)],
    ['api.unsplash.com/photos/2/download', json({})],
    ['images.unsplash.com/photo-2', bytes(BIG)],
  ]);
  const { root, tool } = setup({ unsplash: 'U', pexels: 'P' });
  const r = await tool('get_image').run({ query: 'kitesurfer lagoon', kind: 'photo', aspect: 'landscape', filename: 'hero', variant: 2 });
  assert.equal(r.isError, undefined, r.output);
  assert.ok(fs.readFileSync(path.join(root, 'server/public/media/hero.jpg')).equals(BIG));
  assert.match(fs.readFileSync(path.join(root, 'server/public/media/CREDITS.md'), 'utf8'), /hero\.jpg: Photo by Ben on Unsplash/);
  assert.match(r.output, /\/media\/hero\.jpg/);
  assert.equal(r.images?.length, 1);
  assert.ok(seen.some((u) => u.includes('orientation=landscape') && u.includes('kitesurfer%20lagoon')));
  assert.ok(seen.some((u) => u.includes('&w=2000&q=80&fm=jpg')));
  await new Promise((res) => setTimeout(res, 10));
  assert.ok(seen.includes('https://api.unsplash.com/photos/2/download'), 'Unsplash download_location pinged');
});

test('get_image: falls back Unsplash -> Pexels; illustrations are generated first', async () => {
  stubFetch([
    ['api.unsplash.com', () => new Response('rate limited', { status: 403 })],
    ['api.pexels.com/v1/search', json({ photos: [{ src: { large2x: 'https://images.pexels.com/p1.jpg' }, photographer: 'Cy', url: 'https://pexels.com/p1' }] })],
    ['images.pexels.com/p1.jpg', bytes(BIG)],
  ]);
  const { root, tool, generated } = setup({ unsplash: 'U', pexels: 'P' }, true);
  const photo = await tool('get_image').run({ query: 'beach', kind: 'photo', aspect: 'square', filename: 'beach', variant: 1 });
  assert.match(photo.output, /Photo by Cy on Pexels/);
  const art = await tool('get_image').run({ query: 'kite line art', kind: 'illustration', aspect: 'square', filename: 'art', variant: 1 });
  assert.match(art.output, /generated \(gpt-image-2\)/);
  assert.equal(generated.length, 1);
  // The per-run limit (2) is now used up.
  const third = await tool('get_image').run({ query: 'x', kind: 'photo', aspect: 'square', filename: 'x', variant: 1 });
  assert.equal(third.isError, true);
  assert.match(third.output, /limit reached/);
  assert.ok(fs.existsSync(path.join(root, 'server/public/media/art.jpg')));
});

test('get_video is offered only with a Pexels key; picks HD mp4 <= 1920px and saves a poster', async () => {
  assert.equal(setup({ unsplash: 'U' }).tools.some((t) => t.spec.name === 'get_video'), false);
  const video = Buffer.alloc(50_000, 1);
  stubFetch([
    ['api.pexels.com/videos/search', json({
      videos: [{
        duration: 12,
        image: 'https://images.pexels.com/videos/1/poster.jpg',
        user: { name: 'Dee' },
        url: 'https://pexels.com/v1',
        video_files: [
          { file_type: 'video/mp4', width: 3840, link: 'https://videos.pexels.com/4k.mp4' },
          { file_type: 'video/mp4', width: 1920, link: 'https://videos.pexels.com/1080.mp4' },
          { file_type: 'video/mp4', width: 640, link: 'https://videos.pexels.com/sd.mp4' },
        ],
      }],
    })],
    ['videos.pexels.com/1080.mp4', bytes(video, 'video/mp4')],
    ['poster.jpg', bytes(BIG)],
  ]);
  const { root, tool } = setup({ pexels: 'P' });
  const r = await tool('get_video').run({ query: 'kitesurfing', aspect: 'landscape', filename: 'hero-kite', variant: 1 });
  assert.equal(r.isError, undefined, r.output);
  assert.ok(fs.readFileSync(path.join(root, 'server/public/media/hero-kite.mp4')).equals(video));
  assert.ok(fs.existsSync(path.join(root, 'server/public/media/hero-kite-poster.jpg')));
  assert.match(r.output, /1920px wide, 12s/);
  assert.match(r.output, /poster="\/media\/hero-kite-poster\.jpg"/);
});

test('searchPexelsVideos skips videos without an HD mp4 in range', async () => {
  stubFetch([['api.pexels.com/videos/search', json({ videos: [{ video_files: [{ file_type: 'video/mp4', width: 640, link: 'x' }] }] })]]);
  assert.deepEqual(await searchPexelsVideos('q', 'landscape', 'P'), []);
});
