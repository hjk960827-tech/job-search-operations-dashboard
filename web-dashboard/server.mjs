import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configStatus, loadConfig } from "../lib/config.mjs";
import {
  getResume,
  importJob,
  initializeDatabase,
  listJobs,
  openDatabase,
  saveResume,
  updateApplicationState,
} from "../lib/database.mjs";
import { databasePath, runtimeMode } from "../lib/paths.mjs";
import { runtimeHost, runtimePort } from "../lib/runtime.mjs";
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
const requestedMode = runtimeMode();
const setup = configStatus();
const effectiveMode = requestedMode === "personal" && setup.complete ? "personal" : "demo";
const onboardingRequired = !setup.complete;
const dbPath = databasePath(effectiveMode);
const host = runtimeHost();
const port = runtimePort();
const sourcesConfig = loadConfig("sources", { allowExample: effectiveMode === "demo" });
const resumeConfig = loadConfig("resume", { allowExample: effectiveMode === "demo" });
const searchConfig = loadConfig("search", { allowExample: effectiveMode === "demo" });
const profileConfig = effectiveMode === "personal" ? loadConfig("profile") : null;

function packageQualityOptions() {
  const rules = resumeConfig?.quality_rules || {};
  const threshold = Number(rules.minimum_score ?? 80);
  const maximumPages = Number(rules.maximum_pdf_pages ?? 3);
  return {
    threshold: Number.isFinite(threshold) ? Math.max(0, Math.min(100, threshold)) : 80,
    maximumPages: Number.isInteger(maximumPages) ? Math.max(1, Math.min(10, maximumPages)) : 3,
  };
}

initializeDatabase(dbPath, { mode: effectiveMode });
const db = openDatabase(dbPath);

// DNS rebinding uses an attacker-controlled name that resolves to 127.0.0.1,
// so loopback binding alone does not protect the resume data behind this API.
const allowedHosts = new Set([host, "127.0.0.1", "localhost", "[::1]"].map((name) => `${name.toLowerCase()}:${port}`));
const allowedOrigins = new Set([...allowedHosts].map((value) => `http://${value}`));

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
  const status = Number(error?.statusCode || 500);
  if (status >= 500) {
    console.error(error);
    return { status: 500, message: "요청 처리 중 내부 오류가 발생했습니다." };
  }
  return { status, message: error?.message || "요청을 처리하지 못했습니다." };
}

async function readJson(request) {
  const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw Object.assign(new Error("Content-Type must be application/json"), { statusCode: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 100_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function dashboardPayload() {
  return {
    product: "Job Search Operations Dashboard",
    requestedMode,
    mode: effectiveMode,
    onboardingRequired,
    configStatus: setup,
    profile: {
      displayName: effectiveMode === "personal"
        ? String(profileConfig?.identity?.display_name || "")
        : "예시 사용자",
    },
    jobs: listJobs(db, sourcesConfig),
    resume: getResume(db),
    sources: sourcesConfig.sources || {},
    scoreReviewBelow: Number(searchConfig?.scoring?.review_below ?? 86),
  };
}

function serveStatic(requestPath, response) {
  const decoded = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
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
  const contents = fs.readFileSync(candidate);
  response.writeHead(200, {
    "content-type": mimeTypes.get(path.extname(candidate)) || "application/octet-stream",
    "content-length": contents.length,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(contents);
}

const server = http.createServer(async (request, response) => {
  try {
    const hostHeader = String(request.headers.host || "").toLowerCase();
    if (!allowedHosts.has(hostHeader)) {
      sendError(response, 403, "Unrecognized Host header");
      return;
    }
    const origin = String(request.headers.origin || "").toLowerCase();
    if (origin && !allowedOrigins.has(origin)) {
      sendError(response, 403, "Cross-origin requests are not allowed");
      return;
    }
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        product: "Job Search Operations Dashboard",
        mode: effectiveMode,
        onboardingRequired,
        port,
        database: path.basename(dbPath),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(response, 200, dashboardPayload());
      return;
    }
    if (request.method === "PATCH" && /^\/api\/jobs\/\d+\/state$/.test(url.pathname)) {
      const jobId = Number(url.pathname.split("/")[3]);
      updateApplicationState(db, jobId, await readJson(request));
      sendJson(response, 200, { ok: true, jobs: listJobs(db, sourcesConfig) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/jobs") {
      if (effectiveMode !== "personal") {
        sendError(response, 409, "Complete personal setup before importing real jobs");
        return;
      }
      const jobId = importJob(db, await readJson(request));
      sendJson(response, 201, { ok: true, jobId, jobs: listJobs(db, sourcesConfig) });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/resume") {
      if (effectiveMode !== "personal") {
        sendError(response, 409, "Complete personal setup before saving a real resume");
        return;
      }
      const resume = saveResume(db, await readJson(request));
      sendJson(response, 200, { ok: true, resume });
      return;
    }
    if (request.method === "POST" && /^\/api\/jobs\/\d+\/package$/.test(url.pathname)) {
      const jobId = Number(url.pathname.split("/")[3]);
      const packageValue = createPackage(db, jobId, packageQualityOptions());
      sendJson(response, 201, { ok: true, package: publicPackage(packageValue), jobs: listJobs(db, sourcesConfig) });
      return;
    }
    if (request.method === "PUT" && /^\/api\/packages\/\d+$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      const packageValue = updatePackage(db, packageId, await readJson(request), packageQualityOptions());
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), jobs: listJobs(db, sourcesConfig) });
      return;
    }
    if (request.method === "POST" && /^\/api\/packages\/\d+\/approve$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      const packageValue = await approvePackage(db, packageId, { ...await readJson(request), ...packageQualityOptions() });
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), jobs: listJobs(db, sourcesConfig) });
      return;
    }
    if (request.method === "POST" && /^\/api\/packages\/\d+\/prepare$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      const packageValue = prepareSubmission(db, packageId, await readJson(request));
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), jobs: listJobs(db, sourcesConfig) });
      return;
    }
    if (request.method === "POST" && /^\/api\/packages\/\d+\/submitted$/.test(url.pathname)) {
      const packageId = Number(url.pathname.split("/")[3]);
      const packageValue = recordSubmitted(db, packageId);
      sendJson(response, 200, { ok: true, package: publicPackage(packageValue), jobs: listJobs(db, sourcesConfig) });
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
  console.log(`Mode: ${effectiveMode}${onboardingRequired ? " (personal setup required)" : ""}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
