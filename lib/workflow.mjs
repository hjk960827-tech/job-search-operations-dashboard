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
