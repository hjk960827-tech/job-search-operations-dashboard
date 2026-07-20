import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/git-identity-check.mjs", import.meta.url));

function createCommit(email) {
  const root = mkdtempSync(join(tmpdir(), "jobops-identity-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: email,
    },
  });
  return root;
}

test("identity check accepts GitHub noreply history", () => {
  const safeEmail = ["fixture", "users.noreply.github.com"].join("@");
  const root = createCommit(safeEmail);
  const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /unsafe identities 0/);
});

test("identity check blocks a personal-style email without printing it", () => {
  const unsafeEmail = ["unsafe", ["invalid", "test"].join(".")].join("@");
  const root = createCommit(unsafeEmail);
  const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /values omitted/);
  assert.equal(result.stderr.includes(unsafeEmail), false);
});
