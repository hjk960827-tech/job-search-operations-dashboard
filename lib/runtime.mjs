export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8766;
export const MAX_JSON_BODY_BYTES = 100_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class HttpRequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpRequestError";
    this.statusCode = statusCode;
  }
}

function normalizedHostname(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) return normalized.slice(1, -1);
  return normalized;
}

function isLoopbackHostname(value) {
  return LOOPBACK_HOSTS.has(normalizedHostname(value));
}

function headerValue(headers, name) {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === expected) return Array.isArray(value) ? value.join(",") : value;
  }
  return undefined;
}

function parseLocalAuthority(value, port) {
  if (typeof value !== "string" || !value.trim() || value.includes(",") || value.includes("@")) return false;
  try {
    const parsed = new URL(`http://${value.trim()}`);
    const parsedPort = parsed.port ? Number(parsed.port) : 80;
    return parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && parsedPort === port
      && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isValidDnsName(value) {
  return String(value || "").split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function codespacesForwardedHost(port, env = process.env) {
  if (String(env.CODESPACES || "").toLowerCase() !== "true") return null;
  const name = normalizedHostname(env.CODESPACE_NAME);
  const domain = normalizedHostname(env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN);
  if (!isValidDnsName(name) || !domain.includes(".") || !isValidDnsName(domain)) return null;
  const forwardedHost = `${name}-${port}.${domain}`;
  return isValidDnsName(forwardedHost) ? forwardedHost : null;
}

function parseCodespacesAuthority(value, port, env) {
  const expected = codespacesForwardedHost(port, env);
  if (!expected || typeof value !== "string" || !value.trim() || value.includes(",") || value.includes("@")) return false;
  try {
    const parsed = new URL(`https://${value.trim()}`);
    const parsedPort = parsed.port ? Number(parsed.port) : 443;
    return parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && parsedPort === 443
      && normalizedHostname(parsed.hostname) === expected;
  } catch {
    return false;
  }
}

export function isAllowedRequestHost(value, port, env = process.env) {
  return parseLocalAuthority(value, port) || parseCodespacesAuthority(value, port, env);
}

export function isAllowedRequestOrigin(value, port, env = process.env) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    const parsedPort = parsed.port ? Number(parsed.port) : 80;
    const local = parsed.protocol === "http:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && parsedPort === port
      && isLoopbackHostname(parsed.hostname);
    if (local) return true;
    const expected = codespacesForwardedHost(port, env);
    return Boolean(expected)
      && parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && (parsed.port === "" || parsed.port === "443")
      && normalizedHostname(parsed.hostname) === expected;
  } catch {
    return false;
  }
}

export function isApplicationJson(value) {
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

export function assertRuntimeSetup(requestedMode, setupComplete) {
  if (requestedMode === "onboarding") return requestedMode;
  if (requestedMode === "personal" && !setupComplete) {
    throw new Error("Personal mode requires all four local configuration files with setup_complete: true");
  }
  return requestedMode;
}

export function protectLocalRequest({ method, pathname, headers, port, mode, env = process.env }) {
  if (!isAllowedRequestHost(headerValue(headers, "host"), port, env)) {
    throw new HttpRequestError(403, "허용되지 않은 Host 요청입니다.");
  }

  const origin = headerValue(headers, "origin");
  if (origin !== undefined && !isAllowedRequestOrigin(origin, port, env)) {
    throw new HttpRequestError(403, "허용되지 않은 Origin 요청입니다.");
  }

  const isApiMutation = String(pathname || "").startsWith("/api/")
    && MUTATING_METHODS.has(String(method || "GET").toUpperCase());
  if (!isApiMutation) return;

  const isOnboardingRoute = String(pathname || "").startsWith("/api/onboarding");
  if (mode === "onboarding" && !isOnboardingRoute) {
    throw new HttpRequestError(409, "초기 설정 중에는 설정·문서 등록만 변경할 수 있습니다.");
  }
  if (mode !== "personal" && mode !== "onboarding") {
    throw new HttpRequestError(409, "데모 모드는 읽기 전용입니다. 개인 설정을 완료한 뒤 개인 모드에서 실행하세요.");
  }

  const contentType = String(headerValue(headers, "content-type") || "").toLowerCase();
  const isDocumentUpload = mode === "onboarding" && pathname === "/api/onboarding/documents"
    || mode === "personal" && (pathname === "/api/settings/documents" || /^\/api\/outcomes\/\d+\/evidence$/.test(pathname));
  if (isDocumentUpload) {
    if (!contentType.startsWith("multipart/form-data;") || !contentType.includes("boundary=")) {
      throw new HttpRequestError(415, "문서 등록은 multipart/form-data 요청만 허용합니다.");
    }
    return;
  }
  if (!isApplicationJson(contentType)) {
    throw new HttpRequestError(415, "변경 API는 application/json 요청만 허용합니다.");
  }
}

export async function readJsonBody(request, maximumBytes = MAX_JSON_BODY_BYTES) {
  const declaredLength = headerValue(request.headers, "content-length");
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(String(declaredLength))) {
      throw new HttpRequestError(400, "올바르지 않은 Content-Length 헤더입니다.");
    }
    if (Number(declaredLength) > maximumBytes) {
      throw new HttpRequestError(413, "요청 본문이 허용 크기를 초과했습니다.");
    }
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) throw new HttpRequestError(413, "요청 본문이 허용 크기를 초과했습니다.");
  if (!chunks.length) return {};

  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpRequestError(400, "JSON 요청 본문은 객체여야 합니다.");
  }
  return value;
}

export function runtimeHost(env = process.env) {
  const value = String(env.HOST || DEFAULT_HOST).trim().toLowerCase();
  if (!isLoopbackHostname(value)) {
    throw new Error("HOST must be a loopback address (127.0.0.1, localhost, or ::1)");
  }
  return normalizedHostname(value);
}

export function runtimePort(env = process.env) {
  const configured = String(env.PORT ?? "").trim();
  const rawValue = configured || String(DEFAULT_PORT);
  if (!/^\d+$/.test(rawValue)) {
    throw new Error("PORT must be an integer between 1024 and 65535");
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("PORT must be an integer between 1024 and 65535");
  }
  if (value === 8765) throw new Error("PORT 8765 is reserved for the protected personal dashboard");
  return value;
}
