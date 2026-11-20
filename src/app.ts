import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { dashboardHtml } from "./dashboard/html.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import type { ActionExecutor, RunRepository } from "./repo/types.js";
import { registerIngest } from "./routes/ingest.js";
import { registerRuns } from "./routes/runs.js";
import { IllegalTransitionError } from "./state/machine.js";

export interface AppDeps {
  webhookSecret: string;
  opsToken: string;
  maxAttempts: number;
  runs: RunRepository;
  executor: ActionExecutor;
  ping: () => Promise<void>;
  logger?: boolean;
}

interface RequestWithRaw extends FastifyRequest {
  rawBody?: Buffer;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: 262_144 },
    (request, body, done) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
      (request as RequestWithRaw).rawBody = raw;
      try {
        done(null, JSON.parse(raw.toString("utf8")));
      } catch {
        done(Object.assign(new BadRequestError("Request body must be valid JSON"), { statusCode: 400 }), undefined);
      }
    },
  );

  app.get("/health", async (_request, reply) => {
    try {
      await deps.ping();
      return { ok: true, db: "up" };
    } catch {
      return reply.code(503).send({ ok: false, db: "down" });
    }
  });

  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(dashboardHtml());
  });

  registerIngest(app, {
    webhookSecret: deps.webhookSecret,
    maxAttempts: deps.maxAttempts,
    runs: deps.runs,
  });
  registerRuns(app, {
    runs: deps.runs,
    executor: deps.executor,
    opsToken: deps.opsToken,
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: "not_found", message: "Not found" });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof BadRequestError) {
      return reply.code(400).send({ error: "bad_request", message: error.message });
    }
    if (error instanceof NotFoundError) {
      return reply.code(404).send({ error: "not_found", message: error.message });
    }
    if (error instanceof ConflictError || error instanceof IllegalTransitionError) {
      return reply.code(409).send({ error: "conflict", message: error.message });
    }
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const message = error instanceof Error ? error.message : "Request failed";
    if (statusCode === 401) {
      return reply.code(401).send({ error: "unauthorized", message });
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: "bad_request", message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "Internal error" });
  });

  return app;
}
