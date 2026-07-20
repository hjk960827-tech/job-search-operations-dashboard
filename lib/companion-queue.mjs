import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BUILTIN_SECTION_DEFINITIONS, builtinSectionKind, canonicalSectionKey } from "./document-sections.mjs";
import { PRIVATE_DATA_DIR, PROJECT_ROOT, assertPathInside, companionTaskPath } from "./paths.mjs";
import { normalizePublicHttpUrl } from "./public-url.mjs";

const TASK_KINDS = new Set(["collect_jobs", "analyze_documents", "generate_package"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const SENSITIVE_INPUT_KEY = /(?:api.?key|access.?key|token|password|passwd|secret|cookie|authorization|session)/i;
const AGE_CONTENT = /(?:생년월일|출생(?:일|년도|연도|년)?|나이|연령|date\s*of\s*birth|birth\s*date|\bdob\b|\bage\s*[:=])/i;
const AGE_KEYS = new Set(["age", "birth", "birthday", "birthdate", "dateofbirth", "dob", "birthyear", "yearofbirth", "나이", "연령", "생년", "생년월일", "출생", "출생일", "출생년도", "출생연도"]);
const DEFAULT_LEASE_SECONDS = 300;
const RESUME_SECTION_COLUMNS = {
  headline: "headline",
  summary: "summary",
  skills: "skills_json",
  experience_highlights: "experience_highlights_json",
  achievement_evidence: "achievement_evidence",
  representative_experience: "representative_experience",
  direct_scope: "direct_scope",
  collaboration_scope: "collaboration_scope",
  career_direction: "career_direction",
};

function taskError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
}

export function canonicalCompanionJson(value) {
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

function checksum(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalCompanionJson(value)).digest("hex");
}

function cleanText(value, maximum = 2000) {
  if (value === null || value === undefined) return "";
  if (!["string", "number"].includes(typeof value)) throw taskError("Companion text fields must be text");
  return String(value).replace(/\r\n?/g, "\n").trim().slice(0, maximum);
}

function cleanWorkerId(value) {
  const workerId = cleanText(value, 80);
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(workerId)) throw taskError("workerId must be a local provider-neutral identifier");
  return workerId;
}

function assertNoSensitiveInput(value, field = "input") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveInput(item, `${field}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_INPUT_KEY.test(key)) throw taskError(`${field}.${key} cannot contain credentials or account state`);
    assertNoSensitiveInput(item, `${field}.${key}`);
  }
}

function assertNoAgeContent(value, field = "result") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAgeContent(item, `${field}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
      if (AGE_KEYS.has(normalized)) throw taskError(`${field}.${key} cannot contain age or date of birth`);
      assertNoAgeContent(item, `${field}.${key}`);
    }
    return;
  }
  if (["string", "number"].includes(typeof value) && AGE_CONTENT.test(String(value))) {
    throw taskError(`${field} cannot contain age or date of birth`);
  }
}

function numericTokens(value) {
  const matches = String(value || "").matchAll(/\d[\d,]*(?:\.\d+)?\s*(?:%|percent|퍼센트|명|건|원|년|개월|일|시간)?/gi);
  return [...matches].map((match) => {
    const compact = match[0].replace(/\s+/g, "").toLowerCase();
    const parts = compact.match(/^(\d[\d,]*(?:\.\d+)?)(.*)$/);
    let [integer, fraction = ""] = parts[1].replaceAll(",", "").split(".");
    integer = integer.replace(/^0+(?=\d)/, "") || "0";
    fraction = fraction.replace(/0+$/, "");
    const number = fraction ? `${integer}.${fraction}` : integer;
    const unit = parts[2] === "percent" || parts[2] === "퍼센트" ? "%" : parts[2];
    return { number, unit };
  });
}

function unsupportedNumericClaims(value, sourceText) {
  const source = numericTokens(sourceText);
  return numericTokens(value).filter((candidate) => !source.some((evidence) => evidence.number === candidate.number
    && candidate.unit === evidence.unit));
}

function atomicJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw taskError("Companion task directory must not be a symbolic link", 409);
  fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, canonicalCompanionJson(value), { flag: "wx", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function relativePrivatePath(candidate, label) {
  const safe = assertPathInside(PRIVATE_DATA_DIR, candidate, label);
  const stat = fs.lstatSync(safe);
  if (!stat.isFile() || stat.isSymbolicLink()) throw taskError(`${label} must be a regular local file`, 409);
  const relative = path.relative(PROJECT_ROOT, safe);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw taskError(`${label} must stay inside local private storage`, 409);
  }
  return relative;
}

function collectInput(context = {}) {
  const search = context.searchConfig || {};
  const sourceConfig = context.sourcesConfig || {};
  const profile = context.profileConfig || {};
  const preferences = profile.preferences || {};
  const salary = preferences.salary || {};
  const list = (value) => Array.isArray(value) ? [...value] : [];
  const pair = (value) => ({
    include: list(value?.include),
    exclude: list(value?.exclude),
  });
  return {
    search: {
      targetRoles: list(search.target_roles),
      includeKeywords: list(search.include_keywords),
      excludeKeywords: list(search.exclude_keywords),
      targetTracks: list(search.target_tracks),
      regions: list(search.regions?.length ? search.regions : profile.location?.regions),
      employmentTypes: list(preferences.employment_types),
      workModes: list(preferences.work_modes),
      experience: {
        minimumYears: search.experience?.minimum_years ?? null,
        maximumYears: search.experience?.maximum_years ?? null,
      },
      salary: {
        currency: cleanText(salary.currency, 20),
        minimum: salary.minimum ?? null,
        target: salary.target ?? null,
      },
      companyPreferences: pair(search.company_preferences),
      industryPreferences: pair(search.industry_preferences),
      workPreferences: {
        desired: list(search.work_preferences?.desired),
        avoided: list(search.work_preferences?.avoided),
      },
    },
    sources: Object.entries(sourceConfig.sources || {})
      .filter(([, item]) => item.collect === true)
      .map(([key, item]) => ({ key, label: item.label || key, lifecycleCheck: item.lifecycle_check !== false, priority: Number(item.priority || 0) }))
      .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key)),
  };
}

function documentAnalysisInput(db, request) {
  const requested = Array.isArray(request.documentIds) ? [...new Set(request.documentIds.map((item) => cleanText(item, 120)).filter(Boolean))] : [];
  const rows = db.prepare(`
    SELECT id, kind, internal_path, sha256, mime_type, size_bytes
    FROM source_documents WHERE active = 1 ORDER BY kind, id
  `).all();
  const selected = requested.length ? rows.filter((row) => requested.includes(row.id)) : rows;
  if (!selected.length) throw taskError("No active local documents are available for analysis", 409);
  if (requested.some((id) => !selected.some((row) => row.id === id))) throw taskError("An analysis document is missing or inactive", 409);
  return {
    documents: selected.map((row) => {
      const relativePath = relativePrivatePath(row.internal_path, "source document path");
      const actualChecksum = crypto.createHash("sha256").update(fs.readFileSync(row.internal_path)).digest("hex");
      if (!row.sha256 || actualChecksum !== row.sha256) throw taskError("Source document checksum changed before analysis", 409);
      return {
        id: row.id,
        kind: row.kind,
        relativePath,
        sha256: row.sha256,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
      };
    }),
  };
}

