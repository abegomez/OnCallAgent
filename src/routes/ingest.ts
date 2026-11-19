import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { headerValue, readIdempotencyKey } from "../config.js";
import { BadRequestError } from "../errors.js";
import { verifySignature } from "../hmac.js";
import type { RunRepository } from "../repo/types.js";

const nativeEvent = z
  .object({
    source: z.string().trim().min(1).max(64),
    type: z.string().trim().min(1).max(128),
    payload: z.unknown(),
  })
  .strict();

export interface IngestDeps {
  webhookSecret: string;
  maxAttempts: number;
  runs: RunRepository;
}

interface RawRequest {
  rawBody?: Buffer;
}

export function registerIngest(app: FastifyInstance, deps: IngestDeps): void {
  app.post("/events/ingest", async (request, reply) => {
    const raw = (request as RawRequest).rawBody;
    if (!raw) throw new BadRequestError("Expected a JSON body");

    const signature =
      headerValue(request.headers["x-oncall-signature"]) ??
      headerValue(request.headers["x-hub-signature-256"]);
    if (!verifySignature(deps.webhookSecret, raw, signature)) {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid webhook signature" });
    }

    const githubEvent = headerValue(request.headers["x-github-event"]);
    const keyHeader =
      headerValue(request.headers["idempotency-key"]) ?? headerValue(request.headers["x-github-delivery"]);
    let idempotencyKey: string;
    try {
      idempotencyKey = readIdempotencyKey(keyHeader);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid idempotency key";
      throw new BadRequestError(message);
    }

    const event = normalizeEvent(request.body, githubEvent);
    const saved = await deps.runs.insertReceived({
      id: randomUUID(),
      idempotencyKey,
      source: event.source,
      eventType: event.type,
      payload: event.payload,
      maxAttempts: deps.maxAttempts,
    });

    request.log.info(
      { runId: saved.run.id, duplicate: saved.duplicate, source: saved.run.source, eventType: saved.run.eventType },
      "event queued",
    );

    return reply.code(202).send({
      id: saved.run.id,
      state: saved.run.state,
      duplicate: saved.duplicate,
    });
  });
}

function normalizeEvent(body: unknown, githubEvent: string | undefined): { source: string; type: string; payload: unknown } {
  if (githubEvent) {
    if (!githubEvent.trim() || githubEvent.length > 128) {
      throw new BadRequestError("X-GitHub-Event is invalid");
    }
    return { source: "github", type: githubEvent, payload: body };
  }
  const parsed = nativeEvent.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new BadRequestError(message);
  }
  return parsed.data;
}
