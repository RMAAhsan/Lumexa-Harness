/**
 * Real photos and videos for generated apps, instead of gradient placeholders.
 *
 *   get_image  kind "photo":        Unsplash -> Pexels -> generated -> Openverse
 *              kind "illustration": generated -> Unsplash -> Pexels -> Openverse
 *   get_video  Pexels videos (HD mp4 + a poster frame); only offered with a Pexels key
 *
 * Files are saved in server/public/media (served at /media by the app, so the
 * website and the mobile app share them), credits go to CREDITS.md, and the
 * agent is shown what it got so it can ask for the next match (`variant`).
 * Keys: UNSPLASH_ACCESS_KEY, PEXELS_API_KEY (optional; OPENAI_API_KEY for generation).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CallContext } from '../cost/ledger.js';
import type { Gateway } from '../llm/gateway.js';
import type { ExtraTool, Workspace } from './tools.js';

export interface MediaKeys {
  unsplash?: string;
  pexels?: string;
}

type Aspect = 'landscape' | 'portrait' | 'square';

interface Found {
  url: string;
  credit: string;
  /** Unsplash asks apps to hit this when a photo is used. */
  ping?: string;
  source: string;
}

const UA = 'lumexa-harness/0.1 (code generation harness)';
const SIZES = { landscape: '1536x1024', portrait: '1024x1536', square: '1024x1024' } as const;
const MAX_VIDEO_BYTES = 40_000_000;

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
  return res.json();
}

export async function searchUnsplash(query: string, aspect: Aspect, key: string): Promise<Found[]> {
  const orientation = aspect === 'square' ? 'squarish' : aspect;
  const body = await getJson(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=10&content_filter=high`, {
    Authorization: `Client-ID ${key}`,
    'Accept-Version': 'v1',
  });
  return (body.results ?? []).map((r: any) => ({
    url: `${r.urls.raw}${r.urls.raw.includes('?') ? '&' : '?'}w=${aspect === 'landscape' ? 2000 : 1400}&q=80&fm=jpg&fit=max`,
    credit: `Photo by ${r.user?.name ?? 'unknown'} on Unsplash (${r.links?.html ?? ''})`,
    ping: r.links?.download_location,
    source: 'unsplash',
  }));
}

export async function searchPexelsPhotos(query: string, aspect: Aspect, key: string): Promise<Found[]> {
  const body = await getJson(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=${aspect}&per_page=10`, { Authorization: key });
  return (body.photos ?? []).map((p: any) => ({
    url: p.src?.large2x ?? p.src?.original,
    credit: `Photo by ${p.photographer ?? 'unknown'} on Pexels (${p.url ?? ''})`,
    source: 'pexels',
  }));
}

export async function searchOpenverse(query: string): Promise<Found[]> {
  const body = await getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=10&size=large&license_type=commercial`, {});
  return (body.results ?? [])
    .filter((r: any) => (r.width ?? 0) >= 900)
    .map((r: any) => ({
      url: r.url,
      credit: `"${r.title ?? 'Untitled'}" by ${r.creator ?? 'unknown'} (${String(r.license ?? '').toUpperCase()} ${r.license_version ?? ''}) ${r.foreign_landing_url ?? ''}`.trim(),
      source: 'openverse',
    }));
}

export interface FoundVideo {
  url: string;
  poster: string;
  width: number;
  duration: number;
  credit: string;
}

/** HD mp4s from Pexels, best file per video: 1280-1920px wide, preferring the largest. */
export async function searchPexelsVideos(query: string, aspect: Aspect, key: string): Promise<FoundVideo[]> {
  const body = await getJson(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=${aspect}&per_page=10`, { Authorization: key });
  return (body.videos ?? []).flatMap((v: any) => {
    const files = (v.video_files ?? [])
      .filter((f: any) => f.file_type === 'video/mp4' && f.width >= 1280 && f.width <= 1920)
      .sort((a: any, b: any) => b.width - a.width);
    if (!files.length) return [];
    return [{ url: files[0].link, poster: v.image, width: files[0].width, duration: v.duration ?? 0, credit: `Video by ${v.user?.name ?? 'unknown'} on Pexels (${v.url ?? ''})` }];
  });
}

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > maxBytes) throw new Error(`file too large (${(length / 1e6).toFixed(0)} MB)`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`file too large (${(data.length / 1e6).toFixed(0)} MB)`);
  return data;
}

