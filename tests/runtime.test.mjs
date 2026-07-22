import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRuntimeSetup,
  codespacesForwardedHost,
  isAllowedRequestHost,
  isAllowedRequestOrigin,
  isApplicationJson,
  protectLocalRequest,
  readJsonBody,
  runtimeHost,
  runtimePort,
} from "../lib/runtime.mjs";

const codespacesEnv = {
  CODESPACES: "true",
  CODESPACE_NAME: "example-user-job-search-abc123",
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
};
const codespacesHost = "example-user-job-search-abc123-8766.app.github.dev";

function fakeRequest(chunks, headers = {}) {
  return {
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  };
}

test("runtime host is restricted to loopback addresses", () => {
  assert.equal(runtimeHost({}), "127.0.0.1");
  assert.equal(runtimeHost({ HOST: "localhost" }), "localhost");
  assert.equal(runtimeHost({ HOST: "[::1]" }), "::1");
  assert.throws(() => runtimeHost({ HOST: "0.0.0.0" }), /loopback/);
  assert.throws(() => runtimeHost({ HOST: "192.168.0.10" }), /loopback/);
});

test("release runtime can never claim the protected personal port", () => {
  assert.equal(runtimePort({}), 8766);
  assert.equal(runtimePort({ PORT: " 8766 " }), 8766);
  assert.throws(() => runtimePort({ PORT: "8765" }), /reserved/);
  assert.throws(() => runtimePort({ PORT: "8766-extra" }), /integer/);
  assert.throws(() => runtimePort({ PORT: "8766.5" }), /integer/);
});

test("personal mode fails closed until all local configuration is complete", () => {
  assert.equal(assertRuntimeSetup("demo", false), "demo");
  assert.equal(assertRuntimeSetup("personal", true), "personal");
  assert.throws(() => assertRuntimeSetup("personal", false), /requires all four/);
});

test("request host and origin accept only the configured local port", () => {
  assert.equal(isAllowedRequestHost("127.0.0.1:8766", 8766), true);
  assert.equal(isAllowedRequestHost("localhost:8766", 8766), true);
  assert.equal(isAllowedRequestHost("evil.example:8766", 8766), false);
  assert.equal(isAllowedRequestHost("127.0.0.1:9000", 8766), false);
  assert.equal(isAllowedRequestOrigin("http://127.0.0.1:8766", 8766), true);
  assert.equal(isAllowedRequestOrigin("http://localhost:8766", 8766), true);
  assert.equal(isAllowedRequestOrigin("https://127.0.0.1:8766", 8766), false);
  assert.equal(isAllowedRequestOrigin("https://evil.example", 8766), false);
});

test("request host and origin accept only the exact private Codespaces forwarding address", () => {
  assert.equal(codespacesForwardedHost(8766, codespacesEnv), codespacesHost);
  assert.equal(isAllowedRequestHost(codespacesHost, 8766, codespacesEnv), true);
  assert.equal(isAllowedRequestOrigin(`https://${codespacesHost}`, 8766, codespacesEnv), true);
  assert.equal(isAllowedRequestHost(`other-${codespacesHost}`, 8766, codespacesEnv), false);
  assert.equal(isAllowedRequestHost(`${codespacesHost}:8766`, 8766, codespacesEnv), false);
  assert.equal(isAllowedRequestOrigin(`http://${codespacesHost}`, 8766, codespacesEnv), false);
  assert.equal(isAllowedRequestOrigin(`https://${codespacesHost}.evil.example`, 8766, codespacesEnv), false);
  assert.equal(codespacesForwardedHost(8766, { ...codespacesEnv, CODESPACE_NAME: "bad/name" }), null);
  assert.equal(codespacesForwardedHost(8766, { ...codespacesEnv, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "localhost" }), null);
  assert.doesNotThrow(() => protectLocalRequest({
    method: "PATCH",
    pathname: "/api/onboarding",
    headers: { host: codespacesHost, origin: `https://${codespacesHost}`, "content-type": "application/json" },
    port: 8766,
    mode: "onboarding",
    env: codespacesEnv,
  }));
  assert.throws(
    () => protectLocalRequest({
      method: "PATCH",
      pathname: "/api/onboarding",
      headers: { host: codespacesHost, origin: "https://evil.example", "content-type": "application/json" },
      port: 8766,
      mode: "onboarding",
      env: codespacesEnv,
    }),
    (error) => error.statusCode === 403,
  );
});

