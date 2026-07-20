import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("companion CLI fails before creating a personal database when onboarding is incomplete", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "companion-cli-incomplete-"));
  try {
    for (const name of ["config", "db", "lib", "scripts"]) {
      fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
    }
    for (const name of ["profile", "search", "sources", "resume"]) {
      fs.rmSync(path.join(directory, "config", `${name}.yml`), { force: true });
    }
    fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");

    const result = spawnSync(process.execPath, ["scripts/companion.mjs", "list"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /configuration|onboarding|setup/i);
    assert.equal(fs.existsSync(path.join(directory, "data", "job_search_operations_dev.sqlite")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