function resumeSections(db) {
  const row = db.prepare("SELECT * FROM resume_profile WHERE id = 1").get();
  if (!row) return [];
  const sections = [];
  for (const [key, definition] of Object.entries(BUILTIN_SECTION_DEFINITIONS)) {
    let value = row[RESUME_SECTION_COLUMNS[key]];
    if (definition.kind === "list") value = parseJson(value, []);
    if (definition.kind === "list" ? value.length : String(value || "").trim()) {
      sections.push({ key, label: definition.label, kind: definition.kind, value });
    }
  }
  for (const custom of db.prepare(`
    SELECT section_key, label, kind, value_json FROM resume_custom_sections
    WHERE editable = 1 ORDER BY display_order, section_key
  `).all()) {
    const value = parseJson(custom.value_json, custom.kind === "list" ? [] : "");
    if (custom.kind === "list" ? value.length : String(value || "").trim()) {
      sections.push({ key: custom.section_key, label: custom.label, kind: custom.kind, value });
    }
  }
  return sections;
}

function packageGenerationInput(db, request) {
  const jobId = Number(request.jobId);
  if (!Number.isInteger(jobId) || jobId < 1) throw taskError("generate_package requires a valid jobId");
  const job = db.prepare("SELECT id, job_key, company_name, title, summary FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw taskError("Job not found", 404);
  const tailoring = db.prepare("SELECT focus_sections_json, application_questions_json FROM job_tailoring WHERE job_id = ?").get(jobId);
  const facts = db.prepare(`
    SELECT id, fact_key, label, value, source_document_id, source_locator
    FROM profile_facts ORDER BY id
  `).all().map((item) => ({
    id: item.id, key: item.fact_key, label: item.label, value: item.value,
    sourceDocumentId: item.source_document_id || "", sourceLocator: item.source_locator,
  }));
  const evidence = db.prepare(`
    SELECT id, title, description, metrics_json, skills_json, source_refs_json
    FROM evidence_items ORDER BY id
  `).all().map((item) => ({
    id: item.id, title: item.title, description: item.description,
    metrics: parseJson(item.metrics_json, []), skills: parseJson(item.skills_json, []),
    sourceRefs: parseJson(item.source_refs_json, []),
  }));
  const structuredItems = db.prepare(`
    SELECT id, kind, title, organization, role, location, start_date, end_date, summary,
           highlights_json, skills_json
    FROM resume_structured_items WHERE active = 1 ORDER BY kind, display_order, id
  `).all().map((item) => ({
    id: item.id, kind: item.kind, title: item.title, organization: item.organization,
    role: item.role, location: item.location, startDate: item.start_date, endDate: item.end_date,
    summary: item.summary, highlights: parseJson(item.highlights_json, []), skills: parseJson(item.skills_json, []),
  }));
  const sections = resumeSections(db);
  if (!sections.length) throw taskError("A saved resume section is required before generating a package", 409);
  return {
    job: { id: job.id, jobKey: job.job_key, companyName: job.company_name, title: job.title, summary: job.summary },
    approvedFacts: facts,
    approvedEvidence: evidence,
    approvedStructuredItems: structuredItems,
    resumeSections: sections,
    tailoring: {
      focusSections: parseJson(tailoring?.focus_sections_json, []),
      applicationQuestions: parseJson(tailoring?.application_questions_json, []),
    },
  };
}

function resultContract(kind) {
  if (kind === "collect_jobs") return {
    type: "object", required: ["jobs"], reviewRequired: true,
    note: "Return only publicly accessible job facts and HTTP(S) source links. Completion creates a review draft and never imports jobs automatically.",
  };
  if (kind === "analyze_documents") return {
    type: "object", required: ["facts", "evidence", "sections"], reviewRequired: true,
    note: "Every item must reference a request document and locator. Exclude age and date of birth. Only explicitly accepted items may be saved.",
  };
  return {
    type: "object", required: ["sections"], reviewRequired: true,
    note: "Every generated section must use an allowed key and cite approved fact, evidence, or resume-section references. Package data changes only after explicit approval.",
  };
}

function normalizedTaskInput(db, request, context) {
  if (!isPlainObject(request)) throw taskError("Companion task request must be an object");
  assertNoSensitiveInput(request, "request");
  const kind = cleanText(request.kind, 80);
  if (!TASK_KINDS.has(kind)) throw taskError("Unsupported companion task kind");
  const input = kind === "collect_jobs"
    ? collectInput(context)
    : kind === "analyze_documents"
      ? documentAnalysisInput(db, request)
      : packageGenerationInput(db, request);
  assertNoSensitiveInput(input);
  return { kind, input };
}

function publicTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    requestChecksum: row.request_checksum,
    resultChecksum: row.result_checksum,
    requestPath: row.request_path,
    resultPath: row.result_path,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    cancelRequested: Boolean(row.cancel_requested),
    error: row.error_code || row.error_message ? { code: row.error_code, message: row.error_message } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    leaseExpiresAt: row.lease_expires_at,
    review: row.review_status ? {
      status: row.review_status,
      applicationKind: row.application_kind || "",
      applicationRef: row.application_ref || "",
      reviewedAt: row.reviewed_at || "",
      updatedAt: row.review_updated_at || "",
    } : null,
  };
}

