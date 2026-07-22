import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initializeDatabase,
  importJob,
  openDatabase,
  updateApplicationState,
} from "../lib/database.mjs";
import {
  appendApplicationEvent,
  appendApplicationEventCorrection,
  createFollowUp,
  listJobOutcomes,
  listPendingFollowUps,
  listLocalNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  transitionFollowUp,
} from "../lib/outcome-ledger.mjs";

function fixture(label = "outcome-ledger") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const file = path.join(directory, "personal.sqlite");
  initializeDatabase(file, { mode: "personal" });
  const db = openDatabase(file);
  const jobId = importJob(db, {
    jobKey: "generic-role",
    companyName: "Example Organization",
    title: "Example Specialist",
    sources: [{ platform: "direct", url: "https://example.invalid/jobs/generic-role", status: "active" }],
  });
  return { directory, db, jobId };
}

function cleanup(value) {
  value.db.close();
  fs.rmSync(value.directory, { recursive: true, force: true });
}

test("outcome events append without overwriting submission state and duplicate results coalesce", () => {
  const value = fixture();
  try {
    assert.throws(() => appendApplicationEvent(value.db, value.jobId, {
      type: "document_passed", occurredAt: "2026-07-20T01:00:00.000Z",
    }), /Record submission/);
    updateApplicationState(value.db, value.jobId, { workflowStatus: "applied" });

    const first = appendApplicationEvent(value.db, value.jobId, {
      eventKey: "result-1",
      type: "document_passed",
      occurredAt: "2026-07-20T01:00:00.000Z",
      summary: "Result confirmed in the hiring portal",
      evidence: { kind: "portal", label: "Portal status" },
    });
    assert.equal(first.deduplicated, false);
    const duplicate = appendApplicationEvent(value.db, value.jobId, {
      eventKey: "retry-with-another-key",
      type: "document_passed",
      occurredAt: "2026-07-20T01:00:00.000Z",
      summary: "Result confirmed in the hiring portal",
      evidence: { kind: "portal", label: "Portal status" },
    });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.event.id, first.event.id);

    const offer = appendApplicationEvent(value.db, value.jobId, {
      eventKey: "result-2",
      type: "offer_received",
      occurredAt: "2026-07-24T03:00:00.000Z",
      summary: "Terms received for review",
    });
    assert.equal(offer.deduplicated, false);
    const outcomes = listJobOutcomes(value.db, value.jobId);
    assert.equal(outcomes.events.length, 2);
    assert.equal(outcomes.current.type, "offer_received");
    assert.equal(value.db.prepare("SELECT workflow_status FROM application_state WHERE job_id = ?").get(value.jobId).workflow_status, "offer");
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM local_notifications").get().count, 2);
    assert.throws(() => value.db.prepare("UPDATE application_events SET summary = 'changed' WHERE id = ?").run(first.event.id), /append-only/);
    assert.throws(() => value.db.prepare("DELETE FROM application_events WHERE id = ?").run(first.event.id), /append-only/);
  } finally { cleanup(value); }
});

