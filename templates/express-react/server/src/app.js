import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { prisma } from './db.js';
import { asyncHandler } from './errors.js';
import { stripeWebhook } from './payments.js';
import apiRouter from './routes/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webDist = path.join(root, 'client', 'dist');
// Expo web export of the mobile app (npm run build:web -w mobile).
const mobileDist = path.join(root, 'mobile', 'dist');

/** Serve a single-page app build at `base`, falling back to its index.html. */
function serveSpa(app, base, dist) {
  app.use(base, express.static(dist));
  app.get(base === '/' ? '*' : `${base}*`, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

/** Build the Express app. Tests import this directly (no listening socket). */
export function createApp() {
  const app = express();
  // Stripe needs the raw body to verify webhook signatures, so this route comes before express.json().
  app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), asyncHandler(stripeWebhook));
  app.use(express.json({ limit: '1mb' }));

  app.get(
    '/api/health',
    asyncHandler(async (req, res) => {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: 'up' });
    }),
  );
  app.use('/api', apiRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Photos and videos the app ships with (server/public/media), for the website and the mobile app alike.
  app.use('/media', express.static(path.join(root, 'server', 'public', 'media'), { maxAge: '7d' }));

  // In production the API also serves the built UI: the React website at /, and the mobile
  // app's web build at /app (or at / when the project has no website).
  const hasWeb = fs.existsSync(webDist);
  if (fs.existsSync(mobileDist)) serveSpa(app, hasWeb ? '/app' : '/', mobileDist);
  if (hasWeb) serveSpa(app, '/', webDist);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Prisma: unique constraint -> 409, record not found -> 404.
    if (err.code === 'P2002') return res.status(409).json({ error: 'Already exists' });
    if (err.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });
  return app;
}