const TASK_SELECT = `
  SELECT t.*,
         r.status AS review_status,
         r.application_kind,
         r.application_ref,
         r.reviewed_at,
         r.updated_at AS review_updated_at
  FROM agent_tasks t
  LEFT JOIN agent_task_reviews r ON r.task_id = t.id
`;

function selectTask(db, taskId) {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(cleanText(taskId, 120));
  if (!row) throw taskError("Companion task not found", 404);
  return row;
}

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function recoverStaleCompanionTasks(db, options = {}) {
  const now = (options.now || new Date()).toISOString();
  return transaction(db, () => {
    const rows = db.prepare(`
      SELECT * FROM agent_tasks
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND datetime(lease_expires_at) <= datetime(?)
      ORDER BY created_at, id
    `).all(now);
    for (const row of rows) {
      const exhausted = Number(row.attempt_count) >= Number(row.max_attempts);
      db.prepare(`
        UPDATE agent_tasks SET
          status = ?, lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL,
          error_code = 'stale_lease', error_message = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running'
      `).run(
        exhausted ? "failed" : "queued",
        exhausted ? "Task lease expired and retry limit was reached" : "Task lease expired and was returned to the queue",
        exhausted ? now : null,
        row.id,
      );
    }
    return rows.length;
  });
}

