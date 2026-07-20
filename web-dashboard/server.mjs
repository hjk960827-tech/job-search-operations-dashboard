import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configStatus, loadConfig, loadExampleConfig } from "../lib/config.mjs";
import {
  databaseRevisions,
  getJobDetail,
  getResume,
  importJob,
  initializeDatabase,
  listJobPage,
  listJobs,
  openDatabase,
  publicJobSummary,
  saveResume,
  updateApplicationState,
} from "../lib/database.mjs";
import {
  completeOnboarding,
  deleteOnboardingDocument,
  patchOnboardingState,
  publicOnboardingState,
  putOnboardingAnalysis,
  readOnboardingState,
  scoringProfileFromConfig,
  uploadOnboardingDocument,
} from "../lib/onboarding.mjs";
import { databasePath, runtimeMode } from "../lib/paths.mjs";
import {
  assertRuntimeSetup,
  protectLocalRequest,
  readJsonBody,
  runtimeHost,
  runtimePort,
} from "../lib/runtime.mjs";
import {
  approvePackage,
  createPackage,
  prepareSubmission,
  publicPackage,
  recordSubmitted,
  updatePackage,
} from "../lib/package-workflow.mjs";
import { buildWorkflowOverview } from "../lib/workflow.mjs";
import {
  buildUiContract,
  UI_CONTRACT_ID,
  UI_CONTRACT_SCHEMA_VERSION,
} from "../lib/ui-contract.mjs";
import {
  saveStructuredResumeItems,
  updateResumeAsset,
} from "../lib/structured-records.mjs";
import {
  cancelCompanionTask,
  claimNextCompanionTask,
  completeCompanionTask,
  createCompanionTask,
  failCompanionTask,
  heartbeatCompanionTask,
  listCompanionTasks,
  retryCompanionTask,
} from "../lib/companion-queue.mjs";
import {
  applyCompanionResultReview,
  getCompanionResultReview,
  patchCompanionResultReview,
  prepareCompanionResultReview,
  rejectCompanionResultReview,
  supersedeStaleCompanionResults,
} from "../lib/companion-results.mjs";
import {
  archivePersonalDocument,
  getPersonalSettings,
  savePersonalSettings,
  uploadPersonalDocument,
} from "../lib/personal-settings.mjs";
import {
  collectionAdapterContract,
  getCollectionRun,
  publishCollectionRun,
  stageCollectionBatch,
} from "../lib/collection-pipeline.mjs";
import {
  appendApplicationEvent,
  appendApplicationEventCorrection,
  createFollowUp,
  listPendingFollowUps,
  listJobOutcomes,
  listLocalNotifications,
  markNotificationRead,
  outcomeEventTypes,
  transitionFollowUp,
} from "../lib/outcome-ledger.mjs";
import { deleteSavedFilter, listSavedFilters, saveFilter } from "../lib/saved-filters.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(here, "public");
const realPublicRoot = fs.realpathSync(publicRoot);
const requestedMode = runtimeMode();
const host = runtimeHost();
const port = runtimePort();
const runtimeEnvironment = Object.freeze({ codespaces: String(process.env.CODESPACES || "").toLowerCase() === "true" });

function createRuntime(mode) {
  const setup = configStatus();
  const effectiveMode = assertRuntimeSetup(mode, setup.complete);
  if (effectiveMode === "onboarding") {
    return {
      mode: "onboarding",
      setup,
      onboardingRequired: true,
      db: null,
      dbPath: null,
      sourcesConfig: loadExampleConfig("sources"),
      resumeConfig: loadExampleConfig("resume"),
      searchConfig: loadExampleConfig("search"),
      profileConfig: null,
    };
  }
  const dbPath = databasePath(effectiveMode);
  initializeDatabase(dbPath, { mode: effectiveMode });
  const config = (name) => effectiveMode === "demo" ? loadExampleConfig(name) : loadConfig(name);
  return {
    mode: effectiveMode,
    setup,
    onboardingRequired: !setup.complete,
    db: openDatabase(dbPath),
    dbPath,
    sourcesConfig: config("sources"),
    resumeConfig: config("resume"),
    searchConfig: config("search"),
    profileConfig: effectiveMode === "personal" ? loadConfig("profile") : null,
  };
}

let runtime = createRuntime(requestedMode);
if (requestedMode === "onboarding" && runtime.setup.complete && readOnboardingState().completedAt) {
  runtime = createRuntime("personal");
}

