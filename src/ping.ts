/**
 * `npm run ping`: one tiny request to every model the routing config uses, to
 * confirm keys and model access before a real run. Costs a fraction of a cent.
 */
import { findModel, loadConfig, loadEnv } from './config.js';
import { searchPexelsPhotos, searchPexelsVideos, searchUnsplash } from './agent/media.js';
import { Ledger } from './cost/ledger.js';
import { Gateway } from './llm/gateway.js';
import { usd } from './log.js';

loadEnv();
const config = loadConfig();
const ledger = new Ledger(config, 1);
const gateway = new Gateway(config, ledger);
const p = config.routing.phases;
const ids = new Set([
  p.plan.model,
  p.review.model,
  ...(p.review.fallback ? [p.review.fallback] : []),
  p.fix_review.model,
  p.design.model,
  p.visual_review.model,
  p.design_fix.model,
  ...Object.values(p.build.byDifficulty).map((e) => e.model),
  ...p.repair.chain.map((e) => e.model),
]);

let failed = 0;
for (const id of ids) {
  const m = findModel(config, id)!;
  if (!config.available.has(m.provider)) {
    console.log(`–  ${id.padEnd(20)} skipped: no ${m.provider.toUpperCase()} key`);
    continue;
  }
  try {
    const session = gateway.session({ model: id, effort: 'low', system: 'Reply with exactly: OK', tools: [], maxTokens: 2048, ctx: { stepId: 'ping', phase: 'ping' } });
    const res = await session.send('ping');
    const cost = ledger.entries[ledger.entries.length - 1]?.costUsd;
    console.log(`✓  ${id.padEnd(20)} "${res.text.trim().slice(0, 20)}" served by ${res.servedModel} (${usd(cost)})`);
  } catch (err) {
    failed++;
    console.log(`✗  ${id.padEnd(20)} ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}
// Stock media keys (free APIs, no cost).
const media: [string, string | undefined, (key: string) => Promise<unknown[]>][] = [
  ['Unsplash', process.env.UNSPLASH_ACCESS_KEY?.trim(), (k) => searchUnsplash('ocean', 'landscape', k)],
  ['Pexels photos', process.env.PEXELS_API_KEY?.trim(), (k) => searchPexelsPhotos('ocean', 'landscape', k)],
  ['Pexels videos', process.env.PEXELS_API_KEY?.trim(), (k) => searchPexelsVideos('ocean', 'landscape', k)],
];
for (const [name, key, search] of media) {
  if (!key) {
    console.log(`–  ${name.padEnd(20)} skipped: no key`);
    continue;
  }
  try {
    console.log(`✓  ${name.padEnd(20)} ${(await search(key)).length} results for "ocean"`);
  } catch (err) {
    failed++;
    console.log(`✗  ${name.padEnd(20)} ${(err as Error).message}`);
  }
}

console.log(`\ntotal: ${usd(ledger.totalUsd)}`);
process.exit(failed ? 1 : 0);