export function createCompanionTask(db, request, context = {}) {
  recoverStaleCompanionTasks(db, context);
  const normalized = normalizedTaskInput(db, request, context);
  const inputChecksum = checksum({ kind: normalized.kind, input: normalized.input });
  const dedupeKey = inputChecksum;
  const existing = db.prepare(`
    ${TASK_SELECT}
    WHERE t.kind = ? AND t.dedupe_key = ?
      AND (t.status IN ('queued', 'running') OR (t.status = 'succeeded' AND r.status = 'awaiting_review'))
    ORDER BY t.created_at LIMIT 1
  `).get(normalized.kind, dedupeKey);
  if (existing) return { task: publicTask(existing), deduplicated: true };

  const taskId = crypto.randomUUID();
  const core = {
    schemaVersion: 1,
    taskId,
    kind: normalized.kind,
    input: normalized.input,
    resultContract: resultContract(normalized.kind),
  };
  const requestChecksum = checksum(core);
  const envelope = { ...core, requestChecksum };
  const directory = companionTaskPath(taskId);
  const requestFile = companionTaskPath(taskId, "request.json");
  const requestPath = path.relative(PROJECT_ROOT, requestFile);
  let installed = false;
  try {
    const row = transaction(db, () => {
      db.prepare(`
        INSERT INTO agent_tasks (
          id, kind, status, dedupe_key, request_checksum, request_path, max_attempts
        ) VALUES (?, ?, 'queued', ?, ?, ?, 3)
      `).run(taskId, normalized.kind, dedupeKey, requestChecksum, requestPath);
      atomicJson(requestFile, envelope);
      installed = true;
      return selectTask(db, taskId);
    });
    return { task: publicTask(row), deduplicated: false };
  } catch (error) {
    if (installed || fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    if (/UNIQUE constraint failed/i.test(String(error?.message || ""))) {
      const raced = db.prepare(`${TASK_SELECT} WHERE t.kind = ? AND t.dedupe_key = ? AND t.status IN ('queued', 'running')`).get(normalized.kind, dedupeKey);
      if (raced) return { task: publicTask(raced), deduplicated: true };
    }
    throw error;
  }
}

function verifiedRequest(row) {
  const expected = companionTaskPath(row.id, "request.json");
  if (path.relative(PROJECT_ROOT, expected) !== row.request_path) throw taskError("Companion request path changed", 409);
  const stat = fs.lstatSync(expected);
  if (!stat.isFile() || stat.isSymbolicLink()) throw taskError("Companion request must be a regular local file", 409);
  const envelope = JSON.parse(fs.readFileSync(expected, "utf8"));
  const { requestChecksum, ...core } = envelope;
  if (requestChecksum !== row.request_checksum || checksum(core) !== row.request_checksum) {
    throw taskError("Companion request checksum mismatch", 409);
  }
  return envelope;
}

export function claimNextCompanionTask(db, options = {}) {
  recoverStaleCompanionTasks(db, options);
  const workerId = cleanWorkerId(options.workerId);
  const leaseSeconds = Number(options.leaseSeconds || DEFAULT_LEASE_SECONDS);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw taskError("leaseSeconds must be between 30 and 3600");
  const now = options.now || new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const row = transaction(db, () => {
    const generationRunning = Boolean(db.prepare("SELECT 1 AS value FROM agent_tasks WHERE kind = 'generate_package' AND status = 'running' LIMIT 1").get());
    const candidates = db.prepare("SELECT * FROM agent_tasks WHERE status = 'queued' ORDER BY created_at, id").all();
    const candidate = candidates.find((item) => item.kind !== "generate_package" || !generationRunning);
    if (!candidate) return null;
    const updated = db.prepare(`
      UPDATE agent_tasks SET
        status = 'running', attempt_count = attempt_count + 1, lease_owner = ?, lease_expires_at = ?,
        heartbeat_at = ?, started_at = COALESCE(started_at, ?), completed_at = NULL,
        cancel_requested = 0, error_code = '', error_message = '', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'
    `).run(workerId, leaseExpiresAt, now.toISOString(), now.toISOString(), candidate.id);
    if (Number(updated.changes) !== 1) return null;
    return selectTask(db, candidate.id);
  });
  if (!row) return null;
  return { task: publicTask(row), request: verifiedRequest(row) };
}

function runningTaskForWorker(db, taskId, workerId, now = new Date()) {
  const row = selectTask(db, taskId);
  const owner = cleanWorkerId(workerId);
  if (row.status !== "running" || row.lease_owner !== owner) throw taskError("Task is not running for this worker", 409);
  if (row.cancel_requested) throw taskError("Task cancellation was requested", 409);
  if (!row.lease_expires_at || Date.parse(row.lease_expires_at) <= now.getTime()) throw taskError("Task lease expired", 409);
  return row;
}

export function heartbeatCompanionTask(db, taskId, options = {}) {
  const now = options.now || new Date();
  const row = runningTaskForWorker(db, taskId, options.workerId, now);
  const leaseSeconds = Number(options.leaseSeconds || DEFAULT_LEASE_SECONDS);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw taskError("leaseSeconds must be between 30 and 3600");
  const expires = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  db.prepare("UPDATE agent_tasks SET heartbeat_at = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'")
    .run(now.toISOString(), expires, row.id);
  return publicTask(selectTask(db, row.id));
}

function assertDocumentReferences(items, documents, field) {
  const allowed = new Set(documents.map((item) => item.id));
  for (const [index, item] of items.entries()) {
    if (!isPlainObject(item)) throw taskError(`${field}[${index}] must be an object`);
    const references = item.sourceRefs || (item.sourceDocumentId ? [{ documentId: item.sourceDocumentId, locator: item.sourceLocator }] : []);
    if (!Array.isArray(references) || !references.length) throw taskError(`${field}[${index}] requires source references`);
    for (const reference of references) {
      const documentId = cleanText(reference.documentId || reference.id, 120);
      const locator = cleanText(reference.locator || reference.sourceLocator, 300);
      if (!allowed.has(documentId) || !locator) throw taskError(`${field}[${index}] contains an unknown document or missing locator`);
    }
  }
}

function validateResult(kind, result, request) {
  if (!isPlainObject(result)) throw taskError("Companion result must be an object");
  assertNoSensitiveInput(result, "result");
  if (kind === "collect_jobs") {
    if (!Array.isArray(result.jobs) || result.jobs.length > 1000) throw taskError("collect_jobs result.jobs must be an array of at most 1000 jobs");
    for (const [index, job] of result.jobs.entries()) {
      if (!isPlainObject(job) || !cleanText(job.jobKey, 180) || !cleanText(job.companyName, 200) || !cleanText(job.title, 240)) {
        throw taskError(`result.jobs[${index}] is missing required public job fields`);
      }
      if (!Array.isArray(job.sources) || !job.sources.length) throw taskError(`result.jobs[${index}] requires at least one source`);
      for (const source of job.sources) normalizePublicHttpUrl(
        cleanText(source.url, 4000),
        `result.jobs[${index}] source`,
      );
    }
  } else if (kind === "analyze_documents") {
    assertNoAgeContent(result);
    const ids = new Set();
    const sectionKeys = new Set();
    for (const field of ["facts", "evidence", "sections"]) {
      if (!Array.isArray(result[field])) throw taskError(`analyze_documents result.${field} must be an array`);
      assertDocumentReferences(result[field], request.input.documents, `result.${field}`);
      for (const [index, item] of result[field].entries()) {
        const id = cleanText(item.id, 80);
        if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(id) || ids.has(`${field}:${id}`)) {
          throw taskError(`result.${field}[${index}] requires a unique stable id`);
        }
        ids.add(`${field}:${id}`);
        if (field === "facts") {
          const confidence = Number(item.confidence ?? 0);
          if (!cleanText(item.key, 100) || !cleanText(item.label, 200) || !cleanText(item.value, 4000)
            || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
            throw taskError(`result.facts[${index}] is missing a key, label, value, or valid confidence`);
          }
        } else if (field === "evidence") {
          const metrics = Array.isArray(item.metrics) ? item.metrics : [];
          const skills = Array.isArray(item.skills) ? item.skills : [];
          if (!cleanText(item.title, 240) || (!cleanText(item.description, 6000) && !metrics.length && !skills.length)) {
            throw taskError(`result.evidence[${index}] requires a title and evidence content`);
          }
        } else {
          const key = canonicalSectionKey(item.key, item.label, id);
          const kind = item.kind === "list" ? "list" : item.kind === "text" ? "text" : "";
          const expectedKind = builtinSectionKind(key);
          if (expectedKind && kind !== expectedKind) {
            throw taskError(`result.sections[${index}] ${key} must use kind ${expectedKind}`);
          }
          const hasValue = kind === "list" ? Array.isArray(item.value) && item.value.length : kind === "text" && Boolean(cleanText(item.value, 8000));
          if (!cleanText(item.label, 200) || !kind || !hasValue || sectionKeys.has(key)) {
            throw taskError(`result.sections[${index}] is missing a label/value or duplicates a semantic section`);
          }
          sectionKeys.add(key);
        }
      }
    }
  } else {
    if (!Array.isArray(result.sections) || !result.sections.length) throw taskError("generate_package result.sections must be a non-empty array");
    const allowedKeys = new Set(request.input.resumeSections.map((item) => item.key));
    const allowedReferences = new Set([
      ...request.input.approvedFacts.map((item) => `fact:${item.id}`),
      ...request.input.approvedEvidence.map((item) => `evidence:${item.id}`),
      ...request.input.resumeSections.map((item) => `section:${item.key}`),
      ...(request.input.approvedStructuredItems || []).map((item) => `structured:${item.id}`),
    ]);
    const referenceValues = new Map([
      ...request.input.approvedFacts.map((item) => [`fact:${item.id}`, canonicalCompanionJson(item)]),
      ...request.input.approvedEvidence.map((item) => [`evidence:${item.id}`, canonicalCompanionJson(item)]),
      ...request.input.resumeSections.map((item) => [`section:${item.key}`, canonicalCompanionJson(item)]),
      ...(request.input.approvedStructuredItems || []).map((item) => [`structured:${item.id}`, canonicalCompanionJson(item)]),
    ]);
    const seen = new Set();
    for (const [index, section] of result.sections.entries()) {
      if (!isPlainObject(section)) throw taskError(`result.sections[${index}] must be an object`);
      const key = cleanText(section.key, 120);
      if (!allowedKeys.has(key) || seen.has(key)) throw taskError(`result.sections[${index}] uses an unknown or duplicate section key`);
      seen.add(key);
      if (!Array.isArray(section.sourceRefs) || !section.sourceRefs.length || section.sourceRefs.some((item) => !allowedReferences.has(cleanText(item, 240)))) {
        throw taskError(`result.sections[${index}] must cite only approved local facts or evidence`);
      }
      const source = request.input.resumeSections.find((item) => item.key === key);
      if (source.kind === "list" ? !Array.isArray(section.value) : typeof section.value !== "string") {
        throw taskError(`result.sections[${index}] value type does not match the approved section`);
      }
      const sourceText = section.sourceRefs.map((item) => referenceValues.get(item) || "").join("\n");
      const inventedNumbers = unsupportedNumericClaims(
        Array.isArray(section.value) ? section.value.join("\n") : section.value,
        sourceText,
      );
      if (inventedNumbers.length) throw taskError(`result.sections[${index}] contains a numeric claim that is not present in approved sources`);
    }
  }
  return sortedValue(result);
}

