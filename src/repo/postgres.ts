import pg from "pg";
import type { ClaimedJob, NewRun, RunRecord, TransitionRecord } from "../domain.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { assertTransition, emptyCounts, isRunState, type RunState } from "../state/machine.js";
import type { JobQueue, RunRepository, TransitionPatch } from "./types.js";

const { Pool } = pg;
export type PgPool = pg.Pool;

interface RunRow {
  id: string;
  idempotency_key: string;
  source: string;
  event_type: string;
  payload: unknown;
  state: string;
  error: string | null;
  result: unknown | null;
  decision_lock_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface TransitionRow {
  id: string;
  run_id: string;
  from_state: string | null;
  to_state: string;
  reason: string | null;
  created_at: Date;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRun(row: RunRow): RunRecord {
  if (!isRunState(row.state)) throw new Error(`Unexpected run state ${row.state}`);
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    source: row.source,
    eventType: row.event_type,
    payload: row.payload,
    state: row.state,
    error: row.error,
    result: row.result,
    decisionLockAt: row.decision_lock_at ? iso(row.decision_lock_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapTransition(row: TransitionRow): TransitionRecord {
  if (!isRunState(row.to_state)) throw new Error(`Unexpected transition state ${row.to_state}`);
  if (row.from_state !== null && !isRunState(row.from_state)) {
    throw new Error(`Unexpected transition state ${row.from_state}`);
  }
  return {
    id: String(row.id),
    runId: row.run_id,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    createdAt: iso(row.created_at),
  };
}

export function createPool(databaseUrl: string): PgPool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
}

export class PostgresRunRepository implements RunRepository {
  constructor(
    private readonly pool: PgPool,
    private readonly decisionLockSeconds: number,
  ) {}

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async insertReceived(input: NewRun): Promise<{ run: RunRecord; duplicate: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<RunRow>(
        `INSERT INTO runs (id, idempotency_key, source, event_type, payload, state)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'RECEIVED')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [input.id, input.idempotencyKey, input.source, input.eventType, JSON.stringify(input.payload)],
      );
      if (inserted.rowCount === 0 || !inserted.rows[0]) {
        await client.query("ROLLBACK");
        const existing = await client.query<RunRow>(
          "SELECT * FROM runs WHERE idempotency_key = $1",
          [input.idempotencyKey],
        );
        if (!existing.rowCount || !existing.rows[0]) throw new Error("Idempotent insert lost the original run");
        return { run: mapRun(existing.rows[0]), duplicate: true };
      }

      await client.query(
        `INSERT INTO run_transitions (run_id, from_state, to_state, reason)
         VALUES ($1, NULL, 'RECEIVED', $2)`,
        [input.id, "Event accepted and queued"],
      );
      await client.query(
        `INSERT INTO jobs (run_id, max_attempts)
         VALUES ($1, $2)`,
        [input.id, input.maxAttempts],
      );
      await client.query("COMMIT");
      return { run: mapRun(inserted.rows[0]), duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>("SELECT * FROM runs WHERE id = $1", [id]);
    return result.rowCount && result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async list(filter: { state?: RunState; limit: number }): Promise<RunRecord[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT * FROM runs
       WHERE ($1::text IS NULL OR state = $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [filter.state ?? null, filter.limit],
    );
    return result.rows.map(mapRun);
  }

  async counts(): Promise<Record<RunState, number>> {
    const counts = emptyCounts();
    const result = await this.pool.query<{ state: string; n: number }>(
      "SELECT state, COUNT(*)::int AS n FROM runs GROUP BY state",
    );
    for (const row of result.rows) {
      if (isRunState(row.state)) counts[row.state] = row.n;
    }
    return counts;
  }

  async transitions(runId: string): Promise<TransitionRecord[]> {
    const result = await this.pool.query<TransitionRow>(
      "SELECT * FROM run_transitions WHERE run_id = $1 ORDER BY id",
      [runId],
    );
    return result.rows.map(mapTransition);
  }

  async transition(id: string, to: RunState, reason: string, patch?: TransitionPatch): Promise<RunRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<RunRow>("SELECT * FROM runs WHERE id = $1 FOR UPDATE", [id]);
      if (!current.rowCount || !current.rows[0]) throw new NotFoundError();
      const run = mapRun(current.rows[0]);
      assertTransition(run.state, to);
      const error = to === "FAILED" ? (patch?.error ?? reason).slice(0, 2000) : null;
      const updated = await client.query<RunRow>(
        `UPDATE runs
         SET state = $2,
             updated_at = now(),
             decision_lock_at = NULL,
             error = CASE WHEN $2 = 'FAILED' THEN $3 ELSE error END,
             result = COALESCE($4::jsonb, result)
         WHERE id = $1
         RETURNING *`,
        [id, to, error, patch?.result === undefined ? null : JSON.stringify(patch.result)],
      );
      await client.query(
        `INSERT INTO run_transitions (run_id, from_state, to_state, reason)
         VALUES ($1, $2, $3, $4)`,
        [id, run.state, to, reason.slice(0, 500)],
      );
      await client.query("COMMIT");
      if (!updated.rows[0]) throw new Error("Run update did not return a row");
      return mapRun(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async acquireDecision(id: string): Promise<RunRecord> {
    const locked = await this.pool.query<RunRow>(
      `UPDATE runs
       SET decision_lock_at = now(), updated_at = now()
       WHERE id = $1
         AND state = 'AWAITING_APPROVAL'
         AND (
           decision_lock_at IS NULL
           OR decision_lock_at < now() - make_interval(secs => $2)
         )
       RETURNING *`,
      [id, this.decisionLockSeconds],
    );
    if (locked.rowCount) return mapRun(locked.rows[0]);

    const current = await this.get(id);
    if (!current) throw new NotFoundError();
    if (current.state === "AWAITING_APPROVAL" && current.decisionLockAt) {
      throw new ConflictError("A decision is already in progress for this run");
    }
    throw new ConflictError(`This run is ${current.state} and cannot be decided`);
  }

  async releaseDecision(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs
       SET decision_lock_at = NULL, updated_at = now()
       WHERE id = $1 AND state = 'AWAITING_APPROVAL'`,
      [id],
    );
  }
}

export class PostgresJobQueue implements JobQueue {
  constructor(private readonly pool: PgPool) {}

  async claim(workerId: string, lockTimeoutSeconds: number): Promise<ClaimedJob | null> {
    const result = await this.pool.query<{
      id: string;
      run_id: string;
      attempts: number;
      max_attempts: number;
    }>(
      `WITH next AS (
         SELECT id
         FROM jobs
         WHERE completed_at IS NULL
           AND attempts < max_attempts
           AND available_at <= now()
           AND (
             locked_at IS NULL
             OR locked_at < now() - make_interval(secs => $2::double precision)
           )
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs
       SET locked_at = now(),
           locked_by = $1,
           attempts = jobs.attempts + 1
       FROM next
       WHERE jobs.id = next.id
       RETURNING jobs.id, jobs.run_id, jobs.attempts, jobs.max_attempts`,
      [workerId, lockTimeoutSeconds],
    );
    if (!result.rowCount || !result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: String(row.id),
      runId: row.run_id,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
  }

  async complete(id: string, workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs
       SET completed_at = now(), locked_at = NULL, locked_by = NULL
       WHERE id = $1 AND locked_by = $2 AND completed_at IS NULL`,
      [id, workerId],
    );
  }

  async retry(
    id: string,
    workerId: string,
    error: string,
    delaySeconds: number,
  ): Promise<{ exhausted: boolean }> {
    const result = await this.pool.query<{ attempts: number; max_attempts: number }>(
      `UPDATE jobs
       SET last_error = $3,
           locked_at = NULL,
           locked_by = NULL,
           completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
           available_at = CASE
             WHEN attempts >= max_attempts THEN available_at
             ELSE now() + make_interval(secs => $4)
           END
       WHERE id = $1 AND locked_by = $2 AND completed_at IS NULL
       RETURNING attempts, max_attempts`,
      [id, workerId, error.slice(0, 2000), delaySeconds],
    );
    if (!result.rowCount || !result.rows[0]) return { exhausted: true };
    return { exhausted: result.rows[0].attempts >= result.rows[0].max_attempts };
  }
}
