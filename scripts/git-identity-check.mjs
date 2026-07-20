#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const ref = process.argv[2] || "HEAD";
const webNoreply = ["noreply", "github.com"].join("@");
const allowedPatterns = [
  /^[^@\s]+@users\.noreply\.github\.com$/i,
  /^[^@\s]+@noreply\.github\.com$/i,
  new RegExp(`^${webNoreply.replace(".", "\\.")}$`, "i"),
  /^[^@\s]+@example\.invalid$/i,
];

function isAllowed(email) {
  return allowedPatterns.some((pattern) => pattern.test(email.trim()));
}

const result = spawnSync("git", ["log", ref, "--format=%ae%x00%ce"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.status !== 0) {
  console.error("Git identity check blocked: the requested history could not be inspected.");
  process.exit(1);
}

const unsafe = new Set();
let commitCount = 0;
for (const line of result.stdout.split(/\r?\n/)) {
  if (!line) continue;
  commitCount += 1;
  for (const email of line.split("\0")) {
    if (email && !isAllowed(email)) unsafe.add(email);
  }
}

if (commitCount === 0) {
  console.error("Git identity check blocked: no commit history was found.");
  process.exit(1);
}

if (unsafe.size > 0) {
  console.error(
    `Git identity check blocked: ${unsafe.size} author/committer email address(es) are outside privacy-preserving noreply domains; values omitted.`,
  );
  process.exit(1);
}

console.log(`Git identity check passed: ${commitCount} reachable commit(s), unsafe identities 0.`);
