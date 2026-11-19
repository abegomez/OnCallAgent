export const RUN_STATES = [
  "RECEIVED",
  "INVESTIGATING",
  "AWAITING_APPROVAL",
  "EXECUTED",
  "REJECTED",
  "FAILED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  RECEIVED: ["INVESTIGATING", "FAILED"],
  INVESTIGATING: ["AWAITING_APPROVAL", "FAILED"],
  AWAITING_APPROVAL: ["EXECUTED", "REJECTED", "FAILED"],
  EXECUTED: [],
  REJECTED: [],
  FAILED: [],
};

export class IllegalTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState) {
    super(`Cannot transition from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: RunState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function emptyCounts(): Record<RunState, number> {
  return {
    RECEIVED: 0,
    INVESTIGATING: 0,
    AWAITING_APPROVAL: 0,
    EXECUTED: 0,
    REJECTED: 0,
    FAILED: 0,
  };
}
