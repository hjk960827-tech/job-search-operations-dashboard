import fs from "node:fs";
import yaml from "js-yaml";
import { CONFIG_DIR, configPath, exampleConfigPath } from "./paths.mjs";

export const CONFIG_NAMES = ["profile", "search", "sources", "resume"];
const RESERVED_SOURCE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isValidSourceKey(value) {
  const key = String(value || "").trim();
  return /^[a-z0-9][a-z0-9_-]{0,59}$/i.test(key) && !RESERVED_SOURCE_KEYS.has(key.toLowerCase());
}

function issue(message) {
  return String(message);
}

export function configEntryExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function assertConfigDirectory(directory = CONFIG_DIR) {
  if (!configEntryExists(directory)) throw new Error(`Configuration directory is missing: ${directory}`);
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Configuration directory must be a real directory, not a link: ${directory}`);
  }
}

export function assertRegularConfigFile(filePath) {
  assertConfigDirectory();
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Configuration must be a regular file, not a link: ${filePath}`);
  }
}

export function validateConfig(name, value, { requireComplete = true } = {}) {
  const input = value && typeof value === "object" ? value : {};
  const issues = [];
  if (requireComplete && input.setup_complete !== true) issues.push(issue(`${name}.setup_complete must be true`));
  if (name === "profile") {
    if (requireComplete && !String(input.identity?.display_name || "").trim()) issues.push(issue("profile.identity.display_name is required"));
    if (!Array.isArray(input.location?.regions)) issues.push(issue("profile.location.regions must be a list"));
  } else if (name === "search") {
    if (!Array.isArray(input.target_roles) || (requireComplete && !input.target_roles.some((item) => String(item || "").trim()))) {
      issues.push(issue("search.target_roles must include at least one role"));
    }
    for (const key of ["include_keywords", "exclude_keywords", "target_tracks"]) {
      if (!Array.isArray(input[key])) issues.push(issue(`search.${key} must be a list`));
    }
    for (const [group, value] of [["industry_preferences", input.industry_preferences], ["work_preferences", input.work_preferences]]) {
      if (value !== undefined) {
        if (!value || typeof value !== "object" || Array.isArray(value)) issues.push(issue(`search.${group} must be an object`));
        else {
          for (const key of Object.keys(value)) if (!Array.isArray(value[key])) issues.push(issue(`search.${group}.${key} must be a list`));
        }
      }
    }
    const reviewBelow = Number(input.scoring?.review_below);
    if (!Number.isFinite(reviewBelow) || reviewBelow < 0 || reviewBelow > 100) {
      issues.push(issue("search.scoring.review_below must be between 0 and 100"));
    }
    if (input.scoring?.dimensions !== undefined) {
      if (!Array.isArray(input.scoring.dimensions)) issues.push(issue("search.scoring.dimensions must be a list"));
      else {
        const ids = new Set();
        let enabledWeight = 0;
        let enabledCount = 0;
        for (const [index, dimension] of input.scoring.dimensions.entries()) {
          if (!dimension || typeof dimension !== "object" || Array.isArray(dimension)) {
            issues.push(issue(`search.scoring.dimensions[${index}] must be an object`));
            continue;
          }
          const id = String(dimension.id || "").trim();
          if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id)) issues.push(issue(`search.scoring.dimensions[${index}].id is invalid`));
          else if (ids.has(id)) issues.push(issue(`search.scoring contains duplicate dimension id: ${id}`));
          ids.add(id);
          if (!String(dimension.label || "").trim()) issues.push(issue(`search.scoring.dimensions[${index}].label is required`));
          if (typeof dimension.enabled !== "boolean") issues.push(issue(`search.scoring.dimensions[${index}].enabled must be true or false`));
          const weight = Number(dimension.weight);
          if (!Number.isFinite(weight) || weight < 0 || weight > 100) issues.push(issue(`search.scoring.dimensions[${index}].weight must be between 0 and 100`));
          if (dimension.enabled === true && Number.isFinite(weight)) {
            enabledWeight += weight;
            enabledCount += 1;
          }
        }
        if (enabledCount && Math.abs(enabledWeight - 100) > 0.0001) issues.push(issue("search.scoring enabled dimension weights must total 100"));
      }
    }
  } else if (name === "sources") {
    if (!input.sources || typeof input.sources !== "object" || Array.isArray(input.sources)) {
      issues.push(issue("sources.sources must be an object"));
    } else {
      for (const [key, source] of Object.entries(input.sources)) {
        if (!isValidSourceKey(key)) issues.push(issue(`sources contains an invalid platform key: ${key}`));
        if (!source || typeof source !== "object") {
          issues.push(issue(`sources.${key} must be an object`));
          continue;
        }
        if (!String(source.label || "").trim()) issues.push(issue(`sources.${key}.label is required`));
        for (const flag of ["collect", "display", "lifecycle_check"]) {
          if (typeof source[flag] !== "boolean") issues.push(issue(`sources.${key}.${flag} must be true or false`));
        }
        if (!Number.isFinite(Number(source.priority))) issues.push(issue(`sources.${key}.priority must be a number`));
      }
    }
  } else if (name === "resume") {
    const minimumScore = Number(input.quality_rules?.minimum_score);
    const maximumPages = Number(input.quality_rules?.maximum_pdf_pages);
    if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 100) {
      issues.push(issue("resume.quality_rules.minimum_score must be between 0 and 100"));
    }
    if (!Number.isInteger(maximumPages) || maximumPages < 1 || maximumPages > 10) {
      issues.push(issue("resume.quality_rules.maximum_pdf_pages must be an integer between 1 and 10"));
    }
  } else if (!CONFIG_NAMES.includes(name)) {
    issues.push(issue(`Unknown config: ${name}`));
  }
  return { valid: issues.length === 0, issues };
}

