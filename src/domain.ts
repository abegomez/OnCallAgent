import type { RunState } from "./state/machine.js";

export interface RunRecord {
  id: string;
  idempotencyKey: string;
  source: string;
  eventType: string;
  payload: unknown;
  state: RunState;
  error: string | null;
  result: unknown | null;
  decisionLockAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicRun {
  id: string;
  idempotencyKey: string;
  source: string;
  eventType: string;
  payload: unknown;
  state: RunState;
  error: string | null;
  result: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransitionRecord {
  id: string;
  runId: string;
  fromState: RunState | null;
  toState: RunState;
  reason: string | null;
  createdAt: string;
}

export interface NewRun {
  id: string;
  idempotencyKey: string;
  source: string;
  eventType: string;
  payload: unknown;
  maxAttempts: number;
}

export interface ClaimedJob {
  id: string;
  runId: string;
  attempts: number;
  maxAttempts: number;
}

export function toPublicRun(run: RunRecord): PublicRun {
  return {
    id: run.id,
    idempotencyKey: run.idempotencyKey,
    source: run.source,
    eventType: run.eventType,
    payload: run.payload,
    state: run.state,
    error: run.error,
    result: run.result,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