export function completeCompanionTask(db, taskId, options = {}) {
  const now = options.now || new Date();
  const row = runningTaskForWorker(db, taskId, options.workerId, now);
  const request = verifiedRequest(row);
  if (cleanText(options.requestChecksum, 128) !== row.request_checksum) throw taskError("Completion request checksum is stale", 409);
  const result = validateResult(row.kind, options.result, request);
  const resultChecksum = checksum(result);
  const resultFile = companionTaskPath(row.id, "result.json");
  const resultPath = path.relative(PROJECT_ROOT, resultFile);
  const envelope = {
    schemaVersion: 1,
    taskId: row.id,
    requestChecksum: row.request_checksum,
    result,
    resultChecksum,
  };
  atomicJson(resultFile, envelope);
  try {
    const updated = transaction(db, () => {
      const change = db.prepare(`
        UPDATE agent_tasks SET
          status = 'succeeded', result_checksum = ?, result_path = ?, lease_owner = '',
          lease_expires_at = NULL, heartbeat_at = NULL, completed_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running' AND lease_owner = ? AND request_checksum = ? AND cancel_requested = 0
      `).run(resultChecksum, resultPath, now.toISOString(), row.id, cleanWorkerId(options.workerId), row.request_checksum);
      if (Number(change.changes) !== 1) throw taskError("Task changed before completion", 409);
      db.prepare(`
        INSERT INTO agent_task_reviews (task_id, status, result_checksum)
        VALUES (?, 'awaiting_review', ?)
        ON CONFLICT(task_id) DO UPDATE SET
          status = 'awaiting_review', result_checksum = excluded.result_checksum,
          preview_json = '{}', decision_json = '{}', application_kind = '', application_ref = '',
          note = '', reviewed_at = NULL, updated_at = CURRENT_TIMESTAMP
      `).run(row.id, resultChecksum);
      return selectTask(db, row.id);
    });
    return publicTask(updated);
  } catch (error) {
    fs.rmSync(resultFile, { force: true });
    throw error;
  }
}

