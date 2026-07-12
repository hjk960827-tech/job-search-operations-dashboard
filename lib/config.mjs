import fs from "node:fs";
import yaml from "js-yaml";
import { configPath, exampleConfigPath } from "./paths.mjs";

export const CONFIG_NAMES = ["profile", "search", "sources", "resume"];

export function readYaml(filePath) {
  const contents = fs.readFileSync(filePath, "utf8");
  const parsed = yaml.load(contents);
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function configStatus() {
  const files = Object.fromEntries(CONFIG_NAMES.map((name) => {
    const filePath = configPath(name);
    const exists = fs.existsSync(filePath);
    let complete = false;
    if (exists) {
      try {
        complete = readYaml(filePath).setup_complete === true;
      } catch {
        complete = false;
      }
    }
    return [name, { exists, complete }];
  }));
  return {
    files,
    complete: Object.values(files).every((item) => item.exists && item.complete),
  };
}

export function loadConfig(name, { allowExample = false } = {}) {
  const localPath = configPath(name);
  if (fs.existsSync(localPath)) return readYaml(localPath);
  if (allowExample) return readYaml(exampleConfigPath(name));
  throw new Error(`Missing local configuration: config/${name}.yml`);
}

export function loadAllConfig({ allowExample = false } = {}) {
  return Object.fromEntries(CONFIG_NAMES.map((name) => [name, loadConfig(name, { allowExample })]));
}
