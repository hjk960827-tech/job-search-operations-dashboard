import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { initializeDatabase, importJob, openDatabase, updateApplicationState } from "../lib/database.mjs";
import { appendApplicationEvent, listJobOutcomes } from "../lib/outcome-ledger.mjs";
import { readOutcomeEvidence, storeOutcomeEvidence } from "../lib/result-attachment.mjs";

function uploadRequest(fileName, mimeType, body) {
  const boundary = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const request = Readable.from([payload]);
  request.headers = { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(payload.length) };
  return request;
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "outcome-evidence-"));
  const dbPath = path.join(directory, "personal.sqlite");
  initializeDatabase(dbPath, { mode: "personal" });
  const db = openDatabase(dbPath);
  const jobId = importJob(db, { jobKey: path.basename(directory), companyName: "Example", title: "Example Role", sources: [{ platform: "direct", url: "https://example.invalid/evidence", status: "active" }] });
  updateApplicationState(db, jobId, { workflowStatus: "applied" });
  const event = appendApplicationEvent(db, jobId, { type: "document_passed", occurredAt: "2026-07-22T01:00:00.000Z" }).event;
  return { directory, db, jobId, event };
}

test("outcome evidence stores a validated owner-only file and exposes no internal path", async () => {
  const value = fixture();
  let installedDirectory = "";
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const stored = await storeOutcomeEvidence(value.db, value.event.id, uploadRequest("result.png", "image/png", png));
    assert.equal(stored.fileName, "result.png");
    assert.equal(JSON.stringify(stored).includes("/Users/"), false);
    const row = value.db.prepare("SELECT * FROM outcome_evidence_files WHERE event_id = ?").get(value.event.id);
    installedDirectory = path.dirname(row.internal_path);
    assert.equal(fs.statSync(installedDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(row.internal_path).mode & 0o777, 0o600);
    assert.deepEqual(readOutcomeEvidence(value.db, value.event.id).body, png);
    const publicEvent = listJobOutcomes(value.db, value.jobId).events[0];
    assert.equal(publicEvent.evidence.available, true);
    assert.equal(publicEvent.evidence.url, `/api/outcomes/${value.event.id}/evidence`);
    await assert.rejects(() => storeOutcomeEvidence(value.db, value.event.id, uploadRequest("again.png", "image/png", png)), /already|이미/);
  } finally {
    value.db.close();
    if (installedDirectory) fs.rmSync(installedDirectory, { recursive: true, force: true });
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("outcome evidence rejects an extension, MIME, or signature mismatch before writing", async () => {
  const value = fixture();
  try {
    await assert.rejects(() => storeOutcomeEvidence(value.db, value.event.id, uploadRequest("fake.png", "image/png", Buffer.from("not-a-png"))), /시그니처/);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM outcome_evidence_files").get().count, 0);
  } finally {
    value.db.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
