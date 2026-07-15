import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../lib/paths.mjs";

const source = path.join(PROJECT_ROOT, ".githooks", "pre-push");
const gitDirectory = path.join(PROJECT_ROOT, ".git");
const target = path.join(gitDirectory, "hooks", "pre-push");

if (!fs.existsSync(gitDirectory)) throw new Error("Git metadata directory was not found");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
fs.chmodSync(target, 0o755);
console.log("Installed the explicit-approval pre-push safety gate.");
