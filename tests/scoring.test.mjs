import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importJob, initializeDatabase, openDatabase, saveOnboardingProfileData } from "../lib/database.mjs";
import { scoringProfileFromConfig } from "../lib/onboarding.mjs";

function profile(weights = [60, 40]) {
  return scoringProfileFromConfig({
    scoring: {
      dimensions: [
        { id: "responsibility_match", label: "업무 일치", enabled: true, weight: weights[0] },
        { id: "evidence_strength", label: "보유 근거", enabled: true, weight: weights[1] },
      ],
    },
  });
}

function breakdown(scoringProfile, evidenceRefs = ["evidence-1"]) {
  return {
    profileChecksum: scoringProfile.checksum,
    dimensions: [
      { id: "responsibility_match", score: 90, reason: "요구 업무 대부분을 경험했습니다.", evidenceRefs: [], gaps: [] },
      { id: "evidence_strength", score: 70, reason: "확인된 근거가 있으나 보완할 항목이 있습니다.", evidenceRefs, gaps: ["추가 사례 확인"] },
    ],
  };
}

test("score breakdown uses the saved profile checksum, evidence ids, and server-side weights", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "score-breakdown-"));
  const dbPath = path.join(directory, "personal.sqlite");
  try {
    initializeDatabase(dbPath, { mode: "personal" });
    const db = openDatabase(dbPath);
    try {
      saveOnboardingProfileData(db, {
        careerStage: "experienced",
        documents: [],
        facts: [],
        evidence: [{ id: "evidence-1", title: "검증 근거", description: "업무 결과를 검증했습니다.", metrics: [], skills: [], sourceRefs: [] }],
        customSections: [],
      });
      const scoringProfile = profile();
      assert.equal(scoringProfile.configured, true);

      assert.throws(
        () => importJob(db, {
          jobKey: "stale-score", companyName: "Example A", title: "Example Role",
          scoreBreakdown: { ...breakdown(scoringProfile), profileChecksum: "stale" },
        }, { scoringProfile }),
        (error) => error.statusCode === 409,
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);

      assert.throws(
        () => importJob(db, {
          jobKey: "unknown-evidence", companyName: "Example B", title: "Example Role",
          scoreBreakdown: breakdown(scoringProfile, ["missing-evidence"]),
        }, { scoringProfile }),
        (error) => error.statusCode === 400 && /Unknown evidence/.test(error.message),
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);

      const jobId = importJob(db, {
        jobKey: "weighted-score", companyName: "Example C", title: "Example Role",
        scoreBreakdown: breakdown(scoringProfile),
      }, { scoringProfile });
      const stored = db.prepare("SELECT total_score, score_mode, profile_checksum, breakdown_json FROM job_scores WHERE job_id = ?").get(jobId);
      assert.equal(stored.total_score, 82);
      assert.equal(stored.score_mode, "breakdown");
      assert.equal(stored.profile_checksum, scoringProfile.checksum);
      assert.equal(JSON.parse(stored.breakdown_json).dimensions.length, 2);

      const changedProfile = profile([50, 50]);
      assert.notEqual(changedProfile.checksum, scoringProfile.checksum);
      assert.throws(
        () => importJob(db, {
          jobKey: "weighted-score", companyName: "Example C", title: "Example Role",
          scoreBreakdown: breakdown(scoringProfile),
        }, { scoringProfile: changedProfile }),
        (error) => error.statusCode === 409,
      );
      assert.equal(db.prepare("SELECT total_score FROM job_scores WHERE job_id = ?").get(jobId).total_score, 82);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an onboarding profile with no enabled dimensions does not silently enable scoring", () => {
  const scoringProfile = scoringProfileFromConfig({
    scoring: { dimensions: [{ id: "responsibility_match", label: "업무 일치", enabled: false, weight: 100 }] },
  });
  assert.equal(scoringProfile.configured, false);
  assert.deepEqual(scoringProfile.dimensions, []);
});
