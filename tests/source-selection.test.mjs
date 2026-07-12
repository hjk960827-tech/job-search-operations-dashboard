import test from "node:test";
import assert from "node:assert/strict";
import { rankSources, selectPrimarySource } from "../lib/source-selection.mjs";

const config = {
  primary_selection: { prefer_direct_company: true, require_not_closed: true },
  sources: {
    direct: { display: true, priority: 0 },
    wanted: { display: true, priority: 10 },
    linkedin: { display: true, priority: 20 },
    hidden: { display: false, priority: 1 },
  },
};

test("active direct source wins over platform priority", () => {
  const result = selectPrimarySource([
    { platform: "wanted", status: "active", confidence: 100, checkedAt: "2026-02-01" },
    { platform: "direct", status: "active", confidence: 70, checkedAt: "2026-01-01" },
  ], config);
  assert.equal(result.platform, "direct");
});

test("closed direct source is excluded when an active source exists", () => {
  const result = selectPrimarySource([
    { platform: "direct", status: "closed", confidence: 100, checkedAt: "2026-02-01" },
    { platform: "wanted", status: "active", confidence: 80, checkedAt: "2026-01-01" },
  ], config);
  assert.equal(result.platform, "wanted");
});

test("hidden sources do not participate", () => {
  const ranked = rankSources([
    { platform: "hidden", status: "active", confidence: 100 },
    { platform: "linkedin", status: "active", confidence: 70 },
  ], config);
  assert.deepEqual(ranked.map((item) => item.platform), ["linkedin"]);
});
