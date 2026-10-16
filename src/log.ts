/** Console + run.log logger. */
import fs from 'node:fs';

let logFile: string | undefined;

export function setLogFile(file: string): void {
  logFile = file;
}

export function log(line: string): void {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(stamped);
  if (logFile) fs.appendFileSync(logFile, `${stamped}\n`);
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'n/a';
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