export function readYaml(filePath) {
  const contents = fs.readFileSync(filePath, "utf8");
  const parsed = yaml.load(contents);
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function configStatus() {
  assertConfigDirectory();
  const files = Object.fromEntries(CONFIG_NAMES.map((name) => {
    const filePath = configPath(name);
    const exists = configEntryExists(filePath);
    let complete = false;
    let issues = [];
    if (exists) {
      try {
        assertRegularConfigFile(filePath);
        fs.chmodSync(filePath, 0o600);
        const validation = validateConfig(name, readYaml(filePath));
        complete = validation.valid;
        issues = validation.issues;
      } catch (error) {
        complete = false;
        issues = [String(error?.message || "Configuration could not be read")];
      }
    }
    return [name, { exists, complete, issues }];
  }));
  return {
    files,
    complete: Object.values(files).every((item) => item.exists && item.complete),
  };
}

export function loadConfig(name, { allowExample = false } = {}) {
  const localPath = configPath(name);
  if (configEntryExists(localPath)) {
    assertRegularConfigFile(localPath);
    fs.chmodSync(localPath, 0o600);
    const value = readYaml(localPath);
    const validation = validateConfig(name, value);
    if (!validation.valid) throw new Error(`Invalid local configuration: ${validation.issues.join("; ")}`);
    return value;
  }
  if (allowExample) return loadExampleConfig(name);
  throw new Error(`Missing local configuration: config/${name}.yml`);
}

export function loadExampleConfig(name) {
  const examplePath = exampleConfigPath(name);
  assertRegularConfigFile(examplePath);
  const value = readYaml(examplePath);
  const validation = validateConfig(name, value, { requireComplete: false });
  if (!validation.valid) throw new Error(`Invalid example configuration: ${validation.issues.join("; ")}`);
  return value;
}

export function loadAllConfig({ allowExample = false } = {}) {
  return Object.fromEntries(CONFIG_NAMES.map((name) => [name, loadConfig(name, { allowExample })]));
}