function activatePersonalRuntime() {
  try { runtime.db?.close(); } catch {}
  runtime = createRuntime("personal");
}

function reloadPersonalConfiguration() {
  runtime.setup = configStatus();
  runtime.sourcesConfig = loadConfig("sources");
  runtime.resumeConfig = loadConfig("resume");
  runtime.searchConfig = loadConfig("search");
  runtime.profileConfig = loadConfig("profile");
}

function packageQualityOptions() {
  const rules = runtime.resumeConfig?.quality_rules || {};
  const threshold = Number(rules.minimum_score ?? 80);
  const maximumPages = Number(rules.maximum_pdf_pages ?? 3);
  return {
    threshold: Number.isFinite(threshold) ? Math.max(0, Math.min(100, threshold)) : 80,
    maximumPages: Number.isInteger(maximumPages) ? Math.max(1, Math.min(10, maximumPages)) : 3,
    qualityCriteria: Array.isArray(rules.criteria) ? rules.criteria : undefined,
    contact: selectedPdfContact(),
    timeZone: runtime.profileConfig?.location?.timezone || "Asia/Seoul",
  };
}

function selectedPdfContact() {
  if (runtime.mode !== "personal") return [];
  const identity = runtime.profileConfig?.identity || {};
  const selected = identity.pdf_fields || {};
  return [
    ["email", "이메일", identity.email],
    ["phone", "전화번호", identity.phone],
    ["address", "주소", identity.address],
  ].filter(([key, , value]) => selected[key] === true && String(value || "").trim())
    .map(([key, label, value]) => ({ key, label, value: String(value).trim() }));
}

function requireDatabase() {
  if (!runtime.db) throw Object.assign(new Error("초기 설정을 완료한 뒤 사용할 수 있습니다."), { statusCode: 409 });
  return runtime.db;
}

function requireOnboardingMode() {
  if (runtime.mode !== "onboarding") throw Object.assign(new Error("초기 설정 모드에서만 사용할 수 있습니다."), { statusCode: 409 });
}

function dashboardJobs() {
  return listJobs(requireDatabase(), runtime.sourcesConfig, packageQualityOptions());
}

function dashboardWork() {
  const jobs = dashboardJobs();
  const followUps = listPendingFollowUps(requireDatabase(), outcomeOptions());
  return { jobs, workflow: buildWorkflowOverview(jobs, { followUps }) };
}

function jobMutationPayload(jobId) {
  const detail = getJobDetail(requireDatabase(), jobId, runtime.sourcesConfig, packageQualityOptions());
  return { job: publicJobSummary(detail), detail, revisions: databaseRevisions(requireDatabase()) };
}

function companionContext() {
  return {
    searchConfig: runtime.searchConfig,
    sourcesConfig: runtime.sourcesConfig,
    profileConfig: runtime.profileConfig,
  };
}

function outcomeOptions() {
  return { timeZone: runtime.profileConfig?.location?.timezone || "Asia/Seoul" };
}

function companionReviewOptions() {
  return {
    context: companionContext(),
    sourcesConfig: runtime.sourcesConfig,
    timeZone: runtime.profileConfig?.location?.timezone || "Asia/Seoul",
    packageOptions: packageQualityOptions(),
  };
}

function requirePersonalMode() {
  if (runtime.mode !== "personal") throw Object.assign(new Error("개인 설정을 완료한 뒤 로컬 companion 작업을 사용할 수 있습니다."), { statusCode: 409 });
}

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(payload);
}

function revisionEtag(scope, revisions, identity) {
  const databaseIdentity = Object.fromEntries(requireDatabase().prepare("SELECT key, value FROM app_meta WHERE key IN ('instance_id', 'schema_version')").all()
    .map((item) => [item.key, item.value]));
  const suffix = crypto.createHash("sha256")
    .update(`${identity}:${databaseIdentity.instance_id || "unknown"}:${databaseIdentity.schema_version || "unknown"}`)
    .digest("hex").slice(0, 16);
  return `\"${scope}-j${revisions.jobs || 0}-w${revisions.workflow || 0}-${suffix}\"`;
}

function sendRevisioned(response, request, scope, identity, payload) {
  const revisions = payload.revisions || databaseRevisions(requireDatabase());
  const etag = revisionEtag(scope, revisions, identity);
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { etag, "cache-control": "private, no-cache", "x-content-type-options": "nosniff" });
    response.end();
    return;
  }
  sendJson(response, 200, payload, { etag, "cache-control": "private, no-cache" });
}

