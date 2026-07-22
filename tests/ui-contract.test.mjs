import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUiContract,
  UI_CONTRACT_ID,
  UI_CONTRACT_SCHEMA_VERSION,
} from "../lib/ui-contract.mjs";

test("UI contract is versioned and supports both frontend generations", () => {
  const contract = buildUiContract({ mode: "personal" });
  assert.equal(contract.contractId, UI_CONTRACT_ID);
  assert.equal(contract.schemaVersion, UI_CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(contract.frontendVersions, ["v2", "v3"]);
  assert.equal(contract.defaultFrontend, "v2");
  assert.equal(contract.readModels.bootstrap, "/api/bootstrap");
  assert.equal(contract.readModels.jobDetail, "/api/jobs/:jobId");
  assert.ok(contract.navigationIntents.includes("package_review"));
  assert.ok(contract.navigationIntents.includes("application_results"));
});

test("UI contract exposes runtime capabilities without enabling unsupported automation", () => {
  const onboarding = buildUiContract({ mode: "onboarding" });
  assert.deepEqual(onboarding.capabilities.onboarding, { available: true, writable: true });
  assert.deepEqual(onboarding.capabilities.jobs, { available: false, writable: false });

  const demo = buildUiContract({ mode: "demo" });
  assert.deepEqual(demo.capabilities.jobs, { available: true, writable: false });
  assert.deepEqual(demo.capabilities.packageWorkflow, { available: true, writable: false });
  assert.deepEqual(demo.capabilities.savedFilters, { available: false, writable: false });
  assert.deepEqual(demo.capabilities.localNotifications, { available: false, writable: false });

  const personal = buildUiContract({ mode: "personal" });
  assert.deepEqual(personal.capabilities.jobs, { available: true, writable: true });
  assert.deepEqual(personal.capabilities.resumeManagement, { available: true, writable: true });
  assert.deepEqual(personal.capabilities.jobState, { available: true, writable: true });
  assert.deepEqual(personal.capabilities.settings, { available: true, writable: true });
  assert.deepEqual(personal.capabilities.documents, { available: true, writable: true });
  assert.deepEqual(personal.capabilities.packageGenerationRequest, { available: true, writable: true });
  assert.deepEqual(personal.capabilities.packagePdfPreview, { available: false, writable: false });
  assert.deepEqual(personal.capabilities.packageReviewTransitions, { available: true, writable: true });
  assert.deepEqual(personal.capabilities.cancelSubmissionPreparation, { available: true, writable: true });
  assert.deepEqual(personal.capabilities.markAllNotificationsRead, { available: true, writable: true });
  assert.deepEqual(personal.capabilities.outcomeEvidenceUpload, { available: true, writable: true });
  assert.deepEqual(personal.capabilities.automaticSubmission, { available: false, writable: false });
  assert.equal(personal.constraints.builtInCrawler, false);
  assert.equal(personal.constraints.builtInAiClient, false);
  assert.equal(personal.constraints.storesAiCredentials, false);
});

test("UI contract contains no local file path or user-specific value", () => {
  const serialized = JSON.stringify(buildUiContract({ mode: "personal" }));
  assert.equal(serialized.includes("/Users/"), false);
  assert.equal(serialized.includes("example_user_specific_marker"), false);
  assert.equal(serialized.includes("token"), false);
});

test("UI contract rejects unknown runtime modes", () => {
  assert.throws(() => buildUiContract({ mode: "saas" }), /Unsupported UI contract mode/);
});
