import { ConflictError, NotFoundError } from "../errors.js";
import type { ClaimedJob, NewRun, RunRecord, TransitionRecord } from "../domain.js";
import { assertTransition, emptyCounts, isTerminal, type RunState } from "../state/machine.js";
import type { JobQueue, RunRepository, TransitionPatch } from "./types.js";

interface MemoryJob {
  id: string;
  runId: string;
  availableAt: number;
  lockedBy: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  completed: boolean;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryRunRepository implements RunRepository {
  private runs = new Map<string, RunRecord>();
  private byKey = new Map<string, string>();
  private history: TransitionRecord[] = [];
  private transitionSeq = 1;

  constructor(
    private readonly jobs: MemoryJobQueue,
    private readonly decisionLockMs = 30_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async insertReceived(input: NewRun): Promise<{ run: RunRecord; duplicate: boolean }> {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.runs.get(existingId);
      if (!existing) throw new Error("Idempotency index pointed at a missing run");
      return { run: clone(existing), duplicate: true };
    }

    const stamp = nowIso();
    const run: RunRecord = {
      id: input.id,
      idempotencyKey: input.idempotencyKey,
      source: input.source,
      eventType: input.eventType,
      payload: clone(input.payload),
      state: "RECEIVED",
      error: null,
      result: null,
      decisionLockAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.runs.set(run.id, run);
    this.byKey.set(run.idempotencyKey, run.id);
    this.history.push({
      id: String(this.transitionSeq++),
      runId: run.id,
      fromState: null,
      toState: "RECEIVED",
      reason: "Event accepted and queued",
      createdAt: stamp,
    });
    this.jobs.enqueue(run.id, input.maxAttempts);
    return { run: clone(run), duplicate: false };
  }

  async get(id: string): Promise<RunRecord | null> {
    const run = this.runs.get(id);
    return run ? clone(run) : null;
  }

  async list(filter: { state?: RunState; limit: number }): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => !filter.state || run.state === filter.state)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, filter.limit)
      .map((run) => clone(run));
  }

  async counts(): Promise<Record<RunState, number>> {
    const counts = emptyCounts();
    for (const run of this.runs.values()) counts[run.state] += 1;
    return counts;
  }

  async transitions(runId: string): Promise<TransitionRecord[]> {
    return this.history.filter((item) => item.runId === runId).map((item) => clone(item));
  }

  async transition(id: string, to: RunState, reason: string, patch?: TransitionPatch): Promise<RunRecord> {
    const run = this.runs.get(id);
    if (!run) throw new NotFoundError();
    assertTransition(run.state, to);
    const from = run.state;
    run.state = to;
    run.updatedAt = nowIso();
    run.decisionLockAt = null;
    if (to === "FAILED") run.error = (patch?.error ?? reason).slice(0, 2000);
    if (patch?.result !== undefined) run.result = clone(patch.result);
    this.history.push({
      id: String(this.transitionSeq++),
      runId: run.id,
      fromState: from,
      toState: to,
      reason: reason.slice(0, 500),
      createdAt: run.updatedAt,
    });
    return clone(run);
  }

  async acquireDecision(id: string): Promise<RunRecord> {
    const run = this.runs.get(id);
    if (!run) throw new NotFoundError();
    const lockAge = run.decisionLockAt ? this.clock() - Date.parse(run.decisionLockAt) : null;
    const locked = lockAge !== null && lockAge < this.decisionLockMs;
    if (run.state !== "AWAITING_APPROVAL" || locked) {
      throw new ConflictError(
        locked
          ? "A decision is already in progress for this run"
          : `This run is ${run.state} and cannot be decided`,
      );
    }
    run.decisionLockAt = new Date(this.clock()).toISOString();
    run.updatedAt = run.decisionLockAt;
    return clone(run);
  }

  async releaseDecision(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || isTerminal(run.state)) return;
    run.decisionLockAt = null;
  }
}

export class MemoryJobQueue implements JobQueue {
  private jobs: MemoryJob[] = [];
  private seq = 1;

  enqueue(runId: string, maxAttempts: number): void {
    this.jobs.push({
      id: String(this.seq++),
      runId,
      availableAt: 0,
      lockedBy: null,
      attempts: 0,
      maxAttempts,
      lastError: null,
      completed: false,
    });
  }

  pendingCount(): number {
    return this.jobs.filter((job) => !job.completed).length;
  }

  async claim(workerId: string, _lockTimeoutSeconds: number): Promise<ClaimedJob | null> {
    const now = Date.now();
    const job = this.jobs.find(
      (item) => !item.completed && item.lockedBy === null && item.availableAt <= now && item.attempts < item.maxAttempts,
    );
    if (!job) return null;
    job.lockedBy = workerId;
    job.attempts += 1;
    return {
      id: job.id,
      runId: job.runId,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    };
  }

  async complete(id: string, workerId: string): Promise<void> {
    const job = this.jobs.find((item) => item.id === id && item.lockedBy === workerId);
    if (!job) return;
    job.completed = true;
    job.lockedBy = null;
  }

  async retry(
    id: string,
    workerId: string,
    error: string,
    delaySeconds: number,
  ): Promise<{ exhausted: boolean }> {
    const job = this.jobs.find((item) => item.id === id && item.lockedBy === workerId && !item.completed);
    if (!job) return { exhausted: true };
    job.lastError = error;
    job.lockedBy = null;
    const exhausted = job.attempts >= job.maxAttempts;
    if (exhausted) {
      job.completed = true;
      return { exhausted: true };
    }
    job.availableAt = Date.now() + delaySeconds * 1000;
    return { exhausted: false };
  }
}
