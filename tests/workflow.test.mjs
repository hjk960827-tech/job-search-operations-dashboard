import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowOverview, deriveJobWorkflow } from "../lib/workflow.mjs";

function job(overrides = {}) {
  return {
    id: overrides.id || 1,
    companyName: overrides.companyName || "Example Organization",
    title: overrides.title || "Example Role",
    status: overrides.status || "active",
    application: { workflowStatus: "new", ...(overrides.application || {}) },
    package: overrides.package === undefined ? null : overrides.package,
  };
}

test("workflow is derived from application and package state without another stored status", () => {
  const cases = [
    [job(), "review", "start_review"],
    [job({ application: { workflowStatus: "reviewing" } }), "draft", "create_package"],
    [job({ package: { state: "quality_hold" } }), "quality", "edit_package"],
    [job({ package: { state: "approval_pending" } }), "approval", "approve_package"],
    [job({ package: { state: "approved" } }), "prepare", "prepare_submission"],
    [job({ package: { state: "submit_ready" } }), "submit", "record_submitted"],
    [job({ package: { state: "submitted" } }), "complete", null],
    [job({ application: { workflowStatus: "applied" } }), "complete", null],
    [job({ application: { workflowStatus: "skipped" } }), "archived", null],
    [job({ application: { workflowStatus: "rejected" } }), "archived", null],
    [job({ status: "closed" }), "blocked", null],
    [job({ status: "closed", package: { state: "quality_hold" } }), "blocked", null],
  ];
  for (const [input, stage, action] of cases) {
    const result = deriveJobWorkflow(input);
    assert.equal(result.stage, stage);
    assert.equal(result.nextAction?.type || null, action);
    if (result.nextAction) assert.equal(result.nextAction.deepLink, `#jobs?job=${input.id}&focus=${stage}`);
  }
});

test("stale packages require an explicit refresh only when refresh is available", () => {
  const available = deriveJobWorkflow(job({ package: { state: "approved", refreshRequired: true, refreshAvailable: true } }));
  assert.equal(available.stage, "quality");
  assert.equal(available.nextAction.type, "refresh_package");
  const unavailable = deriveJobWorkflow(job({ package: { state: "approved", refreshRequired: true, refreshAvailable: false } }));
  assert.equal(unavailable.stage, "quality");
  assert.equal(unavailable.nextAction, null);
});

test("workbox groups the same derived records into review, quality, approval, and submission queues", () => {
  const jobs = [
    job({ id: 1 }),
    job({ id: 2, application: { workflowStatus: "reviewing" } }),
    job({ id: 3, package: { state: "quality_hold" } }),
    job({ id: 4, package: { state: "approval_pending" } }),
    job({ id: 5, package: { state: "approved" } }),
    job({ id: 6, package: { state: "submit_ready" } }),
    job({ id: 7, package: { state: "submitted" } }),
    job({ id: 8, application: { workflowStatus: "rejected" } }),
  ].map((item) => ({ ...item, workflow: deriveJobWorkflow(item) }));
  const overview = buildWorkflowOverview(jobs);
  assert.deepEqual(overview.counts, { review: 1, quality: 2, approval: 1, submission: 2, complete: 1, archive: 1, followUp: 0 });
  assert.deepEqual(overview.buckets.submission.map((item) => item.jobId), [5, 6]);
  assert.equal(overview.total, 8);
});

test("workbox carries pending follow-ups without creating another job status", () => {
  const followUps = [{ id: "follow-1", jobId: 1, title: "Check reply", dueAt: "2026-07-21T00:00:00.000Z" }];
  const overview = buildWorkflowOverview([job()], { followUps });
  assert.equal(overview.counts.followUp, 1);
  assert.equal(overview.followUps, followUps);
  assert.equal(overview.buckets.review.length, 1);
});
