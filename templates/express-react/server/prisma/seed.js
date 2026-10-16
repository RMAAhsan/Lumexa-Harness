/**
 * Seed data: `npm run db:seed -w server`. Must be safe to run repeatedly
 * (use upsert, or check before creating).
 */
import '../src/env.js';
import { prisma } from '../src/db.js';

async function main() {
  // Example:
  // await prisma.user.upsert({ where: { email: 'admin@example.com' }, update: {}, create: { ... } });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