function sendError(response, status, message) {
  sendJson(response, status, { ok: false, error: message });
}

function publicError(error) {
  let status = Number(error?.statusCode || 500);
  const message = String(error?.message || "");
  if (!error?.statusCode) {
    if (/database is locked|SQLITE_BUSY/i.test(message)) {
      return { status: 409, message: "다른 작업이 저장 중입니다. 잠시 후 다시 시도해 주세요." };
    }
    if (message === "Job not found" || message === "Package not found") status = 404;
    else if (
      message === "Unsupported workflow status"
      || message === "Only HTTP(S) job sources are allowed"
      || message === "Score must be a number between 0 and 100"
      || message.startsWith("Missing required field:")
    ) status = 400;
  }
  if (status >= 500) {
    console.error(error);
    return { status: 500, message: "요청 처리 중 내부 오류가 발생했습니다." };
  }
  return { status, message: message || "요청을 처리하지 못했습니다." };
}

function publicSetupStatus() {
  return {
    complete: runtime.setup.complete,
    files: Object.fromEntries(Object.entries(runtime.setup.files).map(([name, value]) => [name, {
      exists: value.exists,
      complete: value.complete,
    }])),
  };
}

function emptyResume() {
  return {
    jobFamily: "", jobRole: "", careerType: "new", careerStage: "entry", yearsExperience: "",
    school: "", major: "", headline: "", summary: "", skills: [], certificates: [],
    experienceHighlights: [], achievementEvidence: "", representativeExperience: "",
    directScope: "", collaborationScope: "", careerDirection: "", editableSections: [],
    customSections: [], evidenceItems: [], sourceDocuments: [], assets: [], structuredItems: [],
    readiness: { ready: false, score: 0, checks: [], missing: [] },
  };
}

function dashboardPayload() {
  if (runtime.mode === "onboarding") {
    const onboarding = publicOnboardingState(readOnboardingState());
    return {
      product: "Job Search Operations Dashboard",
      environment: runtimeEnvironment,
      requestedMode,
      mode: "onboarding",
      onboardingRequired: true,
      configStatus: publicSetupStatus(),
      profile: {
        displayName: onboarding.profile.displayName || "",
        timezone: onboarding.profile.timezone || "Asia/Seoul",
      },
      jobs: [],
      resume: emptyResume(),
      sources: onboarding.sources.items || {},
      scoreReviewBelow: Number(onboarding.search.scoring?.reviewBelow ?? 70),
      onboarding,
      uiContract: buildUiContract({ mode: runtime.mode }),
      companionTasks: [],
      inbox: { items: [], unreadCount: 0 },
      outcomeEventTypes: outcomeEventTypes(),
    };
  }
  const work = dashboardWork();
  return {
    product: "Job Search Operations Dashboard",
    environment: runtimeEnvironment,
    requestedMode,
    mode: runtime.mode,
    onboardingRequired: runtime.onboardingRequired,
    configStatus: publicSetupStatus(),
    profile: {
      displayName: runtime.mode === "personal"
        ? String(runtime.profileConfig?.identity?.display_name || "")
        : "예시 사용자",
      timezone: runtime.mode === "personal"
        ? String(runtime.profileConfig?.location?.timezone || "Asia/Seoul")
        : String(loadExampleConfig("profile")?.location?.timezone || "Asia/Seoul"),
    },
    jobs: work.jobs,
    workflow: work.workflow,
    resume: getResume(runtime.db),
    sources: runtime.sourcesConfig.sources || {},
    scoreReviewBelow: Number(runtime.searchConfig?.scoring?.review_below ?? 70),
    scoringProfile: scoringProfileFromConfig(runtime.searchConfig),
    companionTasks: runtime.mode === "personal" ? listCompanionTasks(runtime.db) : [],
    inbox: runtime.mode === "personal" ? listLocalNotifications(runtime.db, { limit: 100 }) : { items: [], unreadCount: 0 },
    outcomeEventTypes: outcomeEventTypes(),
    uiContract: buildUiContract({ mode: runtime.mode }),
  };
}

