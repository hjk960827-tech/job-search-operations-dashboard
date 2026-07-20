import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  CONFIG_NAMES,
  assertConfigDirectory,
  assertRegularConfigFile,
  loadConfig,
  validateConfig,
} from "./config.mjs";
import { receiveValidatedDocumentUpload } from "./onboarding.mjs";
import { CONFIG_DIR, configPath, onboardingDocumentPath } from "./paths.mjs";

function settingsError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, maximum = 1000) {
  if (value === null || value === undefined) return "";
  if (!["string", "number"].includes(typeof value)) throw settingsError("설정 텍스트 형식이 올바르지 않습니다.");
  return String(value).replace(/\r\n?/g, "\n").trim().slice(0, maximum);
}

function list(value, maximumItems = 100, maximumLength = 300) {
  if (!Array.isArray(value)) throw settingsError("설정 목록 형식이 올바르지 않습니다.");
  const result = [];
  for (const item of value.slice(0, maximumItems)) {
    const normalized = text(item, maximumLength);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function numberOrNull(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === "" || value === null || value === undefined) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > maximum) throw settingsError(`${label} 값이 올바르지 않습니다.`);
  return normalized;
}

function clone(value) {
  return structuredClone(value);
}

function trackLabel(item) {
  return text(isObject(item) ? item.label : item, 160);
}

