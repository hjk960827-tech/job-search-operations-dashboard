import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeDatabase, openDatabase } from "../lib/database.mjs";
import {
  PRIVACY_DELETE_CONFIRMATION,
  deleteExpiredPrivateDocuments,
  planPrivateDocumentDeletion,
} from "../lib/privacy-retention.mjs";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function fixture(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const file = path.join(directory, "personal.sqlite");
  const privateDataDir = path.join(directory, "private");
  const quarantineDir = path.join(privateDataDir, ".deletion-quarantine");
  fs.mkdirSync(privateDataDir, { recursive: true, mode: 0o700 });
  initializeDatabase(file, { mode: "personal" });
  const db = openDatabase(file);
  return { directory, file, privateDataDir, quarantineDir, db };
}

function addDocument(value, { id, active, updatedAt, file = true, internalPath } = {}) {
  const documentPath = internalPath || path.join(value.privateDataDir, `${id}.pdf`);
  if (file) fs.writeFileSync(documentPath, `synthetic-${id}`, { mode: 0o600 });
  value.db.prepare(`
    INSERT INTO source_documents (
      id, kind, original_name, internal_path, mime_type, size_bytes, sha256, active, created_at, updated_at
    ) VALUES (?, 'resume', ?, ?, 'application/pdf', 16, ?, ?, ?, ?)
  `).run(id, `${id}.pdf`, documentPath, `sha-${id}`, active ? 1 : 0, updatedAt, updatedAt);
  return documentPath;
}

function options(value, extra = {}) {
  return {
    olderThanDays: 30,
    now: NOW,
    privateDataDir: value.privateDataDir,
    quarantineDir: value.quarantineDir,
    ...extra,
  };
}

test("retention plans include only inactive documents older than the explicit cutoff", () => {
  const value = fixture("privacy-retention-plan");
  try {
    addDocument(value, { id: "active-old", active: true, updatedAt: "2026-01-01T00:00:00.000Z" });
    addDocument(value, { id: "inactive-old", active: false, updatedAt: "2026-01-01T00:00:00.000Z" });
    addDocument(value, { id: "inactive-new", active: false, updatedAt: "2026-07-10T00:00:00.000Z" });
    const plan = planPrivateDocumentDeletion(value.db, options(value));
    assert.equal(plan.cutoff, "2026-06-19T12:00:00.000Z");
    assert.deepEqual(plan.documents.map((item) => item.id), ["inactive-old"]);
    assert.equal(plan.documents[0].fileExists, true);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM source_documents").get().count, 3);
  } finally {
    value.db.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("confirmed deletion removes the inactive row and file while preserving an audit event", () => {
  const value = fixture("privacy-retention-delete");
  try {
    const documentPath = addDocument(value, { id: "expired", active: false, updatedAt: "2026-01-01T00:00:00.000Z" });
    value.db.prepare(`
      INSERT INTO profile_facts (id, fact_key, label, value, source_document_id)
      VALUES ('fact-1', 'sample', 'Sample', 'Synthetic value', 'expired')
    `).run();
    assert.throws(() => deleteExpiredPrivateDocuments(value.db, options(value)), /requires --confirm/);
    assert.equal(fs.existsSync(documentPath), true);

    const result = deleteExpiredPrivateDocuments(value.db, options(value, { confirm: PRIVACY_DELETE_CONFIRMATION }));
    assert.equal(result.count, 1);
    assert.deepEqual(result.deleted.map((item) => ({ id: item.id, status: item.status, fileDeleted: item.fileDeleted })), [
      { id: "expired", status: "deleted", fileDeleted: true },
    ]);
    assert.equal(fs.existsSync(documentPath), false);
    assert.equal(value.db.prepare("SELECT id FROM source_documents WHERE id = 'expired'").get(), undefined);
    assert.equal(value.db.prepare("SELECT source_document_id FROM profile_facts WHERE id = 'fact-1'").get().source_document_id, null);
    assert.equal(value.db.prepare("SELECT status FROM privacy_deletion_events WHERE document_id = 'expired'").get().status, "deleted");
  } finally {
    value.db.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a database deletion failure rolls the transaction back and restores the original file", () => {
  const value = fixture("privacy-retention-rollback");
  try {
    const documentPath = addDocument(value, { id: "blocked", active: false, updatedAt: "2026-01-01T00:00:00.000Z" });
    value.db.exec(`
      CREATE TRIGGER synthetic_delete_failure
      BEFORE DELETE ON source_documents
      BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END;
    `);
    assert.throws(
      () => deleteExpiredPrivateDocuments(value.db, options(value, { confirm: PRIVACY_DELETE_CONFIRMATION })),
      /synthetic delete failure/,
    );
    assert.equal(fs.existsSync(documentPath), true);
    assert.notEqual(value.db.prepare("SELECT id FROM source_documents WHERE id = 'blocked'").get(), undefined);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_events").get().count, 0);
  } finally {
    value.db.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a filesystem removal failure keeps the file quarantined and records that state", () => {
  const value = fixture("privacy-retention-quarantine");
  try {
    const documentPath = addDocument(value, { id: "quarantined", active: false, updatedAt: "2026-01-01T00:00:00.000Z" });
    const result = deleteExpiredPrivateDocuments(value.db, options(value, {
      confirm: PRIVACY_DELETE_CONFIRMATION,
      removeFile() { throw new Error("synthetic unlink failure"); },
    }));
    assert.equal(result.deleted[0].status, "quarantined");
    assert.equal(result.deleted[0].fileDeleted, false);
    assert.equal(fs.existsSync(documentPath), false);
    assert.equal(fs.readdirSync(value.quarantineDir).length, 1);
    assert.equal(value.db.prepare("SELECT status FROM privacy_deletion_events WHERE document_id = 'quarantined'").get().status, "quarantined");
  } finally {
    value.db.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("retention rejects paths outside private storage and symbolic links", () => {
  for (const variant of ["outside", "symlink"]) {
    const value = fixture(`privacy-retention-${variant}`);
    try {
      let documentPath;
      if (variant === "outside") {
        documentPath = path.join(value.directory, "outside.pdf");
        addDocument(value, { id: variant, active: false, updatedAt: "2026-01-01T00:00:00.000Z", internalPath: documentPath });
      } else {
        const target = path.join(value.privateDataDir, "target.pdf");
        fs.writeFileSync(target, "synthetic-target", { mode: 0o600 });
        documentPath = path.join(value.privateDataDir, "linked.pdf");
        fs.symlinkSync(target, documentPath);
        addDocument(value, { id: variant, active: false, updatedAt: "2026-01-01T00:00:00.000Z", file: false, internalPath: documentPath });
      }
      assert.throws(
        () => planPrivateDocumentDeletion(value.db, options(value)),
        variant === "outside" ? /must stay inside/ : /must not use symbolic links|not a symbolic link/,
      );
    } finally {
      value.db.close();
      fs.rmSync(value.directory, { recursive: true, force: true });
    }
  }
});
