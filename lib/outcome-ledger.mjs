import crypto from "node:crypto";
import { dateKey, deadlineDays } from "./deadlines.mjs";

const EVENT_TYPES = new Set([
  "document_passed",
  "document_rejected",
  "interview_scheduled",
  "interview_completed",
  "offer_received",
  "offer_accepted",
  "rejected",
  "withdrawn",
]);
const EVIDENCE_KINDS = new Set(["none", "manual_note", "portal", "email", "document"]);
const EVENT_LABELS = {
  document_passed: "서류 합격",
  document_rejected: "서류 불합격",
  interview_scheduled: "면접 예정",
  interview_completed: "면접 완료",
  offer_received: "합격·제안 수신",
  offer_accepted: "합격·제안 수락",
  rejected: "불합격",
  withdrawn: "지원 철회",
};
const EVENT_WORKFLOW = {
  document_passed: "applied",
  document_rejected: "rejected",
  interview_scheduled: "interview",
  interview_completed: "interview",
  offer_received: "offer",
  offer_accepted: "offer",
  rejected: "rejected",
  withdrawn: "rejected",
};

function outcomeError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, field, maximum, { required = false } = {}) {
  if (value === null || value === undefined) value = "";
  if (typeof value !== "string") throw outcomeError(`${field} must be text`);
  const result = value.trim().replace(/\s+/g, " ");
  if (required && !result) throw outcomeError(`${field} is required`);
  if (result.length > maximum) throw outcomeError(`${field} is too long`);
  return result;
}

