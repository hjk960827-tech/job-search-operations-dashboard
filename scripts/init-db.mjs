import process from "node:process";
import { configStatus } from "../lib/config.mjs";
import { initializeDatabase } from "../lib/database.mjs";
import { databasePath, runtimeMode } from "../lib/paths.mjs";

const mode = process.argv.includes("--demo") ? "demo" : runtimeMode();
const status = configStatus();
if (mode === "personal" && !status.complete) {
  console.error("Personal mode requires all four completed local configuration files.");
  process.exit(1);
}
const dbPath = databasePath(mode);
initializeDatabase(dbPath, { mode, resetDemo: process.argv.includes("--reset-demo") });
console.log(`Initialized ${mode} database inside the repository data directory.`);
