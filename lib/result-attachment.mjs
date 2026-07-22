import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { receivePrivateUpload } from "./onboarding.mjs";
import { OUTCOME_EVIDENCE_DIR, assertPathInside, outcomeEvidencePath } from "./paths.mjs";

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const TYPES = new Map([
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);

function evidenceError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    let read;
    do {
      read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read) hash.update(chunk.subarray(0, read));
    } while (read);
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

function validateSignature(filePath, extension) {
  const descriptor = fs.openSync(filePath, "r");
  const head = Buffer.alloc(8);
  try { fs.readSync(descriptor, head, 0, head.length, 0); }
  finally { fs.closeSync(descriptor); }
  if (extension === ".pdf" && head.subarray(0, 5).toString("ascii") !== "%PDF-") throw evidenceError("PDF 파일 시그니처가 올바르지 않습니다.");
  if (extension === ".png" && !head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw evidenceError("PNG 파일 시그니처가 올바르지 않습니다.");
  if ([".jpg", ".jpeg"].includes(extension) && !(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)) throw evidenceError("JPEG 파일 시그니처가 올바르지 않습니다.");
}

export async function storeOutcomeEvidence(db, eventId, request) {
  const id = Number(eventId);
  if (!Number.isSafeInteger(id) || id < 1) throw evidenceError("결과 기록 번호가 올바르지 않습니다.");
  if (!db.prepare("SELECT 1 AS value FROM application_events WHERE id = ?").get(id)) throw evidenceError("결과 기록을 찾을 수 없습니다.", 404);
  if (db.prepare("SELECT 1 AS value FROM outcome_evidence_files WHERE event_id = ?").get(id)) throw evidenceError("이미 등록된 증빙은 덮어쓸 수 없습니다.", 409);
  const upload = await receivePrivateUpload(request, MAX_EVIDENCE_BYTES);
  let directory = "";
  try {
    const extension = path.extname(upload.originalName).toLowerCase();
    const expectedMime = TYPES.get(extension);
    if (!expectedMime) throw evidenceError("증빙은 PDF, PNG, JPG 파일만 등록할 수 있습니다.");
    if (upload.mimeType !== expectedMime) throw evidenceError("파일 확장자와 MIME 형식이 일치하지 않습니다.");
    validateSignature(upload.tempPath, extension);
    const checksum = hashFile(upload.tempPath);
    directory = outcomeEvidencePath(`${id}-${crypto.randomUUID()}`);
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const target = outcomeEvidencePath(path.basename(directory), `evidence${extension === ".jpeg" ? ".jpg" : extension}`);
    fs.renameSync(upload.tempPath, target);
    fs.chmodSync(target, 0o600);
    try {
      db.prepare(`INSERT INTO outcome_evidence_files
        (event_id, internal_path, original_name, mime_type, size_bytes, sha256)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, target, upload.originalName, expectedMime, upload.bytes, checksum);
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return { eventId: id, fileName: upload.originalName, mimeType: expectedMime, size: upload.bytes, checksumPrefix: checksum.slice(0, 12) };
  } catch (error) {
    try { fs.rmSync(upload.tempPath, { force: true }); } catch {}
    if (directory) try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export function readOutcomeEvidence(db, eventId) {
  const id = Number(eventId);
  if (!Number.isSafeInteger(id) || id < 1) throw evidenceError("결과 기록 번호가 올바르지 않습니다.");
  const row = db.prepare("SELECT * FROM outcome_evidence_files WHERE event_id = ?").get(id);
  if (!row) throw evidenceError("등록된 증빙을 찾을 수 없습니다.", 404);
  const target = assertPathInside(OUTCOME_EVIDENCE_DIR, row.internal_path, "outcome evidence path");
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(row.size_bytes)) throw evidenceError("증빙 파일 무결성 검증에 실패했습니다.", 409);
  if (hashFile(target) !== row.sha256) throw evidenceError("증빙 파일 체크섬이 일치하지 않습니다.", 409);
  return { body: fs.readFileSync(target), fileName: row.original_name, mimeType: row.mime_type, checksum: row.sha256 };
}
