import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, loadDotEnv } from "../config.js";
import { createPool, type PgPool } from "../repo/postgres.js";

export function migrationsDirectory(): string {
  return fileURLToPath(new URL("../../db/migrations/", import.meta.url));
}

export async function migrate(pool: PgPool, directory = migrationsDirectory()): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const applied: string[] = [];

  for (const file of files) {
    const found = await pool.query("SELECT 1 FROM schema_migrations WHERE id = $1", [file]);
    if (found.rowCount) continue;
    const sql = readFileSync(path.join(directory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return applied;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  loadDotEnv();
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  migrate(pool)
    .then((applied) => {
      console.log(applied.length ? `Applied ${applied.join(", ")}` : "Migrations already applied");
      return pool.end();
    })
    .catch(async (error: unknown) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}
