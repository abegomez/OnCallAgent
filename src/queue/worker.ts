import type { ClaimedJob, RunRecord } from "../domain.js";
import { isTerminal } from "../state/machine.js";
import type { JobQueue, RunRepository } from "../repo/types.js";

export interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface AdvanceDeps {
  runs: RunRepository;
  jobs: JobQueue;
  workerId: string;
  lockTimeoutSeconds: number;
  investigate?: (run: RunRecord) => Promise<void>;
  backoffSeconds?: (attempts: number) => number;
  log?: Logger;
}

const defaultInvestigate = async (): Promise<void> => {};

function defaultBackoff(attempts: number): number {
  return Math.min(30, 2 ** Math.max(0, attempts - 1));
}

export async function advanceRun(
  runs: RunRepository,
  runId: string,
  investigate: (run: RunRecord) => Promise<void> = defaultInvestigate,
): Promise<void> {
  const run = await runs.get(runId);
  if (!run) return;
  if (run.state === "AWAITING_APPROVAL" || isTerminal(run.state)) return;

  if (run.state === "RECEIVED") {
    await runs.transition(runId, "INVESTIGATING", "Worker started investigation");
  }

  const mid = await runs.get(runId);
  if (!mid || mid.state !== "INVESTIGATING") return;
  await investigate(mid);
  await runs.transition(
    runId,
    "AWAITING_APPROVAL",
    "Investigation recorded; waiting for human approval before any state-changing action",
  );
}

export async function processClaimedJob(deps: AdvanceDeps, job: ClaimedJob): Promise<void> {
  try {
    await advanceRun(deps.runs, job.runId, deps.investigate);
    await deps.jobs.complete(job.id, deps.workerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Investigation failed";
    const delay = (deps.backoffSeconds ?? defaultBackoff)(job.attempts);
    const { exhausted } = await deps.jobs.retry(job.id, deps.workerId, message, delay);
    deps.log?.error({ err: message, runId: job.runId, attempt: job.attempts }, "investigation attempt failed");
    if (!exhausted) return;
    try {
      const latest = await deps.runs.get(job.runId);
      if (latest && !isTerminal(latest.state)) {
        await deps.runs.transition(latest.id, "FAILED", message, { error: message });
      }
    } catch (markError) {
      const markMessage = markError instanceof Error ? markError.message : "unknown error";
      deps.log?.error({ err: markMessage, runId: job.runId }, "failed to mark run FAILED");
    }
  }
}

export async function drainAvailable(deps: AdvanceDeps, limit = 25): Promise<number> {
  let processed = 0;
  for (; processed < limit; processed += 1) {
    const job = await deps.jobs.claim(deps.workerId, deps.lockTimeoutSeconds);
    if (!job) break;
    await processClaimedJob(deps, job);
  }
  return processed;
}

export function startWorker(deps: AdvanceDeps, pollMs: number): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await drainAvailable(deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : "worker tick failed";
      deps.log?.error({ err: message }, "worker tick failed");
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), pollMs);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
