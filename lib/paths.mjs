import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(here, "..");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const CONFIG_DIR = path.join(PROJECT_ROOT, "config");
export const PACKAGE_DIR = path.join(DATA_DIR, "application-packages");

export function runtimeMode(value = process.env.APP_MODE || "demo") {
  const normalized = String(value).trim().toLowerCase();
  if (!new Set(["demo", "personal"]).has(normalized)) {
    throw new Error("APP_MODE must be either demo or personal");
  }
  return normalized;
}

function existingAncestor(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function assertPathInside(baseDir, candidatePath, label = "path") {
  fs.mkdirSync(baseDir, { recursive: true });
  const resolvedBase = fs.realpathSync(baseDir);
  const resolvedCandidate = path.resolve(PROJECT_ROOT, candidatePath);
  const ancestor = existingAncestor(resolvedCandidate);
  const realAncestor = fs.realpathSync(ancestor);
  const relativeAncestor = path.relative(resolvedBase, realAncestor);
  const lexicalRelative = path.relative(resolvedBase, resolvedCandidate);
  const escaped = (value) => value === ".." || value.startsWith(`..${path.sep}`) || path.isAbsolute(value);
  if (escaped(relativeAncestor) || escaped(lexicalRelative)) {
    throw new Error(`${label} must stay inside ${resolvedBase}`);
  }
  return resolvedCandidate;
}

export function databasePath(mode = runtimeMode(), env = process.env) {
  const defaultName = mode === "demo"
    ? "job_search_operations_demo.sqlite"
    : "job_search_operations_dev.sqlite";
  return assertPathInside(DATA_DIR, env.JOB_SEARCH_DB_PATH || path.join(DATA_DIR, defaultName), "database path");
}

export function packagePath(...segments) {
  return assertPathInside(PACKAGE_DIR, path.join(PACKAGE_DIR, ...segments), "application package path");
}

export function configPath(name) {
  if (!new Set(["profile", "search", "sources", "resume"]).has(name)) {
    throw new Error(`Unknown config: ${name}`);
  }
  return path.join(CONFIG_DIR, `${name}.yml`);
}

export function exampleConfigPath(name) {
  const fileName = name === "resume" ? "document.example.yml" : `${name}.example.yml`;
  return path.join(CONFIG_DIR, fileName);
}
