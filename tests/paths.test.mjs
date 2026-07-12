import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DATA_DIR, assertPathInside, databasePath } from "../lib/paths.mjs";
import { DEFAULT_HOST, DEFAULT_PORT, runtimePort } from "../lib/runtime.mjs";

test("default release runtime is isolated from the protected personal port", () => {
  assert.equal(DEFAULT_HOST, "127.0.0.1");
  assert.equal(DEFAULT_PORT, 8766);
  assert.notEqual(DEFAULT_PORT, 8765);
  assert.equal(runtimePort({}), 8766);
});

test("database defaults stay inside data directory", () => {
  const value = databasePath("personal", {});
  assert.equal(path.dirname(value), DATA_DIR);
});

test("database path outside data directory is rejected", () => {
  const outside = path.join(DATA_DIR, "..", "outside.sqlite");
  assert.throws(() => assertPathInside(DATA_DIR, outside, "database path"), /must stay inside/);
});
