import crypto from "node:crypto";
import {
  assertCompanionTaskCurrent,
  readVerifiedCompanionResult,
} from "./companion-queue.mjs";
import {
  getCollectionRun,
  publishCollectionRun,
  stageCollectionBatch,
} from "./collection-pipeline.mjs";
import { BUILTIN_SECTION_DEFINITIONS, canonicalSectionKey } from "./document-sections.mjs";
import {
  createPackage,
  getLatestPackageForJob,
  publicPackage,
  updatePackage,
} from "./package-workflow.mjs";

const REVIEW_STATUSES = new Set(["awaiting_review", "accepted", "rejected", "superseded"]);
const DECISIONS = new Set(["use", "edit", "exclude"]);
const BUILTIN_COLUMNS = {
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
const PROTECTED_FACT = /^(?:career|careerlevel|careerstage|careertype|yearsexperience|school|major|degree|certificate|certification|license|employment|employmenthistory|workhistory|companyhistory|careerhistory|근무이력|경력사항)/i;

function reviewError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, maximum = 8000) {
  if (value === null || value === undefined) return "";
  if (!["string", "number"].includes(typeof value)) throw reviewError("Review text fields must be text");
  return String(value).replace(/\r\n?/g, "\n").trim().slice(0, maximum);
}

function cleanList(value, maximumItems = 50, maximumLength = 1000) {
  if (!Array.isArray(value)) throw reviewError("Review list fields must be arrays");
  return value.slice(0, maximumItems).map((item) => cleanText(item, maximumLength)).filter(Boolean);
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function inTransaction(db, operation) {
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

function reviewRow(db, taskId) {
  const row = db.prepare("SELECT * FROM agent_task_reviews WHERE task_id = ?").get(cleanText(taskId, 120));
  if (!row) throw reviewError("Companion result review was not found", 404);
  if (!REVIEW_STATUSES.has(row.status)) throw reviewError("Companion result review status is invalid", 409);
  return row;
}

function publicReview(row) {
  return {
    taskId: row.task_id,
    status: row.status,
    resultChecksum: row.result_checksum,
    preview: parseJson(row.preview_json, {}),
    decisions: parseJson(row.decision_json, {}),
    applicationKind: row.application_kind,
    applicationRef: row.application_ref,
    note: row.note,
    reviewedAt: row.reviewed_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertAwaiting(row) {
  if (row.status !== "awaiting_review") throw reviewError("Only a review-pending result can be changed", 409);
}

function itemId(item, type, index) {
  const id = cleanText(item?.id, 80);
  if (!id || !/^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(id)) {
    throw reviewError(`${type}[${index}] requires a stable id`);
  }
  return id;
}

function analysisCatalog(result) {
  const catalog = { facts: new Map(), evidence: new Map(), sections: new Map() };
  for (const type of Object.keys(catalog)) {
    for (const [index, item] of (result[type] || []).entries()) {
      const id = itemId(item, type, index);
      if (catalog[type].has(id)) throw reviewError(`${type} contains a duplicate id: ${id}`);
      catalog[type].set(id, item);
    }
  }
  return catalog;
}

function generatedCatalog(result) {
  const catalog = new Map();
  for (const [index, item] of (result.sections || []).entries()) {
    const key = cleanText(item?.key, 120);
    if (!key || catalog.has(key)) throw reviewError(`sections[${index}] requires a unique key`);
    catalog.set(key, item);
  }
  return catalog;
}

function defaultDecisions(kind, result) {
  if (kind === "analyze_documents") {
    const catalog = analysisCatalog(result);
    return Object.fromEntries(Object.entries(catalog).map(([type, items]) => [type,
      Object.fromEntries([...items.keys()].map((id) => [id, { decision: "pending" }])),
    ]));
  }
  if (kind === "generate_package") {
    return { sections: Object.fromEntries([...generatedCatalog(result).keys()].map((key) => [key, { decision: "pending" }])) };
  }
  return {};
}

function collectionEnvelope(verified) {
  return {
    adapterId: "local-companion",
    accessPolicy: "user_agent",
    generatedAt: verified.task.completedAt || new Date().toISOString(),
    jobs: verified.result.jobs,
  };
}

function preparePreview(db, verified, options) {
  if (verified.task.kind === "collect_jobs") {
    if (!verified.result.jobs.length) return { kind: "collect_jobs", empty: true, counts: { total: 0, create: 0, update: 0, unchanged: 0 }, diff: [] };
    const staged = stageCollectionBatch(db, collectionEnvelope(verified), {
      sourcesConfig: options.sourcesConfig,
      timeZone: options.timeZone,
      runRoot: options.runRoot,
    });
    return { kind: "collect_jobs", run: staged.run, counts: staged.run.counts, diff: staged.run.diff };
  }
  if (verified.task.kind === "analyze_documents") {
    analysisCatalog(verified.result);
    return {
      kind: "analyze_documents",
      counts: Object.fromEntries(["facts", "evidence", "sections"].map((key) => [key, verified.result[key].length])),
      result: verified.result,
    };
  }
  const before = new Map(verified.request.input.resumeSections.map((item) => [item.key, item.value]));
  generatedCatalog(verified.result);
  return {
    kind: "generate_package",
    job: verified.request.input.job,
    sections: verified.result.sections.map((item) => ({
      key: item.key,
      before: before.get(item.key),
      after: item.value,
      sourceRefs: item.sourceRefs,
    })),
  };
}

export function getCompanionResultReview(db, taskId) {
  const verified = readVerifiedCompanionResult(db, taskId);
  const row = reviewRow(db, taskId);
  if (row.result_checksum !== verified.task.resultChecksum) throw reviewError("Review result checksum is stale", 409);
  return { task: verified.task, review: publicReview(row) };
}

export function prepareCompanionResultReview(db, taskId, options = {}) {
  const verified = assertCompanionTaskCurrent(db, taskId, options.context || {});
  const row = reviewRow(db, taskId);
  assertAwaiting(row);
  if (row.result_checksum !== verified.task.resultChecksum) throw reviewError("Review result checksum is stale", 409);
  const preview = preparePreview(db, verified, options);
  const existingDecisions = parseJson(row.decision_json, {});
  const decisions = Object.keys(existingDecisions).length ? existingDecisions : defaultDecisions(verified.task.kind, verified.result);
  inTransaction(db, () => {
    const changed = db.prepare(`
      UPDATE agent_task_reviews SET preview_json = ?, decision_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND status = 'awaiting_review' AND result_checksum = ?
    `).run(JSON.stringify(preview), JSON.stringify(decisions), taskId, verified.task.resultChecksum);
    if (changed.changes !== 1) throw reviewError("Companion review changed before preview was saved", 409);
  });
  return getCompanionResultReview(db, taskId);
}

function normalizeDecision(value, original, type) {
  if (!isObject(value)) throw reviewError(`${type} decision must be an object`);
  const decision = cleanText(value.decision, 20);
  if (!DECISIONS.has(decision)) throw reviewError(`${type} decision must be use, edit, or exclude`);
  if (decision !== "edit") return { decision };
  if (type === "fact") {
    const edited = cleanText(value.value, 4000);
    if (!edited) throw reviewError("Edited fact value cannot be empty");
    return { decision, value: edited };
  }
  if (type === "evidence") {
    const description = cleanText(value.description, 6000);
    if (!description && !(original.metrics || []).length && !(original.skills || []).length) throw reviewError("Edited evidence cannot be empty");
    return { decision, description };
  }
  const edited = original.kind === "list" ? cleanList(value.value) : cleanText(value.value, 8000);
  if (Array.isArray(edited) ? !edited.length : !edited) throw reviewError("Edited section value cannot be empty");
  return { decision, value: edited };
}

export function patchCompanionResultReview(db, taskId, input = {}) {
  if (!isObject(input) || !isObject(input.decisions)) throw reviewError("Review decisions must be an object");
  const verified = readVerifiedCompanionResult(db, taskId);
  const row = reviewRow(db, taskId);
  assertAwaiting(row);
  let decisions;
  if (verified.task.kind === "analyze_documents") {
    const catalog = analysisCatalog(verified.result);
    decisions = {};
    for (const [type, items] of Object.entries(catalog)) {
      const supplied = input.decisions[type];
      if (!isObject(supplied) || Object.keys(supplied).some((id) => !items.has(id))) throw reviewError(`Review decisions for ${type} do not match the result`);
      decisions[type] = Object.fromEntries([...items].map(([id, item]) => [id,
        normalizeDecision(supplied[id], item, type === "facts" ? "fact" : type === "evidence" ? "evidence" : "section"),
      ]));
    }
  } else if (verified.task.kind === "generate_package") {
    const catalog = generatedCatalog(verified.result);
    const supplied = input.decisions.sections;
    if (!isObject(supplied) || Object.keys(supplied).some((key) => !catalog.has(key))) throw reviewError("Section decisions do not match the generated result");
    decisions = { sections: Object.fromEntries([...catalog].map(([key, item]) => [key, normalizeDecision(supplied[key], item, "section")])) };
  } else {
    decisions = {};
  }
  const note = cleanText(input.note, 1000);
  inTransaction(db, () => {
    const changed = db.prepare(`UPDATE agent_task_reviews SET decision_json = ?, note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND status = 'awaiting_review' AND result_checksum = ?`)
      .run(JSON.stringify(decisions), note, taskId, verified.task.resultChecksum);
    if (changed.changes !== 1) throw reviewError("Companion review changed before decisions were saved", 409);
  });
  return getCompanionResultReview(db, taskId);
}

function acceptedAnalysis(result, decisions) {
  const catalog = analysisCatalog(result);
  const accepted = { facts: [], evidence: [], sections: [] };
  for (const [type, items] of Object.entries(catalog)) {
    for (const [id, item] of items) {
      const decision = decisions[type]?.[id];
      if (!decision || !DECISIONS.has(decision.decision)) throw reviewError("Every analysis item must be reviewed before applying", 409);
      if (decision.decision === "exclude") continue;
      if (decision.decision === "edit") {
        if (type === "facts") accepted[type].push({ ...item, value: decision.value });
        else if (type === "evidence") accepted[type].push({ ...item, description: decision.description });
        else accepted[type].push({ ...item, value: decision.value });
      } else accepted[type].push(item);
    }
  }
  return accepted;
}

function stableRecordId(taskId, type, id) {
  return `companion-${crypto.createHash("sha256").update(`${taskId}:${type}:${id}`).digest("hex").slice(0, 32)}`;
}

function firstReference(item) {
  const reference = Array.isArray(item.sourceRefs) ? item.sourceRefs[0] : null;
  return {
    documentId: cleanText(item.sourceDocumentId || reference?.documentId || reference?.id, 120),
    locator: cleanText(item.sourceLocator || reference?.locator || reference?.sourceLocator, 300),
  };
}

function markAccepted(db, row, kind, reference) {
  const changed = db.prepare(`
    UPDATE agent_task_reviews SET status = 'accepted', application_kind = ?, application_ref = ?,
      reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE task_id = ? AND status = 'awaiting_review' AND result_checksum = ?
  `).run(kind, String(reference || ""), row.task_id, row.result_checksum);
  if (changed.changes !== 1) throw reviewError("Companion review changed before the approved result was applied", 409);
}

function applyDocumentAnalysis(db, verified, row) {
  const decisions = parseJson(row.decision_json, {});
  const accepted = acceptedAnalysis(verified.result, decisions);
  return inTransaction(db, () => {
    const addFact = db.prepare(`
      INSERT INTO profile_facts (id, fact_key, label, value, source_document_id, source_locator, confidence, protected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET fact_key = excluded.fact_key, label = excluded.label, value = excluded.value,
        source_document_id = excluded.source_document_id, source_locator = excluded.source_locator,
        confidence = excluded.confidence, protected = excluded.protected, updated_at = CURRENT_TIMESTAMP
    `);
    for (const item of accepted.facts) {
      const reference = firstReference(item);
      const key = cleanText(item.key, 100) || item.id;
      addFact.run(stableRecordId(verified.task.id, "fact", item.id), key, cleanText(item.label, 200) || key,
        cleanText(item.value, 4000), reference.documentId || null, reference.locator,
        Math.max(0, Math.min(100, Number(item.confidence || 0))), PROTECTED_FACT.test(key.replace(/[^a-z0-9가-힣]/gi, "")) ? 1 : 0);
    }
    const addEvidence = db.prepare(`
      INSERT INTO evidence_items (id, title, description, metrics_json, skills_json, source_refs_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
        metrics_json = excluded.metrics_json, skills_json = excluded.skills_json,
        source_refs_json = excluded.source_refs_json, updated_at = CURRENT_TIMESTAMP
    `);
    for (const item of accepted.evidence) addEvidence.run(
      stableRecordId(verified.task.id, "evidence", item.id), cleanText(item.title, 240) || item.id,
      cleanText(item.description, 6000), JSON.stringify(cleanList(item.metrics || [], 30, 300)),
      JSON.stringify(cleanList(item.skills || [], 50, 200)), JSON.stringify(item.sourceRefs || []),
    );
    let displayOrder = Number(db.prepare("SELECT COALESCE(MAX(display_order), 0) AS value FROM resume_custom_sections").get().value);
    for (const item of accepted.sections) {
      const key = canonicalSectionKey(item.key, item.label, item.id);
      const builtin = BUILTIN_SECTION_DEFINITIONS[key];
      if (builtin && item.kind !== builtin.kind) {
        throw reviewError(`Built-in resume section ${key} must use kind ${builtin.kind}`);
      }
      const kind = builtin?.kind || (item.kind === "list" ? "list" : "text");
      const value = kind === "list" ? cleanList(item.value) : cleanText(item.value, 8000);
      if (builtin) {
        const column = BUILTIN_COLUMNS[key];
        db.prepare(`UPDATE resume_profile SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
          .run(kind === "list" ? JSON.stringify(value) : value);
      } else {
        displayOrder += 1;
        db.prepare(`
          INSERT INTO resume_custom_sections (id, section_key, label, kind, value_json, display_order, editable, source_refs_json)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(section_key) DO UPDATE SET label = excluded.label, kind = excluded.kind,
            value_json = excluded.value_json, editable = 1, source_refs_json = excluded.source_refs_json,
            updated_at = CURRENT_TIMESTAMP
        `).run(stableRecordId(verified.task.id, "section", item.id), key,
          cleanText(item.label, 200) || key.slice(7), kind, JSON.stringify(value), displayOrder, JSON.stringify(item.sourceRefs || []));
      }
    }
    markAccepted(db, row, "profile_analysis", verified.task.id);
    return { facts: accepted.facts.length, evidence: accepted.evidence.length, sections: accepted.sections.length };
  });
}

function selectedGeneratedSections(verified, decisions) {
  const catalog = generatedCatalog(verified.result);
  const selected = [];
  for (const [key, item] of catalog) {
    const decision = decisions.sections?.[key];
    if (!decision || !DECISIONS.has(decision.decision)) throw reviewError("Every generated section must be reviewed before applying", 409);
    if (decision.decision === "exclude") continue;
    selected.push({ ...item, value: decision.decision === "edit" ? decision.value : item.value });
  }
  if (!selected.length) throw reviewError("At least one generated section must be accepted or edited", 409);
  return selected;
}

function applyGeneratedPackage(db, verified, row, options) {
  const selected = selectedGeneratedSections(verified, parseJson(row.decision_json, {}));
  const jobId = Number(verified.request.input.job.id);
  const packageOptions = options.packageOptions || {};
  const callback = (packageValue) => markAccepted(db, row, "application_package", packageValue.id);
  const latest = getLatestPackageForJob(db, jobId, packageOptions);
  if (!latest) return createPackage(db, jobId, { ...packageOptions, generatedSections: selected, afterApply: callback });
  if (latest.refreshRequired) {
    return createPackage(db, jobId, {
      ...packageOptions, refreshConfirmed: true, generatedSections: selected, afterApply: callback,
    });
  }
  return updatePackage(db, latest.id, { expectedChecksum: latest.checksum, sections: selected }, {
    ...packageOptions, generatedResult: true, afterApply: callback,
  });
}

function applyCollectedJobs(db, verified, row, options) {
  const preview = parseJson(row.preview_json, {});
  if (preview.kind !== "collect_jobs") throw reviewError("Prepare the collection preview before applying", 409);
  if (preview.empty === true) {
    return inTransaction(db, () => {
      markAccepted(db, row, "collection", "no-new-jobs");
      return { run: null, imported: [] };
    });
  }
  const runId = preview.run?.id;
  const run = getCollectionRun(runId, { db, runRoot: options.runRoot });
  if (run.status !== "staged") throw reviewError("Collection preview is no longer staged", 409);
  return publishCollectionRun(db, runId, {
    expectedChecksum: run.requestChecksum,
    sourcesConfig: options.sourcesConfig,
    timeZone: options.timeZone,
    runRoot: options.runRoot,
    afterApply(_items, publication) { markAccepted(db, row, "collection", publication.runId); },
  });
}

export function applyCompanionResultReview(db, taskId, options = {}) {
  const verified = assertCompanionTaskCurrent(db, taskId, options.context || {});
  const row = reviewRow(db, taskId);
  assertAwaiting(row);
  if (row.result_checksum !== verified.task.resultChecksum) throw reviewError("Review result checksum is stale", 409);
  let applied;
  if (verified.task.kind === "collect_jobs") applied = applyCollectedJobs(db, verified, row, options);
  else if (verified.task.kind === "analyze_documents") applied = applyDocumentAnalysis(db, verified, row);
  else applied = applyGeneratedPackage(db, verified, row, options);
  return { applied: verified.task.kind === "generate_package" ? publicPackage(applied) : applied, ...getCompanionResultReview(db, taskId) };
}

export function rejectCompanionResultReview(db, taskId, input = {}) {
  const verified = readVerifiedCompanionResult(db, taskId);
  const note = cleanText(input.note, 1000);
  return inTransaction(db, () => {
    const changed = db.prepare(`
      UPDATE agent_task_reviews SET status = 'rejected', note = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND status = 'awaiting_review' AND result_checksum = ?
    `).run(note, taskId, verified.task.resultChecksum);
    if (changed.changes !== 1) throw reviewError("Only a review-pending result can be rejected", 409);
    return getCompanionResultReview(db, taskId);
  });
}

export function supersedeCompanionResultReview(db, taskId, note = "Inputs changed before approval") {
  const row = reviewRow(db, taskId);
  if (row.status === "superseded") return publicReview(row);
  assertAwaiting(row);
  db.prepare(`UPDATE agent_task_reviews SET status = 'superseded', note = ?, reviewed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND status = 'awaiting_review'`)
    .run(cleanText(note, 1000), taskId);
  return publicReview(reviewRow(db, taskId));
}

export function supersedeStaleCompanionResults(db, context = {}) {
  const taskIds = db.prepare(`SELECT t.id FROM agent_tasks t JOIN agent_task_reviews r ON r.task_id = t.id
    WHERE t.status = 'succeeded' AND r.status = 'awaiting_review' ORDER BY t.created_at, t.id`).all();
  const superseded = [];
  for (const { id } of taskIds) {
    try {
      assertCompanionTaskCurrent(db, id, context);
    } catch (error) {
      if (error?.statusCode !== 409 || !/inputs changed/i.test(String(error?.message || ""))) throw error;
      supersedeCompanionResultReview(db, id, "Local settings or source inputs changed before approval");
      superseded.push(id);
    }
  }
  return superseded;
}
