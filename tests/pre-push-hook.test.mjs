import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, ".githooks", "pre-push");
const zeroSha = "0".repeat(40);

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-gate-"));
  const scanner = `${directory}-scanner.py`;
  const binDirectory = path.join(directory, "test-bin");
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "config", "user.name", "Release Test"]);
  execFileSync("git", ["-C", directory, "config", "user.email", ["release-test", "example.invalid"].join("@")]);
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: { verify: "node -e \"process.exit(0)\"" } }));
  fs.writeFileSync(path.join(directory, "safe.txt"), "safe\n");
  fs.writeFileSync(scanner, "import sys\nsys.exit(0)\n", { mode: 0o700 });
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(path.join(binDirectory, "gitleaks"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", ["-C", directory, "commit", "-qm", "fixture base"]);
  const base = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(directory, "release.txt"), "approved release\n");
  execFileSync("git", ["-C", directory, "add", "release.txt"]);
  execFileSync("git", ["-C", directory, "commit", "-qm", "fixture release"]);
  const head = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", directory, "rev-parse", `${head}^{tree}`], { encoding: "utf8" }).trim();
  const remoteDescendant = execFileSync(
    "git",
    ["-C", directory, "commit-tree", tree, "-p", head, "-m", "remote-only descendant"],
    { encoding: "utf8" },
  ).trim();
  return { directory, scanner, binDirectory, base, head, remoteDescendant };
}

function runHook(value, input, {
  remoteName = "origin",
  remoteUrl = "https://example.invalid/repository.git",
  includeGitleaks = true,
} = {}) {
  const executablePath = includeGitleaks
    ? `${value.binDirectory}${path.delimiter}${process.env.PATH}`
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
  return spawnSync("sh", [hook, remoteName, remoteUrl], {
    cwd: value.directory,
    env: {
      ...process.env,
      PATH: executablePath,
      PRE_PUBLISH_SAFETY_SCRIPT: value.scanner,
    },
    input,
    encoding: "utf8",
  });
}

function approve(value) {
  fs.writeFileSync(path.join(value.directory, ".git", "PUSH_APPROVED"), [
    `sha=${value.head}`,
    "remote_name=origin",
    "remote_url=https://example.invalid/repository.git",
    "remote_ref=refs/heads/main",
    "",
  ].join("\n"), { mode: 0o600 });
}

test("pre-push gate binds approval to the actual ref and a clean working tree", () => {
  const value = fixture();
  const approvedRef = `refs/heads/main ${value.head} refs/heads/main ${zeroSha}\n`;
  try {
    assert.notEqual(runHook(value, approvedRef).status, 0, "missing approval must fail closed");

    approve(value);
    const differentRef = `refs/heads/other ${"1".repeat(40)} refs/heads/other ${zeroSha}\n`;
    assert.notEqual(runHook(value, differentRef).status, 0, "a different ref tip must not reuse HEAD approval");
    const wrongDestination = `refs/heads/main ${value.head} refs/heads/other ${zeroSha}\n`;
    assert.notEqual(runHook(value, wrongDestination).status, 0, "a different remote ref must not reuse approval");
    assert.notEqual(
      runHook(value, approvedRef, { remoteUrl: "https://example.invalid/different.git" }).status,
      0,
      "a different remote URL must not reuse approval",
    );

    fs.writeFileSync(path.join(value.directory, "untracked.txt"), "not approved\n");
    assert.notEqual(runHook(value, approvedRef).status, 0, "untracked release content must fail closed");
    fs.rmSync(path.join(value.directory, "untracked.txt"), { force: true });

    const forcePush = `${"refs/heads/main"} ${value.head} refs/heads/main ${value.remoteDescendant}\n`;
    const forceBlocked = runHook(value, forcePush);
    assert.notEqual(forceBlocked.status, 0, "non-fast-forward history replacement must fail closed");
    assert.match(forceBlocked.stderr, /non-fast-forward or force push/);

    const fastForward = `refs/heads/main ${value.head} refs/heads/main ${value.base}\n`;
    const passed = runHook(value, fastForward);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(fs.existsSync(path.join(value.directory, ".git", "PUSH_APPROVED")), false);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
    fs.rmSync(value.scanner, { force: true });
  }
});

test("pre-push gate fails closed when gitleaks is unavailable", () => {
  const value = fixture();
  const approvedRef = `refs/heads/main ${value.head} refs/heads/main ${zeroSha}\n`;
  try {
    approve(value);
    const result = runHook(value, approvedRef, { includeGitleaks: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /gitleaks is required/);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
    fs.rmSync(value.scanner, { force: true });
  }
});

test("pre-push gate blocks personal author or committer email metadata", () => {
  const value = fixture();
  try {
    execFileSync("git", ["-C", value.directory, "config", "user.email", ["personal", "example.com"].join("@")]);
    fs.writeFileSync(path.join(value.directory, "metadata-check.txt"), "new commit\n");
    execFileSync("git", ["-C", value.directory, "add", "metadata-check.txt"]);
    execFileSync("git", ["-C", value.directory, "commit", "-qm", "metadata privacy fixture"]);
    value.head = execFileSync("git", ["-C", value.directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    approve(value);
    const approvedRef = `refs/heads/main ${value.head} refs/heads/main ${zeroSha}\n`;
    const result = runHook(value, approvedRef);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside privacy-preserving noreply domains/);
    assert.doesNotMatch(result.stderr, /personal@example\.com/);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
    fs.rmSync(value.scanner, { force: true });
  }
});
