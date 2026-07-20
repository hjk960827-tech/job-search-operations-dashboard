import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeDatabase, openDatabase } from "../lib/database.mjs";
import { deleteSavedFilter, listSavedFilters, saveFilter } from "../lib/saved-filters.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "saved-filter-"));
  const file = path.join(directory, "personal.sqlite");
  initializeDatabase(file, { mode: "personal" });
  return { directory, db: openDatabase(file) };
}

test("saved filters preserve only generic UI conditions and one optional default", () => {
  const value = fixture();
  try {
    const first = saveFilter(value.db, {
      name: "Remote roles",
      filters: { search: "", track: "Engineering", lifecycle: "active", sort: "deadline", favorite: false },
      isDefault: true,
    });
    assert.equal(first.isDefault, true);
    const second = saveFilter(value.db, {
      name: "Interested",
      filters: { favorite: true, lifecycle: "all", status: "", deadline: "", sort: "score" },
      isDefault: true,
    });
    const items = listSavedFilters(value.db);
    assert.equal(items.length, 2);
    assert.equal(items.filter((item) => item.isDefault).length, 1);
    assert.equal(items.find((item) => item.id === second.id).isDefault, true);
    assert.equal(items.find((item) => item.id === first.id).isDefault, false);
    assert.deepEqual(Object.keys(items[0].filters).sort(), ["deadline", "favorite", "lifecycle", "platform", "search", "sort", "status", "track"]);
    assert.equal(deleteSavedFilter(value.db, first.id).length, 1);
  } finally {
    value.db.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("saved filters reject duplicate names, unknown fields, and unsupported enum values", () => {
  const value = fixture();
  try {
    saveFilter(value.db, { name: "Review", filters: { lifecycle: "active" } });
    assert.throws(() => saveFilter(value.db, { name: " review ", filters: {} }), /already exists/);
    assert.throws(() => saveFilter(value.db, { name: "Unknown", filters: { fixedRole: "Example" } }), /Unsupported filter field/);
    assert.throws(() => saveFilter(value.db, { name: "Bad", filters: { sort: "random" } }), /Unsupported sort/);
    assert.throws(() => deleteSavedFilter(value.db, "not-an-id"), /invalid/);
    assert.equal(listSavedFilters(value.db).length, 1);
  } finally {
    value.db.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