export interface MediaToolOptions {
  gateway: Gateway;
  workspace: Workspace;
  keys: MediaKeys;
  ctx: () => CallContext;
  limits: { images: number; videos: number };
  counter: { images: number; videos: number };
}

const mediaDir = (root: string) => path.join(root, 'server', 'public', 'media');

function save(opts: MediaToolOptions, file: string, data: Buffer, credit: string): string {
  const dir = mediaDir(opts.workspace.root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), data);
  fs.appendFileSync(path.join(dir, 'CREDITS.md'), `- ${file}: ${credit}\n`);
  const rel = path.relative(opts.workspace.root, path.join(dir, file));
  opts.workspace.written.add(rel);
  return rel;
}

const usageNote = (file: string) =>
  `Website: <img src="/media/${file}" /> (or <video src="/media/${file}">). Mobile app: { uri: mediaUrl('${file}') } with mediaUrl from src/api.js.`;

const FILENAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

export function mediaTools(opts: MediaToolOptions): ExtraTool[] {
  const canGenerate = Boolean(opts.gateway.imageModel());
  const stock = [opts.keys.unsplash ? 'Unsplash' : '', opts.keys.pexels ? 'Pexels' : ''].filter(Boolean);
  const tools: ExtraTool[] = [];

  tools.push({
    spec: {
      name: 'get_image',
      description:
        `Get a real image for the UI: ${stock.length ? `${stock.join(' and ')} stock photos` : 'openly licensed photos'}${canGenerate ? ', or a generated illustration/scene' : ''}. ` +
        'Use it for every hero, card, gallery, portrait and background image; never ship gradient or icon placeholders where an image belongs. ' +
        'You are shown the result: if it is not right, call again with variant 2, 3... for the next match, or a better query. ' +
        `Saved to server/public/media and served at /media/<file>. Limit: ${opts.limits.images} images per run.`,
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'For photos: a few precise search words ("kitesurfer jumping turquoise lagoon"). For illustrations: a detailed visual description.' },
          kind: { type: 'string', enum: ['photo', 'illustration'], description: 'photo = real-world photography (people, places, products); illustration = generated artwork or a scene no stock photo would show.' },
          aspect: { type: 'string', enum: ['landscape', 'portrait', 'square'] },
          filename: { type: 'string', description: 'kebab-case, no extension, e.g. "hero-lagoon"' },
          variant: { type: 'integer', description: '1 = best match; 2, 3... = next matches for the same query.' },
        },
        required: ['query', 'kind', 'aspect', 'filename', 'variant'],
        additionalProperties: false,
      },
    },
    async run(input) {
      const query = String(input.query ?? '').trim();
      const filename = String(input.filename ?? '').trim();
      const aspect = (['landscape', 'portrait', 'square'] as const).find((a) => a === input.aspect) ?? 'landscape';
      const variant = Math.max(1, Math.min(10, Math.round(Number(input.variant) || 1)));
      if (!query) return { output: 'query is required', isError: true };
      if (!FILENAME.test(filename)) return { output: 'filename must be kebab-case letters/digits, up to 60 chars', isError: true };
      if (opts.counter.images >= opts.limits.images) return { output: `Image limit reached (${opts.limits.images} per run). Reuse an image already in server/public/media.`, isError: true };

      const generate = async () => {
        const b64 = await opts.gateway.image({ prompt: `${query}. No text, letters, logos or watermarks.`, size: SIZES[aspect], ctx: opts.ctx() });
        return { data: Buffer.from(b64, 'base64'), credit: `generated (${opts.gateway.imageModel()})` };
      };
      const fromStock = (search: () => Promise<Found[]>) => async () => {
        const found = await search();
        const pick = found[variant - 1];
        if (!pick) throw new Error(`only ${found.length} match(es)`);
        const data = await download(pick.url, 15_000_000);
        if (pick.ping) fetch(pick.ping, { headers: { Authorization: `Client-ID ${opts.keys.unsplash}` } }).catch(() => undefined);
        return { data, credit: pick.credit };
      };
      const photoSources: [string, () => Promise<{ data: Buffer; credit: string }>][] = [
        ...(opts.keys.unsplash ? [['Unsplash', fromStock(() => searchUnsplash(query, aspect, opts.keys.unsplash!))] as [string, () => Promise<{ data: Buffer; credit: string }>]] : []),
        ...(opts.keys.pexels ? [['Pexels', fromStock(() => searchPexelsPhotos(query, aspect, opts.keys.pexels!))] as [string, () => Promise<{ data: Buffer; credit: string }>]] : []),
      ];
      const order = [
        ...(input.kind === 'illustration' && canGenerate ? [['generation', generate] as [string, () => Promise<{ data: Buffer; credit: string }>]] : []),
        ...photoSources,
        ...(input.kind !== 'illustration' && canGenerate ? [['generation', generate] as [string, () => Promise<{ data: Buffer; credit: string }>]] : []),
        ['Openverse', fromStock(() => searchOpenverse(query))] as [string, () => Promise<{ data: Buffer; credit: string }>],
      ];
      const failures: string[] = [];
      for (const [name, get] of order) {
        try {
          const { data, credit } = await get();
          opts.counter.images++;
          const file = `${filename}.jpg`;
          const rel = save(opts, file, data, credit);
          return {
            output: `Saved ${rel} (${credit}). ${usageNote(file)}`,
            images: [{ mediaType: 'image/jpeg', data: data.toString('base64'), label: `The image saved as ${rel} (variant ${variant}):` }],
          };
        } catch (err) {
          failures.push(`${name}: ${(err as Error).message}`);
        }
      }
      return { output: `No image found. ${failures.join('; ')}. Try a simpler query.`, isError: true };
    },
  });

  if (opts.keys.pexels) {
    tools.push({
      spec: {
        name: 'get_video',
        description:
          'Get a real HD stock video (Pexels) for a hero or background, plus its poster frame. ' +
          'You are shown the poster: if it is not right, call again with variant 2, 3... ' +
          `Saved to server/public/media (<file>.mp4 and <file>-poster.jpg). Limit: ${opts.limits.videos} videos per run.`,
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'A few precise search words, e.g. "kitesurfing turquoise water"' },
            aspect: { type: 'string', enum: ['landscape', 'portrait', 'square'] },
            filename: { type: 'string', description: 'kebab-case, no extension, e.g. "hero-kite"' },
            variant: { type: 'integer', description: '1 = best match; 2, 3... = next matches.' },
          },
          required: ['query', 'aspect', 'filename', 'variant'],
          additionalProperties: false,
        },
      },
      async run(input) {
        const query = String(input.query ?? '').trim();
        const filename = String(input.filename ?? '').trim();
        const aspect = (['landscape', 'portrait', 'square'] as const).find((a) => a === input.aspect) ?? 'landscape';
        const variant = Math.max(1, Math.min(10, Math.round(Number(input.variant) || 1)));
        if (!query) return { output: 'query is required', isError: true };
        if (!FILENAME.test(filename)) return { output: 'filename must be kebab-case letters/digits, up to 60 chars', isError: true };
        if (opts.counter.videos >= opts.limits.videos) return { output: `Video limit reached (${opts.limits.videos} per run).`, isError: true };
        const videos = await searchPexelsVideos(query, aspect, opts.keys.pexels!);
        for (const v of videos.slice(variant - 1)) {
          try {
            const data = await download(v.url, MAX_VIDEO_BYTES);
            const poster = await download(v.poster, 10_000_000);
            opts.counter.videos++;
            const rel = save(opts, `${filename}.mp4`, data, v.credit);
            save(opts, `${filename}-poster.jpg`, poster, `${v.credit} (poster frame)`);
            return {
              output:
                `Saved ${rel} (${v.width}px wide, ${v.duration}s, ${(data.length / 1e6).toFixed(1)} MB, ${v.credit}) and its poster ${filename}-poster.jpg. ` +
                `Website: <video src="/media/${filename}.mp4" poster="/media/${filename}-poster.jpg" autoPlay muted loop playsInline className="object-cover" />. ` +
                `Mobile app: expo-video useVideoPlayer(mediaUrl('${filename}.mp4')) with muted + loop, poster via expo-image.`,
              images: [{ mediaType: 'image/jpeg', data: poster.toString('base64'), label: `Poster frame of ${rel} (variant ${variant}):` }],
            };
          } catch {
            // too large or unavailable: try the next match
          }
        }
        return { output: `No usable video for "${query}" (variant ${variant}). Try other words.`, isError: true };
      },
    });
  }
  return tools;
}
