import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeDatabase, openDatabase } from "../lib/database.mjs";
import { runDoctor } from "../lib/doctor.mjs";

function fixture(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const data = path.join(directory, "data");
  const config = path.join(directory, "config");
  fs.mkdirSync(data, { mode: 0o700 });
  fs.mkdirSync(config, { mode: 0o700 });
  const databasePath = path.join(data, "personal.sqlite");
  initializeDatabase(databasePath, { mode: "personal" });
  return { directory, data, config, databasePath };
}

function doctorOptions(value, extra = {}) {
  return {
    mode: "personal",
    nodeVersion: "22.13.0",
    env: { HOST: "127.0.0.1", PORT: "8766" },
    directories: { projectRoot: value.directory, data: value.data, config: value.config },
    databasePath: value.databasePath,
    configStatus: { complete: true },
    ...extra,
  };
}

test("doctor reports a healthy local personal installation", () => {
  const value = fixture("doctor-healthy");
  try {
    const result = runDoctor(doctorOptions(value));
    assert.equal(result.ok, true);
    assert.equal(result.checks.every((item) => item.ok), true);
    assert.deepEqual(
      result.checks.filter((item) => item.id.startsWith("database:")).map((item) => item.id),
      ["database:integrity", "database:role", "database:version", "database:permissions", "database:migrations"],
    );
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("doctor fails closed when migration history is incomplete", () => {
  const value = fixture("doctor-migrations");
  try {
    const db = openDatabase(value.databasePath);
    db.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    db.close();
    const result = runDoctor(doctorOptions(value));
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((item) => item.id === "database:migrations").ok, false);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("doctor fails closed when a migration checksum is changed", () => {
  const value = fixture("doctor-migration-checksum");
  try {
    const db = openDatabase(value.databasePath);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 6").run();
    db.close();
    const result = runDoctor(doctorOptions(value));
    const check = result.checks.find((item) => item.id === "database:migrations");
    assert.equal(result.ok, false);
    assert.equal(check.ok, false);
    assert.match(check.detail.join(" "), /migration 6 checksum mismatch/);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("doctor accepts an uninitialized demo data directory but rejects protected port 8765", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-clean-clone-"));
  const config = path.join(directory, "config");
  fs.mkdirSync(config, { mode: 0o700 });
  try {
    const base = {
      mode: "demo",
      nodeVersion: "22.13.0",
      directories: { projectRoot: directory, data: path.join(directory, "data"), config },
      databasePath: path.join(directory, "data", "demo.sqlite"),
      configStatus: { complete: false },
    };
    const safe = runDoctor({ ...base, env: { HOST: "localhost", PORT: "8766" } });
    assert.equal(safe.ok, true);
    assert.equal(safe.checks.find((item) => item.id === "path:data").ok, true);
    const protectedPort = runDoctor({ ...base, env: { HOST: "localhost", PORT: "8765" } });
    assert.equal(protectedPort.ok, false);
    assert.equal(protectedPort.checks.find((item) => item.id === "runtime:port").ok, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