function bootstrapPayload() {
  if (runtime.mode === "onboarding") return dashboardPayload();
  return {
    product: "Job Search Operations Dashboard",
    environment: runtimeEnvironment,
    requestedMode,
    mode: runtime.mode,
    onboardingRequired: runtime.onboardingRequired,
    configStatus: publicSetupStatus(),
    profile: {
      displayName: runtime.mode === "personal"
        ? String(runtime.profileConfig?.identity?.display_name || "")
        : "예시 사용자",
      timezone: runtime.mode === "personal"
        ? String(runtime.profileConfig?.location?.timezone || "Asia/Seoul")
        : String(loadExampleConfig("profile")?.location?.timezone || "Asia/Seoul"),
    },
    jobs: [],
    workflow: { counts: {}, buckets: {}, total: 0 },
    resume: getResume(runtime.db),
    sources: runtime.sourcesConfig.sources || {},
    scoreReviewBelow: Number(runtime.searchConfig?.scoring?.review_below ?? 70),
    scoringProfile: scoringProfileFromConfig(runtime.searchConfig),
    companionTasks: runtime.mode === "personal" ? listCompanionTasks(runtime.db) : [],
    inbox: runtime.mode === "personal" ? listLocalNotifications(runtime.db, { limit: 100 }) : { items: [], unreadCount: 0 },
    outcomeEventTypes: outcomeEventTypes(),
    savedFilters: runtime.mode === "personal" ? listSavedFilters(runtime.db) : [],
    revisions: databaseRevisions(runtime.db),
    uiContract: buildUiContract({ mode: runtime.mode }),
  };
}

function jobPageOptions(url) {
  return {
    page: Number(url.searchParams.get("page") || 1),
    pageSize: Number(url.searchParams.get("pageSize") || 30),
    timeZone: runtime.profileConfig?.location?.timezone || "Asia/Seoul",
    filters: {
      search: url.searchParams.get("search") || "",
      track: url.searchParams.get("track") || "",
      platform: url.searchParams.get("platform") || "",
      status: url.searchParams.get("status") || "",
      lifecycle: url.searchParams.get("lifecycle") || "active",
      deadline: url.searchParams.get("deadline") || "",
      sort: url.searchParams.get("sort") || "score",
      favorite: url.searchParams.get("favorite") === "true",
    },
  };
}

