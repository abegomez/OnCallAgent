import type { RunRecord } from "../domain.js";
import { ConflictError } from "../errors.js";
import type { ActionExecutor, RunRepository } from "../repo/types.js";

export type DecisionAction = "approve" | "reject";

export async function decideRun(
  runs: RunRepository,
  executor: ActionExecutor,
  id: string,
  action: DecisionAction,
  note?: string,
): Promise<RunRecord> {
  const run = await runs.acquireDecision(id);
  try {
    if (action === "reject") {
      const reason = note?.trim() || "Rejected by operator";
      return await runs.transition(id, "REJECTED", reason);
    }
    const outcome = await executor.execute(run);
    const reason = note?.trim() || outcome.summary;
    return await runs.transition(id, "EXECUTED", reason, { result: outcome });
  } catch (error) {
    await runs.releaseDecision(id);
    if (error instanceof ConflictError) throw error;
    throw error;
  }
}