export function readVerifiedCompanionResult(db, taskId) {
  const row = selectTask(db, taskId);
  if (row.status !== "succeeded" || !row.result_checksum || !row.result_path) {
    throw taskError("Companion result is not ready for review", 409);
  }
  const request = verifiedRequest(row);
  const expected = companionTaskPath(row.id, "result.json");
  if (path.relative(PROJECT_ROOT, expected) !== row.result_path) throw taskError("Companion result path changed", 409);
  let stat;
  try { stat = fs.lstatSync(expected); } catch { throw taskError("Companion result file is missing", 409); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw taskError("Companion result must be a regular local file", 409);
  const envelope = JSON.parse(fs.readFileSync(expected, "utf8"));
  if (envelope.taskId !== row.id || envelope.requestChecksum !== row.request_checksum
    || envelope.resultChecksum !== row.result_checksum || checksum(envelope.result) !== row.result_checksum) {
    throw taskError("Companion result checksum mismatch", 409);
  }
  return { task: publicTask(row), row, request, result: envelope.result };
}

export function assertCompanionTaskCurrent(db, taskId, context = {}) {
  const verified = readVerifiedCompanionResult(db, taskId);
  const request = verified.request;
  const currentRequest = request.kind === "analyze_documents"
    ? { kind: request.kind, documentIds: request.input.documents.map((item) => item.id) }
    : request.kind === "generate_package"
      ? { kind: request.kind, jobId: request.input.job.id }
      : { kind: request.kind };
  const normalized = normalizedTaskInput(db, currentRequest, context);
  if (checksum({ kind: normalized.kind, input: normalized.input }) !== verified.row.dedupe_key) {
    throw taskError("Companion result inputs changed; create a new task before applying this result", 409);
  }
  return verified;
}

export function failCompanionTask(db, taskId, options = {}) {
  const now = options.now || new Date();
  const row = runningTaskForWorker(db, taskId, options.workerId, now);
  const code = cleanText(options.code || "worker_failed", 80).replace(/[^a-z0-9_-]/gi, "_") || "worker_failed";
  const message = cleanText(options.message || "Local companion task failed", 500);
  db.prepare(`
    UPDATE agent_tasks SET status = 'failed', error_code = ?, error_message = ?, lease_owner = '',
      lease_expires_at = NULL, heartbeat_at = NULL, completed_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
  `).run(code, message, now.toISOString(), row.id);
  return publicTask(selectTask(db, row.id));
}

export function retryCompanionTask(db, taskId) {
  const row = selectTask(db, taskId);
  if (row.status !== "failed") throw taskError("Only failed tasks can be retried", 409);
  if (Number(row.attempt_count) >= Number(row.max_attempts)) throw taskError("Task retry limit has been reached", 409);
  try {
    db.prepare(`
      UPDATE agent_tasks SET status = 'queued', error_code = '', error_message = '', completed_at = NULL,
        cancel_requested = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'failed'
    `).run(row.id);
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || ""))) throw taskError("An equivalent task is already queued or running", 409);
    throw error;
  }
  return publicTask(selectTask(db, row.id));
}

export function cancelCompanionTask(db, taskId) {
  const row = selectTask(db, taskId);
  if (row.status === "cancelled") return publicTask(row);
  if (TERMINAL_STATUSES.has(row.status)) throw taskError("Completed tasks cannot be cancelled", 409);
  db.prepare(`
    UPDATE agent_tasks SET status = 'cancelled', cancel_requested = 1, lease_owner = '',
      lease_expires_at = NULL, heartbeat_at = NULL, completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')
  `).run(row.id);
  return publicTask(selectTask(db, row.id));
}

export function listCompanionTasks(db, options = {}) {
  recoverStaleCompanionTasks(db, options);
  return db.prepare(`${TASK_SELECT} ORDER BY t.created_at DESC, t.id DESC`).all().map(publicTask);
}
