/**
 * Call useTestDb() at the top of every test file that touches the database:
 * tables are emptied before each test and after the file, so every test starts
 * from an empty database and nothing is left behind.
 */
import { after, beforeEach } from 'node:test';
import { prisma, resetDb } from '../src/db.js';

export function useTestDb() {
  beforeEach(() => resetDb());
  after(async () => {
    await resetDb();
    await prisma.$disconnect();
  });
}
