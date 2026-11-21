import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition, canTransition, type RunState } from "../src/state/machine.js";

const validTransitions: Array<[RunState, RunState]> = [
  ["RECEIVED", "INVESTIGATING"],
  ["RECEIVED", "FAILED"],
  ["INVESTIGATING", "AWAITING_APPROVAL"],
  ["INVESTIGATING", "FAILED"],
  ["AWAITING_APPROVAL", "EXECUTED"],
  ["AWAITING_APPROVAL", "REJECTED"],
  ["AWAITING_APPROVAL", "FAILED"],
];

for (const [from, to] of validTransitions) {
  test(`${from} can transition to ${to}`, () => {
    assert.equal(canTransition(from, to), true);
    assert.doesNotThrow(() => assertTransition(from, to));
  });
}
