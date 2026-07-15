import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configStatus, loadConfig, loadExampleConfig } from "../lib/config.mjs";
import {
  getResume,
  importJob,
  initializeDatabase,
  listJobs,
  openDatabase,
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

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(here, "public");
const realPublicRoot = fs.realpathSync(publicRoot);
const requestedMode = runtimeMode();
const host = runtimeHost();
const port = runtimePort();

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

function packageQualityOptions() {
  const rules = runtime.resumeConfig?.quality_rules || {};
  const threshold = Number(rules.minimum_score ?? 80);
  const maximumPages = Number(rules.maximum_pdf_pages ?? 3);
  return {
    threshold: Number.isFinite(threshold) ? Math.max(0, Math.min(100, threshold)) : 80,
    maximumPages: Number.isInteger(maximumPages) ? Math.max(1, Math.min(10, maximumPages)) : 3,
  };
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

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
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
    customSections: [], evidenceItems: [], sourceDocuments: [],
  };
}

function dashboardPayload() {
  if (runtime.mode === "onboarding") {
    const onboarding = publicOnboardingState(readOnboardingState());
    return {
      product: "Job Search Operations Dashboard",
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
    };
  }
  return {
    product: "Job Search Operations Dashboard",
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
    jobs: dashboardJobs(),
    resume: getResume(runtime.db),
    sources: runtime.sourcesConfig.sources || {},
    scoreReviewBelow: Number(runtime.searchConfig?.scoring?.review_below ?? 70),
    scoringProfile: scoringProfileFromConfig(runtime.searchConfig),
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
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        product: "Job Search Operations Dashboard",
        mode: runtime.mode,
        onboardingRequired: runtime.onboardingRequired,
        port,
        database: runtime.dbPath ? path.basename(runtime.dbPath) : null,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(response, 200, dashboardPayload());
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
    if (request.method === "PATCH" && /^\/api\/jobs\/\d+\/state$/.test(url.pathname)) {
      const jobId = Number(url.pathname.split("/")[3]);
      updateApplicationState(requireDatabase(), jobId, await readJsonBody(request));
      sendJson(response, 200, { ok: true, jobs: dashboardJobs() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/jobs") {
      if (runtime.mode !== "personal") {
        sendError(response, 409, "Complete personal setup before importing real jobs");
        return;
      }
      const jobId = importJob(requireDatabase(), await readJsonBody(request), {
        scoringProfile: scoringProfileFromConfig(runtime.searchConfig),
      });
      sendJson(response, 201, { ok: true, jobId, jobs: dashboardJobs() });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/resume") {
      const resume = saveResume(requireDatabase(), await readJsonBody(request, 2_000_000));
      sendJson(response, 200, { ok: true, resume });
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
      sendJson(response, 201, { ok: true, package: publicPackage(packageValue), jobs: dashboardJobs() });
      return;
    }
    if (request.method === "PUT" && /^\/api\/packages\/\d+$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      const packageValue = updatePackage(requireDatabase(), packageId, await readJsonBody(request), packageQualityOptions());
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), jobs: dashboardJobs() });
      return;
    }
    if (request.method === "POST" && /^\/api\/packages\/\d+\/approve$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      const packageValue = await approvePackage(requireDatabase(), packageId, { ...await readJsonBody(request), ...packageQualityOptions() });
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), jobs: dashboardJobs() });
      return;
    }
    if (request.method === "POST" && /^\/api\/packages\/\d+\/prepare$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      const packageValue = prepareSubmission(requireDatabase(), packageId, {
        ...await readJsonBody(request),
        ...packageQualityOptions(),
      });
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), jobs: dashboardJobs() });
      return;
    }
    if (request.method === "POST" && /^\/api\/packages\/\d+\/submitted$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      await readJsonBody(request);
      const packageValue = recordSubmitted(requireDatabase(), packageId);
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), jobs: dashboardJobs() });
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
