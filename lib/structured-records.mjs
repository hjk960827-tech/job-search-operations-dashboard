import crypto from "node:crypto";

export const STRUCTURED_ITEM_KINDS = Object.freeze([
  "experience", "education", "skill", "certification", "project",
]);

const KIND_SET = new Set(STRUCTURED_ITEM_KINDS);
const ASSET_STATUSES = new Set(["active", "review_required", "archived"]);

function inputError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, field, maximum = 4000) {
  if (value === null || value === undefined) return "";
  if (!["string", "number"].includes(typeof value)) throw inputError(`${field} must be text`);
  return String(value).replace(/\r\n?/g, "\n").trim().slice(0, maximum);
}

function textList(value, field, maximumItems = 50, maximum = 1000) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw inputError(`${field} must be a list`);
  const result = [];
  for (const [index, item] of value.slice(0, maximumItems).entries()) {
    const normalized = text(item, `${field}[${index}]`, maximum);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizedDate(value, field, { allowPresent = false } = {}) {
  const normalized = text(value, field, 10);
  if (!normalized) return "";
  if (allowPresent && normalized.toLowerCase() === "present") return "present";
  if (!/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(normalized)) {
    throw inputError(`${field} must be YYYY, YYYY-MM, present, or blank`);
  }
  return normalized;
}

function referenceList(value, field) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw inputError(`${field} must be a list`);
  return value.slice(0, 30).map((item, index) => {
    if (!isObject(item)) throw inputError(`${field}[${index}] must be an object`);
    const documentId = text(item.documentId, `${field}[${index}].documentId`, 100);
    const locator = text(item.locator, `${field}[${index}].locator`, 300);
    if (!documentId || !locator) throw inputError(`${field}[${index}] requires documentId and locator`);
    return { documentId, locator };
  });
}

function semantic(value) {
  return text(value, "semantic value", 500).toLocaleLowerCase().replace(/[\s._/\\-]+/g, "");
}

function semanticKey(item) {
  const core = [item.kind, item.title];
  if (item.kind !== "skill") core.push(item.organization, item.role, item.startDate, item.endDate);
  return core.map(semantic).join("|");
}

export function normalizeStructuredItems(input, db = null) {
  if (!Array.isArray(input)) throw inputError("structuredItems must be a list");
  if (input.length > 200) throw inputError("structuredItems cannot contain more than 200 items");
  const ids = new Set();
  const meanings = new Set();
  const knownDocuments = db
    ? new Set(db.prepare("SELECT id FROM source_documents WHERE active = 1").all().map((item) => item.id))
    : null;
  return input.map((item, index) => {
    if (!isObject(item)) throw inputError(`structuredItems[${index}] must be an object`);
    const kind = text(item.kind, `structuredItems[${index}].kind`, 40);
    if (!KIND_SET.has(kind)) throw inputError(`structuredItems[${index}].kind is unsupported`);
    const id = text(item.id, `structuredItems[${index}].id`, 100) || crypto.randomUUID();
    if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(id)) throw inputError(`structuredItems[${index}].id is invalid`);
    if (ids.has(id)) throw inputError(`Duplicate structured item id: ${id}`);
    ids.add(id);
    const normalized = {
      id,
      kind,
      title: text(item.title, `structuredItems[${index}].title`, 300),
      organization: text(item.organization, `structuredItems[${index}].organization`, 300),
      role: text(item.role, `structuredItems[${index}].role`, 300),
      location: text(item.location, `structuredItems[${index}].location`, 200),
      startDate: normalizedDate(item.startDate, `structuredItems[${index}].startDate`),
      endDate: normalizedDate(item.endDate, `structuredItems[${index}].endDate`, { allowPresent: true }),
      summary: text(item.summary, `structuredItems[${index}].summary`, 8000),
      highlights: textList(item.highlights, `structuredItems[${index}].highlights`, 50, 1200),
      skills: textList(item.skills, `structuredItems[${index}].skills`, 50, 300),
      sourceRefs: referenceList(item.sourceRefs, `structuredItems[${index}].sourceRefs`),
      displayOrder: Number(item.displayOrder ?? index + 1),
      active: item.active !== false,
    };
    if (!normalized.title) throw inputError(`structuredItems[${index}].title is required`);
    if (!Number.isInteger(normalized.displayOrder) || normalized.displayOrder < 0 || normalized.displayOrder > 10000) {
      throw inputError(`structuredItems[${index}].displayOrder must be an integer between 0 and 10000`);
    }
    if (normalized.startDate && normalized.endDate && normalized.endDate !== "present"
      && normalized.startDate.localeCompare(normalized.endDate) > 0) {
      throw inputError(`structuredItems[${index}] startDate cannot be after endDate`);
    }
    for (const reference of normalized.sourceRefs) {
      if (knownDocuments && !knownDocuments.has(reference.documentId)) {
        throw inputError(`Unknown active source document: ${reference.documentId}`);
      }
    }
    const meaning = semanticKey(normalized);
    if (meanings.has(meaning)) throw inputError(`Duplicate structured item meaning at index ${index}`);
    meanings.add(meaning);
    return normalized;
  });
}

