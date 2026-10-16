/**
 * The Prisma client (PostgreSQL). Models live in prisma/schema.prisma.
 *   import { prisma } from '../db.js';
 *   await prisma.booking.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
 */
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/** Empty every table (tests only: called from test/helpers.js). */
export async function resetDb() {
  const rows = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
