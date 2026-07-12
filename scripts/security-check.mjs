import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { PROJECT_ROOT } from "../lib/paths.mjs";

const skippedDirectories = new Set([".git", "node_modules", "data", "reports", "output", "logs", "tmp"]);
const riskyExtensions = new Set([".sqlite", ".db", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pem", ".p12", ".pfx"]);
const findings = [];

const contentRules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["absolute macOS user path", /\/Users\/[A-Za-z0-9._-]+\//],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["assigned secret", /(?:api[_-]?key|access[_-]?token|bot[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
  ["Korean phone number", /(?<!\d)01[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)/],
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

for (const filePath of walk(PROJECT_ROOT)) {
  const relative = path.relative(PROJECT_ROOT, filePath);
  if (relative === ".env") findings.push({ file: relative, rule: "tracked local environment file" });
  if (riskyExtensions.has(path.extname(relative).toLowerCase())) findings.push({ file: relative, rule: "risky binary or personal document" });
  const stat = fs.statSync(filePath);
  if (stat.size > 2_000_000) {
    findings.push({ file: relative, rule: "file larger than 2 MB requires review" });
    continue;
  }
  let contents;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch {
    findings.push({ file: relative, rule: "unreadable or binary file" });
    continue;
  }
  for (const [rule, pattern] of contentRules) {
    if (pattern.test(contents)) findings.push({ file: relative, rule });
  }
}

if (findings.length) {
  console.error(`Security check blocked release (${findings.length} finding(s)).`);
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.rule}`);
  process.exit(1);
}
console.log("Security check passed: no secret, personal-contact, absolute-user-path, or risky-file findings.");
