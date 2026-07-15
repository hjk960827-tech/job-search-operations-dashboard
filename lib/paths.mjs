import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(here, "..");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const CONFIG_DIR = path.join(PROJECT_ROOT, "config");
export const PACKAGE_DIR = path.join(DATA_DIR, "application-packages");
export const PRIVATE_DATA_DIR = path.join(DATA_DIR, "private");
export const ONBOARDING_DIR = path.join(PRIVATE_DATA_DIR, "onboarding");
export const ONBOARDING_DOCUMENTS_DIR = path.join(PRIVATE_DATA_DIR, "documents");

export function runtimeMode(value = process.env.APP_MODE || "demo") {
  const normalized = String(value).trim().toLowerCase();
  if (!new Set(["demo", "onboarding", "personal"]).has(normalized)) {
    throw new Error("APP_MODE must be demo, onboarding, or personal");
  }
  return normalized;
}

function lstatIfPresent(candidate) {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function assertPathInside(baseDir, candidatePath, label = "path") {
  const lexicalBase = path.resolve(baseDir);
  fs.mkdirSync(lexicalBase, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(lexicalBase).isSymbolicLink()) throw new Error(`${label} base directory must not be a symbolic link`);
  const resolvedBase = fs.realpathSync(lexicalBase);
  fs.chmodSync(resolvedBase, 0o700);
  const resolvedCandidate = path.resolve(PROJECT_ROOT, candidatePath);
  const lexicalRelative = path.relative(lexicalBase, resolvedCandidate);
  const escaped = (value) => value === ".." || value.startsWith(`..${path.sep}`) || path.isAbsolute(value);
  if (escaped(lexicalRelative)) {
    throw new Error(`${label} must stay inside ${resolvedBase}`);
  }
  let current = lexicalBase;
  for (const segment of lexicalRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`${label} must not use symbolic links`);
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

export function onboardingPath(...segments) {
  return assertPathInside(ONBOARDING_DIR, path.join(ONBOARDING_DIR, ...segments), "onboarding path");
}

export function onboardingDocumentPath(...segments) {
  return assertPathInside(ONBOARDING_DOCUMENTS_DIR, path.join(ONBOARDING_DOCUMENTS_DIR, ...segments), "onboarding document path");
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
