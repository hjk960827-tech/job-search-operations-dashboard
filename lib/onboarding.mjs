import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Busboy from "busboy";
import yaml from "js-yaml";
import yauzl from "yauzl";
import { assertConfigDirectory, configEntryExists, loadExampleConfig, validateConfig } from "./config.mjs";
import {
  CONFIG_DIR,
  PROJECT_ROOT,
  configPath,
  databasePath,
  onboardingDocumentPath,
  onboardingPath,
} from "./paths.mjs";
import {
  initializeDatabase,
  openDatabase,
  saveOnboardingProfileData,
  saveResume,
} from "./database.mjs";
import {
  BUILTIN_SECTION_DEFINITIONS,
  builtinSectionKind,
  canonicalSectionKey,
  sectionAliasKey,
} from "./document-sections.mjs";
import { defaultDocumentQualityCriteria } from "./document-quality.mjs";

export { canonicalSectionKey } from "./document-sections.mjs";

const STATE_VERSION = 1;
const MAX_RESUME_PDF_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_DOCUMENT_BYTES = 70 * 1024 * 1024;
const MAX_DOCX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 5000;
const MAX_DOCX_COMPRESSION_RATIO = 100;
const STATE_FILE = "state.json";
const AGENT_REQUEST_FILE = "agent-request.json";
const CAREER_STAGES = new Set(["entry", "experienced", "career_change", "returning"]);
const AGE_FACT_KEYS = new Set([
  "age", "birth", "birthday", "birthdate", "dateofbirth", "dob", "yearofbirth", "birthyear",
  "나이", "연령", "생년", "생년월일", "생일", "출생", "출생일", "출생일자", "출생년", "출생년도", "출생연도",
]);
const AGE_VALUE_PATTERNS = [
  /(?:생년월일|출생(?:일자|일|년도|연도|년)?)[\s:：=-]*(?:19|20)\d{2}(?:[.\-/년]\s*\d{1,2})?/i,
  /\b(?:date\s*of\s*birth|birth\s*date|dob)\s*[:=-]?\s*(?:19|20)\d{2}\b/i,
  /\bborn\s+(?:in\s+)?(?:19|20)\d{2}\b/i,
  /(?:19|20)\d{2}\s*년\s*생(?:\s|$|[,.!?])/,
  /(?:나이|연령|만)\s*[:：=-]?\s*\d{1,3}\s*세/,
  /\bage\s*[:=-]\s*\d{1,3}\b/i,
];
const REVIEW_DECISIONS = new Set(["use", "edit", "exclude"]);
const PROTECTED_FACT_KEYS = new Set([
  "careerstage", "careerlevel", "careertype", "yearsexperience",
  "school", "educationschool", "major", "educationmajor", "degree",
  "certificate", "certificates", "certification", "certifications", "license", "licenses",
  "employment", "employmenthistory", "workhistory", "companyhistory", "careerhistory", "근무이력", "경력사항",
]);

export { BUILTIN_SECTION_DEFINITIONS } from "./document-sections.mjs";

export const SCORING_DIMENSIONS = Object.freeze([
  { id: "responsibility_match", label: "업무 일치", weight: 20 },
  { id: "skill_qualification_match", label: "기술·자격", weight: 20 },
  { id: "experience_range_match", label: "경력 범위", weight: 15 },
  { id: "evidence_strength", label: "보유 근거", weight: 15 },
  { id: "work_condition_match", label: "지역·근무·고용 조건", weight: 15 },
  { id: "company_industry_preference", label: "회사·산업 선호", weight: 15 },
]);

function onboardingError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, maximum = 5000) {
  if (value === null || value === undefined) return "";
  if (!["string", "number"].includes(typeof value)) throw onboardingError("텍스트 입력 형식이 올바르지 않습니다.");
  return String(value).replace(/\r\n?/g, "\n").trim().slice(0, maximum);
}

