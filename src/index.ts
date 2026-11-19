import { buildApp } from "./app.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool, PostgresJobQueue, PostgresRunRepository } from "./repo/postgres.js";
import { noopActionExecutor } from "./repo/types.js";
import { startWorker } from "./queue/worker.js";

loadDotEnv();
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const runs = new PostgresRunRepository(pool, config.decisionLockSeconds);
const jobs = new PostgresJobQueue(pool);

const app = buildApp({
  webhookSecret: config.webhookSecret,
  opsToken: config.opsToken,
  maxAttempts: config.jobMaxAttempts,
  runs,
  executor: noopActionExecutor,
  ping: () => runs.ping(),
  logger: true,
});

if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
  app.log.warn("HOST is not loopback. GET /runs is unauthenticated and includes event payloads.");
}

async function main(): Promise<void> {
  if (config.autoMigrate) {
    const applied = await migrate(pool);
    if (applied.length) app.log.info({ applied }, "migrations applied");
  }

  const stopWorker = startWorker(
    {
      runs,
      jobs,
      workerId: config.workerId,
      lockTimeoutSeconds: config.jobLockTimeoutSeconds,
      log: app.log,
    },
    config.workerPollMs,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    stopWorker();
    await app.close();
    await pool.end();
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0));
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ port: config.port, host: config.host }, "oncall-agent listening");
}

main().catch(async (error: unknown) => {
  app.log.error(error);
  await pool.end();
  process.exit(1);
});
