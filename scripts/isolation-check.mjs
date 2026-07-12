import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { databasePath, DATA_DIR, PROJECT_ROOT } from "../lib/paths.mjs";
import { DEFAULT_HOST, DEFAULT_PORT } from "../lib/runtime.mjs";

const failures = [];
const dbPath = databasePath("personal", {});
const relativeDb = path.relative(DATA_DIR, dbPath);
if (relativeDb.startsWith("..") || path.isAbsolute(relativeDb)) failures.push("default database escapes data/");
if (DEFAULT_PORT === 8765) failures.push("release dashboard must not use the protected personal port");
if (DEFAULT_HOST !== "127.0.0.1") failures.push("dashboard must bind to loopback by default");

function walk(directory) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...walk(fullPath));
    else results.push(fullPath);
  }
  return results;
}

if (walk(PROJECT_ROOT).some((file) => file.endsWith(".plist"))) {
  failures.push("LaunchAgent files are not allowed in the initial release");
}

if (failures.length) {
  console.error(`Isolation check failed (${failures.length}).`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Isolation check passed: loopback host, port 8766, repository-local database, no LaunchAgent.");