test("central request guard makes every demo API mutation read-only", () => {
  const headers = { host: "127.0.0.1:8766", "content-type": "application/json" };
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.throws(
      () => protectLocalRequest({ method, pathname: "/api/future-write-route", headers, port: 8766, mode: "demo" }),
      (error) => error.statusCode === 409,
    );
  }
  assert.doesNotThrow(() => protectLocalRequest({ method: "GET", pathname: "/api/dashboard", headers, port: 8766, mode: "demo" }));
});

test("onboarding mode permits only onboarding mutations and requires multipart uploads", () => {
  const jsonHeaders = { host: "127.0.0.1:8766", "content-type": "application/json" };
  assert.doesNotThrow(() => protectLocalRequest({
    method: "PATCH", pathname: "/api/onboarding", headers: jsonHeaders, port: 8766, mode: "onboarding",
  }));
  assert.throws(
    () => protectLocalRequest({ method: "POST", pathname: "/api/jobs", headers: jsonHeaders, port: 8766, mode: "onboarding" }),
    (error) => error.statusCode === 409,
  );
  assert.throws(
    () => protectLocalRequest({ method: "POST", pathname: "/api/onboarding/documents", headers: jsonHeaders, port: 8766, mode: "onboarding" }),
    (error) => error.statusCode === 415,
  );
  assert.doesNotThrow(() => protectLocalRequest({
    method: "POST",
    pathname: "/api/onboarding/documents",
    headers: { host: "127.0.0.1:8766", "content-type": "multipart/form-data; boundary=example" },
    port: 8766,
    mode: "onboarding",
  }));
});

test("request guard rejects foreign origins and non-JSON personal mutations", () => {
  assert.throws(
    () => protectLocalRequest({
      method: "GET",
      pathname: "/api/dashboard",
      headers: { host: "127.0.0.1:8766", origin: "https://evil.example" },
      port: 8766,
      mode: "personal",
    }),
    (error) => error.statusCode === 403,
  );
  assert.throws(
    () => protectLocalRequest({
      method: "PATCH",
      pathname: "/api/jobs/1/state",
      headers: { host: "127.0.0.1:8766", "content-type": "text/plain" },
      port: 8766,
      mode: "personal",
    }),
    (error) => error.statusCode === 415,
  );
  assert.equal(isApplicationJson("application/json; charset=utf-8"), true);
  assert.equal(isApplicationJson("text/json"), false);
  assert.doesNotThrow(() => protectLocalRequest({
    method: "POST",
    pathname: "/api/settings/documents",
    headers: { host: "127.0.0.1:8766", "content-type": "multipart/form-data; boundary=example" },
    port: 8766,
    mode: "personal",
  }));
  assert.doesNotThrow(() => protectLocalRequest({
    method: "POST",
    pathname: "/api/outcomes/7/evidence",
    headers: { host: "127.0.0.1:8766", "content-type": "multipart/form-data; boundary=example" },
    port: 8766,
    mode: "personal",
  }));
  assert.throws(
    () => protectLocalRequest({
      method: "POST", pathname: "/api/settings/documents",
      headers: { host: "127.0.0.1:8766", "content-type": "application/json" },
      port: 8766, mode: "personal",
    }),
    (error) => error.statusCode === 415,
  );
});

test("JSON reader maps oversized and non-object bodies to client errors", async () => {
  await assert.rejects(
    () => readJsonBody(fakeRequest([], { "content-length": "100001" })),
    (error) => error.statusCode === 413,
  );
  await assert.rejects(
    () => readJsonBody(fakeRequest(["a".repeat(60_000), "b".repeat(50_000)])),
    (error) => error.statusCode === 413,
  );
  await assert.rejects(
    () => readJsonBody(fakeRequest(["[]"])),
    (error) => error.statusCode === 400,
  );
  assert.deepEqual(await readJsonBody(fakeRequest(["{\"ok\":true}"])), { ok: true });
});
