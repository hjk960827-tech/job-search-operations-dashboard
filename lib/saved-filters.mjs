import crypto from "node:crypto";

const ENUMS = {
  status: new Set(["", "new", "reviewing", "skipped", "applied", "interview", "offer", "rejected"]),
  lifecycle: new Set(["active", "archive", "all"]),
  deadline: new Set(["", "urgent", "overdue", "none"]),
  sort: new Set(["score", "deadline", "recent"]),
};

function filterError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanText(value, field, maximum) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw filterError(`${field} must be text`);
  const result = value.trim();
  if (result.length > maximum) throw filterError(`${field} is too long`);
  return result;
}

export function normalizeJobFilters(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw filterError("filters must be an object");
  const unknown = Object.keys(input).filter((key) => !new Set(["search", "track", "platform", "status", "lifecycle", "deadline", "sort", "favorite"]).has(key));
  if (unknown.length) throw filterError(`Unsupported filter field: ${unknown.join(", ")}`);
  const result = {
    search: cleanText(input.search, "filters.search", 200),
    track: cleanText(input.track, "filters.track", 120),
    platform: cleanText(input.platform, "filters.platform", 60),
    status: cleanText(input.status, "filters.status", 30),
    lifecycle: cleanText(input.lifecycle ?? "active", "filters.lifecycle", 30) || "active",
    deadline: cleanText(input.deadline, "filters.deadline", 30),
    sort: cleanText(input.sort ?? "score", "filters.sort", 30) || "score",
    favorite: input.favorite === true,
  };
  if (input.favorite !== undefined && typeof input.favorite !== "boolean") throw filterError("filters.favorite must be true or false");
  for (const [key, values] of Object.entries(ENUMS)) {
    if (!values.has(result[key])) throw filterError(`Unsupported ${key} filter`);
  }
  return result;
}

function rowToFilter(row) {
  return {
    id: row.id,
    name: row.name,
    filters: normalizeJobFilters(JSON.parse(row.filter_json)),
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSavedFilters(db) {
  return db.prepare("SELECT * FROM saved_filters ORDER BY is_default DESC, name_key, id").all().map(rowToFilter);
}

export function saveFilter(db, input, { id = "" } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw filterError("Saved filter must be an object");
  const name = cleanText(input.name, "name", 80);
  if (!name) throw filterError("name is required");
  const nameKey = name.normalize("NFKC").toLocaleLowerCase("en-US");
  const filters = normalizeJobFilters(input.filters);
  if (input.isDefault !== undefined && typeof input.isDefault !== "boolean") throw filterError("isDefault must be true or false");
  const isDefault = input.isDefault === true;
  const identifier = id || crypto.randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(identifier)) throw filterError("Saved filter id is invalid");
  const existing = id ? db.prepare("SELECT id FROM saved_filters WHERE id = ?").get(id) : null;
  if (id && !existing) throw filterError("Saved filter not found", 404);
  if (!id && Number(db.prepare("SELECT COUNT(*) AS count FROM saved_filters").get().count) >= 30) {
    throw filterError("No more than 30 saved filters are allowed", 409);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (isDefault) db.exec("UPDATE saved_filters SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE is_default = 1");
    db.prepare(`
      INSERT INTO saved_filters (id, name, name_key, filter_json, is_default)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        name_key = excluded.name_key,
        filter_json = excluded.filter_json,
        is_default = excluded.is_default,
        updated_at = CURRENT_TIMESTAMP
    `).run(identifier, name, nameKey, JSON.stringify(filters), isDefault ? 1 : 0);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (/UNIQUE constraint failed: saved_filters\.name_key/.test(String(error.message))) throw filterError("A saved filter with this name already exists", 409);
    throw error;
  }
  return listSavedFilters(db).find((item) => item.id === identifier);
}

export function deleteSavedFilter(db, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) throw filterError("Saved filter id is invalid");
  const result = db.prepare("DELETE FROM saved_filters WHERE id = ?").run(id);
  if (!result.changes) throw filterError("Saved filter not found", 404);
  return listSavedFilters(db);
}