test("follow-ups support explicit dates and D+ schedules with terminal complete and cancel states", () => {
  const value = fixture("follow-ups");
  try {
    updateApplicationState(value.db, value.jobId, { workflowStatus: "applied" });
    const event = appendApplicationEvent(value.db, value.jobId, {
      type: "interview_completed",
      occurredAt: "2026-07-20T02:00:00.000Z",
      summary: "Interview completed",
    }).event;
    const scheduled = createFollowUp(value.db, value.jobId, {
      title: "Check next-step result",
      sourceEventId: event.id,
      offsetDays: 3,
    });
    assert.equal(scheduled.followUp.dueAt, "2026-07-23T00:00:00.000Z");
    const duplicate = createFollowUp(value.db, value.jobId, {
      title: "Check next-step result",
      sourceEventId: event.id,
      offsetDays: 3,
    });
    assert.equal(duplicate.deduplicated, true);
    const completed = transitionFollowUp(value.db, scheduled.followUp.id, "complete");
    assert.equal(completed.followUp.status, "completed");
    assert.equal(transitionFollowUp(value.db, scheduled.followUp.id, "complete").deduplicated, true);
    assert.throws(() => transitionFollowUp(value.db, scheduled.followUp.id, "cancel"), /cannot change again/);

    const direct = createFollowUp(value.db, value.jobId, { title: "Archive notes", dueAt: "2026-07-30" });
    assert.equal(transitionFollowUp(value.db, direct.followUp.id, "cancel").followUp.status, "cancelled");
    const outcomes = listJobOutcomes(value.db, value.jobId, { now: new Date("2026-07-22T12:00:00.000Z") });
    assert.equal(outcomes.followUps.length, 2);
    assert.equal(outcomes.pendingCount, 0);
  } finally { cleanup(value); }
});

test("outcome corrections append a linked record and preserve the original evidence", () => {
  const value = fixture("outcome-correction");
  try {
    updateApplicationState(value.db, value.jobId, { workflowStatus: "applied" });
    const original = appendApplicationEvent(value.db, value.jobId, {
      eventKey: "original-result",
      type: "document_rejected",
      occurredAt: "2026-07-20T01:00:00.000Z",
      summary: "Portal status was read incorrectly",
      evidence: { kind: "portal", label: "Hiring portal" },
    }).event;
    assert.throws(() => appendApplicationEventCorrection(value.db, value.jobId, original.id, {
      type: "document_passed", occurredAt: "2026-07-20T02:00:00.000Z", reason: "",
    }), /correctionReason is required/);
    const correction = appendApplicationEventCorrection(value.db, value.jobId, original.id, {
      eventKey: "corrected-result",
      type: "document_passed",
      occurredAt: "2026-07-20T02:00:00.000Z",
      summary: "Portal confirms the document review passed",
      reason: "The earlier portal label was misread",
      evidence: { kind: "portal", label: "Hiring portal confirmation" },
    }).event;
    assert.equal(correction.correctionOfEventId, original.id);
    const outcomes = listJobOutcomes(value.db, value.jobId);
    assert.equal(outcomes.events.length, 2);
    assert.equal(outcomes.events.find((item) => item.id === original.id).corrected, true);
    assert.equal(outcomes.current.id, correction.id);
    assert.equal(value.db.prepare("SELECT summary FROM application_events WHERE id = ?").get(original.id).summary, "Portal status was read incorrectly");
    assert.equal(value.db.prepare("SELECT workflow_status FROM application_state WHERE job_id = ?").get(value.jobId).workflow_status, "applied");
  } finally { cleanup(value); }
});

test("pending follow-ups are exposed as a due-date ordered home workbox", () => {
  const value = fixture("follow-up-workbox");
  try {
    updateApplicationState(value.db, value.jobId, { workflowStatus: "applied" });
    createFollowUp(value.db, value.jobId, { title: "Later check", dueAt: "2026-07-24" });
    createFollowUp(value.db, value.jobId, { title: "First check", dueAt: "2026-07-21" });
    const items = listPendingFollowUps(value.db, { now: new Date("2026-07-20T12:00:00.000Z"), timeZone: "Asia/Seoul" });
    assert.deepEqual(items.map((item) => item.title), ["First check", "Later check"]);
    assert.equal(items[0].daysUntil, 1);
    assert.equal(items[0].deepLink, `#jobs?job=${value.jobId}&focus=outcomes`);
  } finally { cleanup(value); }
});