function publicDocuments(db) {
  return db.prepare(`
    SELECT d.id, d.kind, d.original_name, d.mime_type, d.size_bytes, d.sha256, d.active,
           d.created_at, d.updated_at, COALESCE(a.status, CASE WHEN d.active = 1 THEN 'active' ELSE 'archived' END) AS asset_status
    FROM source_documents d LEFT JOIN resume_assets a ON a.document_id = d.id
    ORDER BY d.active DESC, d.created_at DESC, d.id DESC
  `).all().map((row) => ({
    id: row.id,
    kind: row.kind,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: Number(row.size_bytes),
    checksumPrefix: row.sha256 ? row.sha256.slice(0, 12) : "",
    active: Boolean(row.active),
    status: row.asset_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getPersonalSettings(db) {
  const profile = loadConfig("profile");
  const search = loadConfig("search");
  const sources = loadConfig("sources");
  const resume = loadConfig("resume");
  return {
    profile: {
      displayName: profile.identity?.display_name || "",
      email: profile.identity?.email || "",
      phone: profile.identity?.phone || "",
      address: profile.identity?.address || "",
      pdfFields: { ...profile.identity?.pdf_fields },
      country: profile.location?.country || "",
      regions: [...(profile.location?.regions || [])],
      timezone: profile.location?.timezone || "Asia/Seoul",
      careerStage: profile.career?.current_level || "",
      yearsExperience: profile.career?.years_experience ?? null,
      employmentTypes: [...(profile.preferences?.employment_types || [])],
      workModes: [...(profile.preferences?.work_modes || [])],
      currency: profile.preferences?.salary?.currency || "",
      salaryMinimum: profile.preferences?.salary?.minimum ?? null,
      salaryTarget: profile.preferences?.salary?.target ?? null,
    },
    search: {
      targetRoles: [...(search.target_roles || [])],
      includeKeywords: [...(search.include_keywords || [])],
      excludeKeywords: [...(search.exclude_keywords || [])],
      experienceMinimum: search.experience?.minimum_years ?? null,
      experienceMaximum: search.experience?.maximum_years ?? null,
      tracks: (search.target_tracks || []).map(trackLabel).filter(Boolean),
      preferredCompanies: [...(search.company_preferences?.include || [])],
      excludedCompanies: [...(search.company_preferences?.exclude || [])],
      preferredIndustries: [...(search.industry_preferences?.include || [])],
      excludedIndustries: [...(search.industry_preferences?.exclude || [])],
      desiredWork: [...(search.work_preferences?.desired || [])],
      avoidedWork: [...(search.work_preferences?.avoided || [])],
      scoring: clone(search.scoring || { review_below: 70, dimensions: [] }),
    },
    sources: {
      preferDirectCompany: sources.primary_selection?.prefer_direct_company !== false,
      requireNotClosed: sources.primary_selection?.require_not_closed !== false,
      items: clone(sources.sources || {}),
    },
    resume: clone(resume),
    documents: publicDocuments(db),
  };
}

function normalizedConfigs(input) {
  if (!isObject(input)) throw settingsError("개인 설정 변경값은 객체여야 합니다.");
  for (const key of Object.keys(input)) if (!new Set(["profile", "search", "sources", "resume"]).has(key)) throw settingsError(`지원하지 않는 설정 묶음입니다: ${key}`);
  const current = Object.fromEntries(CONFIG_NAMES.map((name) => [name, clone(loadConfig(name))]));
  current.profile.identity ||= {};
  current.profile.identity.pdf_fields ||= { email: false, phone: false, address: false };
  current.profile.location ||= { country: "", regions: [], timezone: "Asia/Seoul" };
  current.profile.career ||= { years_experience: null, current_level: "" };
  current.profile.preferences ||= {};
  current.profile.preferences.employment_types ||= [];
  current.profile.preferences.work_modes ||= [];
  current.profile.preferences.salary ||= { currency: "", minimum: null, target: null };
  current.search.experience ||= { minimum_years: null, maximum_years: null };
  current.search.company_preferences ||= { include: [], exclude: [] };
  current.search.industry_preferences ||= { include: [], exclude: [] };
  current.search.work_preferences ||= { desired: [], avoided: [] };
  current.search.scoring ||= { review_below: 70, dimensions: [] };
  current.sources.primary_selection ||= { prefer_direct_company: true, require_not_closed: true };
  current.sources.sources ||= {};
  current.resume.quality_rules ||= { minimum_score: 80, maximum_pdf_pages: 3 };
  const profileInput = isObject(input.profile) ? input.profile : {};
  const searchInput = isObject(input.search) ? input.search : {};
  const sourcesInput = isObject(input.sources) ? input.sources : {};
  const resumeInput = isObject(input.resume) ? input.resume : {};

  if (Object.keys(profileInput).length) {
    const allowed = new Set(["displayName", "email", "phone", "address", "pdfFields", "country", "regions", "timezone", "careerStage", "yearsExperience", "employmentTypes", "workModes", "currency", "salaryMinimum", "salaryTarget"]);
    for (const key of Object.keys(profileInput)) if (!allowed.has(key)) throw settingsError(`지원하지 않는 프로필 설정입니다: ${key}`);
    current.profile.identity.display_name = text(profileInput.displayName ?? current.profile.identity.display_name, 160);
    current.profile.identity.email = text(profileInput.email ?? current.profile.identity.email, 320);
    current.profile.identity.phone = text(profileInput.phone ?? current.profile.identity.phone, 120);
    current.profile.identity.address = text(profileInput.address ?? current.profile.identity.address, 500);
    if (isObject(profileInput.pdfFields)) {
      for (const key of ["email", "phone", "address"]) {
        if (Object.hasOwn(profileInput.pdfFields, key) && typeof profileInput.pdfFields[key] !== "boolean") throw settingsError(`PDF ${key} 선택값은 true 또는 false여야 합니다.`);
        if (Object.hasOwn(profileInput.pdfFields, key)) current.profile.identity.pdf_fields[key] = profileInput.pdfFields[key];
      }
    }
    current.profile.location.country = text(profileInput.country ?? current.profile.location.country, 20);
    if (Object.hasOwn(profileInput, "regions")) current.profile.location.regions = list(profileInput.regions, 30, 160);
    current.profile.location.timezone = text(profileInput.timezone ?? current.profile.location.timezone, 80);
    current.profile.career.current_level = text(profileInput.careerStage ?? current.profile.career.current_level, 40);
    if (Object.hasOwn(profileInput, "yearsExperience")) current.profile.career.years_experience = numberOrNull(profileInput.yearsExperience, "총 경력 연수", 80);
    if (Object.hasOwn(profileInput, "employmentTypes")) current.profile.preferences.employment_types = list(profileInput.employmentTypes, 20, 80);
    if (Object.hasOwn(profileInput, "workModes")) current.profile.preferences.work_modes = list(profileInput.workModes, 20, 80);
    current.profile.preferences.salary.currency = text(profileInput.currency ?? current.profile.preferences.salary.currency, 20);
    if (Object.hasOwn(profileInput, "salaryMinimum")) current.profile.preferences.salary.minimum = numberOrNull(profileInput.salaryMinimum, "희망 연봉 최소");
    if (Object.hasOwn(profileInput, "salaryTarget")) current.profile.preferences.salary.target = numberOrNull(profileInput.salaryTarget, "희망 연봉 목표");
    if (current.profile.preferences.salary.minimum !== null && current.profile.preferences.salary.target !== null
      && current.profile.preferences.salary.minimum > current.profile.preferences.salary.target) throw settingsError("희망 연봉 목표는 최소보다 작을 수 없습니다.");
  }

  if (Object.keys(searchInput).length) {
    const allowed = new Set(["targetRoles", "includeKeywords", "excludeKeywords", "experienceMinimum", "experienceMaximum", "tracks", "preferredCompanies", "excludedCompanies", "preferredIndustries", "excludedIndustries", "desiredWork", "avoidedWork", "scoring"]);
    for (const key of Object.keys(searchInput)) if (!allowed.has(key)) throw settingsError(`지원하지 않는 검색 설정입니다: ${key}`);
    if (Object.hasOwn(searchInput, "targetRoles")) current.search.target_roles = list(searchInput.targetRoles, 20, 160);
    if (Object.hasOwn(searchInput, "includeKeywords")) current.search.include_keywords = list(searchInput.includeKeywords, 100, 120);
    if (Object.hasOwn(searchInput, "excludeKeywords")) current.search.exclude_keywords = list(searchInput.excludeKeywords, 100, 120);
    if (Object.hasOwn(searchInput, "experienceMinimum")) current.search.experience.minimum_years = numberOrNull(searchInput.experienceMinimum, "지원 경력 최소", 80);
    if (Object.hasOwn(searchInput, "experienceMaximum")) current.search.experience.maximum_years = numberOrNull(searchInput.experienceMaximum, "지원 경력 최대", 80);
    if (current.search.experience.minimum_years !== null && current.search.experience.maximum_years !== null
      && current.search.experience.minimum_years > current.search.experience.maximum_years) throw settingsError("지원 경력 최대는 최소보다 작을 수 없습니다.");
    if (Object.hasOwn(searchInput, "tracks")) current.search.target_tracks = list(searchInput.tracks, 20, 160).map((label, index) => ({ id: `track-${index + 1}`, label, priority: index + 1 }));
    if (Object.hasOwn(searchInput, "preferredCompanies")) current.search.company_preferences.include = list(searchInput.preferredCompanies, 50, 200);
    if (Object.hasOwn(searchInput, "excludedCompanies")) current.search.company_preferences.exclude = list(searchInput.excludedCompanies, 50, 200);
    if (Object.hasOwn(searchInput, "preferredIndustries")) current.search.industry_preferences.include = list(searchInput.preferredIndustries, 50, 160);
    if (Object.hasOwn(searchInput, "excludedIndustries")) current.search.industry_preferences.exclude = list(searchInput.excludedIndustries, 50, 160);
    if (Object.hasOwn(searchInput, "desiredWork")) current.search.work_preferences.desired = list(searchInput.desiredWork, 50, 300);
    if (Object.hasOwn(searchInput, "avoidedWork")) current.search.work_preferences.avoided = list(searchInput.avoidedWork, 50, 300);
    if (Object.hasOwn(searchInput, "scoring")) current.search.scoring = clone(searchInput.scoring);
  }

  if (Object.keys(sourcesInput).length) {
    const allowed = new Set(["preferDirectCompany", "requireNotClosed", "items"]);
    for (const key of Object.keys(sourcesInput)) if (!allowed.has(key)) throw settingsError(`지원하지 않는 플랫폼 설정입니다: ${key}`);
    if (Object.hasOwn(sourcesInput, "preferDirectCompany")) current.sources.primary_selection.prefer_direct_company = sourcesInput.preferDirectCompany === true;
    if (Object.hasOwn(sourcesInput, "requireNotClosed")) current.sources.primary_selection.require_not_closed = sourcesInput.requireNotClosed === true;
    if (Object.hasOwn(sourcesInput, "items")) current.sources.sources = clone(sourcesInput.items);
  }

  if (Object.keys(resumeInput).length) {
    if (!isObject(resumeInput.quality_rules)) throw settingsError("문서 품질 기준 형식이 올바르지 않습니다.");
    current.resume.quality_rules = clone(resumeInput.quality_rules);
  }
  for (const value of Object.values(current)) value.setup_complete = true;
  if (!Object.values(current.sources.sources).some((item) => item?.collect === true)) throw settingsError("수집할 채용 플랫폼을 하나 이상 선택해 주세요.");
  for (const [name, value] of Object.entries(current)) {
    const validation = validateConfig(name, value);
    if (!validation.valid) throw settingsError(`설정 검증 실패: ${validation.issues.join("; ")}`);
  }
  return current;
}

function installConfigsAtomically(configs) {
  assertConfigDirectory(CONFIG_DIR);
  const operationId = crypto.randomUUID();
  const files = [];
  try {
    for (const name of CONFIG_NAMES) {
      const target = configPath(name);
      assertRegularConfigFile(target);
      const temporary = `${target}.${operationId}.tmp`;
      const backup = `${target}.${operationId}.previous`;
      fs.writeFileSync(temporary, yaml.dump(configs[name], { lineWidth: 100, noRefs: true }), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      files.push({ target, temporary, backup, backedUp: false, installed: false });
    }
    for (const file of files) {
      fs.renameSync(file.target, file.backup);
      file.backedUp = true;
      fs.renameSync(file.temporary, file.target);
      file.installed = true;
      fs.chmodSync(file.target, 0o600);
    }
  } catch (error) {
    for (const file of [...files].reverse()) {
      if (file.installed) fs.rmSync(file.target, { force: true });
      if (file.backedUp && fs.existsSync(file.backup)) fs.renameSync(file.backup, file.target);
      fs.rmSync(file.temporary, { force: true });
    }
    throw error;
  }
  for (const file of files) {
    fs.rmSync(file.temporary, { force: true });
    fs.rmSync(file.backup, { force: true });
  }
}

export function savePersonalSettings(db, input) {
  const configs = normalizedConfigs(input);
  installConfigsAtomically(configs);
  return getPersonalSettings(db);
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

export async function uploadPersonalDocument(db, request, kind, { replaceId = "" } = {}) {
  const parsed = await receiveValidatedDocumentUpload(request, kind);
  let directory = "";
  try {
    const previous = replaceId ? db.prepare("SELECT * FROM source_documents WHERE id = ? AND active = 1").get(text(replaceId, 120)) : null;
    if (replaceId && (!previous || previous.kind !== kind)) throw settingsError("교체할 활성 문서를 찾을 수 없습니다.", 404);
    const activeBytes = Number(db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS value FROM source_documents WHERE active = 1 AND id <> ?").get(previous?.id || "").value);
    if (activeBytes + parsed.bytes > parsed.maximumTotalBytes) throw settingsError("활성 문서 전체 용량 제한을 초과했습니다.", 413);
    const id = crypto.randomUUID();
    directory = onboardingDocumentPath(id);
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const target = onboardingDocumentPath(id, `source${parsed.extension}`);
    fs.renameSync(parsed.tempPath, target);
    fs.chmodSync(target, 0o600);
    inTransaction(db, () => {
      db.prepare(`INSERT INTO source_documents
        (id, kind, original_name, internal_path, mime_type, size_bytes, sha256, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(id, kind, parsed.originalName, target, parsed.mimeType, parsed.bytes, parsed.sha256);
      db.prepare("INSERT INTO resume_assets (document_id, label, status) VALUES (?, ?, 'review_required')")
        .run(id, parsed.originalName);
      if (previous) {
        db.prepare("UPDATE source_documents SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1").run(previous.id);
        db.prepare("UPDATE resume_assets SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE document_id = ?").run(previous.id);
      }
    });
    return { documentId: id, replacedDocumentId: previous?.id || "", documents: publicDocuments(db) };
  } catch (error) {
    try { fs.rmSync(parsed.tempPath, { force: true }); } catch {}
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function archivePersonalDocument(db, documentId) {
  return inTransaction(db, () => {
    const row = db.prepare("SELECT id, active FROM source_documents WHERE id = ?").get(text(documentId, 120));
    if (!row) throw settingsError("등록 문서를 찾을 수 없습니다.", 404);
    if (row.active) db.prepare("UPDATE source_documents SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
    db.prepare("UPDATE resume_assets SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE document_id = ?").run(row.id);
    return { documents: publicDocuments(db) };
  });
}
