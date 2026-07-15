import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertConfigDirectory, assertRegularConfigFile, configEntryExists, loadExampleConfig, readYaml, validateConfig } from "../lib/config.mjs";
import { exampleConfigPath } from "../lib/paths.mjs";

function completedExample(name) {
  const value = structuredClone(readYaml(exampleConfigPath(name)));
  value.setup_complete = true;
  if (name === "profile") value.identity.display_name = "Example User";
  if (name === "search") value.target_roles = ["Example Role"];
  return value;
}

test("completed example configurations pass structural validation", () => {
  for (const name of ["profile", "search", "sources", "resume"]) {
    assert.deepEqual(validateConfig(name, completedExample(name)), { valid: true, issues: [] });
  }
});

test("configuration validation rejects incomplete settings and unsafe source keys", () => {
  const incomplete = completedExample("search");
  incomplete.target_roles = [];
  assert.equal(validateConfig("search", incomplete).valid, false);

  const sources = completedExample("sources");
  sources.sources["bad/platform"] = { label: "Bad", collect: true, display: true, lifecycle_check: true, priority: 10 };
  const result = validateConfig("sources", sources);
  assert.equal(result.valid, false);
  assert.equal(result.issues.some((item) => item.includes("invalid platform key")), true);
});

test("users can add a structurally valid custom job platform", () => {
  const sources = completedExample("sources");
  sources.sources.custom_portal = {
    label: "Custom Portal",
    collect: true,
    display: true,
    lifecycle_check: true,
    priority: 100,
  };
  assert.deepEqual(validateConfig("sources", sources), { valid: true, issues: [] });
});

test("resume configuration exposes only active quality rules and rejects invalid bounds", () => {
  const resume = completedExample("resume");
  assert.deepEqual(Object.keys(resume).sort(), ["quality_rules", "setup_complete"]);
  assert.deepEqual(Object.keys(resume.quality_rules).sort(), ["maximum_pdf_pages", "minimum_score"]);
  resume.quality_rules.minimum_score = 101;
  resume.quality_rules.maximum_pdf_pages = 0;
  const result = validateConfig("resume", resume);
  assert.equal(result.valid, false);
  assert.equal(result.issues.length, 2);
});

test("demo examples load directly and configuration links are rejected", () => {
  assert.deepEqual(loadExampleConfig("search"), readYaml(exampleConfigPath("search")));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "config-link-"));
  const target = path.join(directory, "target.yml");
  const link = path.join(directory, "profile.yml");
  try {
    fs.writeFileSync(target, "setup_complete: true\n");
    fs.symlinkSync(target, link);
    assert.throws(() => assertRegularConfigFile(link), /regular file, not a link/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("dangling configuration links count as entries and fail closed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "config-dangling-link-"));
  const link = path.join(directory, "profile.yml");
  try {
    fs.symlinkSync(path.join(directory, "missing-target.yml"), link);
    assert.equal(configEntryExists(link), true);
    assert.throws(() => assertRegularConfigFile(link), /regular file, not a link/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a linked configuration directory is rejected", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "config-directory-link-"));
  const target = path.join(directory, "target");
  const link = path.join(directory, "config");
  try {
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, "dir");
    assert.throws(() => assertConfigDirectory(link), /real directory, not a link/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
