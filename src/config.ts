import { existsSync, readFileSync } from "node:fs";

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  webhookSecret: string;
  opsToken: string;
  workerPollMs: number;
  workerId: string;
  jobMaxAttempts: number;
  jobLockTimeoutSeconds: number;
  decisionLockSeconds: number;
  autoMigrate: boolean;
}

export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  applyEnvFile(readFileSync(path, "utf8"));
}

export function applyEnvFile(text: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const webhookSecret = required(env, "WEBHOOK_SECRET");
  if (webhookSecret.length < 16) {
    throw new Error("WEBHOOK_SECRET must be at least 16 characters");
  }
  const opsToken = required(env, "OPS_TOKEN");
  if (opsToken.length < 8) throw new Error("OPS_TOKEN must be at least 8 characters");

  return {
    port: integer(env, "PORT", 3000, 1),
    host: env.HOST?.trim() || "127.0.0.1",
    databaseUrl: required(env, "DATABASE_URL"),
    webhookSecret,
    opsToken,
    workerPollMs: integer(env, "WORKER_POLL_MS", 400, 50),
    workerId: env.WORKER_ID?.trim() || `worker-${process.pid}`,
    jobMaxAttempts: integer(env, "JOB_MAX_ATTEMPTS", 5, 1),
    jobLockTimeoutSeconds: integer(env, "JOB_LOCK_TIMEOUT_SECONDS", 300, 5),
    decisionLockSeconds: integer(env, "DECISION_LOCK_SECONDS", 30, 5),
    autoMigrate: (env.AUTO_MIGRATE ?? "true").trim().toLowerCase() !== "false",
  };
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

export function readIdempotencyKey(value: string | undefined): string {
  if (!value || !IDEMPOTENCY_KEY.test(value)) {
    throw new Error("Idempotency-Key must be 1-200 printable ASCII characters");
  }
  return value;
}
