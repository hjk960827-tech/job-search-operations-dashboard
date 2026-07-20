const ARCHIVED_APPLICATION_STATUSES = new Set(["skipped", "rejected"]);
const COMPLETED_APPLICATION_STATUSES = new Set(["applied", "interview", "offer"]);
const CLOSED_JOB_STATUSES = new Set(["closed", "expired", "ended"]);

export const WORKFLOW_STAGE_ORDER = [
  "review",
  "draft",
  "quality",
  "approval",
  "prepare",
  "submit",
  "complete",
];

const STAGES = {
  review: {
    label: "공고 검토",
    description: "공고와 출처를 확인하고 지원 검토를 시작합니다.",
    bucket: "review",
    action: "start_review",
    actionLabel: "공고 검토 시작",
  },
  draft: {
    label: "작업본 생성",
    description: "기본 이력서에서 이 공고에 맞는 수정 작업본을 만듭니다.",
    bucket: "quality",
    action: "create_package",
    actionLabel: "공고별 작업본 만들기",
  },
  quality: {
    label: "문안·품질 보완",
    description: "부족한 항목을 보완하고 품질 기준을 다시 확인합니다.",
    bucket: "quality",
    action: "edit_package",
    actionLabel: "문안 보완하기",
  },
  approval: {
    label: "승인 대기",
    description: "문안을 최종 확인하고 승인된 PDF를 생성합니다.",
    bucket: "approval",
    action: "approve_package",
    actionLabel: "문안 승인·PDF 생성",
  },
  prepare: {
    label: "수기 제출 준비",
    description: "승인된 PDF를 제출본으로 동결합니다.",
    bucket: "submission",
    action: "prepare_submission",
    actionLabel: "수기 제출 준비",
  },
  submit: {
    label: "제출 완료 기록",
    description: "채용 플랫폼에서 직접 제출한 뒤 완료를 기록합니다.",
    bucket: "submission",
    action: "record_submitted",
    actionLabel: "제출 완료 기록",
  },
  complete: {
    label: "제출 완료",
    description: "제출 기록이 완료되었습니다.",
    bucket: "complete",
    action: null,
    actionLabel: null,
  },
  archived: {
    label: "보관됨",
    description: "제외 또는 종료 상태로 보관된 공고입니다.",
    bucket: "archive",
    action: null,
    actionLabel: null,
  },
  blocked: {
    label: "진행 중단",
    description: "마감된 공고이므로 새 지원 작업을 진행할 수 없습니다.",
    bucket: "archive",
    action: null,
    actionLabel: null,
  },
};

function workflowValue(job, stage, overrides = {}) {
  const definition = STAGES[stage];
  return {
    stage,
    label: definition.label,
    description: definition.description,
    bucket: definition.bucket,
    nextAction: definition.action ? {
      type: definition.action,
      label: definition.actionLabel,
      deepLink: `#jobs?job=${Number(job.id)}&focus=${stage}`,
    } : null,
    ...overrides,
  };
}

export function deriveJobWorkflow(job) {
  const applicationStatus = String(job?.application?.workflowStatus || "new").toLowerCase();
  const lifecycleStatus = String(job?.status || "unknown").toLowerCase();
  const packageValue = job?.package || null;

  if (packageValue?.state === "submitted") return workflowValue(job, "complete");
  if (ARCHIVED_APPLICATION_STATUSES.has(applicationStatus)) return workflowValue(job, "archived");
  if (!packageValue && COMPLETED_APPLICATION_STATUSES.has(applicationStatus)) {
    return workflowValue(job, "complete", { description: "외부 지원 완료 상태가 기록되었습니다." });
  }
  if (CLOSED_JOB_STATUSES.has(lifecycleStatus)) return workflowValue(job, "blocked");
  if (packageValue?.refreshRequired) {
    return workflowValue(job, "quality", {
      label: "기준 변경 반영 필요",
      description: "기본 이력서·공고·품질 기준 변경을 확인하고 새 작업본을 만듭니다.",
      nextAction: packageValue.refreshAvailable ? {
        type: "refresh_package",
        label: "변경 반영하기",
        deepLink: `#jobs?job=${Number(job.id)}&focus=quality`,
      } : null,
    });
  }
  if (packageValue?.state === "quality_hold") return workflowValue(job, "quality");
  if (packageValue?.state === "approval_pending") return workflowValue(job, "approval");
  if (packageValue?.state === "approved") return workflowValue(job, "prepare");
  if (packageValue?.state === "submit_ready") return workflowValue(job, "submit");
  if (!packageValue && applicationStatus === "new") return workflowValue(job, "review");
  if (!packageValue) return workflowValue(job, "draft");
  return workflowValue(job, "blocked", { description: "현재 상태를 확인한 뒤 다시 시도해 주세요." });
}

