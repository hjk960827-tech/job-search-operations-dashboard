import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_DIR, packagePath } from "./paths.mjs";

const EDITABLE_STATES = new Set(["quality_hold", "approval_pending", "revision_requested", "approval_hold", "approved"]);
const CONTENT_KEYS = ["headline", "summary", "skills", "experienceHighlights", "motivation", "plan"];

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanText(value, maximum = 8000) {
  return String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, maximum);
}

function cleanLines(value, maximumItems = 30) {
  const input = Array.isArray(value) ? value : String(value || "").split("\n");
  return input.map((item) => cleanText(item, 1000)).filter(Boolean).slice(0, maximumItems);
}

export function normalizePackageContent(input = {}) {
  return {
    headline: cleanText(input.headline, 300),
    summary: cleanText(input.summary, 5000),
    skills: cleanLines(input.skills),
    experienceHighlights: cleanLines(input.experienceHighlights),
    motivation: cleanText(input.motivation, 6000),
    plan: cleanText(input.plan, 6000),
  };
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function contentChecksum(content) {
  return crypto.createHash("sha256").update(JSON.stringify(normalizePackageContent(content))).digest("hex");
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraphs(value = "") {
  return cleanText(value).split(/\n\s*\n/).map((item) => item.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
}

export function renderPackageMarkdown(content, job = {}) {
  const normalized = normalizePackageContent(content);
  const lines = [
    `# ${normalized.headline || "맞춤 이력서"}`,
    "",
    `> ${cleanText(job.companyName, 200)} · ${cleanText(job.title, 240)}`,
    "",
    "## 경력 요약",
    "",
    normalized.summary,
    "",
    "## 핵심 역량",
    "",
    ...normalized.skills.map((item) => `- ${item}`),
    "",
    "## 주요 경험",
    "",
    ...normalized.experienceHighlights.map((item) => `- ${item}`),
    "",
    "## 지원 동기",
    "",
    normalized.motivation,
    "",
    "## 입사 후 기여 방향",
    "",
    normalized.plan,
    "",
  ];
  return lines.join("\n");
}

export function renderPackageHtml(content, job = {}) {
  const normalized = normalizePackageContent(content);
  const list = (items) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const prose = (value) => paragraphs(value).map((item) => `<p>${escapeHtml(item)}</p>`).join("");
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(normalized.headline || "Resume")}</title>
<style>
@page { size: A4; margin: 16mm 17mm; }
* { box-sizing: border-box; } body { margin: 0; color: #17231f; font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; font-size: 10.5pt; line-height: 1.55; }
h1 { margin: 0 0 4mm; font-size: 20pt; } h2 { margin: 7mm 0 2mm; padding-bottom: 1.5mm; border-bottom: 1px solid #b9c8c1; font-size: 12pt; }
.target { margin-bottom: 7mm; color: #52635c; } p { margin: 0 0 2.5mm; } ul { margin: 0; padding-left: 5mm; } li { margin-bottom: 1.5mm; }
</style></head><body>
<h1>${escapeHtml(normalized.headline || "맞춤 이력서")}</h1>
<div class="target">${escapeHtml(job.companyName || "")} · ${escapeHtml(job.title || "")}</div>
<section><h2>경력 요약</h2>${prose(normalized.summary)}</section>
<section><h2>핵심 역량</h2><ul>${list(normalized.skills)}</ul></section>
<section><h2>주요 경험</h2><ul>${list(normalized.experienceHighlights)}</ul></section>
<section><h2>지원 동기</h2>${prose(normalized.motivation)}</section>
<section><h2>입사 후 기여 방향</h2>${prose(normalized.plan)}</section>
</body></html>`;
}

export function evaluatePackageQuality(content, { threshold = 80 } = {}) {
  const normalized = normalizePackageContent(content);
  const checks = [
    ["headline", Boolean(normalized.headline), 10, "헤드라인을 입력해 주세요."],
    ["summary", normalized.summary.length >= 80, 25, "경력 요약을 80자 이상 작성해 주세요."],
    ["skills", normalized.skills.length >= 2, 15, "핵심 역량을 2개 이상 입력해 주세요."],
    ["experienceHighlights", normalized.experienceHighlights.length >= 2, 25, "근거가 있는 주요 경험을 2개 이상 입력해 주세요."],
    ["motivation", normalized.motivation.length >= 80, 15, "지원 동기를 80자 이상 작성해 주세요."],
    ["plan", normalized.plan.length >= 60, 10, "입사 후 기여 방향을 60자 이상 작성해 주세요."],
  ];
  const score = checks.reduce((sum, [, passed, points]) => sum + (passed ? points : 0), 0);
  const placeholderPattern = /(?:TODO|TBD|Lorem ipsum|\[수치\]|\[회사명\]|<[^>]{1,40}>)/i;
  const placeholder = placeholderPattern.test(JSON.stringify(normalized));
  const findings = checks.filter(([, passed]) => !passed).map(([key, , , message]) => ({ key, message }));
  if (placeholder) findings.push({ key: "placeholder", message: "미확정 자리표시자 문구를 제거해 주세요." });
  const status = score >= threshold && !placeholder ? "passed" : "review";
  return { status, score, threshold, findings };
}

function rowToPackage(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    version: row.version,
    state: row.state,
    content: safeJson(row.content_json, {}),
    checksum: row.content_checksum,
    quality: {
      status: row.quality_status,
      score: row.quality_score,
      findings: safeJson(row.quality_findings_json, []),
    },
    artifacts: {
      directory: row.artifact_directory,
      contentJsonPath: row.content_json_path,
      markdownPath: row.resume_markdown_path,
      htmlPath: row.resume_html_path,
      pdfPath: row.resume_pdf_path,
      pdfChecksum: row.resume_pdf_checksum,
      pdfPages: row.resume_pdf_pages,
    },
    approvedChecksum: row.approved_checksum,
    updatedAt: row.updated_at,
  };
}

function getPackageRow(db, packageId) {
  return db.prepare(`
    SELECT p.*, j.company_name, j.title, j.lifecycle_status,
           COALESCE(a.workflow_status, 'new') AS workflow_status,
           s.status AS submission_status, s.frozen_pdf_path, s.frozen_pdf_checksum, s.frozen_pdf_pages
    FROM application_packages p
    JOIN jobs j ON j.id = p.job_id
    LEFT JOIN application_state a ON a.job_id = j.id
    LEFT JOIN package_submissions s ON s.package_id = p.id
    WHERE p.id = ?
  `).get(packageId);
}

export function getLatestPackageForJob(db, jobId) {
  const row = db.prepare("SELECT * FROM application_packages WHERE job_id = ? ORDER BY version DESC LIMIT 1").get(jobId);
  return rowToPackage(row);
}

function databaseInstanceId(db) {
  const value = db.prepare("SELECT value FROM app_meta WHERE key = 'instance_id'").get()?.value;
  if (!/^[0-9a-f-]{36}$/i.test(String(value || ""))) throw new Error("Database instance identifier is missing");
  return value;
}

function artifactPaths(db, jobId, version) {
  const scope = `instance-${databaseInstanceId(db)}`;
  const directory = packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`);
  return {
    directory,
    json: packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`, "content.json"),
    markdown: packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`, "resume.md"),
    html: packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`, "resume.html"),
    pdf: packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`, "resume.pdf"),
  };
}

function assertStoredPath(candidate, label) {
  if (!candidate) return "";
  const resolved = packagePath(path.relative(PACKAGE_DIR, path.resolve(candidate)));
  if (resolved !== path.resolve(candidate)) throw new Error(`${label} is outside the package data directory`);
  return resolved;
}

function artifactFiles(paths, content, job) {
  return [
    { path: paths.json, content: canonicalJson(normalizePackageContent(content)) },
    { path: paths.markdown, content: renderPackageMarkdown(content, job) },
    { path: paths.html, content: renderPackageHtml(content, job) },
  ];
}

function installFilesAtomically(files) {
  const operationId = crypto.randomUUID();
  const staged = [];
  const installed = [];
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      const temp = `${file.path}.tmp-${operationId}`;
      fs.writeFileSync(temp, file.content, "utf8");
      staged.push({ ...file, temp, backup: `${file.path}.previous-${operationId}`, existed: fs.existsSync(file.path) });
    }
    for (const file of staged) {
      if (file.existed) fs.renameSync(file.path, file.backup);
      fs.renameSync(file.temp, file.path);
      installed.push(file);
    }
  } catch (error) {
    for (const file of [...staged].reverse()) {
      if (installed.includes(file)) fs.rmSync(file.path, { force: true });
      if (file.existed && fs.existsSync(file.backup)) {
        fs.rmSync(file.path, { force: true });
        fs.renameSync(file.backup, file.path);
      }
    }
    for (const file of staged) fs.rmSync(file.temp, { force: true });
    throw error;
  }
  return {
    rollback() {
      for (const file of [...staged].reverse()) {
        if (installed.includes(file)) fs.rmSync(file.path, { force: true });
        if (file.existed && fs.existsSync(file.backup)) {
          fs.rmSync(file.path, { force: true });
          fs.renameSync(file.backup, file.path);
        }
      }
    },
    cleanup() {
      for (const file of staged) {
        fs.rmSync(file.temp, { force: true });
        fs.rmSync(file.backup, { force: true });
      }
    },
  };
}

