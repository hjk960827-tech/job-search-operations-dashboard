import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { PROJECT_ROOT } from "../lib/paths.mjs";

const rootArgument = process.argv.indexOf("--root");
const scanRoot = path.resolve(rootArgument >= 0 ? process.argv[rootArgument + 1] || "" : PROJECT_ROOT);
const riskyExtensions = new Set([".sqlite", ".db", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pem", ".p12", ".pfx"]);
const riskySegments = new Set([
  "raw", "reports", "output", "logs", "backups", "support-packages", "evidence",
  "resume", "resumes", "portfolio", "portfolios", "applications", "application-packages",
]);
const findings = [];

const contentRules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["absolute macOS user path", /\/Users\/[A-Za-z0-9._-]+\//],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["Telegram bot token", /\b\d{6,12}:[A-Za-z0-9_-]{30,50}\b/],
  ["assigned secret", /(?:api[_-]?key|access[_-]?token|bot[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
  ["Korean phone number", /(?<!\d)01[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)/],
  ["resident-registration-like number", /(?<!\d)\d{6}[ -]?[1-4]\d{6}(?!\d)/],
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];

function releaseCandidateFiles(root) {
  try {
    const output = execFileSync(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return output.split("\0").filter(Boolean).map((relative) => path.join(root, relative));
  } catch {
    throw new Error(`Security check requires a Git working tree: ${root}`);
  }
}

function riskyPath(relative) {
  const normalized = relative.split(path.sep).join("/");
  const segments = normalized.split("/");
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const basename = path.posix.basename(normalized);
  const lower = normalized.toLowerCase();
  const exampleConfig = lower.startsWith("config/") && /\.example\.ya?ml$/i.test(basename);
  if (lower.startsWith("config/") && /\.ya?ml$/i.test(basename) && !exampleConfig) {
    return "non-example local configuration";
  }
  const syntheticDemo = lower.startsWith("examples/demo/");
  const sensitiveName = /(?:^|[-_.])(resume|cv|portfolio|profile|applications?|job[-_]?export|claim[-_]?bank|evidence|backup)(?:[-_.]|$)/i;
  if (!syntheticDemo && !exampleConfig && sensitiveName.test(basename)) return "personal career-data filename";
  if (basename === ".env" || basename.startsWith(".env.")) return basename !== ".env.example" ? "tracked local environment file" : "";
  if (riskyExtensions.has(path.posix.extname(basename).toLowerCase())) return "risky binary or personal document";
  if (lowerSegments.some((segment) => riskySegments.has(segment))) return "risky private-data path";
  return "";
}

for (const filePath of releaseCandidateFiles(scanRoot)) {
  const relative = path.relative(scanRoot, filePath);
  const pathFinding = riskyPath(relative);
  if (pathFinding) findings.push({ file: relative, rule: pathFinding });
  let candidateStat;
  try {
    candidateStat = fs.lstatSync(filePath);
  } catch {
    findings.push({ file: relative, rule: "release candidate path is missing or unreadable" });
    continue;
  }
  if (candidateStat.isSymbolicLink()) {
    findings.push({ file: relative, rule: "symbolic links are not allowed in release candidates" });
    continue;
  }
  if (candidateStat.size > 2_000_000) {
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
console.log("Security check passed: every tracked or non-ignored candidate file is free of secret, personal-contact, absolute-user-path, and risky-file findings.");
