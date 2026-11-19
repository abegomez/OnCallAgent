import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { headerValue } from "../config.js";
import { decideRun } from "../decisions.js";
import { toPublicRun } from "../domain.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { tokensMatch } from "../hmac.js";
import type { ActionExecutor, RunRepository } from "../repo/types.js";
import { isRunState } from "../state/machine.js";

const decisionBody = z
  .object({
    action: z.enum(["approve", "reject"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerRuns(
  app: FastifyInstance,
  deps: { runs: RunRepository; executor: ActionExecutor; opsToken: string },
): void {
  app.get("/runs", async (request: FastifyRequest) => {
    const query = request.query as { state?: string; limit?: string };
    const state = query.state === undefined || query.state === "" ? undefined : query.state;
    if (state !== undefined && !isRunState(state)) throw new BadRequestError("Unknown state filter");
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new BadRequestError("limit must be an integer from 1 to 200");
    }
    const [runs, counts] = await Promise.all([deps.runs.list({ state, limit }), deps.runs.counts()]);
    return { runs: runs.map(toPublicRun), counts };
  });

  app.get("/runs/:id", async (request: FastifyRequest) => {
    const id = parseRunId((request.params as { id: string }).id);
    const run = await deps.runs.get(id);
    if (!run) throw new NotFoundError();
    return { run: toPublicRun(run), transitions: await deps.runs.transitions(id) };
  });

  app.post("/runs/:id/decisions", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(request.headers.authorization, deps.opsToken)) {
      return reply.code(401).send({ error: "unauthorized", message: "Ops token required" });
    }
    const id = parseRunId((request.params as { id: string }).id);
    const parsed = decisionBody.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    const run = await decideRun(deps.runs, deps.executor, id, parsed.data.action, parsed.data.note);
    return toPublicRun(run);
  });
}

function parseRunId(id: string): string {
  if (!UUID.test(id)) throw new BadRequestError("Run id must be a UUID");
  return id;
}

function authorized(header: string | string[] | undefined, opsToken: string): boolean {
  const value = headerValue(header);
  const match = value?.match(/^Bearer\s+(\S+)$/i);
  return Boolean(match && tokensMatch(match[1], opsToken));
}