function action(enabled, reason = "", extra = {}) {
  return { enabled: Boolean(enabled), reason: enabled ? "" : reason, ...extra };
}

export function deriveJobAllowedActions(job) {
  const workflow = job?.workflow || deriveJobWorkflow(job);
  const packageValue = job?.package || null;
  const archived = workflow.stage === "archived";
  const blocked = workflow.stage === "blocked";
  const packageLocked = packageValue?.refreshAvailable === false;
  const frozenReason = archived
    ? "제외 또는 종료 처리된 공고입니다."
    : blocked
      ? "마감되었거나 현재 진행할 수 없는 공고입니다."
      : "현재 단계에서는 사용할 수 없습니다.";
  const editablePackage = Boolean(
    packageValue
    && !packageValue.refreshRequired
    && !packageLocked
    && ["quality_hold", "approval_pending", "approved"].includes(packageValue.state),
  );
  const submissionReady = Boolean(
    packageValue?.state === "approved"
    && packageValue.pdf?.available
    && packageValue.approvedChecksum
    && packageValue.approvedChecksum === packageValue.checksum
    && !packageValue.refreshRequired
    && !packageLocked,
  );

  return {
    updateJobState: action(true),
    startReview: action(!packageValue && workflow.stage === "review", frozenReason),
    createPackage: action(!packageValue && workflow.stage === "draft", frozenReason),
    requestPackageGeneration: action(
      (!packageValue && workflow.stage === "draft")
        || Boolean(packageValue && ["draft", "quality", "approval"].includes(workflow.stage) && !packageLocked),
      frozenReason,
      { requiresCompanion: true },
    ),
    refreshPackage: action(
      Boolean(packageValue?.refreshRequired && packageValue.refreshAvailable),
      packageValue?.refreshRequired
        ? "이 공고 상태에서는 새 문서 버전을 만들 수 없습니다."
        : "기준 정보 변경이 없어 새 버전이 필요하지 않습니다.",
    ),
    editPackage: action(editablePackage, packageLocked ? frozenReason : "승인 전 작업본만 수정할 수 있습니다."),
    approvePackage: action(
      Boolean(editablePackage && packageValue?.state === "approval_pending"),
      "품질 기준을 통과한 승인 대기 문서만 승인할 수 있습니다.",
    ),
    prepareSubmission: action(
      submissionReady,
      "승인된 최신 문안과 검증된 PDF가 모두 준비되어야 합니다.",
    ),
    recordSubmitted: action(
      Boolean(packageValue?.state === "submit_ready" && !packageLocked),
      "수기 제출 준비가 완료된 문서만 제출 완료로 기록할 수 있습니다.",
    ),
  };
}

export function buildWorkflowOverview(jobs, { followUps = [] } = {}) {
  const items = (jobs || []).map((job) => ({
    jobId: job.id,
    companyName: job.companyName,
    title: job.title,
    workflow: job.workflow || deriveJobWorkflow(job),
  }));
  const buckets = { review: [], quality: [], approval: [], submission: [], complete: [], archive: [] };
  for (const item of items) buckets[item.workflow.bucket]?.push(item);
  const counts = Object.fromEntries(Object.entries(buckets).map(([key, values]) => [key, values.length]));
  counts.followUp = followUps.length;
  return { counts, buckets, followUps, total: items.length };
}