test("follow-up D-day and D+ dates follow the configured local calendar instead of UTC", () => {
  const value = fixture("follow-up-time-zone");
  try {
    updateApplicationState(value.db, value.jobId, { workflowStatus: "applied" });
    const event = appendApplicationEvent(value.db, value.jobId, {
      type: "interview_completed",
      occurredAt: "2026-07-20T16:30:00.000Z",
      summary: "Completed after midnight in the configured time zone",
    }).event;
    const scheduled = createFollowUp(value.db, value.jobId, {
      title: "Check the result",
      sourceEventId: event.id,
      offsetDays: 1,
    }, { timeZone: "Asia/Seoul", now: new Date("2026-07-21T00:30:00.000Z") });
    assert.equal(scheduled.followUp.dueAt, "2026-07-22T00:00:00.000Z");
    assert.equal(scheduled.followUp.daysUntil, 1);
    const outcomes = listJobOutcomes(value.db, value.jobId, {
      now: new Date("2026-07-21T16:30:00.000Z"),
      timeZone: "Asia/Seoul",
    });
    assert.equal(outcomes.followUps[0].daysUntil, 0);
  } finally { cleanup(value); }
});

test("the local inbox uses internal deep links, prevents duplicate notifications, and records read state", () => {
  const value = fixture("local-inbox");
  try {
    updateApplicationState(value.db, value.jobId, { workflowStatus: "applied" });
    appendApplicationEvent(value.db, value.jobId, {
      type: "withdrawn",
      occurredAt: "2026-07-21T05:00:00.000Z",
      summary: "Application withdrawn by the user",
    });
    const before = listLocalNotifications(value.db);
    assert.equal(before.items.length, 1);
    assert.equal(before.unreadCount, 1);
    assert.equal(before.items[0].deepLink, `#jobs?job=${value.jobId}&focus=outcomes`);
    assert.equal(JSON.stringify(before).includes("Telegram"), false);
    const after = markNotificationRead(value.db, before.items[0].id);
    assert.equal(after.unreadCount, 0);
    assert.equal(after.items[0].read, true);
    const again = markNotificationRead(value.db, before.items[0].id);
    assert.equal(again.unreadCount, 0);
  } finally { cleanup(value); }
});

test("all local notifications can be marked read in one idempotent operation", () => {
  const value = fixture("local-inbox-all");
  try {
    updateApplicationState(value.db, value.jobId, { workflowStatus: "applied" });
    appendApplicationEvent(value.db, value.jobId, { type: "document_passed", occurredAt: "2026-07-21T05:00:00.000Z" });
    appendApplicationEvent(value.db, value.jobId, { type: "interview_scheduled", occurredAt: "2026-07-22T05:00:00.000Z" });
    assert.equal(listLocalNotifications(value.db).unreadCount, 2);
    assert.equal(markAllNotificationsRead(value.db).unreadCount, 0);
    assert.equal(markAllNotificationsRead(value.db).unreadCount, 0);
  } finally { cleanup(value); }
});

test("outcome evidence and schedules reject malformed or unbound inputs before writing", () => {
  const value = fixture("outcome-validation");
  try {
    updateApplicationState(value.db, value.jobId, { workflowStatus: "applied" });
    for (const input of [
      { type: "unknown", occurredAt: "2026-07-20T01:00:00.000Z" },
      { type: "rejected", occurredAt: "not-a-date" },
      { type: "rejected", occurredAt: "2026-07-20T01:00:00.000Z", evidence: { kind: "document", label: "result document" } },
      { type: "rejected", occurredAt: "2026-07-20T01:00:00.000Z", evidence: { kind: "none", label: "unexpected" } },
    ]) assert.throws(() => appendApplicationEvent(value.db, value.jobId, input));
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM application_events").get().count, 0);
    assert.throws(() => createFollowUp(value.db, value.jobId, { title: "Ambiguous", dueAt: "2026-07-30", offsetDays: 3 }), /either dueAt/);
    assert.throws(() => createFollowUp(value.db, value.jobId, { title: "Missing event", offsetDays: 3 }), /requires a source event/);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM follow_ups").get().count, 0);
  } finally { cleanup(value); }
});
