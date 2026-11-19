import { mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";

const destination = path.join("dist", "dashboard", "index.html");
mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(path.join("src", "dashboard", "index.html"), destination);