export function createPackage(db, jobId, { threshold = 80 } = {}) {
  const existing = getLatestPackageForJob(db, jobId);
  if (existing) return existing;
  const job = db.prepare("SELECT id, company_name AS companyName, title FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw new Error("Job not found");
  const resume = db.prepare("SELECT * FROM resume_profile WHERE id = 1").get() || {};
  const content = normalizePackageContent({
    headline: resume.headline,
    summary: resume.summary,
    skills: safeJson(resume.skills_json, []),
    experienceHighlights: safeJson(resume.experience_highlights_json, []),
    motivation: "",
    plan: "",
  });
  const checksum = contentChecksum(content);
  const quality = evaluatePackageQuality(content, { threshold });
  const state = quality.status === "passed" ? "approval_pending" : "quality_hold";
  const paths = artifactPaths(db, jobId, 1);
  const files = installFilesAtomically(artifactFiles(paths, content, job));
  try {
    db.prepare(`
      INSERT INTO application_packages (
        job_id, version, state, content_json, content_checksum, quality_status, quality_score,
        quality_findings_json, artifact_directory, content_json_path, resume_markdown_path, resume_html_path
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, state, JSON.stringify(content), checksum, quality.status, quality.score,
      JSON.stringify(quality.findings), paths.directory, paths.json, paths.markdown, paths.html);
    files.cleanup();
  } catch (error) {
    files.rollback();
    files.cleanup();
    throw error;
  }
  return getLatestPackageForJob(db, jobId);
}

function snapshotPackage(row, revisionNo) {
  const directory = packagePath(path.relative(
    PACKAGE_DIR,
    path.join(assertStoredPath(row.artifact_directory, "artifact directory"), ".revisions", `revision-${revisionNo}`),
  ));
  fs.mkdirSync(directory, { recursive: true });
  for (const candidate of [row.content_json_path, row.resume_markdown_path, row.resume_html_path, row.resume_pdf_path]) {
    if (!candidate) continue;
    const source = assertStoredPath(candidate, "package artifact");
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(directory, path.basename(source)));
  }
  return directory;
}

export function updatePackage(db, packageId, input = {}, { threshold = 80, beforeCommit } = {}) {
  const row = getPackageRow(db, packageId);
  if (!row) throw Object.assign(new Error("Package not found"), { statusCode: 404 });
  if (!EDITABLE_STATES.has(row.state)) throw Object.assign(new Error("Prepared or submitted packages cannot be edited"), { statusCode: 409 });
  if (row.lifecycle_status === "closed" || row.workflow_status === "skipped") {
    throw Object.assign(new Error("Closed or skipped jobs cannot be edited"), { statusCode: 409 });
  }
  if (new Set(["submit_ready", "submitted"]).has(row.submission_status)) {
    throw Object.assign(new Error("Prepared or submitted packages cannot be edited"), { statusCode: 409 });
  }
  if (!input.expectedChecksum || input.expectedChecksum !== row.content_checksum) {
    throw Object.assign(new Error("The package changed in another session; reload before saving"), { statusCode: 409 });
  }
  const current = normalizePackageContent(safeJson(row.content_json, {}));
  const patch = Object.fromEntries(CONTENT_KEYS.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
  const next = normalizePackageContent({ ...current, ...patch });
  const nextChecksum = contentChecksum(next);
  const quality = evaluatePackageQuality(next, { threshold });
  const nextState = quality.status === "passed" ? "approval_pending" : "quality_hold";
  const revisionNo = Number(db.prepare("SELECT COALESCE(MAX(revision_no), 0) + 1 AS value FROM package_revisions WHERE package_id = ?").get(packageId).value);
  const snapshotDirectory = snapshotPackage(row, revisionNo);
  const job = { companyName: row.company_name, title: row.title };
  const paths = {
    directory: assertStoredPath(row.artifact_directory, "artifact directory"),
    json: assertStoredPath(row.content_json_path, "content JSON"),
    markdown: assertStoredPath(row.resume_markdown_path, "resume Markdown"),
    html: assertStoredPath(row.resume_html_path, "resume HTML"),
  };
  const files = installFilesAtomically(artifactFiles(paths, next, job));
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      INSERT INTO package_revisions (
        package_id, revision_no, previous_checksum, next_checksum, previous_content_json,
        next_content_json, snapshot_directory, quality_status, quality_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(packageId, revisionNo, row.content_checksum, nextChecksum, JSON.stringify(current), JSON.stringify(next),
      snapshotDirectory, quality.status, quality.score);
    if (row.approved_checksum || row.state === "approved") {
      db.prepare(`INSERT INTO package_approvals (package_id, action, package_checksum, note)
                  VALUES (?, 'invalidated', ?, 'Content changed after approval')`).run(packageId, row.approved_checksum || row.content_checksum);
    }
    db.prepare(`
      UPDATE application_packages SET state = ?, content_json = ?, content_checksum = ?, quality_status = ?,
        quality_score = ?, quality_findings_json = ?, resume_pdf_path = '', resume_pdf_checksum = '',
        resume_pdf_pages = 0, approved_checksum = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(nextState, JSON.stringify(next), nextChecksum, quality.status, quality.score, JSON.stringify(quality.findings), packageId);
    if (beforeCommit) beforeCommit();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    files.rollback();
    files.cleanup();
    fs.rmSync(snapshotDirectory, { recursive: true, force: true });
    throw error;
  }
  if (row.resume_pdf_path) {
    try { fs.rmSync(assertStoredPath(row.resume_pdf_path, "resume PDF"), { force: true }); } catch {}
  }
  files.cleanup();
  return rowToPackage(db.prepare("SELECT * FROM application_packages WHERE id = ?").get(packageId));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function pdfPageCount(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Generated artifact is not a PDF");
  const matches = buffer.toString("latin1").match(/\/Type\s*\/Page\b/g);
  return matches?.length || 0;
}

export async function renderHtmlPdf(htmlPath, outputPath) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.pdf({ path: outputPath, format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

export async function approvePackage(db, packageId, { actorId = "local-user", note = "", maximumPages = 3, renderer = renderHtmlPdf, beforeCommit } = {}) {
  const row = getPackageRow(db, packageId);
  if (!row) throw Object.assign(new Error("Package not found"), { statusCode: 404 });
  if (row.state !== "approval_pending" || row.quality_status !== "passed") {
    throw Object.assign(new Error("Only a quality-passed package awaiting approval can be approved"), { statusCode: 409 });
  }
  const htmlPath = assertStoredPath(row.resume_html_path, "resume HTML");
  const pdfPath = packagePath(path.relative(PACKAGE_DIR, path.join(row.artifact_directory, "resume.pdf")));
  const stagedPath = `${pdfPath}.staged-${crypto.randomUUID()}`;
  let previousPath = "";
  try {
    await renderer(htmlPath, stagedPath);
    const pages = pdfPageCount(stagedPath);
    if (pages < 1 || pages > maximumPages) {
      throw Object.assign(new Error(`Resume PDF must contain 1-${maximumPages} pages (received ${pages})`), { statusCode: 409 });
    }
    const checksum = sha256File(stagedPath);
    if (fs.existsSync(pdfPath)) {
      previousPath = `${pdfPath}.previous-${crypto.randomUUID()}`;
      fs.renameSync(pdfPath, previousPath);
    }
    fs.renameSync(stagedPath, pdfPath);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(`UPDATE application_packages SET state = 'approved', resume_pdf_path = ?, resume_pdf_checksum = ?,
                  resume_pdf_pages = ?, approved_checksum = content_checksum, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(pdfPath, checksum, pages, packageId);
      db.prepare(`INSERT INTO package_approvals (package_id, action, package_checksum, actor_id, note)
                  VALUES (?, 'approved', ?, ?, ?)`)
        .run(packageId, row.content_checksum, cleanText(actorId, 120) || "local-user", cleanText(note, 1000));
      if (beforeCommit) beforeCommit();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      fs.rmSync(pdfPath, { force: true });
      if (previousPath && fs.existsSync(previousPath)) fs.renameSync(previousPath, pdfPath);
      throw error;
    }
    if (previousPath) {
      try { fs.rmSync(previousPath, { force: true }); } catch {}
    }
  } catch (error) {
    fs.rmSync(stagedPath, { force: true });
    throw error;
  }
  return rowToPackage(db.prepare("SELECT * FROM application_packages WHERE id = ?").get(packageId));
}

function verifiedPdf(filePath, checksum, pages) {
  const resolved = assertStoredPath(filePath, "resume PDF");
  if (!fs.existsSync(resolved)) throw new Error("Resume PDF is missing");
  const actualChecksum = sha256File(resolved);
  const actualPages = pdfPageCount(resolved);
  if (!checksum || actualChecksum !== checksum) throw new Error("Resume PDF checksum changed");
  if (!pages || actualPages !== Number(pages)) throw new Error("Resume PDF page count changed");
  return { path: resolved, checksum: actualChecksum, pages: actualPages };
}

export function prepareSubmission(db, packageId, { platform = "", beforeCommit } = {}) {
  const row = getPackageRow(db, packageId);
  if (!row) throw Object.assign(new Error("Package not found"), { statusCode: 404 });
  if (row.state !== "approved") throw Object.assign(new Error("Only approved packages can be prepared"), { statusCode: 409 });
  if (row.approved_checksum !== row.content_checksum) throw new Error("Approved content checksum does not match current content");
  const pdf = verifiedPdf(row.resume_pdf_path, row.resume_pdf_checksum, row.resume_pdf_pages);
  const frozenPath = packagePath(path.relative(PACKAGE_DIR, path.join(row.artifact_directory, "submissions", `resume-${pdf.checksum.slice(0, 16)}.pdf`)));
  fs.mkdirSync(path.dirname(frozenPath), { recursive: true });
  const stagedPath = `${frozenPath}.tmp-${crypto.randomUUID()}`;
  fs.copyFileSync(pdf.path, stagedPath);
  if (sha256File(stagedPath) !== pdf.checksum) {
    fs.rmSync(stagedPath, { force: true });
    throw new Error("Frozen submission copy failed checksum verification");
  }
  const createdFrozen = !fs.existsSync(frozenPath);
  if (createdFrozen) fs.renameSync(stagedPath, frozenPath);
  else fs.rmSync(stagedPath, { force: true });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO package_submissions (package_id, status, platform, frozen_pdf_path, frozen_pdf_checksum, frozen_pdf_pages)
      VALUES (?, 'submit_ready', ?, ?, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET status = 'submit_ready', platform = excluded.platform,
        frozen_pdf_path = excluded.frozen_pdf_path, frozen_pdf_checksum = excluded.frozen_pdf_checksum,
        frozen_pdf_pages = excluded.frozen_pdf_pages, submitted_at = NULL, updated_at = CURRENT_TIMESTAMP
    `).run(packageId, cleanText(platform, 80), frozenPath, pdf.checksum, pdf.pages);
    db.prepare("UPDATE application_packages SET state = 'submit_ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(packageId);
    if (beforeCommit) beforeCommit();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (createdFrozen) {
      fs.rmSync(frozenPath, { force: true });
      try { fs.rmdirSync(path.dirname(frozenPath)); } catch {}
    }
    throw error;
  }
  return rowToPackage(db.prepare("SELECT * FROM application_packages WHERE id = ?").get(packageId));
}

export function recordSubmitted(db, packageId) {
  const row = getPackageRow(db, packageId);
  if (!row) throw Object.assign(new Error("Package not found"), { statusCode: 404 });
  if (row.state !== "submit_ready" || row.submission_status !== "submit_ready") {
    throw Object.assign(new Error("Package is not ready for submission"), { statusCode: 409 });
  }
  verifiedPdf(row.frozen_pdf_path, row.frozen_pdf_checksum, row.frozen_pdf_pages);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE package_submissions SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE package_id = ?").run(packageId);
    db.prepare("UPDATE application_packages SET state = 'submitted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(packageId);
    db.prepare(`INSERT INTO application_state (job_id, workflow_status) VALUES (?, 'applied')
                ON CONFLICT(job_id) DO UPDATE SET workflow_status = 'applied', updated_at = CURRENT_TIMESTAMP`).run(row.job_id);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return rowToPackage(db.prepare("SELECT * FROM application_packages WHERE id = ?").get(packageId));
}

export function publicPackage(value) {
  if (!value) return null;
  return {
    id: value.id,
    version: value.version,
    state: value.state,
    content: value.content,
    checksum: value.checksum,
    quality: value.quality,
    pdf: value.artifacts?.pdfPath ? {
      available: true,
      fileName: path.basename(value.artifacts.pdfPath),
      checksum: value.artifacts.pdfChecksum,
      pages: value.artifacts.pdfPages,
    } : { available: false },
    approvedChecksum: value.approvedChecksum,
    updatedAt: value.updatedAt,
  };
}
