const SENSITIVE_PARAMETER_NAMES = new Set([
  "accesstoken", "apikey", "authorization", "authtoken", "bearertoken", "clientsecret",
  "cookie", "credential", "credentials", "idtoken", "jwt", "password", "passwd",
  "refreshtoken", "secret", "session", "sessionid", "signature", "signedtoken", "token",
]);

function urlError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function normalizedParameterName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sensitiveParameterName(value) {
  const normalized = normalizedParameterName(value);
  if (SENSITIVE_PARAMETER_NAMES.has(normalized)) return true;
  return /(?:token|secret|password|passwd|credential|signature|sessionid)$/.test(normalized);
}

function fragmentParameterNames(hash) {
  const fragment = String(hash || "").replace(/^#/, "");
  if (!fragment) return [];
  const query = fragment.includes("?") ? fragment.slice(fragment.indexOf("?") + 1) : fragment;
  if (query.includes("=")) return [...new URLSearchParams(query).keys()];
  const first = query.split(/[/:]/, 1)[0];
  return first ? [first] : [];
}

export function normalizePublicHttpUrl(value, field = "Job source URL") {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw urlError(`${field} must be a valid URL`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw urlError("Only HTTP(S) job sources are allowed");
  }
  if (url.username || url.password) {
    throw urlError("Job source URLs must not contain usernames or passwords");
  }
  const unsafeKey = [
    ...url.searchParams.keys(),
    ...fragmentParameterNames(url.hash),
  ].find(sensitiveParameterName);
  if (unsafeKey) {
    throw urlError("Job source URLs must not contain credential-like query or fragment parameters");
  }
  return url.toString();
}