export function listResumeAssets(db) {
  return db.prepare(`
    SELECT d.id, d.kind, d.original_name, d.mime_type, d.size_bytes, d.sha256, d.active,
           COALESCE(a.label, '') AS asset_label,
           COALESCE(a.status, CASE WHEN d.active = 1 THEN 'active' ELSE 'archived' END) AS asset_status,
           COALESCE(a.updated_at, d.updated_at) AS asset_updated_at,
           d.created_at
    FROM source_documents d LEFT JOIN resume_assets a ON a.document_id = d.id
    ORDER BY d.kind, d.created_at, d.id
  `).all().map((item) => ({
    id: item.id,
    kind: item.kind,
    label: item.asset_label || item.original_name || (item.kind === "portfolio" ? "Portfolio" : "Resume"),
    originalName: item.original_name,
    mimeType: item.mime_type,
    size: Number(item.size_bytes),
    sha256: item.sha256,
    status: item.asset_status,
    active: item.asset_status !== "archived" && Boolean(item.active),
    createdAt: item.created_at,
    updatedAt: item.asset_updated_at,
  }));
}

export function updateResumeAsset(db, documentId, input = {}) {
  const id = text(documentId, "documentId", 100);
  const document = db.prepare("SELECT id, original_name FROM source_documents WHERE id = ?").get(id);
  if (!document) throw inputError("Resume asset not found", 404);
  const status = text(input.status, "status", 40);
  if (!ASSET_STATUSES.has(status)) throw inputError("status must be active, review_required, or archived");
  const label = Object.hasOwn(input, "label") ? text(input.label, "label", 240) : document.original_name;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO resume_assets (document_id, label, status) VALUES (?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET label = excluded.label, status = excluded.status, updated_at = CURRENT_TIMESTAMP
    `).run(id, label, status);
    db.prepare("UPDATE source_documents SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(status === "archived" ? 0 : 1, id);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return listResumeAssets(db);
}

export function getStructuredResumeItems(db, { activeOnly = false } = {}) {
  const where = activeOnly ? "WHERE active = 1" : "";
  return db.prepare(`
    SELECT * FROM resume_structured_items ${where}
    ORDER BY kind, display_order, id
  `).all().map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    organization: item.organization,
    role: item.role,
    location: item.location,
    startDate: item.start_date,
    endDate: item.end_date,
    summary: item.summary,
    highlights: safeJson(item.highlights_json, []),
    skills: safeJson(item.skills_json, []),
    sourceRefs: safeJson(item.source_refs_json, []),
    displayOrder: Number(item.display_order),
    active: Boolean(item.active),
    updatedAt: item.updated_at,
  }));
}

export function replaceStructuredResumeItems(db, items) {
  db.prepare("DELETE FROM resume_structured_items").run();
  const insert = db.prepare(`
    INSERT INTO resume_structured_items (
      id, kind, title, organization, role, location, start_date, end_date, summary,
      highlights_json, skills_json, source_refs_json, display_order, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    insert.run(item.id, item.kind, item.title, item.organization, item.role, item.location,
      item.startDate, item.endDate, item.summary, JSON.stringify(item.highlights), JSON.stringify(item.skills),
      JSON.stringify(item.sourceRefs), item.displayOrder, item.active ? 1 : 0);
  }
}

export function saveStructuredResumeItems(db, input) {
  const items = normalizeStructuredItems(input, db);
  db.exec("BEGIN IMMEDIATE");
  try {
    replaceStructuredResumeItems(db, items);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return getStructuredResumeItems(db);
}

export function resumeReadiness(resume = {}) {
  const assets = Array.isArray(resume.assets) ? resume.assets : [];
  const items = Array.isArray(resume.structuredItems) ? resume.structuredItems.filter((item) => item.active !== false) : [];
  const nonempty = (value) => Array.isArray(value) ? value.length > 0 : Boolean(String(value || "").trim());
  const hasLegacyBody = [resume.summary, resume.experienceHighlights, resume.representativeExperience].some(nonempty);
  const checks = [
    { key: "resume_asset", label: "기준 이력서", ready: assets.some((item) => item.kind === "resume" && item.status === "active") || hasLegacyBody },
    { key: "target_role", label: "목표 직무", ready: nonempty(resume.jobRole) },
    { key: "summary", label: "소개 또는 요약", ready: nonempty(resume.headline) || nonempty(resume.summary) },
    { key: "skills", label: "기술·역량", ready: nonempty(resume.skills) || items.some((item) => item.kind === "skill") },
    { key: "experience", label: "경력 또는 프로젝트", ready: nonempty(resume.experienceHighlights)
      || nonempty(resume.representativeExperience) || items.some((item) => new Set(["experience", "project"]).has(item.kind)) },
  ];
  const complete = checks.filter((item) => item.ready).length;
  return {
    ready: complete === checks.length,
    score: Math.round((complete / checks.length) * 100),
    checks,
    missing: checks.filter((item) => !item.ready).map((item) => ({ key: item.key, message: `${item.label} 정보를 확인해 주세요.` })),
  };
}