function serveStatic(requestPath, response) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    sendError(response, 400, "올바르지 않은 요청 경로입니다.");
    return;
  }
  const candidate = path.resolve(publicRoot, `.${decoded}`);
  const relative = path.relative(publicRoot, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    sendError(response, 403, "Forbidden path");
    return;
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    sendError(response, 404, "Not found");
    return;
  }
  const realCandidate = fs.realpathSync(candidate);
  const realRelative = path.relative(realPublicRoot, realCandidate);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    sendError(response, 403, "Forbidden path");
    return;
  }
  const contents = fs.readFileSync(realCandidate);
  response.writeHead(200, {
    "content-type": mimeTypes.get(path.extname(realCandidate)) || "application/octet-stream",
    "content-length": contents.length,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(contents);
}

const server = http.createServer(async (request, response) => {
  try {
    const requestPath = request.url || "/";
    if (!requestPath.startsWith("/")) {
      sendError(response, 400, "올바르지 않은 요청 경로입니다.");
      return;
    }
    const baseHost = host.includes(":") ? `[${host}]` : host;
    const url = new URL(requestPath, `http://${baseHost}:${port}`);
    protectLocalRequest({ method: request.method, pathname: url.pathname, headers: request.headers, port, mode: runtime.mode });
    if (request.method === "GET" && url.pathname === "/api/ui-contract") {
      sendJson(response, 200, buildUiContract({ mode: runtime.mode }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        product: "Job Search Operations Dashboard",
        mode: runtime.mode,
        onboardingRequired: runtime.onboardingRequired,
        port,
        database: runtime.dbPath ? path.basename(runtime.dbPath) : null,
        uiContract: {
          contractId: UI_CONTRACT_ID,
          schemaVersion: UI_CONTRACT_SCHEMA_VERSION,
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(response, 200, dashboardPayload());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(response, 200, bootstrapPayload());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      const page = listJobPage(requireDatabase(), runtime.sourcesConfig, jobPageOptions(url));
      sendRevisioned(response, request, "jobs", url.search, { ok: true, ...page });
      return;
    }
    if (request.method === "GET" && /^\/api\/jobs\/\d+$/.test(url.pathname)) {
      const jobId = Number(url.pathname.split("/")[3]);
      const detail = getJobDetail(requireDatabase(), jobId, runtime.sourcesConfig, packageQualityOptions());
      const revisions = databaseRevisions(requireDatabase());
      sendRevisioned(response, request, "job", String(jobId), { ok: true, detail, revisions });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/workflow") {
      const revisions = databaseRevisions(requireDatabase());
      sendRevisioned(response, request, "workflow", "all", {
        ok: true,
        workflow: buildWorkflowOverview(dashboardJobs(), {
          followUps: listPendingFollowUps(requireDatabase(), outcomeOptions()),
        }),
        revisions,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/saved-filters") {
      requirePersonalMode();
      sendJson(response, 200, { ok: true, savedFilters: listSavedFilters(requireDatabase()) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/saved-filters") {
      requirePersonalMode();
      const savedFilter = saveFilter(requireDatabase(), await readJsonBody(request));
      sendJson(response, 201, { ok: true, savedFilter, savedFilters: listSavedFilters(requireDatabase()) });
      return;
    }
    if (request.method === "PUT" && /^\/api\/saved-filters\/[0-9a-f-]{36}$/i.test(url.pathname)) {
      requirePersonalMode();
      const id = url.pathname.split("/")[3];
      const savedFilter = saveFilter(requireDatabase(), await readJsonBody(request), { id });
      sendJson(response, 200, { ok: true, savedFilter, savedFilters: listSavedFilters(requireDatabase()) });
      return;
    }
    if (request.method === "DELETE" && /^\/api\/saved-filters\/[0-9a-f-]{36}$/i.test(url.pathname)) {
      requirePersonalMode();
      await readJsonBody(request);
      sendJson(response, 200, { ok: true, savedFilters: deleteSavedFilter(requireDatabase(), url.pathname.split("/")[3]) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/onboarding") {
      requireOnboardingMode();
      sendJson(response, 200, { ok: true, onboarding: publicOnboardingState(readOnboardingState()) });
      return;
    }
    if (request.method === "PATCH" && url.pathname === "/api/onboarding") {
      requireOnboardingMode();
      const onboarding = patchOnboardingState(await readJsonBody(request, 2_000_000));
      sendJson(response, 200, { ok: true, onboarding });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/onboarding/documents") {
      requireOnboardingMode();
      const onboarding = await uploadOnboardingDocument(request, String(url.searchParams.get("kind") || ""));
      sendJson(response, 201, { ok: true, onboarding });
      return;
    }
    if (request.method === "DELETE" && /^\/api\/onboarding\/documents\/[^/]+$/.test(url.pathname)) {
      requireOnboardingMode();
      await readJsonBody(request);
      const onboarding = deleteOnboardingDocument(decodeURIComponent(url.pathname.split("/").pop()));
      sendJson(response, 200, { ok: true, onboarding });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/onboarding/analysis") {
      requireOnboardingMode();
      const onboarding = putOnboardingAnalysis(await readJsonBody(request, 2_000_000));
      sendJson(response, 200, { ok: true, onboarding });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/onboarding/complete") {
      requireOnboardingMode();
      await readJsonBody(request);
      completeOnboarding();
      activatePersonalRuntime();
      sendJson(response, 200, { ok: true, dashboard: dashboardPayload() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/scoring-profile") {
      if (runtime.mode !== "personal") throw Object.assign(new Error("개인 설정을 완료한 뒤 평가 기준을 사용할 수 있습니다."), { statusCode: 409 });
      sendJson(response, 200, { ok: true, scoringProfile: scoringProfileFromConfig(runtime.searchConfig) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      requirePersonalMode();
      sendJson(response, 200, { ok: true, settings: getPersonalSettings(requireDatabase()) });
      return;
    }
    if (request.method === "PATCH" && url.pathname === "/api/settings") {
      requirePersonalMode();
      const settings = savePersonalSettings(requireDatabase(), await readJsonBody(request, 2_000_000));
      reloadPersonalConfiguration();
      const supersededTaskIds = supersedeStaleCompanionResults(requireDatabase(), companionContext());
      sendJson(response, 200, {
        ok: true,
        settings,
        supersededTaskIds,
        dashboard: bootstrapPayload(),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings/documents") {
      requirePersonalMode();
      const result = await uploadPersonalDocument(requireDatabase(), request, String(url.searchParams.get("kind") || ""), {
        replaceId: String(url.searchParams.get("replace") || ""),
      });
      const supersededTaskIds = supersedeStaleCompanionResults(requireDatabase(), companionContext());
      sendJson(response, 201, { ok: true, ...result, supersededTaskIds, resume: getResume(requireDatabase()), tasks: listCompanionTasks(requireDatabase()) });
      return;
    }
    if (request.method === "DELETE" && /^\/api\/settings\/documents\/[^/]+$/.test(url.pathname)) {
      requirePersonalMode();
      await readJsonBody(request);
      const result = archivePersonalDocument(requireDatabase(), decodeURIComponent(url.pathname.split("/").pop()));
      const supersededTaskIds = supersedeStaleCompanionResults(requireDatabase(), companionContext());
      sendJson(response, 200, { ok: true, ...result, supersededTaskIds, resume: getResume(requireDatabase()), tasks: listCompanionTasks(requireDatabase()) });
      return;
    }
    if (request.method === "GET" && /^\/api\/jobs\/\d+\/outcomes$/.test(url.pathname)) {
      requirePersonalMode();
      const jobId = Number(url.pathname.split("/")[3]);
      sendJson(response, 200, { ok: true, outcomes: listJobOutcomes(requireDatabase(), jobId, outcomeOptions()) });
      return;
    }
    if (request.method === "POST" && /^\/api\/jobs\/\d+\/outcomes$/.test(url.pathname)) {
      requirePersonalMode();
      const jobId = Number(url.pathname.split("/")[3]);
      const result = appendApplicationEvent(requireDatabase(), jobId, await readJsonBody(request));
      sendJson(response, result.deduplicated ? 200 : 201, {
        ok: true,
        ...result,
        outcomes: listJobOutcomes(requireDatabase(), jobId, outcomeOptions()),
        inbox: listLocalNotifications(requireDatabase()),
        workflow: dashboardWork().workflow,
        ...jobMutationPayload(jobId),
      });
      return;
    }
    if (request.method === "POST" && /^\/api\/jobs\/\d+\/outcomes\/\d+\/corrections$/.test(url.pathname)) {
      requirePersonalMode();
      const parts = url.pathname.split("/");
      const jobId = Number(parts[3]);
      const eventId = Number(parts[5]);
      const result = appendApplicationEventCorrection(requireDatabase(), jobId, eventId, await readJsonBody(request));
      sendJson(response, result.deduplicated ? 200 : 201, {
        ok: true,
        ...result,
        outcomes: listJobOutcomes(requireDatabase(), jobId, outcomeOptions()),
        inbox: listLocalNotifications(requireDatabase()),
        workflow: dashboardWork().workflow,
        ...jobMutationPayload(jobId),
      });
      return;
    }
    if (request.method === "POST" && /^\/api\/jobs\/\d+\/follow-ups$/.test(url.pathname)) {
      requirePersonalMode();
      const jobId = Number(url.pathname.split("/")[3]);
      const result = createFollowUp(requireDatabase(), jobId, await readJsonBody(request), outcomeOptions());
      sendJson(response, result.deduplicated ? 200 : 201, {
        ok: true,
        ...result,
        outcomes: listJobOutcomes(requireDatabase(), jobId, outcomeOptions()),
        inbox: listLocalNotifications(requireDatabase()),
        workflow: dashboardWork().workflow,
      });
      return;
    }
    if (request.method === "POST" && /^\/api\/follow-ups\/[^/]+\/(complete|cancel)$/.test(url.pathname)) {
      requirePersonalMode();
      const parts = url.pathname.split("/");
      const result = transitionFollowUp(requireDatabase(), decodeURIComponent(parts[3]), parts[4], outcomeOptions());
      sendJson(response, 200, {
        ok: true,
        ...result,
        outcomes: listJobOutcomes(requireDatabase(), result.followUp.jobId, outcomeOptions()),
        inbox: listLocalNotifications(requireDatabase()),
        workflow: dashboardWork().workflow,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/inbox") {
      requirePersonalMode();
      sendJson(response, 200, {
        ok: true,
        inbox: listLocalNotifications(requireDatabase(), {
          unreadOnly: url.searchParams.get("unread") === "true",
          limit: Number(url.searchParams.get("limit") || 100),
        }),
      });
      return;
    }
    if (request.method === "POST" && /^\/api\/inbox\/\d+\/read$/.test(url.pathname)) {
      requirePersonalMode();
      await readJsonBody(request);
      sendJson(response, 200, { ok: true, inbox: markNotificationRead(requireDatabase(), Number(url.pathname.split("/")[3])) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/companion/tasks") {
      requirePersonalMode();
      sendJson(response, 200, { ok: true, tasks: listCompanionTasks(requireDatabase()) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/companion/tasks") {
      requirePersonalMode();
      const result = createCompanionTask(requireDatabase(), await readJsonBody(request, 2_000_000), companionContext());
      sendJson(response, result.deduplicated ? 200 : 201, { ok: true, ...result, tasks: listCompanionTasks(requireDatabase()) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/companion/tasks/claim") {
      requirePersonalMode();
      const claimed = claimNextCompanionTask(requireDatabase(), await readJsonBody(request));
      sendJson(response, 200, { ok: true, claimed });
      return;
    }
    if (request.method === "GET" && /^\/api\/companion\/tasks\/[^/]+\/review$/.test(url.pathname)) {
      requirePersonalMode();
      const taskId = decodeURIComponent(url.pathname.split("/")[4]);
      sendJson(response, 200, { ok: true, ...getCompanionResultReview(requireDatabase(), taskId) });
      return;
    }
    if (request.method === "PATCH" && /^\/api\/companion\/tasks\/[^/]+\/review$/.test(url.pathname)) {
      requirePersonalMode();
      const taskId = decodeURIComponent(url.pathname.split("/")[4]);
      const result = patchCompanionResultReview(requireDatabase(), taskId, await readJsonBody(request, 2_000_000));
      sendJson(response, 200, { ok: true, ...result, tasks: listCompanionTasks(requireDatabase()) });
      return;
    }
    if (request.method === "POST" && /^\/api\/companion\/tasks\/[^/]+\/(prepare-review|apply-review|reject-review)$/.test(url.pathname)) {
      requirePersonalMode();
      const parts = url.pathname.split("/");
      const taskId = decodeURIComponent(parts[4]);
      const action = parts[5];
      const body = await readJsonBody(request, 2_000_000);
      const result = action === "prepare-review"
        ? prepareCompanionResultReview(requireDatabase(), taskId, companionReviewOptions())
        : action === "apply-review"
          ? applyCompanionResultReview(requireDatabase(), taskId, companionReviewOptions())
          : rejectCompanionResultReview(requireDatabase(), taskId, body);
      sendJson(response, 200, {
        ok: true,
        ...result,
        tasks: listCompanionTasks(requireDatabase()),
        revisions: databaseRevisions(requireDatabase()),
      });
      return;
    }
    if (request.method === "POST" && /^\/api\/companion\/tasks\/[^/]+\/(heartbeat|complete|fail|retry|cancel)$/.test(url.pathname)) {
      requirePersonalMode();
      const parts = url.pathname.split("/");
      const taskId = decodeURIComponent(parts[4]);
      const action = parts[5];
      const body = await readJsonBody(request, 2_000_000);
      let task;
      if (action === "heartbeat") task = heartbeatCompanionTask(requireDatabase(), taskId, body);
      else if (action === "complete") task = completeCompanionTask(requireDatabase(), taskId, body);
      else if (action === "fail") task = failCompanionTask(requireDatabase(), taskId, body);
      else if (action === "retry") task = retryCompanionTask(requireDatabase(), taskId);
      else task = cancelCompanionTask(requireDatabase(), taskId);
      sendJson(response, 200, { ok: true, task, tasks: listCompanionTasks(requireDatabase()) });
      return;
    }
    if (request.method === "PATCH" && /^\/api\/jobs\/\d+\/state$/.test(url.pathname)) {
      const jobId = Number(url.pathname.split("/")[3]);
      updateApplicationState(requireDatabase(), jobId, await readJsonBody(request));
      sendJson(response, 200, { ok: true, ...jobMutationPayload(jobId) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/jobs") {
      if (runtime.mode !== "personal") {
        sendError(response, 409, "Complete personal setup before importing real jobs");
        return;
      }
      const jobId = importJob(requireDatabase(), await readJsonBody(request), {
        scoringProfile: scoringProfileFromConfig(runtime.searchConfig),
        timeZone: runtime.profileConfig?.location?.timezone || "Asia/Seoul",
      });
      sendJson(response, 201, { ok: true, jobId, ...jobMutationPayload(jobId) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/collection/contract") {
      sendJson(response, 200, { contract: collectionAdapterContract() });
      return;
    }
    if (request.method === "GET" && /^\/api\/collection\/runs\/[0-9a-f-]{36}$/i.test(url.pathname)) {
      requirePersonalMode();
      sendJson(response, 200, { run: getCollectionRun(url.pathname.split("/")[4], { db: requireDatabase() }) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/jobs/batch") {
      requirePersonalMode();
      const body = await readJsonBody(request, 8_000_000);
      if (body.publishConfirmed === true) {
        const result = publishCollectionRun(requireDatabase(), String(body.runId || ""), {
          expectedChecksum: body.expectedChecksum,
          sourcesConfig: runtime.sourcesConfig,
          timeZone: runtime.profileConfig?.location?.timezone || "Asia/Seoul",
        });
        sendJson(response, 200, { ok: true, ...result, invalidate: ["jobs", "workflow"], revisions: databaseRevisions(requireDatabase()) });
      } else {
        const result = stageCollectionBatch(requireDatabase(), body, {
          sourcesConfig: runtime.sourcesConfig,
          timeZone: runtime.profileConfig?.location?.timezone || "Asia/Seoul",
        });
        sendJson(response, result.coalesced ? 200 : 201, { ok: true, dryRun: true, ...result });
      }
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/resume") {
      const resume = saveResume(requireDatabase(), await readJsonBody(request, 2_000_000));
      sendJson(response, 200, { ok: true, resume, invalidate: ["jobs", "workflow"], revisions: databaseRevisions(requireDatabase()) });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/resume/structured") {
      const structuredItems = saveStructuredResumeItems(requireDatabase(), (await readJsonBody(request, 2_000_000)).structuredItems);
      sendJson(response, 200, { ok: true, structuredItems, resume: getResume(requireDatabase()), invalidate: ["jobs", "workflow"], revisions: databaseRevisions(requireDatabase()) });
      return;
    }
    if (request.method === "PATCH" && /^\/api\/resume\/assets\/[^/]+$/.test(url.pathname)) {
      const documentId = decodeURIComponent(url.pathname.split("/")[4]);
      const assets = updateResumeAsset(requireDatabase(), documentId, await readJsonBody(request));
      sendJson(response, 200, { ok: true, assets, resume: getResume(requireDatabase()), invalidate: ["jobs", "workflow"], revisions: databaseRevisions(requireDatabase()) });
      return;
    }
    if (request.method === "POST" && /^\/api\/jobs\/\d+\/package$/.test(url.pathname)) {
      const jobId = Number(url.pathname.split("/")[3]);
      const body = await readJsonBody(request);
      if (body.refreshConfirmed !== undefined && typeof body.refreshConfirmed !== "boolean") {
        throw Object.assign(new Error("refreshConfirmed must be true or false"), { statusCode: 400 });
      }
      const packageValue = createPackage(requireDatabase(), jobId, {
        ...packageQualityOptions(),
        refreshConfirmed: body.refreshConfirmed === true,
      });
      sendJson(response, 201, { ok: true, package: publicPackage(packageValue), ...jobMutationPayload(jobId) });
      return;
    }
    if (request.method === "PUT" && /^\/api\/packages\/\d+$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      const packageValue = updatePackage(requireDatabase(), packageId, await readJsonBody(request), packageQualityOptions());
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), ...jobMutationPayload(packageValue.jobId) });
      return;
    }
    if (request.method === "POST" && /^\/api\/packages\/\d+\/approve$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      const packageValue = await approvePackage(requireDatabase(), packageId, { ...await readJsonBody(request), ...packageQualityOptions() });
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), ...jobMutationPayload(packageValue.jobId) });
      return;
    }
    if (request.method === "POST" && /^\/api\/packages\/\d+\/prepare$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      const packageValue = prepareSubmission(requireDatabase(), packageId, {
        ...await readJsonBody(request),
        ...packageQualityOptions(),
      });
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), ...jobMutationPayload(packageValue.jobId) });
      return;
    }
    if (request.method === "POST" && /^\/api\/packages\/\d+\/submitted$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      await readJsonBody(request);
      const packageValue = recordSubmitted(requireDatabase(), packageId);
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), ...jobMutationPayload(packageValue.jobId) });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendError(response, 404, "API route not found");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendError(response, 405, "Method not allowed");
      return;
    }
    serveStatic(url.pathname, response);
  } catch (error) {
    if (error instanceof SyntaxError) sendError(response, 400, "올바른 JSON 요청이 아닙니다.");
    else {
      const safe = publicError(error);
      sendError(response, safe.status, safe.message);
    }
  }
});

server.listen(port, host, () => {
  console.log(`Job Search Operations Dashboard: http://${host}:${port}`);
  console.log(`Mode: ${runtime.mode}${runtime.onboardingRequired ? " (personal setup required)" : ""}`);
});

function shutdown() {
  server.close(() => {
    try { runtime.db?.close(); } catch {}
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
