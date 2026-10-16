/**
 * A throwaway PostgreSQL server for one harness run (Docker, random localhost
 * port). Agents and tests use `app` / `app_test`; every smoke check and the
 * migration check get a brand-new database, so nothing is ever reset or
 * dropped. The container is removed when the run ends.
 */
import { spawnSync } from 'node:child_process';
import { exec } from '../agent/exec.js';

const IMAGE = 'postgres:16-alpine';
const USER = 'app';
const PASSWORD = 'app';

/** Containers started by this process, so an interrupted run can still remove them. */
const running = new Set<string>();

export class PgServer {
  private port = 0;
  private dbCounter = 0;

  private constructor(readonly container: string) {}

  static async start(runId: string): Promise<PgServer> {
    const pg = new PgServer(`harness-pg-${runId}`);
    const docker = await exec('docker version --format "{{.Server.Version}}"', { cwd: process.cwd(), timeoutMs: 20_000 });
    if (docker.code !== 0) {
      throw new Error(`Docker is required (the harness runs PostgreSQL in a container) but is not available:\n${docker.output}`);
    }
    const run = await exec(
      `docker run -d --rm --name ${pg.container} -e POSTGRES_USER=${USER} -e POSTGRES_PASSWORD=${PASSWORD} ` +
        `-e POSTGRES_DB=app -p 127.0.0.1::5432 ${IMAGE}`,
      { cwd: process.cwd(), timeoutMs: 300_000 },
    );
    if (run.code !== 0) throw new Error(`could not start PostgreSQL:\n${run.output}`);
    running.add(pg.container);
    const port = await exec(`docker port ${pg.container} 5432/tcp`, { cwd: process.cwd(), timeoutMs: 20_000 });
    pg.port = Number(/:(\d+)\s*$/m.exec(port.output.trim())?.[1]);
    if (!pg.port) throw new Error(`could not read the PostgreSQL port: ${port.output}`);
    for (let i = 0; i < 120; i++) {
      // pg_isready can succeed during the image's init restart; a real query cannot.
      const ready = await exec(`docker exec ${pg.container} psql -U ${USER} -d app -qtAc "SELECT 1"`, { cwd: process.cwd(), timeoutMs: 10_000 });
      if (ready.code === 0 && ready.output.trim() === '1') return pg;
      await new Promise((r) => setTimeout(r, 500));
    }
    await pg.stop();
    throw new Error('PostgreSQL did not become ready in 60s');
  }

  url(database: string): string {
    return `postgresql://${USER}:${PASSWORD}@127.0.0.1:${this.port}/${database}`;
  }

  /** Environment for the app's processes: dev database + test database. */
  appEnv(): Record<string, string> {
    return {
      DATABASE_URL: this.url('app'),
      TEST_DATABASE_URL: this.url('app_test'),
      JWT_SECRET: 'harness-dev-secret',
    };
  }

  /** A new, empty database (prefix_N); returns its URL. */
  async freshDatabase(prefix: string): Promise<string> {
    const name = `${prefix}_${++this.dbCounter}`;
    const r = await exec(`docker exec ${this.container} psql -U ${USER} -d app -qc 'CREATE DATABASE "${name}"'`, {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    if (r.code !== 0) throw new Error(`could not create database ${name}: ${r.output}`);
    return this.url(name);
  }

  async stop(): Promise<void> {
    await exec(`docker rm -f -v ${this.container}`, { cwd: process.cwd(), timeoutMs: 60_000 });
    running.delete(this.container);
  }

  /** Remove every container this process started (Ctrl+C / crash path; synchronous on purpose). */
  static stopAllSync(): void {
    for (const name of running) spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', timeout: 30_000 });
    running.clear();
  }
}
