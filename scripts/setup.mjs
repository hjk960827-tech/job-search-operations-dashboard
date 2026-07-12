import fs from "node:fs";
import process from "node:process";
import readline from "node:readline/promises";
import yaml from "js-yaml";
import { CONFIG_NAMES, readYaml } from "../lib/config.mjs";
import { configPath, exampleConfigPath } from "../lib/paths.mjs";

function list(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

const force = process.argv.includes("--force");
const existing = CONFIG_NAMES.filter((name) => fs.existsSync(configPath(name)));
if (existing.length && !force) {
  console.error(`Local configuration already exists: ${existing.join(", ")}`);
  console.error("Nothing was changed. Use --force only if you intend to replace it.");
  process.exit(1);
}

const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
try {
  const displayName = await terminal.question("화면에 표시할 이름: ");
  const targetRoles = list(await terminal.question("목표 직무를 쉼표로 구분해 입력: "));
  const regions = list(await terminal.question("희망 지역을 쉼표로 구분해 입력: "));
  const includeKeywords = list(await terminal.question("포함 키워드를 쉼표로 구분해 입력: "));
  const excludeKeywords = list(await terminal.question("제외 키워드를 쉼표로 구분해 입력: "));
  const enabledSources = new Set(list(await terminal.question("수집할 플랫폼 키를 쉼표로 구분해 입력: ")));

  if (!displayName.trim() || !targetRoles.length) {
    throw new Error("표시 이름과 목표 직무는 필수입니다.");
  }

  const configs = Object.fromEntries(CONFIG_NAMES.map((name) => [name, readYaml(exampleConfigPath(name))]));
  configs.profile.setup_complete = true;
  configs.profile.identity.display_name = displayName.trim();
  configs.profile.location.regions = regions;
  configs.search.setup_complete = true;
  configs.search.target_roles = targetRoles;
  configs.search.include_keywords = includeKeywords;
  configs.search.exclude_keywords = excludeKeywords;
  configs.search.target_tracks = targetRoles.map((label, index) => ({ id: `track-${index + 1}`, label, priority: index + 1 }));
  configs.sources.setup_complete = true;
  for (const [key, source] of Object.entries(configs.sources.sources || {})) {
    source.collect = enabledSources.has(key);
  }
  configs.resume.setup_complete = true;
  configs.resume.target_tracks = targetRoles;

  for (const name of CONFIG_NAMES) {
    fs.writeFileSync(configPath(name), yaml.dump(configs[name], { lineWidth: 100, noRefs: true }), { mode: 0o600 });
  }
  console.log("Local configuration created. These files are ignored by Git.");
  console.log("Next: APP_MODE=personal npm run db:init");
} finally {
  terminal.close();
}
