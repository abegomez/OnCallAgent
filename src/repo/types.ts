import type { ClaimedJob, NewRun, RunRecord, TransitionRecord } from "../domain.js";
import type { RunState } from "../state/machine.js";

export interface TransitionPatch {
  result?: unknown;
  error?: string;
}

export interface RunRepository {
  insertReceived(input: NewRun): Promise<{ run: RunRecord; duplicate: boolean }>;
  get(id: string): Promise<RunRecord | null>;
  list(filter: { state?: RunState; limit: number }): Promise<RunRecord[]>;
  counts(): Promise<Record<RunState, number>>;
  transitions(runId: string): Promise<TransitionRecord[]>;
  transition(id: string, to: RunState, reason: string, patch?: TransitionPatch): Promise<RunRecord>;
  acquireDecision(id: string): Promise<RunRecord>;
  releaseDecision(id: string): Promise<void>;
}

export interface JobQueue {
  claim(workerId: string, lockTimeoutSeconds: number): Promise<ClaimedJob | null>;
  complete(id: string, workerId: string): Promise<void>;
  retry(
    id: string,
    workerId: string,
    error: string,
    delaySeconds: number,
  ): Promise<{ exhausted: boolean }>;
}

export interface ActionExecutor {
  execute(run: RunRecord): Promise<{ summary: string; externalAction: boolean }>;
}

export const noopActionExecutor: ActionExecutor = {
  async execute(run) {
    return {
      summary: `Recorded approval for ${run.source}/${run.eventType}. No external action is configured.`,
      externalAction: false,
    };
  },
};
