/** The workflow record: every step the run took, in order. REPORT.md is built from it. */
import type { Decision } from '../brain/router.js';

export type StepStatus = 'running' | 'passed' | 'failed' | 'skipped';

export interface Step {
  id: string;
  phase: 'plan' | 'design' | 'scaffold' | 'build' | 'repair' | 'review' | 'fix_review' | 'visual_review' | 'design_fix' | 'final_verify' | 'finalize';
  title: string;
  taskId?: string;
  decision?: Decision;
  status: StepStatus;
  detail?: string;
  turns?: number;
  startedAt: number;
  endedAt?: number;
}

export class Steps {
  readonly list: Step[] = [];

  start(phase: Step['phase'], title: string, extra: { taskId?: string; decision?: Decision } = {}): Step {
    const step: Step = { id: `s${this.list.length + 1}`, phase, title, status: 'running', startedAt: Date.now(), ...extra };
    this.list.push(step);
    return step;
  }

  end(step: Step, status: StepStatus, detail?: string): void {
    step.status = status;
    step.endedAt = Date.now();
    if (detail !== undefined) step.detail = detail;
  }
}
