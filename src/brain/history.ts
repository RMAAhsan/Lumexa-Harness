/**
 * Outcome history across runs: did a model's work pass verification?
 * Appended to runs/history.jsonl after every build/repair/fix attempt, and read
 * by the router to stop picking a model that keeps failing a kind of task.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Outcome {
  at: string;
  phase: string;
  /** Build difficulty, or the repair-chain position ("attempt-1"...). */
  kind: string;
  model: string;
  passed: boolean;
}

export class History {
  private outcomes: Outcome[];

  constructor(private readonly file?: string) {
    this.outcomes = file && fs.existsSync(file) ? History.parse(fs.readFileSync(file, 'utf8')) : [];
  }

  static parse(text: string): Outcome[] {
    return text
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Outcome];
        } catch {
          return [];
        }
      });
  }

  record(o: Omit<Outcome, 'at'>): void {
    const full = { ...o, at: new Date().toISOString() };
    this.outcomes.push(full);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(full)}\n`);
    }
  }

  stats(phase: string, kind: string, model: string): { n: number; passed: number; rate: number } {
    const rows = this.outcomes.filter((o) => o.phase === phase && o.kind === kind && o.model === model);
    const passed = rows.filter((o) => o.passed).length;
    return { n: rows.length, passed, rate: rows.length ? passed / rows.length : 0 };
  }
}
