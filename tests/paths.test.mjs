import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, assertPathInside, databasePath } from "../lib/paths.mjs";
import { DEFAULT_HOST, DEFAULT_PORT, runtimePort } from "../lib/runtime.mjs";

test("default release runtime is isolated from the protected personal port", () => {
  assert.equal(DEFAULT_HOST, "127.0.0.1");
  assert.equal(DEFAULT_PORT, 8766);
  assert.notEqual(DEFAULT_PORT, 8765);
  assert.equal(runtimePort({}), 8766);
  assert.throws(() => runtimePort({ PORT: "8765" }), /reserved/);
});

test("database defaults stay inside data directory", () => {
  const value = databasePath("personal", {});
  assert.equal(path.dirname(value), DATA_DIR);
  assert.equal(fs.statSync(DATA_DIR).mode & 0o777, 0o700);
});

test("database path outside data directory is rejected", () => {
  const outside = path.join(DATA_DIR, "..", "outside.sqlite");
  assert.throws(() => assertPathInside(DATA_DIR, outside, "database path"), /must stay inside/);
});

test("dangling links cannot redirect a database path outside its data directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "path-symlink-"));
  const base = path.join(directory, "data");
  const outside = path.join(directory, "outside", "private.sqlite");
  const link = path.join(base, "redirect.sqlite");
  try {
    fs.mkdirSync(base);
    fs.symlinkSync(outside, link);
    assert.throws(() => assertPathInside(base, link, "database path"), /must not use symbolic links/);
    assert.equal(fs.existsSync(outside), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
