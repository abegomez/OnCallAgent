import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function dashboardHtml(): string {
  return readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
}