function timestamp(value, field, { dateOnly = false } = {}) {
  const raw = value ?? new Date().toISOString();
  if (typeof raw !== "string") throw outcomeError(`${field} must be an ISO timestamp`);
  const input = dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime())) throw outcomeError(`${field} must be a valid ISO timestamp`);
  return parsed.toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function jobContext(db, jobId) {
  const row = db.prepare(`
    SELECT j.id, j.company_name, j.title,
           COALESCE(a.workflow_status, 'new') AS workflow_status,
           EXISTS(
             SELECT 1 FROM application_packages p
             JOIN package_submissions s ON s.package_id = p.id
             WHERE p.job_id = j.id AND s.status = 'submitted'
           ) AS has_submission
    FROM jobs j
    LEFT JOIN application_state a ON a.job_id = j.id
    WHERE j.id = ?
  `).get(jobId);
  if (!row) throw outcomeError("Job not found", 404);
  const eligible = Boolean(row.has_submission) || new Set(["applied", "interview", "offer", "rejected"]).has(row.workflow_status);
  return { ...row, eligible };
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    eventKey: row.event_key,
    type: row.event_type,
    label: EVENT_LABELS[row.event_type] || row.event_type,
    summary: row.summary,
    evidence: {
      kind: row.evidence_available ? "document" : row.evidence_kind,
      label: row.evidence_available ? row.evidence_file_name : row.evidence_label,
      checksum: row.evidence_available ? row.evidence_file_checksum : row.evidence_checksum,
      available: Boolean(row.evidence_available),
      url: row.evidence_available ? `/api/outcomes/${Number(row.id)}/evidence` : "",
    },
    packageId: row.package_id === null ? null : Number(row.package_id),
    correctionOfEventId: row.correction_of_event_id === null ? null : Number(row.correction_of_event_id),
    correctionReason: row.correction_reason || "",
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function daysUntil(value, now = new Date(), timeZone = "Asia/Seoul") {
  const dueDate = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
  return deadlineDays(dueDate, now, timeZone);
}

function rowToFollowUp(row, now, timeZone = "Asia/Seoul") {
  return {
    id: row.id,
    jobId: Number(row.job_id),
    sourceEventId: row.source_event_id === null ? null : Number(row.source_event_id),
    title: row.title,
    dueAt: row.due_at,
    offsetDays: row.offset_days === null ? null : Number(row.offset_days),
    daysUntil: daysUntil(row.due_at, now, timeZone),
    status: row.status,
    completedAt: row.completed_at || "",
    cancelledAt: row.cancelled_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeEventInput(input, jobId, correction = {}) {
  if (!isObject(input)) throw outcomeError("Outcome event must be an object");
  const type = cleanText(input.type, "type", 60, { required: true });
  if (!EVENT_TYPES.has(type)) throw outcomeError("Unsupported outcome event type");
  const occurredAt = timestamp(input.occurredAt, "occurredAt");
  const summary = cleanText(input.summary, "summary", 2000);
  const evidenceInput = input.evidence ?? {};
  if (!isObject(evidenceInput)) throw outcomeError("evidence must be an object");
  const evidenceKind = cleanText(evidenceInput.kind || "none", "evidence.kind", 30);
  if (!EVIDENCE_KINDS.has(evidenceKind)) throw outcomeError("Unsupported evidence kind");
  const evidenceLabel = cleanText(evidenceInput.label, "evidence.label", 500, { required: evidenceKind !== "none" });
  const evidenceChecksum = cleanText(evidenceInput.checksum, "evidence.checksum", 64).toLowerCase();
  if (evidenceChecksum && !/^[a-f0-9]{64}$/.test(evidenceChecksum)) throw outcomeError("evidence.checksum must be SHA-256");
  if (evidenceKind === "document" && !evidenceChecksum) throw outcomeError("Document evidence requires a SHA-256 checksum");
  if (evidenceKind === "none" && (evidenceLabel || evidenceChecksum)) throw outcomeError("Evidence details require an evidence kind");
  const eventKey = cleanText(input.eventKey || crypto.randomUUID(), "eventKey", 120, { required: true });
  if (!/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(eventKey)) throw outcomeError("eventKey has an unsupported format");
  const packageId = input.packageId === undefined || input.packageId === null ? null : Number(input.packageId);
  if (packageId !== null && (!Number.isSafeInteger(packageId) || packageId < 1)) throw outcomeError("packageId must be a positive integer");
  const correctionOfEventId = correction.correctionOfEventId ?? null;
  const correctionReason = cleanText(correction.correctionReason, "correctionReason", 1000, { required: correctionOfEventId !== null });
  const semantic = { jobId, type, occurredAt, summary: summary.toLowerCase(), evidenceKind, evidenceLabel: evidenceLabel.toLowerCase(), evidenceChecksum, packageId, correctionOfEventId, correctionReason: correctionReason.toLowerCase() };
  return { eventKey, dedupeKey: sha256(semantic), type, summary, evidenceKind, evidenceLabel, evidenceChecksum, occurredAt, packageId, correctionOfEventId, correctionReason };
}

function syncWorkflowFromLatestEvent(db, jobId) {
  const latest = db.prepare("SELECT event_type FROM application_events WHERE job_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1").get(jobId);
  const status = EVENT_WORKFLOW[latest?.event_type];
  if (!status) return;
  db.prepare(`
    INSERT INTO application_state (job_id, workflow_status)
    VALUES (?, ?)
    ON CONFLICT(job_id) DO UPDATE SET workflow_status = excluded.workflow_status, updated_at = CURRENT_TIMESTAMP
  `).run(jobId, status);
}

function createNotification(db, values) {
  db.prepare(`
    INSERT OR IGNORE INTO local_notifications (
      notification_key, job_id, event_id, follow_up_id, notification_type, title, body, deep_link
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.key, values.jobId, values.eventId ?? null, values.followUpId ?? null,
    values.type, values.title, values.body || "", `#jobs?job=${values.jobId}&focus=outcomes`,
  );
}

function appendApplicationEventRecord(db, jobId, input, correction = {}) {
  const context = jobContext(db, jobId);
  if (!context.eligible) throw outcomeError("Record submission before adding an outcome event", 409);
  const normalized = normalizeEventInput(input, Number(jobId), correction);
  return inTransaction(db, () => {
    const eventKeyMatch = db.prepare("SELECT * FROM application_events WHERE event_key = ?").get(normalized.eventKey);
    if (eventKeyMatch && eventKeyMatch.dedupe_key !== normalized.dedupeKey) throw outcomeError("eventKey is already bound to another result", 409);
    const existing = eventKeyMatch || db.prepare("SELECT * FROM application_events WHERE dedupe_key = ?").get(normalized.dedupeKey);
    if (existing) return { event: rowToEvent(existing), deduplicated: true };
    if (normalized.packageId !== null) {
      const related = db.prepare("SELECT 1 AS value FROM application_packages WHERE id = ? AND job_id = ?").get(normalized.packageId, jobId);
      if (!related) throw outcomeError("packageId does not belong to this job", 409);
    }
    const result = db.prepare(`
      INSERT INTO application_events (
        event_key, dedupe_key, job_id, package_id, event_type, summary,
        evidence_kind, evidence_label, evidence_checksum, correction_of_event_id, correction_reason, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.eventKey, normalized.dedupeKey, jobId, normalized.packageId, normalized.type,
      normalized.summary, normalized.evidenceKind, normalized.evidenceLabel, normalized.evidenceChecksum,
      normalized.correctionOfEventId, normalized.correctionReason, normalized.occurredAt,
    );
    const event = db.prepare("SELECT * FROM application_events WHERE id = ?").get(Number(result.lastInsertRowid));
    syncWorkflowFromLatestEvent(db, jobId);
    createNotification(db, {
      key: `outcome:${event.id}`,
      jobId,
      eventId: Number(event.id),
      type: "outcome",
      title: `${context.company_name} · ${event.correction_of_event_id ? "결과 정정" : EVENT_LABELS[event.event_type]}`,
      body: event.correction_of_event_id ? `${EVENT_LABELS[event.event_type]} · ${event.correction_reason}` : event.summary || context.title,
    });
    return { event: rowToEvent(event), deduplicated: false };
  });
}

export function appendApplicationEvent(db, jobId, input) {
  return appendApplicationEventRecord(db, jobId, input);
}

export function appendApplicationEventCorrection(db, jobId, eventId, input) {
  const targetId = Number(eventId);
  if (!Number.isSafeInteger(targetId) || targetId < 1) throw outcomeError("Correction target must be a positive integer");
  const target = db.prepare("SELECT * FROM application_events WHERE id = ? AND job_id = ?").get(targetId, jobId);
  if (!target) throw outcomeError("Correction target was not found for this job", 404);
  if (!isObject(input)) throw outcomeError("Outcome correction must be an object");
  return appendApplicationEventRecord(db, jobId, input, {
    correctionOfEventId: targetId,
    correctionReason: input.reason,
  });
}

function addCalendarDays(date, offsetDays) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function normalizeFollowUpInput(db, jobId, input, timeZone = "Asia/Seoul") {
  if (!isObject(input)) throw outcomeError("Follow-up must be an object");
  const title = cleanText(input.title, "title", 200, { required: true });
  const sourceEventId = input.sourceEventId === undefined || input.sourceEventId === null || input.sourceEventId === ""
    ? null : Number(input.sourceEventId);
  if (sourceEventId !== null && (!Number.isSafeInteger(sourceEventId) || sourceEventId < 1)) {
    throw outcomeError("sourceEventId must be a positive integer");
  }
  const hasOffset = input.offsetDays !== undefined && input.offsetDays !== null && input.offsetDays !== "";
  const hasDue = input.dueAt !== undefined && input.dueAt !== null && input.dueAt !== "";
  if (hasOffset === hasDue) throw outcomeError("Provide either dueAt or sourceEventId with offsetDays");
  let offsetDays = null;
  let dueAt;
  if (hasOffset) {
    offsetDays = Number(input.offsetDays);
    if (!Number.isInteger(offsetDays) || offsetDays < 0 || offsetDays > 365 || sourceEventId === null) {
      throw outcomeError("D+ scheduling requires a source event and an offset from 0 to 365");
    }
    const event = db.prepare("SELECT occurred_at FROM application_events WHERE id = ? AND job_id = ?").get(sourceEventId, jobId);
    if (!event) throw outcomeError("Source event not found for this job", 404);
    const dueDate = addCalendarDays(dateKey(new Date(event.occurred_at), timeZone), offsetDays);
    dueAt = `${dueDate}T00:00:00.000Z`;
  } else {
    dueAt = timestamp(input.dueAt, "dueAt", { dateOnly: true });
    if (sourceEventId !== null) throw outcomeError("sourceEventId requires D+ offsetDays");
  }
  return {
    title,
    sourceEventId,
    offsetDays,
    dueAt,
    dedupeKey: sha256({ title: title.toLowerCase(), sourceEventId, offsetDays, dueAt }),
  };
}

export function createFollowUp(db, jobId, input, { timeZone = "Asia/Seoul", now = new Date() } = {}) {
  const context = jobContext(db, jobId);
  if (!context.eligible) throw outcomeError("Record submission before adding a follow-up", 409);
  const normalized = normalizeFollowUpInput(db, Number(jobId), input, timeZone);
  return inTransaction(db, () => {
    const existing = db.prepare("SELECT * FROM follow_ups WHERE job_id = ? AND dedupe_key = ? AND status = 'pending'").get(jobId, normalized.dedupeKey);
    if (existing) return { followUp: rowToFollowUp(existing, now, timeZone), deduplicated: true };
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO follow_ups (id, job_id, source_event_id, dedupe_key, title, due_at, offset_days)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, jobId, normalized.sourceEventId, normalized.dedupeKey, normalized.title, normalized.dueAt, normalized.offsetDays);
    const row = db.prepare("SELECT * FROM follow_ups WHERE id = ?").get(id);
    createNotification(db, {
      key: `follow-up:${id}`,
      jobId,
      followUpId: id,
      type: "follow_up",
      title: `${context.company_name} · 후속조치 예정`,
      body: `${normalized.title} · ${normalized.offsetDays === null ? normalized.dueAt.slice(0, 10) : `D+${normalized.offsetDays}`}`,
    });
    return { followUp: rowToFollowUp(row, now, timeZone), deduplicated: false };
  });
}

export function transitionFollowUp(db, id, action, { timeZone = "Asia/Seoul", now = new Date() } = {}) {
  if (!new Set(["complete", "cancel"]).has(action)) throw outcomeError("Unsupported follow-up action");
  const row = db.prepare("SELECT * FROM follow_ups WHERE id = ?").get(id);
  if (!row) throw outcomeError("Follow-up not found", 404);
  const target = action === "complete" ? "completed" : "cancelled";
  if (row.status === target) return { followUp: rowToFollowUp(row, now, timeZone), deduplicated: true };
  if (row.status !== "pending") throw outcomeError("A completed or cancelled follow-up cannot change again", 409);
  const column = action === "complete" ? "completed_at" : "cancelled_at";
  db.prepare(`UPDATE follow_ups SET status = ?, ${column} = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).run(target, id);
  return { followUp: rowToFollowUp(db.prepare("SELECT * FROM follow_ups WHERE id = ?").get(id), now, timeZone), deduplicated: false };
}

export function listJobOutcomes(db, jobId, { now = new Date(), timeZone = "Asia/Seoul" } = {}) {
  const context = jobContext(db, jobId);
  const events = db.prepare(`SELECT e.*, f.event_id IS NOT NULL AS evidence_available,
      f.original_name AS evidence_file_name, f.sha256 AS evidence_file_checksum
    FROM application_events e LEFT JOIN outcome_evidence_files f ON f.event_id = e.id
    WHERE e.job_id = ? ORDER BY e.occurred_at DESC, e.id DESC`).all(jobId).map(rowToEvent);
  const corrected = new Set(events.map((item) => item.correctionOfEventId).filter(Boolean));
  for (const event of events) event.corrected = corrected.has(event.id);
  const followUps = db.prepare("SELECT * FROM follow_ups WHERE job_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, due_at, id").all(jobId)
    .map((row) => rowToFollowUp(row, now, timeZone));
  return {
    jobId: Number(jobId),
    eligible: context.eligible,
    current: events[0] || null,
    events,
    followUps,
    pendingCount: followUps.filter((item) => item.status === "pending").length,
  };
}

export function listPendingFollowUps(db, { now = new Date(), timeZone = "Asia/Seoul", limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number.isInteger(Number(limit)) ? Number(limit) : 100));
  return db.prepare(`
    SELECT f.*, j.company_name, j.title AS job_title
    FROM follow_ups f JOIN jobs j ON j.id = f.job_id
    WHERE f.status = 'pending'
    ORDER BY f.due_at, f.created_at, f.id LIMIT ?
  `).all(safeLimit).map((row) => ({
    ...rowToFollowUp(row, now, timeZone),
    companyName: row.company_name,
    jobTitle: row.job_title,
    deepLink: `#jobs?job=${Number(row.job_id)}&focus=outcomes`,
  }));
}

function rowToNotification(row) {
  return {
    id: Number(row.id),
    type: row.notification_type,
    jobId: Number(row.job_id),
    companyName: row.company_name,
    jobTitle: row.job_title,
    title: row.title,
    body: row.body,
    deepLink: row.deep_link,
    read: Boolean(row.read_at),
    readAt: row.read_at || "",
    createdAt: row.created_at,
  };
}

export function listLocalNotifications(db, { unreadOnly = false, limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number.isInteger(Number(limit)) ? Number(limit) : 100));
  const where = unreadOnly ? "WHERE n.read_at IS NULL" : "";
  const items = db.prepare(`
    SELECT n.*, j.company_name, j.title AS job_title
    FROM local_notifications n JOIN jobs j ON j.id = n.job_id
    ${where}
    ORDER BY n.created_at DESC, n.id DESC LIMIT ?
  `).all(safeLimit).map(rowToNotification);
  const unreadCount = Number(db.prepare("SELECT COUNT(*) AS count FROM local_notifications WHERE read_at IS NULL").get().count);
  return { items, unreadCount };
}

export function markNotificationRead(db, notificationId) {
  if (!Number.isSafeInteger(Number(notificationId)) || Number(notificationId) < 1) throw outcomeError("Notification id must be a positive integer");
  const result = db.prepare("UPDATE local_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = ?").run(Number(notificationId));
  if (!result.changes && !db.prepare("SELECT 1 AS value FROM local_notifications WHERE id = ?").get(Number(notificationId))) {
    throw outcomeError("Notification not found", 404);
  }
  return listLocalNotifications(db);
}

export function markAllNotificationsRead(db) {
  db.prepare("UPDATE local_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE read_at IS NULL").run();
  return listLocalNotifications(db);
}

export function outcomeEventTypes() {
  return Object.entries(EVENT_LABELS).map(([value, label]) => ({ value, label }));
}
