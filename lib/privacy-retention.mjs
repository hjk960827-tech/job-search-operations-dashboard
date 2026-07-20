import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DELETION_QUARANTINE_DIR, PRIVATE_DATA_DIR, assertPathInside } from "./paths.mjs";

export const PRIVACY_DELETE_CONFIRMATION = "DELETE_EXPIRED_PRIVATE_DOCUMENTS";

function normalizedDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Retention days must be an integer between 1 and 3650");
  return days;
}

function safeDocumentPath(internalPath, privateDataDir = PRIVATE_DATA_DIR) {
  const candidate = assertPathInside(privateDataDir, internalPath, "private document path");
  if (!fs.existsSync(candidate)) return candidate;
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Private document must be a regular file and not a symbolic link");
  return candidate;
}

export function planPrivateDocumentDeletion(db, options = {}) {
  const days = normalizedDays(options.olderThanDays);
  const now = options.now || new Date();
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT id, kind, internal_path, sha256, updated_at
    FROM source_documents
    WHERE active = 0 AND datetime(updated_at) <= datetime(?)
    ORDER BY updated_at, id
  `).all(cutoff);
  const privateDataDir = options.privateDataDir || PRIVATE_DATA_DIR;
  return {
    cutoff,
    count: rows.length,
    documents: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      path: safeDocumentPath(row.internal_path, privateDataDir),
      sha256: row.sha256 || "",
      updatedAt: row.updated_at,
      fileExists: fs.existsSync(safeDocumentPath(row.internal_path, privateDataDir)),
    })),
  };
}

export function deleteExpiredPrivateDocuments(db, options = {}) {
  if (options.confirm !== PRIVACY_DELETE_CONFIRMATION) {
    throw new Error(`Deletion requires --confirm=${PRIVACY_DELETE_CONFIRMATION}`);
  }
  const plan = planPrivateDocumentDeletion(db, options);
  const quarantineDir = options.quarantineDir || DELETION_QUARANTINE_DIR;
  assertPathInside(options.privateDataDir || PRIVATE_DATA_DIR, quarantineDir, "deletion quarantine path");
  fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(quarantineDir).isSymbolicLink()) throw new Error("Deletion quarantine must not be a symbolic link");
  fs.chmodSync(quarantineDir, 0o700);
  const deleted = [];
  const removeFile = options.removeFile || ((filePath) => fs.rmSync(filePath, { force: true }));

  for (const document of plan.documents) {
    const eventKey = crypto.randomUUID();
    const quarantined = path.join(quarantineDir, `${eventKey}.pending`);
    let moved = false;
    let committed = false;
    try {
      if (document.fileExists) {
        fs.renameSync(document.path, quarantined);
        moved = true;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const removed = db.prepare("DELETE FROM source_documents WHERE id = ? AND active = 0").run(document.id);
        if (Number(removed.changes) !== 1) throw new Error("Private document changed after the deletion plan was created");
        db.prepare(`
          INSERT INTO privacy_deletion_events (
            event_key, document_id, document_kind, document_sha256, status
          ) VALUES (?, ?, ?, ?, 'deleted')
        `).run(eventKey, document.id, document.kind, document.sha256);
        db.exec("COMMIT");
        committed = true;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
      let status = "deleted";
      if (moved) {
        try {
          removeFile(quarantined);
        } catch (error) {
          status = "quarantined";
          db.prepare("UPDATE privacy_deletion_events SET status = 'quarantined' WHERE event_key = ?").run(eventKey);
        }
      }
      deleted.push({ id: document.id, eventKey, status, fileDeleted: moved && status === "deleted" });
    } catch (error) {
      if (!committed && moved && fs.existsSync(quarantined) && !fs.existsSync(document.path)) {
        fs.renameSync(quarantined, document.path);
      }
      throw error;
    }
  }
  return { cutoff: plan.cutoff, count: deleted.length, deleted };
}
