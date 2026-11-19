import { randomUUID } from "node:crypto";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { signBody } from "../src/hmac.js";

loadDotEnv();
const config = loadConfig();
const url = process.env.SMOKE_URL ?? `http://${config.host}:${config.port}/events/ingest`;
const key = randomUUID();
const body = JSON.stringify({
  source: "simulated_alert",
  type: "cpu_high",
  payload: { host: "api-1", value: 99 },
});

async function post(idempotencyKey: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-oncall-signature": signBody(config.webhookSecret, Buffer.from(body)),
    },
    body,
  });
  const text = await response.text();
  console.log(response.status, text);
  if (response.status !== 202) process.exitCode = 1;
}

await post(key);
await post(key);
