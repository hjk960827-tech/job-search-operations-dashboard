import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanner = path.join(root, "scripts", "security-check.mjs");

function repository() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-security-"));
  execFileSync("git", ["init", "-q", directory]);
  return directory;
}

function stage(directory, relative, contents = "safe fixture\n") {
  const file = path.join(directory, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  execFileSync("git", ["-C", directory, "add", "--", relative]);
}

function scan(directory) {
  return spawnSync(process.execPath, [scanner, "--root", directory], { encoding: "utf8" });
}

test("security check scans tracked and non-ignored files but ignores local data excluded by Git", () => {
  const directory = repository();
  try {
    stage(directory, ".gitignore", "data/\n");
    fs.mkdirSync(path.join(directory, "src"), { recursive: true });
    fs.writeFileSync(path.join(directory, "src", "index.mjs"), "safe untracked candidate\n");
    fs.mkdirSync(path.join(directory, "data"), { recursive: true });
    fs.writeFileSync(path.join(directory, "data", "local.sqlite"), "private local fixture");
    assert.equal(scan(directory).status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("security check blocks unsafe untracked release candidates", () => {
  const directory = repository();
  try {
    fs.mkdirSync(path.join(directory, "src"), { recursive: true });
    fs.writeFileSync(path.join(directory, "src", "contact.txt"), ["010", "1234", "5678"].join("-"));
    assert.notEqual(scan(directory).status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("security check blocks tracked symbolic links without following their target", () => {
  const directory = repository();
  const outside = path.join(os.tmpdir(), `release-security-outside-${process.pid}.txt`);
  try {
    fs.writeFileSync(outside, "safe-looking outside file\n");
    fs.mkdirSync(path.join(directory, "src"), { recursive: true });
    fs.symlinkSync(outside, path.join(directory, "src", "outside-link"));
    execFileSync("git", ["-C", directory, "add", "--", "src/outside-link"]);
    assert.notEqual(scan(directory).status, 0);
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("security check blocks untracked symbolic links without following their target", () => {
  const directory = repository();
  const outside = path.join(os.tmpdir(), `release-security-untracked-outside-${process.pid}.txt`);
  try {
    fs.writeFileSync(outside, "safe-looking outside file\n");
    fs.mkdirSync(path.join(directory, "src"), { recursive: true });
    fs.symlinkSync(outside, path.join(directory, "src", "untracked-outside-link"));
    const result = scan(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symbolic links are not allowed/);
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const tracked of [true, false]) {
  test(`security check blocks ${tracked ? "tracked" : "untracked"} dangling symbolic links`, () => {
    const directory = repository();
    try {
      const link = path.join(directory, "src", "dangling-link");
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.join(directory, "missing-target"), link);
      if (tracked) execFileSync("git", ["-C", directory, "add", "--", "src/dangling-link"]);
      const result = scan(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /symbolic links are not allowed/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("security check blocks tracked risky files and private content", () => {
  const fixtures = [
    ["data/leak.sqlite", "binary-like"],
    [".env", "SAFE_NAME=value"],
    ["config/custom.yml", "setup_complete: true\n"],
    ["resume.json", "{}\n"],
    ["portfolio-notes.md", "sanitized-looking content\n"],
    ["Reports/result.txt", "sanitized-looking content\n"],
    ["Resume/data.txt", "sanitized-looking content\n"],
    ["src/token.txt", `sk-${"x".repeat(24)}`],
    ["src/telegram.txt", ["123456789", "A".repeat(35)].join(":")],
    ["src/contact.txt", ["010", "1234", "5678"].join("-")],
    ["src/email.txt", ["private.person", "example.invalid"].join("@")],
  ];
  for (const [relative, contents] of fixtures) {
    const directory = repository();
    try {
      stage(directory, relative, contents);
      const result = scan(directory);
      assert.notEqual(result.status, 0, `${relative} should be blocked`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