function cleanList(value, maximumItems = 50, maximumLength = 300) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw onboardingError("목록 입력 형식이 올바르지 않습니다.");
  const result = [];
  for (const item of value.slice(0, maximumItems)) {
    const text = cleanText(item, maximumLength);
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function factKey(value) {
  return sectionAliasKey(value);
}

function isAgeFactKey(value) {
  return AGE_FACT_KEYS.has(factKey(value));
}

function containsPersonalAgeData(value) {
  if (Array.isArray(value)) return value.some(containsPersonalAgeData);
  if (isPlainObject(value)) return Object.values(value).some(containsPersonalAgeData);
  if (typeof value !== "string" && typeof value !== "number") return false;
  const text = String(value);
  return AGE_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

function assertNoPersonalAgeData(value, field) {
  if (containsPersonalAgeData(value)) throw onboardingError(`${field}에 나이·생년월일 정보를 포함할 수 없습니다.`);
}

function isProtectedFactKey(value) {
  const key = factKey(value);
  return PROTECTED_FACT_KEYS.has(key)
    || key.startsWith("employmenthistory")
    || key.startsWith("workhistory")
    || key.startsWith("careerhistory");
}

function defaultSources() {
  const example = loadExampleConfig("sources");
  return {
    preferDirectCompany: example.primary_selection?.prefer_direct_company !== false,
    requireNotClosed: example.primary_selection?.require_not_closed !== false,
    items: Object.fromEntries(Object.entries(example.sources || {}).map(([key, item]) => [key, {
      label: cleanText(item.label, 100) || key,
      collect: false,
      display: item.display !== false,
      lifecycleCheck: item.lifecycle_check !== false,
      priority: Number(item.priority || 0),
    }])),
  };
}

function defaultState() {
  return {
    version: STATE_VERSION,
    currentStep: 1,
    privacyAccepted: false,
    documents: [],
    analysis: { status: "waiting", facts: [], evidence: [], sections: [], suggested: {} },
    analysisReview: { facts: {}, evidence: {}, sections: {} },
    profile: {
      displayName: "",
      country: "KR",
      timezone: "Asia/Seoul",
      currency: "KRW",
      careerStage: "",
      yearsExperience: null,
      employmentTypes: [],
      workModes: [],
      salaryMinimum: null,
      salaryTarget: null,
      email: "",
      phone: "",
      address: "",
      includeEmailInPdf: false,
      includePhoneInPdf: false,
      includeAddressInPdf: false,
    },
    search: {
      primaryRole: "",
      secondaryRoles: [],
      desiredWork: [],
      avoidedWork: [],
      regions: [],
      experienceMinimum: null,
      experienceMaximum: null,
      includeKeywords: [],
      excludeKeywords: [],
      tracks: [],
      preferredCompanies: [],
      excludedCompanies: [],
      preferredIndustries: [],
      excludedIndustries: [],
      scoring: {
        reviewBelow: 70,
        dimensions: SCORING_DIMENSIONS.map((item) => ({ ...item, enabled: false })),
      },
    },
    sources: defaultSources(),
    resume: {
      editableSections: Object.keys(BUILTIN_SECTION_DEFINITIONS),
      customPermissions: {},
      minimumScore: 80,
      maximumPdfPages: 3,
      qualityCriteria: defaultDocumentQualityCriteria(),
    },
    completedAt: "",
  };
}

function ensurePrivateDirectories() {
  const stateDirectory = onboardingPath();
  const documentDirectory = onboardingDocumentPath();
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(documentDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDirectory, 0o700);
  fs.chmodSync(documentDirectory, 0o700);
}

function atomicJson(filePath, value) {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function agentRequest(state) {
  return {
    schemaVersion: 1,
    instruction: "등록 문서를 사실 근거만으로 분석하고 추측을 추가하지 마세요. 나이·생년월일은 추출하지 마세요. 결과를 /api/onboarding/analysis 계약으로 제출하세요.",
    documents: state.documents.map((item) => ({
      id: item.id,
      kind: item.kind,
      relativePath: item.relativePath,
      sha256: item.sha256,
    })),
    output: {
      facts: [{ id: "fact-1", key: "school", label: "학교", value: "", sourceDocumentId: "", sourceLocator: "", confidence: 0 }],
      evidence: [{ id: "evidence-1", title: "", description: "", metrics: [], skills: [], sourceRefs: [] }],
      sections: [{ id: "section-1", key: "summary", label: "경력 요약", kind: "text", value: "", sourceRefs: [] }],
      suggested: { roles: [], includeKeywords: [], excludeKeywords: [], tracks: [] },
    },
  };
}

function writeState(state) {
  ensurePrivateDirectories();
  atomicJson(onboardingPath(STATE_FILE), state);
  atomicJson(onboardingPath(AGENT_REQUEST_FILE), agentRequest(state));
}

export function readOnboardingState() {
  ensurePrivateDirectories();
  const filePath = onboardingPath(STATE_FILE);
  if (!fs.existsSync(filePath)) {
    const state = defaultState();
    writeState(state);
    return state;
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw onboardingError("초기 설정 상태 파일이 안전한 일반 파일이 아닙니다.", 409);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw onboardingError("초기 설정 상태 파일을 읽을 수 없습니다.", 409);
  }
  if (!isPlainObject(parsed) || parsed.version !== STATE_VERSION) throw onboardingError("초기 설정 상태 버전이 올바르지 않습니다.", 409);
  const defaults = defaultState();
  parsed.profile = { ...defaults.profile, ...(isPlainObject(parsed.profile) ? parsed.profile : {}) };
  parsed.search = { ...defaults.search, ...(isPlainObject(parsed.search) ? parsed.search : {}) };
  parsed.resume = { ...defaults.resume, ...(isPlainObject(parsed.resume) ? parsed.resume : {}) };
  fs.chmodSync(filePath, 0o600);
  return parsed;
}

function publicDocument(item) {
  return {
    id: item.id,
    kind: item.kind,
    originalName: item.originalName,
    extension: item.extension,
    mimeType: item.mimeType,
    size: item.size,
    sha256: item.sha256,
    uploadedAt: item.uploadedAt,
  };
}

export function publicOnboardingState(state = readOnboardingState()) {
  return {
    ...state,
    documents: state.documents.map(publicDocument),
    agentRequestPath: path.relative(PROJECT_ROOT, onboardingPath(AGENT_REQUEST_FILE)),
    limits: {
      resumePdfBytes: MAX_RESUME_PDF_BYTES,
      documentBytes: MAX_DOCUMENT_BYTES,
      totalBytes: MAX_TOTAL_DOCUMENT_BYTES,
    },
    builtinSections: BUILTIN_SECTION_DEFINITIONS,
  };
}

function mergeKnownObject(current, patch, fields) {
  const next = { ...current };
  for (const field of fields) if (Object.hasOwn(patch, field)) next[field] = patch[field];
  return next;
}

export function patchOnboardingState(patch) {
  if (!isPlainObject(patch)) throw onboardingError("초기 설정 변경값은 객체여야 합니다.");
  const state = readOnboardingState();
  if (state.completedAt) throw onboardingError("이미 완료된 초기 설정은 덮어쓸 수 없습니다.", 409);
  if (Object.hasOwn(patch, "currentStep")) {
    const step = Number(patch.currentStep);
    if (!Number.isInteger(step) || step < 1 || step > 11) throw onboardingError("초기 설정 단계는 1부터 11 사이여야 합니다.");
    state.currentStep = step;
  }
  if (Object.hasOwn(patch, "privacyAccepted")) {
    if (typeof patch.privacyAccepted !== "boolean") throw onboardingError("개인정보 안내 확인값이 올바르지 않습니다.");
    state.privacyAccepted = patch.privacyAccepted;
  }
  if (isPlainObject(patch.profile)) state.profile = mergeKnownObject(state.profile, patch.profile, Object.keys(state.profile));
  if (isPlainObject(patch.search)) {
    state.search = mergeKnownObject(state.search, patch.search, Object.keys(state.search));
    if (isPlainObject(patch.search.scoring)) {
      state.search.scoring = mergeKnownObject(state.search.scoring, patch.search.scoring, ["reviewBelow", "dimensions"]);
    }
  }
  if (isPlainObject(patch.sources)) state.sources = mergeKnownObject(state.sources, patch.sources, ["preferDirectCompany", "requireNotClosed", "items"]);
  if (isPlainObject(patch.resume)) state.resume = mergeKnownObject(state.resume, patch.resume, Object.keys(state.resume));
  if (isPlainObject(patch.analysisReview)) {
    for (const type of ["facts", "evidence", "sections"]) {
      if (isPlainObject(patch.analysisReview[type])) state.analysisReview[type] = patch.analysisReview[type];
    }
  }
  writeState(state);
  return publicOnboardingState(state);
}

function safeOriginalName(value) {
  return path.basename(String(value || "document")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240) || "document";
}

function parseUpload(request, maximumBytes) {
  ensurePrivateDirectories();
  const tempPath = onboardingPath("uploads", `${crypto.randomUUID()}.upload`);
  fs.mkdirSync(path.dirname(tempPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(tempPath), 0o700);
  return new Promise((resolve, reject) => {
    let fileInfo = null;
    let bytes = 0;
    let filePromise = null;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { fs.rmSync(tempPath, { force: true }); } catch {}
      reject(error?.statusCode ? error : onboardingError(error?.message || "문서 등록에 실패했습니다."));
    };
    let parser;
    try {
      parser = Busboy({ headers: request.headers, limits: { files: 1, fields: 0, parts: 1, fileSize: maximumBytes } });
    } catch (error) {
      fail(onboardingError("multipart/form-data 요청을 읽을 수 없습니다."));
      return;
    }
    parser.on("file", (_field, file, info) => {
      if (fileInfo) {
        file.resume();
        fail(onboardingError("문서는 한 번에 하나만 등록할 수 있습니다."));
        return;
      }
      fileInfo = { originalName: safeOriginalName(info.filename), mimeType: cleanText(info.mimeType, 160) };
      const output = fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
      file.on("data", (chunk) => { bytes += chunk.length; });
      file.on("limit", () => fail(onboardingError("문서 용량 제한을 초과했습니다.", 413)));
      file.on("error", fail);
      output.on("error", fail);
      file.pipe(output);
      filePromise = new Promise((finish, error) => output.on("finish", finish).on("error", error));
    });
    parser.on("filesLimit", () => fail(onboardingError("문서는 한 번에 하나만 등록할 수 있습니다.")));
    parser.on("error", fail);
    parser.on("finish", async () => {
      if (settled) return;
      try {
        await filePromise;
        if (!fileInfo || !bytes) throw onboardingError("등록할 문서가 없습니다.");
        fs.chmodSync(tempPath, 0o600);
        settled = true;
        resolve({ tempPath, bytes, ...fileInfo });
      } catch (error) {
        fail(error);
      }
    });
    request.on("aborted", () => fail(onboardingError("문서 등록 요청이 중단되었습니다.")));
    request.pipe(parser);
  });
}

function validatePdf(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(5);
    fs.readSync(descriptor, buffer, 0, 5, 0);
    if (buffer.toString("ascii") !== "%PDF-") throw onboardingError("PDF 파일 시그니처가 올바르지 않습니다.");
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateDocx(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true }, (openError, archive) => {
      if (openError) {
        reject(onboardingError("DOCX ZIP 구조가 올바르지 않습니다."));
        return;
      }
      let total = 0;
      let entries = 0;
      let contentTypes = false;
      let documentXml = false;
      const names = new Set();
      const compressedBytes = Math.max(1, fs.statSync(filePath).size);
      const fail = (message) => {
        try { archive.close(); } catch {}
        reject(onboardingError(message));
      };
      archive.on("error", () => fail("DOCX ZIP 구조를 안전하게 확인할 수 없습니다."));
      archive.on("entry", (entry) => {
        entries += 1;
        if (entries > MAX_DOCX_ENTRIES) return fail("DOCX 내부 파일 수가 허용 범위를 초과했습니다.");
        const name = String(entry.fileName || "").replaceAll("\\", "/");
        if (name.startsWith("/") || name.split("/").includes("..")) return fail("DOCX 내부 경로가 안전하지 않습니다.");
        if (names.has(name)) return fail("DOCX 내부에 중복된 파일 경로가 있습니다.");
        names.add(name);
        if (entry.generalPurposeBitFlag & 0x1) return fail("암호화된 DOCX 파일은 등록할 수 없습니다.");
        const unixMode = Number(entry.externalFileAttributes >>> 16);
        if ((unixMode & 0o170000) === 0o120000) return fail("DOCX 내부 심볼릭 링크는 허용하지 않습니다.");
        total += Number(entry.uncompressedSize || 0);
        if (total > MAX_DOCX_UNCOMPRESSED_BYTES) return fail("DOCX 압축 해제 크기가 허용 범위를 초과했습니다.");
        if (total / compressedBytes > MAX_DOCX_COMPRESSION_RATIO) return fail("DOCX 압축 비율이 안전 범위를 초과했습니다.");
        if (name === "[Content_Types].xml") contentTypes = true;
        if (name === "word/document.xml") documentXml = true;
        archive.readEntry();
      });
      archive.on("end", () => {
        if (!contentTypes || !documentXml) return fail("Word 문서에 필요한 DOCX 항목이 없습니다.");
        resolve();
      });
      archive.readEntry();
    });
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

export async function uploadOnboardingDocument(request, kind) {
  const parsed = await receiveValidatedDocumentUpload(request, kind);
  let installedDirectory = "";
  let previousState = null;
  let statePersisted = false;
  try {
    const state = readOnboardingState();
    previousState = structuredClone(state);
    if (state.completedAt) throw onboardingError("완료된 초기 설정에는 문서를 추가할 수 없습니다.", 409);
    const previous = state.documents.find((item) => item.kind === kind);
    const otherBytes = state.documents.filter((item) => item.id !== previous?.id).reduce((sum, item) => sum + Number(item.size || 0), 0);
    if (otherBytes + parsed.bytes > MAX_TOTAL_DOCUMENT_BYTES) throw onboardingError("등록 문서 전체 용량 제한을 초과했습니다.", 413);

    const id = crypto.randomUUID();
    installedDirectory = onboardingDocumentPath(id);
    fs.mkdirSync(installedDirectory, { recursive: false, mode: 0o700 });
    fs.chmodSync(installedDirectory, 0o700);
    const target = onboardingDocumentPath(id, `source${parsed.extension}`);
    fs.renameSync(parsed.tempPath, target);
    fs.chmodSync(target, 0o600);
    const metadata = {
      id,
      kind,
      originalName: parsed.originalName,
      extension: parsed.extension,
      mimeType: parsed.mimeType,
      size: parsed.bytes,
      sha256: parsed.sha256,
      relativePath: path.relative(PROJECT_ROOT, target),
      uploadedAt: new Date().toISOString(),
    };
    state.documents = [...state.documents.filter((item) => item.kind !== kind), metadata];
    state.analysis = { status: "waiting", facts: [], evidence: [], sections: [], suggested: {} };
    state.analysisReview = { facts: {}, evidence: {}, sections: {} };
    try {
      writeState(state);
      statePersisted = true;
    } catch (error) {
      // writeState updates two owner-only files. If the second write fails after
      // state.json changed, restore the prior state before deleting the new file.
      try { atomicJson(onboardingPath(STATE_FILE), previousState); } catch {}
      throw error;
    }
    if (previous) fs.rmSync(onboardingDocumentPath(previous.id), { recursive: true, force: true });
    return publicOnboardingState(state);
  } catch (error) {
    try { fs.rmSync(parsed.tempPath, { force: true }); } catch {}
    if (!statePersisted && installedDirectory) {
      try { fs.rmSync(installedDirectory, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
}

export async function receiveValidatedDocumentUpload(request, kind) {
  if (!new Set(["resume", "portfolio"]).has(kind)) throw onboardingError("문서 종류는 resume 또는 portfolio여야 합니다.");
  const parsed = await parseUpload(request, MAX_DOCUMENT_BYTES);
  try {
    const extension = path.extname(parsed.originalName).toLowerCase();
    const expectedMime = extension === ".pdf"
      ? "application/pdf"
      : extension === ".docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "";
    if (!expectedMime) throw onboardingError("PDF 또는 DOCX 파일만 등록할 수 있습니다.");
    if (parsed.mimeType !== expectedMime) throw onboardingError("파일 확장자와 MIME 형식이 일치하지 않습니다.");
    if (kind === "resume" && extension === ".pdf" && parsed.bytes > MAX_RESUME_PDF_BYTES) {
      throw onboardingError("이력서 PDF 용량 제한을 초과했습니다.", 413);
    }
    if (extension === ".pdf") validatePdf(parsed.tempPath);
    else await validateDocx(parsed.tempPath);
    return { ...parsed, extension, sha256: sha256File(parsed.tempPath), maximumTotalBytes: MAX_TOTAL_DOCUMENT_BYTES };
  } catch (error) {
    try { fs.rmSync(parsed.tempPath, { force: true }); } catch {}
    throw error;
  }
}

export function deleteOnboardingDocument(id) {
  const normalizedId = cleanText(id, 80);
  const state = readOnboardingState();
  const document = state.documents.find((item) => item.id === normalizedId);
  if (!document) throw onboardingError("등록 문서를 찾을 수 없습니다.", 404);
  state.documents = state.documents.filter((item) => item.id !== normalizedId);
  state.analysis = { status: "waiting", facts: [], evidence: [], sections: [], suggested: {} };
  state.analysisReview = { facts: {}, evidence: {}, sections: {} };
  writeState(state);
  fs.rmSync(onboardingDocumentPath(document.id), { recursive: true, force: true });
  return publicOnboardingState(state);
}

function validateSourceDocumentId(value, knownDocuments, field) {
  const id = cleanText(value, 80);
  if (!knownDocuments.has(id)) throw onboardingError(`${field}의 출처 문서를 찾을 수 없습니다.`);
  return id;
}

function sourceRefs(value, knownDocuments, field, { required = false, requireLocator = false } = {}) {
  if (value === null || value === undefined) {
    if (required) throw onboardingError(`${field}에는 등록 문서의 출처가 하나 이상 필요합니다.`);
    return [];
  }
  if (!Array.isArray(value)) throw onboardingError(`${field}는 목록이어야 합니다.`);
  const normalized = value.slice(0, 30).map((reference, index) => {
    if (!isPlainObject(reference)) throw onboardingError(`${field}[${index}] 형식이 올바르지 않습니다.`);
    const locator = cleanText(reference.locator || reference.sourceLocator, 300);
    if (requireLocator && !locator) throw onboardingError(`${field}[${index}]의 원본 위치가 필요합니다.`);
    return {
      documentId: validateSourceDocumentId(reference.documentId || reference.sourceDocumentId, knownDocuments, `${field}[${index}]`),
      locator,
    };
  });
  if (required && !normalized.length) throw onboardingError(`${field}에는 등록 문서의 출처가 하나 이상 필요합니다.`);
  return normalized;
}

export function putOnboardingAnalysis(input) {
  if (!isPlainObject(input)) throw onboardingError("문서 분석 결과는 객체여야 합니다.");
  const state = readOnboardingState();
  const knownDocuments = new Set(state.documents.map((item) => item.id));
  if (!state.documents.some((item) => item.kind === "resume")) throw onboardingError("이력서를 먼저 등록해 주세요.", 409);
  const ids = new Set();
  const uniqueId = (value, prefix, index) => {
    const id = cleanText(value, 80) || `${prefix}-${index + 1}`;
    if (ids.has(id)) throw onboardingError(`분석 항목 ID가 중복됩니다: ${id}`);
    ids.add(id);
    return id;
  };
  const facts = (Array.isArray(input.facts) ? input.facts : []).slice(0, 100).map((fact, index) => {
    if (!isPlainObject(fact)) throw onboardingError(`facts[${index}] 형식이 올바르지 않습니다.`);
    const value = cleanText(fact.value, 4000);
    if (!value) return null;
    const confidence = Number(fact.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw onboardingError(`facts[${index}].confidence는 0~100이어야 합니다.`);
    const key = cleanText(fact.key, 100) || `fact-${index + 1}`;
    const label = cleanText(fact.label, 200) || key || `사실 ${index + 1}`;
    if (isAgeFactKey(key) || isAgeFactKey(label)) throw onboardingError("나이·생년월일은 분석하거나 저장할 수 없습니다.");
    assertNoPersonalAgeData(value, `facts[${index}].value`);
    const sourceLocator = cleanText(fact.sourceLocator, 300);
    if (value && !sourceLocator) throw onboardingError(`facts[${index}].sourceLocator의 원본 위치가 필요합니다.`);
    return {
      id: uniqueId(fact.id, "fact", index),
      key,
      label,
      value,
      sourceDocumentId: validateSourceDocumentId(fact.sourceDocumentId, knownDocuments, `facts[${index}]`),
      sourceLocator,
      confidence,
    };
  }).filter(Boolean);
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).slice(0, 100).map((item, index) => {
    if (!isPlainObject(item)) throw onboardingError(`evidence[${index}] 형식이 올바르지 않습니다.`);
    const description = cleanText(item.description, 6000);
    const metrics = cleanList(item.metrics || [], 30, 300);
    const skills = cleanList(item.skills || [], 50, 200);
    if (!description && !metrics.length && !skills.length) return null;
    const normalized = {
      id: uniqueId(item.id, "evidence", index),
      title: cleanText(item.title, 240) || `근거 ${index + 1}`,
      description,
      metrics,
      skills,
      sourceRefs: sourceRefs(item.sourceRefs || [], knownDocuments, `evidence[${index}].sourceRefs`, { required: true, requireLocator: true }),
    };
    if (isAgeFactKey(normalized.title)) throw onboardingError("나이·생년월일은 분석하거나 저장할 수 없습니다.");
    assertNoPersonalAgeData(normalized, `evidence[${index}]`);
    return normalized;
  }).filter(Boolean);
  const seenSections = new Set();
  const sections = (Array.isArray(input.sections) ? input.sections : []).slice(0, 50).map((section, index) => {
    if (!isPlainObject(section)) throw onboardingError(`sections[${index}] 형식이 올바르지 않습니다.`);
    const suppliedKey = cleanText(section.key, 100);
    const suppliedLabel = cleanText(section.label, 200);
    const key = canonicalSectionKey(suppliedKey, suppliedLabel, `section-${index + 1}`);
    const kind = section.kind === "list" ? "list" : section.kind === "text" ? "text" : "";
    if (!kind) throw onboardingError(`sections[${index}].kind는 text 또는 list여야 합니다.`);
    const expectedKind = builtinSectionKind(key);
    if (expectedKind && kind !== expectedKind) {
      throw onboardingError(`기본 이력서 항목 ${key}의 kind는 ${expectedKind}여야 합니다.`);
    }
    const value = kind === "list" ? cleanList(section.value || [], 50, 1000) : cleanText(section.value, 8000);
    if (!(Array.isArray(value) ? value.length : value)) return null;
    if (seenSections.has(key)) throw onboardingError(`같은 의미의 이력서 항목이 중복됩니다: ${key}`);
    seenSections.add(key);
    const normalized = {
      id: uniqueId(section.id, "section", index),
      key,
      label: suppliedLabel || BUILTIN_SECTION_DEFINITIONS[key]?.label || key.replace(/^custom:/, ""),
      kind,
      value,
      sourceRefs: sourceRefs(section.sourceRefs || [], knownDocuments, `sections[${index}].sourceRefs`, { required: true, requireLocator: true }),
    };
    if (isAgeFactKey(suppliedKey) || isAgeFactKey(normalized.label)) throw onboardingError("나이·생년월일은 분석하거나 저장할 수 없습니다.");
    assertNoPersonalAgeData(normalized, `sections[${index}]`);
    return normalized;
  }).filter(Boolean);
  const suggested = isPlainObject(input.suggested) ? {
    roles: cleanList(input.suggested.roles || [], 20, 160),
    includeKeywords: cleanList(input.suggested.includeKeywords || [], 50, 120),
    excludeKeywords: cleanList(input.suggested.excludeKeywords || [], 50, 120),
    tracks: cleanList(input.suggested.tracks || [], 20, 160),
  } : {};
  state.analysis = { status: "ready", facts, evidence, sections, suggested, receivedAt: new Date().toISOString() };
  state.analysisReview = {
    facts: Object.fromEntries(facts.map((item) => [item.id, { decision: "pending", value: item.value }])),
    evidence: Object.fromEntries(evidence.map((item) => [item.id, { decision: "pending", description: item.description }])),
    sections: Object.fromEntries(sections.map((item) => [item.id, { decision: "pending", value: item.value }])),
  };
  writeState(state);
  return publicOnboardingState(state);
}

function assertAnalysisReviewed(state) {
  for (const type of ["facts", "evidence", "sections"]) {
    for (const item of state.analysis[type] || []) {
      const decision = state.analysisReview[type]?.[item.id]?.decision;
      if (!REVIEW_DECISIONS.has(decision)) {
        throw onboardingError("모든 분석 항목을 사용·수정·제외 중 하나로 확인해 주세요.");
      }
    }
  }
}

function acceptedAnalysis(state) {
  assertAnalysisReviewed(state);
  const facts = state.analysis.facts.flatMap((item) => {
    const review = state.analysisReview.facts[item.id] || {};
    if (review.decision === "exclude") return [];
    const value = cleanText(review.decision === "edit" ? review.value : item.value, 4000);
    if (review.decision === "edit" && !value) throw onboardingError("수정 후 사용할 사실 값은 비어 있을 수 없습니다.");
    assertNoPersonalAgeData(value, `facts.${item.id}.value`);
    return value ? [{ ...item, value }] : [];
  });
  const evidence = state.analysis.evidence.flatMap((item) => {
    const review = state.analysisReview.evidence[item.id] || {};
    if (review.decision === "exclude") return [];
    const description = cleanText(review.decision === "edit" ? review.description : item.description, 6000);
    if (review.decision === "edit" && !description && !item.metrics.length && !item.skills.length) {
      throw onboardingError("수정 후 사용할 근거 내용은 비어 있을 수 없습니다.");
    }
    assertNoPersonalAgeData({ ...item, description }, `evidence.${item.id}`);
    return description || item.metrics.length || item.skills.length ? [{ ...item, description }] : [];
  });
  const sections = state.analysis.sections.flatMap((item) => {
    const review = state.analysisReview.sections[item.id] || {};
    if (review.decision === "exclude") return [];
    const selectedValue = review.decision === "edit" ? review.value : item.value;
    const value = item.kind === "list" ? cleanList(selectedValue, 50, 1000) : cleanText(selectedValue, 8000);
    if (review.decision === "edit" && !(Array.isArray(value) ? value.length : value)) {
      throw onboardingError("수정 후 사용할 이력서 항목은 비어 있을 수 없습니다.");
    }
    assertNoPersonalAgeData({ ...item, value }, `sections.${item.id}`);
    return Array.isArray(value) ? value.length ? [{ ...item, value }] : [] : value ? [{ ...item, value }] : [];
  });
  return { facts, evidence, sections };
}

function normalizedScoring(search) {
  const supplied = Array.isArray(search.scoring?.dimensions) ? search.scoring.dimensions : [];
  const known = new Map(SCORING_DIMENSIONS.map((item) => [item.id, item]));
  const dimensions = supplied.map((item) => {
    if (!isPlainObject(item) || !known.has(item.id)) throw onboardingError("알 수 없는 공고 평가축이 포함되어 있습니다.");
    const weight = Number(item.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) throw onboardingError("공고 평가축 가중치는 0~100이어야 합니다.");
    return { id: item.id, label: known.get(item.id).label, enabled: item.enabled !== false, weight };
  });
  const enabled = dimensions.filter((item) => item.enabled);
  if (enabled.length) {
    const total = enabled.reduce((sum, item) => sum + item.weight, 0);
    if (Math.abs(total - 100) > 0.0001) throw onboardingError("활성화된 공고 평가축 가중치 합계는 100이어야 합니다.");
  }
  const reviewBelow = Number(search.scoring?.reviewBelow ?? 70);
  if (!Number.isFinite(reviewBelow) || reviewBelow < 0 || reviewBelow > 100) throw onboardingError("검토 필요 점수는 0~100이어야 합니다.");
  return { review_below: reviewBelow, dimensions };
}

function normalizeSources(state) {
  if (!isPlainObject(state.sources.items)) throw onboardingError("플랫폼 설정이 올바르지 않습니다.");
  const result = {};
  for (const [key, item] of Object.entries(state.sources.items)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,59}$/i.test(key) || !isPlainObject(item)) throw onboardingError("플랫폼 키 또는 설정이 올바르지 않습니다.");
    const priority = Number(item.priority);
    if (!Number.isFinite(priority)) throw onboardingError("플랫폼 우선순위는 숫자여야 합니다.");
    result[key] = {
      label: cleanText(item.label, 100) || key,
      collect: item.collect === true,
      display: item.display !== false,
      lifecycle_check: item.lifecycleCheck !== false,
      priority,
    };
  }
  if (!Object.values(result).some((item) => item.collect)) throw onboardingError("수집할 채용 플랫폼을 하나 이상 선택해 주세요.");
  return result;
}

function factValue(facts, keys) {
  const lowered = new Set(keys.map((item) => item.toLowerCase()));
  return facts.find((item) => lowered.has(String(item.key || "").toLowerCase()))?.value || "";
}

function resumeInput(state, accepted) {
  const sectionMap = new Map(accepted.sections.filter((item) => Object.hasOwn(BUILTIN_SECTION_DEFINITIONS, item.key)).map((item) => [item.key, item]));
  const listValue = (key) => sectionMap.get(key)?.kind === "list" ? sectionMap.get(key).value : [];
  const textValue = (key) => {
    const item = sectionMap.get(key);
    return item?.kind === "list" ? item.value.join("\n") : item?.value || "";
  };
  const stage = cleanText(state.profile.careerStage, 40);
  return {
    jobFamily: factValue(accepted.facts, ["job_family", "jobfamily"]),
    jobRole: cleanText(state.search.primaryRole, 160),
    careerType: stage === "entry" ? "new" : "experienced",
    yearsExperience: state.profile.yearsExperience,
    school: factValue(accepted.facts, ["school", "education_school"]),
    major: factValue(accepted.facts, ["major", "education_major"]),
    headline: textValue("headline"),
    summary: textValue("summary"),
    skills: listValue("skills"),
    certificates: cleanList(factValue(accepted.facts, ["certificates", "certificate"]).split(/[\n,]/), 30, 240),
    experienceHighlights: listValue("experience_highlights"),
    achievementEvidence: textValue("achievement_evidence"),
    representativeExperience: textValue("representative_experience"),
    directScope: textValue("direct_scope"),
    collaborationScope: textValue("collaboration_scope"),
    careerDirection: textValue("career_direction"),
    editableSections: cleanList(state.resume.editableSections || [], 20, 100).filter((key) => Object.hasOwn(BUILTIN_SECTION_DEFINITIONS, key)),
  };
}

function buildConfigs(state) {
  const targetRoles = [cleanText(state.search.primaryRole, 160), ...cleanList(state.search.secondaryRoles || [], 10, 160)].filter(Boolean);
  if (!targetRoles.length) throw onboardingError("주 목표 직무를 입력해 주세요.");
  const sources = normalizeSources(state);
  const scoring = normalizedScoring(state.search);
  const profile = loadExampleConfig("profile");
  profile.setup_complete = true;
  profile.identity.display_name = cleanText(state.profile.displayName, 160);
  if (!profile.identity.display_name) throw onboardingError("화면에 표시할 이름을 입력해 주세요.");
  profile.identity.email = cleanText(state.profile.email, 320);
  profile.identity.phone = cleanText(state.profile.phone, 120);
  profile.identity.address = cleanText(state.profile.address, 500);
  profile.identity.pdf_fields = {
    email: state.profile.includeEmailInPdf === true,
    phone: state.profile.includePhoneInPdf === true,
    address: state.profile.includeAddressInPdf === true,
  };
  profile.location.country = cleanText(state.profile.country, 20) || "KR";
  profile.location.regions = cleanList(state.search.regions || [], 30, 160);
  profile.location.timezone = cleanText(state.profile.timezone, 80) || "Asia/Seoul";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: profile.location.timezone }).format(new Date(0));
  } catch {
    throw onboardingError("시간대는 Asia/Seoul 또는 America/New_York 같은 IANA 형식이어야 합니다.");
  }
  const careerStage = cleanText(state.profile.careerStage, 40);
  if (!CAREER_STAGES.has(careerStage)) throw onboardingError("경력 단계는 신입·경력·직무전환·경력복귀 중 하나여야 합니다.");
  const numericOrNull = (value, label, { maximum = Number.MAX_SAFE_INTEGER } = {}) => {
    if (value === null || value === "" || value === undefined) return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > maximum) throw onboardingError(`${label} 입력값이 올바르지 않습니다.`);
    return number;
  };
  profile.career.years_experience = numericOrNull(state.profile.yearsExperience, "총 경력 연수", { maximum: 80 });
  profile.career.current_level = careerStage;
  profile.preferences.employment_types = cleanList(state.profile.employmentTypes || [], 20, 80);
  profile.preferences.work_modes = cleanList(state.profile.workModes || [], 20, 80);
  profile.preferences.salary.currency = cleanText(state.profile.currency, 20) || "KRW";
  profile.preferences.salary.minimum = numericOrNull(state.profile.salaryMinimum, "희망 연봉 최소");
  profile.preferences.salary.target = numericOrNull(state.profile.salaryTarget, "희망 연봉 목표");
  if (profile.preferences.salary.minimum !== null && profile.preferences.salary.target !== null
      && profile.preferences.salary.minimum > profile.preferences.salary.target) {
    throw onboardingError("희망 연봉 목표는 희망 연봉 최소보다 작을 수 없습니다.");
  }

  const search = loadExampleConfig("search");
  search.setup_complete = true;
  search.target_roles = targetRoles;
  search.include_keywords = cleanList(state.search.includeKeywords || [], 100, 120);
  search.exclude_keywords = cleanList(state.search.excludeKeywords || [], 100, 120);
  search.experience.minimum_years = numericOrNull(state.search.experienceMinimum, "지원 경력 최소", { maximum: 80 });
  search.experience.maximum_years = numericOrNull(state.search.experienceMaximum, "지원 경력 최대", { maximum: 80 });
  if (search.experience.minimum_years !== null && search.experience.maximum_years !== null
      && search.experience.minimum_years > search.experience.maximum_years) {
    throw onboardingError("지원 경력 최대는 최소보다 작을 수 없습니다.");
  }
  const trackLabels = cleanList(state.search.tracks || [], 20, 160);
  search.target_tracks = (trackLabels.length ? trackLabels : targetRoles).map((label, index) => ({ id: `track-${index + 1}`, label, priority: index + 1 }));
  search.company_preferences.include = cleanList(state.search.preferredCompanies || [], 50, 200);
  search.company_preferences.exclude = cleanList(state.search.excludedCompanies || [], 50, 200);
  search.industry_preferences = {
    include: cleanList(state.search.preferredIndustries || [], 50, 160),
    exclude: cleanList(state.search.excludedIndustries || [], 50, 160),
  };
  search.work_preferences = {
    desired: cleanList(state.search.desiredWork || [], 50, 300),
    avoided: cleanList(state.search.avoidedWork || [], 50, 300),
  };
  search.scoring = scoring;

  const sourceConfig = loadExampleConfig("sources");
  sourceConfig.setup_complete = true;
  sourceConfig.primary_selection.prefer_direct_company = state.sources.preferDirectCompany !== false;
  sourceConfig.primary_selection.require_not_closed = state.sources.requireNotClosed !== false;
  sourceConfig.sources = sources;

  const resume = loadExampleConfig("resume");
  resume.setup_complete = true;
  resume.quality_rules.minimum_score = Number(state.resume.minimumScore ?? 80);
  resume.quality_rules.maximum_pdf_pages = Number(state.resume.maximumPdfPages ?? 3);
  resume.quality_rules.criteria = Array.isArray(state.resume.qualityCriteria)
    ? state.resume.qualityCriteria
    : defaultDocumentQualityCriteria();

  const configs = { profile, search, sources: sourceConfig, resume };
  for (const [name, value] of Object.entries(configs)) {
    const validation = validateConfig(name, value);
    if (!validation.valid) throw onboardingError(`설정 검증 실패: ${validation.issues.join("; ")}`);
  }
  return configs;
}

function installConfigs(configs) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  assertConfigDirectory();
  fs.chmodSync(CONFIG_DIR, 0o700);
  const existing = Object.keys(configs).filter((name) => configEntryExists(configPath(name)));
  if (existing.length) throw onboardingError(`기존 로컬 설정을 자동으로 덮어쓸 수 없습니다: ${existing.join(", ")}`, 409);
  const temporary = [];
  const installed = [];
  try {
    for (const [name, value] of Object.entries(configs)) {
      const temp = `${configPath(name)}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temp, yaml.dump(value, { lineWidth: 100, noRefs: true }), { mode: 0o600 });
      fs.chmodSync(temp, 0o600);
      temporary.push({ name, temp });
    }
    for (const item of temporary) {
      fs.renameSync(item.temp, configPath(item.name));
      fs.chmodSync(configPath(item.name), 0o600);
      installed.push(item.name);
    }
  } catch (error) {
    for (const item of temporary) try { fs.rmSync(item.temp, { force: true }); } catch {}
    for (const name of installed) try { fs.rmSync(configPath(name), { force: true }); } catch {}
    throw error;
  }
  return installed;
}

export function scoringProfileFromConfig(searchConfig) {
  const dimensions = Array.isArray(searchConfig?.scoring?.dimensions)
    ? searchConfig.scoring.dimensions.filter((item) => item?.enabled !== false).map((item) => ({
      id: cleanText(item.id, 100),
      label: cleanText(item.label, 160),
      weight: Number(item.weight),
    }))
    : [];
  const profile = { version: 1, dimensions };
  return {
    ...profile,
    checksum: crypto.createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
    configured: dimensions.length > 0,
  };
}

function assertRegisteredDocuments(state) {
  for (const item of state.documents) {
    if (!new Set(["resume", "portfolio"]).has(item.kind)) throw onboardingError("등록 문서 종류가 올바르지 않습니다.", 409);
    if (!/^[0-9a-f-]{36}$/i.test(String(item.id || ""))) throw onboardingError("등록 문서 ID가 올바르지 않습니다.", 409);
    const extension = item.extension === ".pdf" ? ".pdf" : item.extension === ".docx" ? ".docx" : "";
    if (!extension) throw onboardingError("등록 문서 형식이 올바르지 않습니다.", 409);
    const candidate = onboardingDocumentPath(item.id, `source${extension}`);
    const expectedRelative = path.relative(PROJECT_ROOT, candidate);
    if (item.relativePath !== expectedRelative) throw onboardingError("등록 문서 경로가 변경되었습니다.", 409);
    let stat;
    try { stat = fs.lstatSync(candidate); } catch { throw onboardingError("등록 문서 파일을 찾을 수 없습니다.", 409); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw onboardingError("등록 문서는 안전한 일반 파일이어야 합니다.", 409);
    if (stat.size !== Number(item.size) || sha256File(candidate) !== item.sha256) {
      throw onboardingError("등록 문서 파일이 등록 이후 변경되었습니다.", 409);
    }
  }
}

export function completeOnboarding() {
  const state = readOnboardingState();
  if (state.completedAt) throw onboardingError("초기 설정이 이미 완료되었습니다.", 409);
  if (!state.privacyAccepted) throw onboardingError("개인정보 저장 안내를 먼저 확인해 주세요.");
  if (!state.documents.some((item) => item.kind === "resume")) throw onboardingError("이력서를 등록해 주세요.");
  assertRegisteredDocuments(state);
  if (state.analysis.status !== "ready") throw onboardingError("Codex·Claude 문서 분석 결과를 먼저 등록해 주세요.");
  const accepted = acceptedAnalysis(state);
  if (!accepted.sections.length && !accepted.facts.length && !accepted.evidence.length) {
    throw onboardingError("사용하기로 확인한 문서 분석 항목이 없습니다.");
  }
  const configs = buildConfigs(state);
  const dbPath = databasePath("personal");
  if (fs.existsSync(dbPath)) throw onboardingError("기존 개인 DB를 자동으로 덮어쓸 수 없습니다.", 409);
  let installedConfigs = [];
  try {
    installedConfigs = installConfigs(configs);
    initializeDatabase(dbPath, { mode: "personal" });
    const db = openDatabase(dbPath);
    try {
      saveResume(db, resumeInput(state, accepted));
      const customSections = accepted.sections.filter((item) => item.key.startsWith("custom:")).map((item, index) => ({
        id: item.id,
        key: item.key,
        label: item.label,
        kind: item.kind,
        value: item.value,
        displayOrder: index + 1,
        editable: state.resume.customPermissions?.[item.id] !== false,
        sourceRefs: item.sourceRefs,
      }));
      saveOnboardingProfileData(db, {
        careerStage: cleanText(state.profile.careerStage, 40),
        documents: state.documents,
        facts: accepted.facts.map((item) => ({ ...item, protected: isProtectedFactKey(item.key) })),
        evidence: accepted.evidence,
        customSections,
      });
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('onboarding_status', 'complete') ON CONFLICT(key) DO UPDATE SET value = 'complete', updated_at = CURRENT_TIMESTAMP").run();
    } finally {
      db.close();
    }
    state.completedAt = new Date().toISOString();
    state.currentStep = 11;
    writeState(state);
    return { dbPath, configs, state: publicOnboardingState(state) };
  } catch (error) {
    for (const suffix of ["", "-wal", "-shm"]) try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
    for (const name of installedConfigs) try { fs.rmSync(configPath(name), { force: true }); } catch {}
    throw error;
  }
}
