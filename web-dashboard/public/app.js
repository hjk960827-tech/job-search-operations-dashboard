const state = {
  data: null,
  uiContract: null,
  selectedJobId: null,
  screen: "home",
  filters: { search: "", track: "", platform: "", status: "", lifecycle: "active", deadline: "", sort: "score", favorite: false },
  onboarding: null,
  outcomes: new Map(),
  pagination: { page: 1, pageSize: 30, total: 0, totalPages: 1 },
  facets: { tracks: [], platforms: [] },
  cache: { etags: new Map(), details: new Map() },
  companionReviews: new Map(),
  personalSettings: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const statusLabels = {
  new: "신규",
  reviewing: "검토 중",
  skipped: "제외",
  applied: "지원 완료",
  interview: "면접",
  offer: "제안",
  rejected: "종료",
};

const packageStateLabels = {
  quality_hold: "품질 보완 필요",
  approval_pending: "승인 대기",
  approved: "승인 완료",
  submit_ready: "제출 준비 완료",
  submitted: "제출 완료",
};

const sourceStatusLabels = {
  active: "게시 중",
  closed: "마감",
  unknown: "확인 필요",
};

const companionKindLabels = {
  collect_jobs: "공고 수집",
  analyze_documents: "등록 문서 분석",
  generate_package: "공고별 문서 생성",
};

const companionStatusLabels = {
  queued: "대기 중",
  running: "처리 중",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

const companionReviewLabels = {
  awaiting_review: "결과 검토 필요",
  accepted: "반영 완료",
  rejected: "사용 안 함",
  superseded: "새 입력으로 대체됨",
};

const defaultDocumentQualityCriteria = [
  { id: "required_sections", label: "필수 항목 작성", enabled: true, weight: 35, required: true },
  { id: "content_depth", label: "내용 구체성", enabled: true, weight: 35 },
  { id: "placeholder_free", label: "미확정 문구 제거", enabled: true, weight: 20, required: true },
  { id: "job_focus_coverage", label: "공고 중점 항목 반영", enabled: true, weight: 10 },
  { id: "evidence_traceability", label: "수정 내용의 근거 연결", enabled: false, weight: 0 },
];

const structuredKindLabels = {
  experience: "경력",
  education: "학력",
  skill: "기술",
  certification: "자격·인증",
  project: "프로젝트",
};

function sourceConfidenceLabel(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return "확인 필요";
  if (score >= 80) return "높음";
  if (score >= 50) return "보통";
  return "낮음";
}

function isReadOnlyDemo() {
  return state.data?.mode !== "personal";
}

function capabilityWritable(name) {
  const value = state.uiContract?.capabilities?.[name];
  return Boolean(value?.available && value?.writable);
}

function protectDemoControl(control) {
  if (isReadOnlyDemo()) {
    control.disabled = true;
    control.title = "예시 모드는 읽기 전용입니다. 개인 설정을 완료한 뒤 사용할 수 있습니다.";
  }
  return control;
}

function protectBackendControl(control, { capability = "", job = null, action = "" } = {}) {
  protectDemoControl(control);
  const contractCapability = capability ? state.uiContract?.capabilities?.[capability] : null;
  if (!control.disabled && contractCapability && (!contractCapability.available || !contractCapability.writable)) {
    control.disabled = true;
    control.title = "현재 실행 모드의 백엔드에서는 이 기능을 사용할 수 없습니다.";
  }
  const actionValue = action ? job?.allowedActions?.[action] : null;
  if (!control.disabled && actionValue && !actionValue.enabled) {
    control.disabled = true;
    control.title = actionValue.reason || "현재 공고 단계에서는 이 기능을 사용할 수 없습니다.";
  }
  return control;
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 3000);
}

function formatDateTime(value) {
  if (!value) return "";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  const options = {
    timeZone: state.data?.profile?.timezone || "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("ko-KR", options).format(date);
  } catch {
    return new Intl.DateTimeFormat("ko-KR", { ...options, timeZone: "Asia/Seoul" }).format(date);
  }
}

async function request(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(url, {
    ...options,
    headers: isFormData ? { ...(options.headers || {}) } : { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "요청을 처리하지 못했습니다.");
  return payload;
}

async function revisionedRequest(url, { force = false } = {}) {
  const headers = {};
  const etag = state.cache.etags.get(url);
  if (etag && !force) headers["if-none-match"] = etag;
  const response = await fetch(url, { headers });
  if (response.status === 304) return null;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "요청을 처리하지 못했습니다.");
  const nextEtag = response.headers.get("etag");
  if (nextEtag) state.cache.etags.set(url, nextEtag);
  return payload;
}

function jobPageUrl() {
  const params = new URLSearchParams({
    page: String(state.pagination.page),
    pageSize: String(state.pagination.pageSize),
  });
  for (const [key, value] of Object.entries(state.filters)) {
    if (value !== "" && value !== false) params.set(key, String(value));
  }
  return `/api/jobs?${params}`;
}

async function loadJobPage({ force = false, render = true } = {}) {
  const payload = await revisionedRequest(jobPageUrl(), { force });
  if (payload) {
    state.data.jobs = payload.items;
    state.pagination = {
      page: payload.page,
      pageSize: payload.pageSize,
      total: payload.total,
      totalPages: payload.totalPages,
    };
    state.facets = payload.facets || state.facets;
    state.data.revisions = payload.revisions;
  }
  if (render) {
    fillSelect($("#trackFilter"), state.facets.tracks || []);
    fillSelect($("#platformFilter"), state.facets.platforms || []);
    renderJobs();
    renderPagination();
  }
  return payload;
}

async function loadWorkflow({ force = false } = {}) {
  const payload = await revisionedRequest("/api/workflow", { force });
  if (payload) {
    state.data.workflow = payload.workflow;
    state.data.revisions = payload.revisions;
  }
  renderWorkflow();
}

async function refreshDashboardData() {
  state.cache.etags.clear();
  state.cache.details.clear();
  state.data = await request("/api/bootstrap");
  await Promise.all([
    loadJobPage({ force: true, render: false }),
    loadWorkflow({ force: true }),
  ]);
  renderAll();
}

async function loadPersonalSettings() {
  if (isReadOnlyDemo()) return;
  const payload = await request("/api/settings");
  state.personalSettings = payload.settings;
  renderSettings();
  renderDocumentManager();
}

function setScreen(screen) {
  state.screen = screen;
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.screen === screen));
  $("#workflowScreen").hidden = screen !== "home";
  $("#jobsScreen").hidden = screen !== "jobs";
  $("#inboxScreen").hidden = screen !== "inbox";
  $("#companionScreen").hidden = screen !== "companion";
  $("#resumeScreen").hidden = screen !== "resume";
  $("#settingsScreen").hidden = screen !== "settings";
  $("#onboardingScreen").hidden = true;
}

function fillSelect(select, values) {
  const current = select.value;
  const first = select.firstElementChild.cloneNode(true);
  select.replaceChildren(first);
  for (const value of values.filter(Boolean).sort((a, b) => a.localeCompare(b))) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  select.value = values.includes(current) ? current : "";
}

function filteredJobs() {
  const query = state.filters.search.toLowerCase();
  const jobs = state.data.jobs.filter((job) => {
    if (query && !`${job.companyName} ${job.title} ${job.summary}`.toLowerCase().includes(query)) return false;
    if (state.filters.track && job.track !== state.filters.track) return false;
    if (state.filters.platform && !job.sources.some((source) => source.platform === state.filters.platform)) return false;
    if (state.filters.status && job.application.workflowStatus !== state.filters.status) return false;
    const lifecycleStatus = String(job.status || "unknown").trim().toLowerCase();
    const archived = ["closed", "expired", "ended"].includes(lifecycleStatus)
      || ["skipped", "rejected"].includes(job.application.workflowStatus);
    if (state.filters.lifecycle === "active" && archived) return false;
    if (state.filters.lifecycle === "archive" && !archived) return false;
    if (state.filters.favorite && !job.application.favorite) return false;
    if (state.filters.deadline === "urgent" && !(Number.isFinite(job.deadlineDays) && job.deadlineDays >= 0 && job.deadlineDays <= 7)) return false;
    if (state.filters.deadline === "overdue" && !(Number.isFinite(job.deadlineDays) && job.deadlineDays < 0)) return false;
    if (state.filters.deadline === "none" && job.deadline) return false;
    return true;
  });
  return jobs.sort((left, right) => {
    if (state.filters.sort === "deadline") {
      const leftValue = Number.isFinite(left.deadlineDays) ? left.deadlineDays : Number.MAX_SAFE_INTEGER;
      const rightValue = Number.isFinite(right.deadlineDays) ? right.deadlineDays : Number.MAX_SAFE_INTEGER;
      return leftValue - rightValue || left.companyName.localeCompare(right.companyName);
    }
    if (state.filters.sort === "recent") {
      const latest = (job) => Math.max(0, ...(job.sources || []).map((source) => Date.parse(source.checkedAt) || 0));
      return latest(right) - latest(left) || left.companyName.localeCompare(right.companyName);
    }
    return Number(right.score ?? -1) - Number(left.score ?? -1) || left.companyName.localeCompare(right.companyName);
  });
}

function deadlineLabel(job) {
  if (!job.deadline) return "";
  if (job.deadlineDays < 0) return `마감 ${Math.abs(job.deadlineDays)}일 경과`;
  if (job.deadlineDays === 0) return "D-Day";
  return `D-${job.deadlineDays}`;
}

async function navigateToJob(jobId, focus = "", { preserveFilters = false } = {}) {
  const id = Number(jobId);
  const summary = state.data.jobs.find((item) => item.id === id);
  state.selectedJobId = id;
  if (!preserveFilters) {
    state.filters = { search: "", track: "", platform: "", status: "", lifecycle: "all", deadline: "", sort: "score", favorite: false };
    state.pagination.page = 1;
    syncFilterControls();
    loadJobPage({ force: true }).catch((error) => showToast(error.message, true));
  }
  setScreen("jobs");
  renderJobs();
  const detail = $("#jobDetail");
  detail.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "empty-state";
  const title = document.createElement("h3");
  title.textContent = summary ? `${summary.companyName} · ${summary.title}` : "공고 상세 불러오는 중";
  const copy = document.createElement("p");
  copy.textContent = "선택한 공고의 출처와 지원 문서를 불러오고 있습니다.";
  loading.append(title, copy);
  detail.append(loading);
  window.history.replaceState(null, "", `#jobs?job=${id}${focus ? `&focus=${encodeURIComponent(focus)}` : ""}`);
  try {
    const url = `/api/jobs/${id}`;
    const payload = await revisionedRequest(url);
    if (payload) state.cache.details.set(id, payload.detail);
    const job = payload?.detail || state.cache.details.get(id);
    if (!job) throw new Error("공고 상세 캐시를 다시 불러와야 합니다.");
    if (state.selectedJobId !== id) return;
    renderDetail(job.id, job);
  } catch (error) {
    if (state.selectedJobId === id) showToast(error.message, true);
    return;
  }
  window.setTimeout(() => {
    const target = focus === "outcomes" ? $("#jobDetail .outcome-panel") : $("#jobDetail");
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, 0);
}

function createJobCard(job) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `job-card${state.selectedJobId === job.id ? " active" : ""}`;

  const score = document.createElement("span");
  score.className = `job-score${job.score === null ? " empty" : ""}`;
  const reviewBelow = Number(state.data.scoreReviewBelow ?? 70);
  if (job.score !== null && Number(job.score) < reviewBelow) {
    score.classList.add("caution");
    score.title = "적합도 주의";
  }
  score.textContent = job.score === null ? "–" : Math.round(job.score);

  const companyCell = document.createElement("div");
  companyCell.className = "job-cell job-company-cell";
  const company = document.createElement("p");
  company.className = "job-company";
  company.textContent = `${job.application.favorite ? "★ " : ""}${job.companyName}`;
  if (job.application.favorite) company.classList.add("favorite-star");
  companyCell.append(company);

  const positionCell = document.createElement("div");
  positionCell.className = "job-cell job-position-cell";
  const title = document.createElement("h3");
  title.textContent = job.title;
  const meta = document.createElement("div");
  meta.className = "job-meta";
  for (const value of [job.location, job.employmentType]) {
    if (!value) continue;
    const span = document.createElement("span");
    span.textContent = value;
    meta.append(span);
  }
  if (job.discovery?.isNew) {
    const span = document.createElement("span");
    span.className = "discovery-badge new";
    span.textContent = "새 공고";
    meta.append(span);
  }
  if (job.discovery?.isReopened) {
    const span = document.createElement("span");
    span.className = "discovery-badge reopened";
    span.textContent = `재오픈${job.discovery.reopenCount > 1 ? ` ${job.discovery.reopenCount}회` : ""}`;
    span.title = job.discovery.reopenedAt ? `최근 재오픈 ${formatDateTime(job.discovery.reopenedAt)}` : "마감 후 다시 활성화된 공고";
    meta.append(span);
  }
  positionCell.append(title, meta);

  const track = document.createElement("span");
  track.className = "job-cell job-chip-cell";
  track.textContent = job.track || "미분류";

  const deadline = document.createElement("span");
  deadline.className = `job-cell job-deadline${job.deadlineDays !== null && job.deadlineDays <= 7 ? " deadline-urgent" : ""}`;
  deadline.textContent = job.deadline ? `${deadlineLabel(job)} · ${job.deadline}` : "상시·미정";

  const platform = document.createElement("span");
  platform.className = "job-cell job-platform";
  platform.textContent = job.primarySource?.platform ? sourceLabel(job.primarySource.platform) : "출처 확인";

  const status = document.createElement("span");
  status.className = `job-cell job-status job-status-${job.application.workflowStatus}`;
  status.textContent = statusLabels[job.application.workflowStatus] || "확인 필요";

  const favorite = document.createElement("span");
  favorite.className = `job-cell job-favorite${job.application.favorite ? " active" : ""}`;
  favorite.textContent = job.application.favorite ? "♥" : "♡";
  favorite.setAttribute("aria-label", job.application.favorite ? "관심 공고" : "관심 없음");

  button.append(score, companyCell, positionCell, track, deadline, platform, status, favorite);
  button.addEventListener("click", () => navigateToJob(job.id, job.workflow?.stage || "", { preserveFilters: true }));
  return button;
}

function renderQuickFilters() {
  const dynamic = $("#trackQuickTabs");
  dynamic.replaceChildren();
  for (const value of (state.facets.tracks || []).filter(Boolean).slice(0, 4)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `quick-tab${state.filters.track === value ? " active" : ""}`;
    button.dataset.quickKind = "track";
    button.dataset.quickValue = value;
    button.textContent = value;
    dynamic.append(button);
  }
  for (const button of $$("#jobQuickTabs > .quick-tab")) {
    const kind = button.dataset.quickKind;
    const active = kind === "all"
      ? !state.filters.track && !state.filters.favorite && !["applied", "skipped"].includes(state.filters.status)
      : kind === "favorite"
        ? state.filters.favorite
        : state.filters.status === kind;
    button.classList.toggle("active", active);
  }
}

function renderJobStatusSummary() {
  const overview = state.data.workflow || { counts: {}, total: 0 };
  const items = [
    ["전체", state.pagination.total],
    ["검토", overview.counts?.review || 0],
    ["보완 필요", overview.counts?.quality || 0],
    ["승인 대기", overview.counts?.approval || 0],
    ["제출 준비", overview.counts?.submission || 0],
    ["후속조치", overview.counts?.followUp || 0],
  ];
  const container = $("#jobStatusSummary");
  container.replaceChildren();
  for (const [label, count] of items) {
    const chip = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = count;
    chip.append(strong, ` ${label}`);
    container.append(chip);
  }
}

function renderWorkflow() {
  const overview = state.data.workflow || { counts: {}, buckets: {}, total: 0 };
  $("#workflowCount").textContent = `${overview.total || 0}건`;
  $("#workflowReviewCount").textContent = overview.counts?.review || 0;
  $("#workflowQualityCount").textContent = overview.counts?.quality || 0;
  $("#workflowApprovalCount").textContent = overview.counts?.approval || 0;
  $("#workflowSubmissionCount").textContent = overview.counts?.submission || 0;
  $("#workflowFollowUpCount").textContent = overview.counts?.followUp || 0;
  const container = $("#workflowQueues");
  container.replaceChildren();
  const followUpSection = document.createElement("section");
  followUpSection.className = "card workflow-queue follow-up-workbox";
  const followUpHeading = document.createElement("div");
  followUpHeading.className = "workflow-queue-heading";
  const followUpHeadingText = document.createElement("div");
  const followUpTitle = document.createElement("h3");
  followUpTitle.textContent = "예정 후속조치";
  const followUpDescription = document.createElement("p");
  followUpDescription.textContent = "제출 이후 오늘 해야 하거나 예정된 확인 작업입니다.";
  followUpHeadingText.append(followUpTitle, followUpDescription);
  const followUpCount = document.createElement("span");
  followUpCount.className = "count-pill";
  followUpCount.textContent = `${overview.followUps?.length || 0}건`;
  followUpHeading.append(followUpHeadingText, followUpCount);
  const followUpList = document.createElement("div");
  followUpList.className = "workflow-task-list";
  for (const item of overview.followUps || []) {
    const row = document.createElement("article");
    row.className = `workflow-task${Number(item.daysUntil) < 0 ? " overdue" : ""}`;
    const copy = document.createElement("div");
    const company = document.createElement("span");
    company.textContent = item.companyName;
    const title = document.createElement("strong");
    title.textContent = item.title;
    const due = document.createElement("small");
    due.textContent = `${outcomeDateLabel(item.daysUntil)} · ${item.dueAt.slice(0, 10)} · ${item.jobTitle}`;
    copy.append(company, title, due);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary-button";
    open.textContent = "결과·후속조치 열기";
    open.addEventListener("click", () => navigateToJob(item.jobId, "outcomes"));
    row.append(copy, open);
    followUpList.append(row);
  }
  if (!(overview.followUps || []).length) {
    const empty = document.createElement("p");
    empty.className = "workflow-empty";
    empty.textContent = "예정된 후속조치가 없습니다.";
    followUpList.append(empty);
  }
  followUpSection.append(followUpHeading, followUpList);
  container.append(followUpSection);
  const definitions = [
    ["review", "공고 검토", "새 공고를 확인하고 지원 검토 여부를 정합니다."],
    ["quality", "보완 필요", "작업본 생성, 문안 수정 또는 기준 변경 반영이 필요합니다."],
    ["approval", "승인 대기", "문안을 확인하고 승인된 PDF를 생성합니다."],
    ["submission", "제출 준비", "제출본 동결 또는 제출 완료 기록이 필요합니다."],
  ];
  for (const [bucket, titleText, descriptionText] of definitions) {
    const section = document.createElement("section");
    section.className = "card workflow-queue";
    const heading = document.createElement("div");
    heading.className = "workflow-queue-heading";
    const headingText = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const description = document.createElement("p");
    description.textContent = descriptionText;
    headingText.append(title, description);
    const count = document.createElement("span");
    count.className = "count-pill";
    count.textContent = `${overview.buckets?.[bucket]?.length || 0}건`;
    heading.append(headingText, count);
    const list = document.createElement("div");
    list.className = "workflow-task-list";
    const items = overview.buckets?.[bucket] || [];
    for (const item of items) {
      const row = document.createElement("article");
      row.className = "workflow-task";
      row.dataset.jobId = item.jobId;
      row.dataset.workflowStage = item.workflow.stage;
      const copy = document.createElement("div");
      const company = document.createElement("span");
      company.textContent = item.companyName;
      const jobTitle = document.createElement("strong");
      jobTitle.textContent = item.title;
      const stage = document.createElement("small");
      stage.textContent = `${item.workflow.label} · ${item.workflow.description}`;
      copy.append(company, jobTitle, stage);
      const open = document.createElement("button");
      open.type = "button";
      open.className = "secondary-button";
      open.textContent = item.workflow.nextAction?.label || "공고 열기";
      open.addEventListener("click", () => navigateToJob(item.jobId, item.workflow.stage));
      row.append(copy, open);
      list.append(row);
    }
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "workflow-empty";
      empty.textContent = "현재 해당 작업이 없습니다.";
      list.append(empty);
    }
    section.append(heading, list);
    container.append(section);
  }
}

async function createCompanionRequest(kind, extra = {}) {
  try {
    const payload = await request("/api/companion/tasks", {
      method: "POST",
      body: JSON.stringify({ kind, ...extra }),
    });
    state.data.companionTasks = payload.tasks;
    renderCompanion();
    setScreen("companion");
    showToast(payload.deduplicated ? "같은 활성 요청이 있어 기존 작업을 열었습니다." : "로컬 에이전트 작업을 만들었습니다.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function updateCompanionTask(taskId, action) {
  try {
    const payload = await request(`/api/companion/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST", body: "{}" });
    state.data.companionTasks = payload.tasks;
    renderCompanion();
    showToast(action === "retry" ? "실패한 작업을 다시 대기열에 넣었습니다." : "작업을 취소했습니다.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function prepareCompanionReview(taskId) {
  try {
    const payload = await request(`/api/companion/tasks/${encodeURIComponent(taskId)}/prepare-review`, { method: "POST", body: "{}" });
    state.companionReviews.set(taskId, payload.review);
    state.data.companionTasks = payload.tasks;
    renderCompanion();
  } catch (error) { showToast(error.message, true); }
}

function companionDecisionRows(task, review) {
  const panel = document.createElement("div");
  panel.className = "companion-review-panel";
  panel.dataset.companionReviewTask = task.id;
  if (task.kind === "collect_jobs") {
    const counts = review.preview?.counts || {};
    const summary = document.createElement("p");
    summary.textContent = `총 ${counts.total || 0}건 · 새 공고 ${counts.create || 0}건 · 변경 ${counts.update || 0}건 · 동일 ${counts.unchanged || 0}건`;
    panel.append(summary);
    for (const item of review.preview?.diff || []) {
      const row = document.createElement("small");
      row.textContent = `${item.action === "create" ? "추가" : item.action === "update" ? "변경" : "동일"} · ${item.jobKey}`;
      panel.append(row);
    }
    return panel;
  }
  const groups = task.kind === "analyze_documents"
    ? [["facts", "확인된 사실"], ["evidence", "경력 근거"], ["sections", "이력서 항목"]]
    : [["sections", "맞춤 문서 항목"]];
  const source = task.kind === "analyze_documents" ? review.preview?.result || {} : {
    sections: (review.preview?.sections || []).map((item) => ({ ...item, id: item.key, value: item.after })),
  };
  for (const [type, label] of groups) {
    const heading = document.createElement("strong");
    heading.textContent = label;
    panel.append(heading);
    for (const item of source[type] || []) {
      const id = String(item.id || item.key || "");
      const saved = review.decisions?.[type]?.[id] || { decision: "pending" };
      const row = document.createElement("div");
      row.className = "analysis-review-row";
      row.dataset.resultType = type;
      row.dataset.resultId = id;
      const top = document.createElement("div");
      top.className = "analysis-review-heading";
      const title = document.createElement("span");
      title.textContent = item.label || item.title || item.key || id;
      const decision = document.createElement("select");
      decision.dataset.resultDecision = "true";
      for (const [value, text] of [["pending", "확인 필요"], ["use", "사용"], ["edit", "수정 후 사용"], ["exclude", "제외"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        decision.append(option);
      }
      decision.value = saved.decision || "pending";
      top.append(title, decision);
      const editor = document.createElement("textarea");
      editor.dataset.resultValue = "true";
      const original = type === "facts" ? item.value : type === "evidence" ? item.description : item.value;
      const edited = type === "facts" ? saved.value : type === "evidence" ? saved.description : saved.value;
      editor.value = Array.isArray(edited ?? original) ? (edited ?? original).join("\n") : edited ?? original ?? "";
      editor.rows = 3;
      const sourceNote = document.createElement("small");
      const references = item.sourceRefs || (item.sourceDocumentId ? [{ documentId: item.sourceDocumentId, locator: item.sourceLocator }] : []);
      sourceNote.textContent = references.length
        ? `근거: ${references.map((ref) => typeof ref === "string" ? ref : `${ref.documentId || ref.id} · ${ref.locator || ref.sourceLocator}`).join(" / ")}`
        : "근거 연결 없음";
      row.append(top, editor, sourceNote);
      panel.append(row);
    }
  }
  return panel;
}

function collectCompanionDecisions(taskId) {
  const panel = document.querySelector(`[data-companion-review-task="${taskId}"]`);
  const decisions = {};
  for (const row of panel?.querySelectorAll("[data-result-type]") || []) {
    const type = row.dataset.resultType;
    const id = row.dataset.resultId;
    decisions[type] ||= {};
    const decision = row.querySelector('[data-result-decision="true"]').value;
    const value = row.querySelector('[data-result-value="true"]').value;
    const entry = { decision };
    if (decision === "edit") {
      if (type === "evidence") entry.description = value;
      else entry.value = value.includes("\n") ? value.split("\n").map((line) => line.trim()).filter(Boolean) : value;
    }
    decisions[type][id] = entry;
  }
  return decisions;
}

async function applyCompanionReview(task) {
  try {
    if (task.kind !== "collect_jobs") {
      const saved = await request(`/api/companion/tasks/${encodeURIComponent(task.id)}/review`, {
        method: "PATCH", body: JSON.stringify({ decisions: collectCompanionDecisions(task.id) }),
      });
      state.companionReviews.set(task.id, saved.review);
    }
    const payload = await request(`/api/companion/tasks/${encodeURIComponent(task.id)}/apply-review`, { method: "POST", body: "{}" });
    state.companionReviews.set(task.id, payload.review);
    state.data.companionTasks = payload.tasks;
    renderCompanion();
    showToast("검토한 결과를 로컬 데이터에 반영했습니다.");
    await refreshDashboardData();
  } catch (error) { showToast(error.message, true); }
}

async function rejectCompanionReview(taskId) {
  try {
    const payload = await request(`/api/companion/tasks/${encodeURIComponent(taskId)}/reject-review`, {
      method: "POST", body: JSON.stringify({ note: "사용자가 결과를 사용하지 않기로 선택했습니다." }),
    });
    state.companionReviews.set(taskId, payload.review);
    state.data.companionTasks = payload.tasks;
    renderCompanion();
    showToast("이 결과는 로컬 데이터에 반영하지 않습니다.");
  } catch (error) { showToast(error.message, true); }
}

function renderCompanion() {
  const tasks = state.data.companionTasks || [];
  $("#companionTaskCount").textContent = `${tasks.length}건`;
  const list = $("#companionTaskList");
  list.replaceChildren();
  for (const task of tasks) {
    const card = document.createElement("article");
    card.className = "card companion-task";
    card.dataset.companionTaskId = task.id;
    const heading = document.createElement("div");
    heading.className = "companion-task-heading";
    const title = document.createElement("strong");
    title.textContent = companionKindLabels[task.kind] || task.kind;
    const status = document.createElement("span");
    const reviewStatus = task.review?.status;
    status.className = `package-state ${reviewStatus === "accepted" ? "ready" : reviewStatus && reviewStatus !== "awaiting_review" || ["failed", "cancelled"].includes(task.status) ? "hold" : ""}`;
    status.textContent = reviewStatus ? companionReviewLabels[reviewStatus] || reviewStatus : companionStatusLabels[task.status] || task.status;
    heading.append(title, status);
    const detail = document.createElement("p");
    detail.textContent = `시도 ${task.attemptCount}/${task.maxAttempts} · 요청 파일 ${task.requestPath}`;
    card.append(heading, detail);
    if (task.error) {
      const error = document.createElement("p");
      error.className = "companion-error";
      error.textContent = `${task.error.code} · ${task.error.message}`;
      card.append(error);
    }
    if (task.status === "running" && task.leaseExpiresAt) {
      const progress = document.createElement("small");
      progress.textContent = `lease 만료 ${formatDateTime(task.leaseExpiresAt)} · heartbeat로 연장됩니다.`;
      card.append(progress);
    }
    const actions = document.createElement("div");
    actions.className = "companion-task-actions";
    if (["queued", "running"].includes(task.status)) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary-button";
      cancel.textContent = "작업 취소";
      cancel.addEventListener("click", () => updateCompanionTask(task.id, "cancel"));
      protectBackendControl(cancel, { capability: "companionQueue" });
      actions.append(cancel);
    }
    if (task.status === "failed" && task.attemptCount < task.maxAttempts) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "primary-button";
      retry.textContent = "다시 시도";
      retry.addEventListener("click", () => updateCompanionTask(task.id, "retry"));
      protectBackendControl(retry, { capability: "companionQueue" });
      actions.append(retry);
    }
    if (task.status === "succeeded" && task.review?.status === "awaiting_review") {
      const review = state.companionReviews.get(task.id);
      if (!review?.preview?.kind) {
        const prepare = document.createElement("button");
        prepare.type = "button";
        prepare.className = "primary-button";
        prepare.textContent = "결과 미리보기";
        prepare.addEventListener("click", () => prepareCompanionReview(task.id));
        protectBackendControl(prepare, { capability: "companionQueue" });
        actions.append(prepare);
      } else {
        card.append(companionDecisionRows(task, review));
        const apply = document.createElement("button");
        apply.type = "button";
        apply.className = "primary-button";
        apply.textContent = "검토 결과 반영";
        apply.addEventListener("click", () => applyCompanionReview(task));
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "secondary-button";
        reject.textContent = "사용하지 않음";
        reject.addEventListener("click", () => rejectCompanionReview(task.id));
        protectBackendControl(apply, { capability: "companionQueue" });
        protectBackendControl(reject, { capability: "companionQueue" });
        actions.append(apply, reject);
      }
    }
    if (actions.childElementCount) card.append(actions);
    list.append(card);
  }
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    const title = document.createElement("h3");
    title.textContent = "아직 로컬 에이전트 작업이 없습니다";
    const copy = document.createElement("p");
    copy.textContent = "공고 수집·문서 분석 요청을 만들거나 공고 상세에서 문서 생성 요청을 추가해 주세요.";
    empty.append(title, copy);
    list.append(empty);
  }
  protectBackendControl($("#queueJobCollection"), { capability: "jobCollectionRequest" });
  protectBackendControl($("#queueDocumentAnalysis"), { capability: "documentAnalysisRequest" });
}

function renderInbox() {
  const inbox = state.data.inbox || { items: [], unreadCount: 0 };
  $("#inboxCount").textContent = `${inbox.items.length}건`;
  const badge = $("#inboxUnreadBadge");
  badge.textContent = String(inbox.unreadCount || 0);
  badge.hidden = !inbox.unreadCount;
  const list = $("#inboxList");
  list.replaceChildren();
  for (const item of inbox.items) {
    const card = document.createElement("article");
    card.className = `card inbox-item${item.read ? " read" : " unread"}`;
    card.dataset.notificationId = item.id;
    const copy = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = item.title;
    const body = document.createElement("p");
    body.textContent = item.body || `${item.companyName} · ${item.jobTitle}`;
    const time = document.createElement("small");
    time.textContent = formatDateTime(item.createdAt);
    copy.append(heading, body, time);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary-button";
    open.textContent = item.read ? "공고 열기" : "확인하고 열기";
    open.addEventListener("click", async () => {
      try {
        if (!item.read) {
          const payload = await request(`/api/inbox/${item.id}/read`, { method: "POST", body: "{}" });
          state.data.inbox = payload.inbox;
          renderInbox();
        }
        navigateToJob(item.jobId, "outcomes");
      } catch (error) { showToast(error.message, true); }
    });
    protectBackendControl(open, { capability: "localNotifications" });
    card.append(copy, open);
    list.append(card);
  }
  if (!inbox.items.length) {
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    const title = document.createElement("h3");
    title.textContent = "아직 로컬 알림이 없습니다";
    const copy = document.createElement("p");
    copy.textContent = "제출 뒤 결과나 후속조치를 기록하면 이곳에만 알림이 쌓입니다.";
    empty.append(title, copy);
    list.append(empty);
  }
}

function outcomeDateLabel(days) {
  if (!Number.isFinite(days)) return "";
  if (days === 0) return "오늘";
  return days > 0 ? `D-${days}` : `${Math.abs(days)}일 지남`;
}

function applyOutcomePayload(payload, jobId) {
  if (payload.inbox) state.data.inbox = payload.inbox;
  if (payload.outcomes) state.outcomes.set(Number(jobId), payload.outcomes);
  renderInbox();
  applyJobs(payload, Number(jobId));
}

function renderOutcomePanel(panel, job, outcomes) {
  panel.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "panel-title-row";
  const copy = document.createElement("div");
  const title = document.createElement("h4");
  title.textContent = "지원 결과·후속조치";
  const description = document.createElement("p");
  description.className = "subtle";
  description.textContent = "제출 뒤 결과를 덮어쓰지 않고 시간순으로 보관합니다.";
  copy.append(title, description);
  const pending = document.createElement("span");
  pending.className = "count-pill";
  pending.textContent = `예정 ${outcomes.pendingCount || 0}건`;
  heading.append(copy, pending);
  panel.append(heading);

  const events = document.createElement("div");
  events.className = "outcome-events";
  for (const event of outcomes.events || []) {
    const row = document.createElement("article");
    row.className = "outcome-row";
    row.dataset.outcomeEventId = event.id;
    const eventCopy = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = event.correctionOfEventId ? `정정 · ${event.label}` : event.label;
    const summary = document.createElement("p");
    summary.textContent = event.summary || "별도 메모 없음";
    const meta = document.createElement("small");
    const checksum = event.evidence.checksum ? ` · SHA-256 ${event.evidence.checksum.slice(0, 12)}…` : "";
    const evidence = event.evidence.kind === "none" ? "증빙 없음" : `증빙 · ${event.evidence.label}${checksum}`;
    const correction = event.correctionOfEventId ? ` · 원본 #${event.correctionOfEventId} 정정 사유: ${event.correctionReason}` : event.corrected ? " · 이후 정정 기록 있음" : "";
    meta.textContent = `${formatDateTime(event.occurredAt)} · ${evidence}${correction}`;
    eventCopy.append(label, summary, meta);
    row.append(eventCopy);
    if (!isReadOnlyDemo()) {
      const details = document.createElement("details");
      details.className = "outcome-correction";
      const toggle = document.createElement("summary");
      toggle.textContent = "이 기록 정정";
      const form = document.createElement("form");
      form.className = "outcome-form correction-form";
      const type = document.createElement("select");
      for (const item of state.data.outcomeEventTypes || []) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        option.selected = item.value === event.type;
        type.append(option);
      }
      const occurredAt = document.createElement("input");
      occurredAt.type = "datetime-local";
      occurredAt.value = new Date(new Date(event.occurredAt).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
      const correctedSummary = document.createElement("input");
      correctedSummary.maxLength = 2000;
      correctedSummary.value = event.summary;
      correctedSummary.placeholder = "정정된 결과 메모";
      const reason = document.createElement("input");
      reason.required = true;
      reason.maxLength = 1000;
      reason.placeholder = "정정 사유 · 필수";
      const evidenceKind = document.createElement("select");
      for (const [value, textValue] of [["none", "증빙 없음"], ["manual_note", "직접 확인"], ["portal", "채용 사이트"], ["email", "이메일"], ["document", "문서 체크섬"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = textValue;
        option.selected = value === event.evidence.kind;
        evidenceKind.append(option);
      }
      const evidenceLabel = document.createElement("input");
      evidenceLabel.maxLength = 500;
      evidenceLabel.value = event.evidence.label;
      evidenceLabel.placeholder = "증빙 설명";
      const evidenceChecksum = document.createElement("input");
      evidenceChecksum.maxLength = 64;
      evidenceChecksum.value = event.evidence.checksum;
      evidenceChecksum.placeholder = "문서 SHA-256";
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "secondary-button";
      submit.textContent = "정정 기록 추가";
      form.append(type, occurredAt, correctedSummary, reason, evidenceKind, evidenceLabel, evidenceChecksum, submit);
      form.addEventListener("submit", async (submitEvent) => {
        submitEvent.preventDefault();
        try {
          const payload = await request(`/api/jobs/${job.id}/outcomes/${event.id}/corrections`, {
            method: "POST",
            body: JSON.stringify({
              type: type.value,
              occurredAt: new Date(occurredAt.value).toISOString(),
              summary: correctedSummary.value,
              reason: reason.value,
              evidence: evidenceKind.value === "none"
                ? { kind: "none" }
                : { kind: evidenceKind.value, label: evidenceLabel.value, checksum: evidenceChecksum.value },
            }),
          });
          applyOutcomePayload(payload, job.id);
          showToast(payload.deduplicated ? "같은 정정 기록이 이미 있습니다." : "원본을 보존하고 정정 기록을 추가했습니다.");
        } catch (error) { showToast(error.message, true); }
      });
      details.append(toggle, form);
      row.append(details);
    }
    events.append(row);
  }
  if (!(outcomes.events || []).length) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = outcomes.eligible ? "아직 기록된 지원 결과가 없습니다." : "제출 완료를 먼저 기록하면 결과 원장을 사용할 수 있습니다.";
    events.append(empty);
  }
  panel.append(events);

  if (outcomes.eligible && !isReadOnlyDemo()) {
    const resultForm = document.createElement("form");
    resultForm.className = "outcome-form";
    const resultType = document.createElement("select");
    resultType.name = "resultType";
    for (const item of state.data.outcomeEventTypes || []) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      resultType.append(option);
    }
    const occurredAt = document.createElement("input");
    occurredAt.type = "datetime-local";
    occurredAt.name = "occurredAt";
    occurredAt.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    const summary = document.createElement("input");
    summary.name = "summary";
    summary.maxLength = 2000;
    summary.placeholder = "결과 메모 · 선택";
    const evidenceKind = document.createElement("select");
    evidenceKind.name = "evidenceKind";
    for (const [value, label] of [["none", "증빙 없음"], ["manual_note", "직접 확인"], ["portal", "채용 사이트"], ["email", "이메일"], ["document", "문서 체크섬"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      evidenceKind.append(option);
    }
    const evidenceLabel = document.createElement("input");
    evidenceLabel.name = "evidenceLabel";
    evidenceLabel.maxLength = 500;
    evidenceLabel.placeholder = "증빙 설명 · 종류 선택 시 필수";
    const evidenceChecksum = document.createElement("input");
    evidenceChecksum.name = "evidenceChecksum";
    evidenceChecksum.maxLength = 64;
    evidenceChecksum.placeholder = "문서 SHA-256 · 문서 선택 시 필수";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-button";
    submit.textContent = "결과 추가";
    resultForm.append(resultType, occurredAt, summary, evidenceKind, evidenceLabel, evidenceChecksum, submit);
    resultForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const payload = await request(`/api/jobs/${job.id}/outcomes`, {
          method: "POST",
          body: JSON.stringify({
            type: resultType.value,
            occurredAt: new Date(occurredAt.value).toISOString(),
            summary: summary.value,
            evidence: evidenceKind.value === "none"
              ? { kind: "none" }
              : { kind: evidenceKind.value, label: evidenceLabel.value, checksum: evidenceChecksum.value },
          }),
        });
        applyOutcomePayload(payload, job.id);
        showToast(payload.deduplicated ? "같은 결과가 이미 기록되어 있습니다." : "지원 결과를 원장에 추가했습니다.");
      } catch (error) { showToast(error.message, true); }
    });
    panel.append(resultForm);
  }

  const followUps = document.createElement("div");
  followUps.className = "follow-up-list";
  for (const followUp of outcomes.followUps || []) {
    const row = document.createElement("article");
    row.className = `follow-up-row ${followUp.status}`;
    row.dataset.followUpId = followUp.id;
    const content = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = followUp.title;
    const meta = document.createElement("small");
    meta.textContent = `${outcomeDateLabel(followUp.daysUntil)} · ${formatDateTime(followUp.dueAt)} · ${followUp.status === "pending" ? "예정" : followUp.status === "completed" ? "완료" : "취소"}`;
    content.append(label, meta);
    row.append(content);
    if (followUp.status === "pending" && !isReadOnlyDemo()) {
      const actions = document.createElement("div");
      actions.className = "follow-up-actions";
      for (const [action, actionLabel] of [["complete", "완료"], ["cancel", "취소"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = actionLabel;
        button.addEventListener("click", async () => {
          try {
            const payload = await request(`/api/follow-ups/${followUp.id}/${action}`, { method: "POST", body: "{}" });
            applyOutcomePayload(payload, job.id);
          } catch (error) { showToast(error.message, true); }
        });
        actions.append(button);
      }
      row.append(actions);
    }
    followUps.append(row);
  }
  panel.append(followUps);

  if (outcomes.eligible && !isReadOnlyDemo()) {
    const followForm = document.createElement("form");
    followForm.className = "follow-up-form";
    const followTitle = document.createElement("input");
    followTitle.name = "followTitle";
    followTitle.required = true;
    followTitle.maxLength = 200;
    followTitle.placeholder = "후속조치 제목";
    const dueAt = document.createElement("input");
    dueAt.type = "date";
    dueAt.name = "dueAt";
    dueAt.value = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const sourceEvent = document.createElement("select");
    sourceEvent.name = "sourceEvent";
    const direct = document.createElement("option");
    direct.value = "";
    direct.textContent = "날짜 직접 지정";
    sourceEvent.append(direct);
    for (const item of outcomes.events || []) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.label} 기준`;
      sourceEvent.append(option);
    }
    const offset = document.createElement("input");
    offset.type = "number";
    offset.name = "offsetDays";
    offset.min = "0";
    offset.max = "365";
    offset.placeholder = "D+ 일수";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "secondary-button";
    submit.textContent = "후속조치 추가";
    followForm.append(followTitle, dueAt, sourceEvent, offset, submit);
    sourceEvent.addEventListener("change", () => {
      const anchored = Boolean(sourceEvent.value);
      dueAt.disabled = anchored;
      offset.required = anchored;
    });
    followForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const anchored = Boolean(sourceEvent.value);
        const body = anchored
          ? { title: followTitle.value, sourceEventId: Number(sourceEvent.value), offsetDays: Number(offset.value) }
          : { title: followTitle.value, dueAt: dueAt.value };
        const payload = await request(`/api/jobs/${job.id}/follow-ups`, { method: "POST", body: JSON.stringify(body) });
        applyOutcomePayload(payload, job.id);
        showToast(payload.deduplicated ? "같은 후속조치가 이미 예정되어 있습니다." : "후속조치를 추가했습니다.");
      } catch (error) { showToast(error.message, true); }
    });
    panel.append(followForm);
  }
}

async function loadJobOutcomes(job, panel) {
  try {
    const cached = state.outcomes.get(Number(job.id));
    if (cached) renderOutcomePanel(panel, job, cached);
    const payload = await request(`/api/jobs/${job.id}/outcomes`);
    state.outcomes.set(Number(job.id), payload.outcomes);
    if (panel.isConnected && panel.dataset.jobId === String(job.id)) renderOutcomePanel(panel, job, payload.outcomes);
  } catch (error) {
    if (panel.isConnected) {
      const notice = document.createElement("p");
      notice.className = "package-state hold";
      notice.textContent = error.message;
      panel.replaceChildren(notice);
    }
  }
}

function renderJobs() {
  const jobs = filteredJobs();
  $("#jobCount").textContent = `${state.pagination.total}건`;
  renderQuickFilters();
  renderJobStatusSummary();
  const list = $("#jobList");
  list.replaceChildren(...jobs.map(createJobCard));
  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    const title = document.createElement("h3");
    title.textContent = "조건에 맞는 공고가 없습니다";
    const copy = document.createElement("p");
    copy.textContent = "필터를 조정하거나 개인 설정의 검색 조건을 확인해 주세요.";
    empty.append(title, copy);
    list.append(empty);
  }
}

function renderPagination() {
  $("#jobPageStatus").textContent = `${state.pagination.page} / ${state.pagination.totalPages}`;
  $("#previousJobPage").disabled = state.pagination.page <= 1;
  $("#nextJobPage").disabled = state.pagination.page >= state.pagination.totalPages;
}

function sourceLabel(platform) {
  return state.data.sources?.[platform]?.label || platform;
}

function renderDetail(jobId, suppliedJob = null) {
  const job = suppliedJob || state.cache.details.get(Number(jobId)) || state.data.jobs.find((item) => item.id === jobId);
  const detail = $("#jobDetail");
  detail.replaceChildren();
  if (!job) return;

  const headingRow = document.createElement("div");
  headingRow.className = "detail-heading-row";
  const company = document.createElement("p");
  company.className = "detail-company";
  company.textContent = job.companyName;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "detail-close-button";
  close.setAttribute("aria-label", "공고 상세 닫기");
  close.textContent = "×";
  close.addEventListener("click", () => {
    state.selectedJobId = null;
    renderJobs();
    detail.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "empty-state detail-empty-state";
    const emptyTitle = document.createElement("strong");
    emptyTitle.textContent = "공고를 선택해 주세요";
    const emptyCopy = document.createElement("p");
    emptyCopy.textContent = "목록에서 공고를 선택하면 출처와 지원 문서 작업 단계를 확인할 수 있습니다.";
    empty.append(emptyTitle, emptyCopy);
    detail.append(empty);
  });
  headingRow.append(company, close);
  const title = document.createElement("h3");
  title.className = "detail-title";
  title.textContent = job.title;
  const meta = document.createElement("div");
  meta.className = "job-meta";
  for (const value of [job.track, job.location, job.employmentType]) {
    if (!value) continue;
    const span = document.createElement("span");
    span.textContent = value;
    meta.append(span);
  }
  if (job.deadline) {
    const span = document.createElement("span");
    span.className = job.deadlineDays !== null && job.deadlineDays <= 7 ? "deadline-urgent" : "";
    span.textContent = `${deadlineLabel(job)} · ${job.deadline}`;
    meta.append(span);
  }
  if (job.discovery?.isNew) {
    const span = document.createElement("span");
    span.className = "discovery-badge new";
    span.textContent = "새 공고";
    meta.append(span);
  }
  if (job.discovery?.isReopened) {
    const span = document.createElement("span");
    span.className = "discovery-badge reopened";
    span.textContent = `재오픈${job.discovery.reopenCount > 1 ? ` ${job.discovery.reopenCount}회` : ""}`;
    meta.append(span);
  }
  const summary = document.createElement("p");
  summary.className = "detail-summary";
  summary.textContent = job.summary || "공고 요약이 아직 없습니다.";
  const scoreSummary = document.createElement("div");
  scoreSummary.className = "detail-score-summary";
  const scoreValue = document.createElement("strong");
  scoreValue.textContent = job.score === null ? "—" : String(Math.round(Number(job.score)));
  const scoreCopy = document.createElement("span");
  scoreCopy.textContent = job.score === null ? "평가 기준 설정 후 점수가 표시됩니다" : "공고 적합도";
  scoreSummary.append(scoreValue, scoreCopy);
  detail.append(headingRow, title, meta, scoreSummary, summary);
  if (job.workflow) {
    const workflow = document.createElement("section");
    workflow.className = "workflow-current";
    const label = document.createElement("strong");
    label.textContent = `현재 단계 · ${job.workflow.label}`;
    const description = document.createElement("p");
    description.textContent = job.workflow.description;
    workflow.append(label, description);
    detail.append(workflow);
  }
  if (job.score !== null && Number(job.score) < Number(state.data.scoreReviewBelow ?? 70)) {
    const caution = document.createElement("p");
    caution.className = "package-state hold";
    caution.textContent = "적합도 주의 · 사용자 기준 점수 미만";
    detail.append(caution);
  }
  if (job.scoreMode === "scalar" && job.score !== null) {
    const scoreSource = document.createElement("p");
    scoreSource.className = "subtle";
    scoreSource.textContent = "외부에서 전달된 단일 적합도 점수입니다.";
    detail.append(scoreSource);
  }
  if (job.score === null && state.data.scoringProfile?.configured === false) {
    const scoringNotice = document.createElement("p");
    scoringNotice.className = "package-state hold";
    scoringNotice.textContent = "평가 기준 설정 필요 · 점수를 자동 계산하지 않았습니다.";
    detail.append(scoringNotice);
  }
  if (job.scoreMode === "breakdown" && Array.isArray(job.scoreBreakdown?.dimensions)) {
    const breakdown = document.createElement("section");
    breakdown.className = "score-breakdown";
    const heading = document.createElement("h4");
    heading.textContent = "적합도 판단 근거";
    breakdown.append(heading);
    for (const dimension of job.scoreBreakdown.dimensions) {
      const row = document.createElement("div");
      row.className = "score-breakdown-row";
      const label = document.createElement("strong");
      label.textContent = `${dimension.label} ${Math.round(Number(dimension.score) || 0)}점`;
      const reason = document.createElement("p");
      reason.textContent = dimension.reason || "판단 이유가 입력되지 않았습니다.";
      row.append(label, reason);
      if (Array.isArray(dimension.gaps) && dimension.gaps.length) {
        const gaps = document.createElement("small");
        gaps.textContent = `확인할 점: ${dimension.gaps.join(" · ")}`;
        row.append(gaps);
      }
      breakdown.append(row);
    }
    detail.append(breakdown);
  }

  if (job.primarySource) {
    const actions = document.createElement("div");
    actions.className = "detail-actions";
    const link = document.createElement("a");
    link.className = "primary-link";
    link.href = job.primarySource.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `${sourceLabel(job.primarySource.platform)}에서 보기`;
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = "secondary-button";
    favorite.textContent = job.application.favorite ? "관심 해제" : "관심 추가";
    favorite.addEventListener("click", () => saveState(job, { favorite: !job.application.favorite }));
    protectBackendControl(favorite, { capability: "jobState", job, action: "updateJobState" });
    actions.append(link, favorite);
    detail.append(actions);
  }

  const sourceHeading = document.createElement("h4");
  sourceHeading.textContent = `확인된 출처 ${job.sources.length}개`;
  const sourceList = document.createElement("div");
  sourceList.className = "source-list";
  for (const source of job.sources) {
    const row = document.createElement("div");
    row.className = "source-row";
    const info = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = sourceLabel(source.platform);
    const status = document.createElement("span");
    const sourceDeadline = source.deadline ? ` · 마감 ${source.deadline}` : "";
    const provenance = source.provenance?.adapterId ? ` · ${source.provenance.adapterId}` : "";
    status.textContent = `${sourceStatusLabels[source.status] || "확인 필요"}${sourceDeadline} · 상태 확인 신뢰도 ${sourceConfidenceLabel(source.confidence)}${provenance} · 확인 ${formatDateTime(source.checkedAt)}`;
    info.append(label, document.createElement("br"), status);
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const isPrimary = source.platform === job.primarySource?.platform && source.url === job.primarySource?.url;
    link.textContent = isPrimary ? "대표" : "열기";
    row.append(info, link);
    sourceList.append(row);
  }
  detail.append(sourceHeading, sourceList);

  const statePanel = document.createElement("div");
  statePanel.className = "detail-state";
  const statusLabel = document.createElement("label");
  const statusCaption = document.createElement("span");
  statusCaption.textContent = "지원 상태";
  const statusSelect = document.createElement("select");
  for (const [value, label] of Object.entries(statusLabels)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    statusSelect.append(option);
  }
  statusSelect.value = job.application.workflowStatus;
  protectBackendControl(statusSelect, { capability: "jobState", job, action: "updateJobState" });
  statusLabel.append(statusCaption, statusSelect);
  const noteLabel = document.createElement("label");
  const noteCaption = document.createElement("span");
  noteCaption.textContent = "메모";
  const note = document.createElement("textarea");
  note.rows = 4;
  note.maxLength = 2000;
  note.value = job.application.note;
  protectBackendControl(note, { capability: "jobState", job, action: "updateJobState" });
  noteLabel.append(noteCaption, note);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary-button";
  save.textContent = "상태 저장";
  save.addEventListener("click", () => saveState(job, { workflowStatus: statusSelect.value, note: note.value }));
  protectBackendControl(save, { capability: "jobState", job, action: "updateJobState" });
  statePanel.append(statusLabel, noteLabel, save);
  detail.append(statePanel);
  detail.append(renderPackagePanel(job));
  const outcomePanel = document.createElement("section");
  outcomePanel.className = "package-panel outcome-panel";
  outcomePanel.dataset.jobId = job.id;
  if (state.data.mode === "personal") {
    const loading = document.createElement("p");
    loading.className = "subtle";
    loading.textContent = "지원 결과를 불러오는 중입니다.";
    outcomePanel.append(loading);
    loadJobOutcomes(job, outcomePanel);
  } else {
    renderOutcomePanel(outcomePanel, job, { eligible: false, events: [], followUps: [], pendingCount: 0 });
  }
  detail.append(outcomePanel);
}

function packageField(section) {
  const label = document.createElement("label");
  label.className = "package-field";
  const heading = document.createElement("span");
  heading.className = "package-field-heading";
  const caption = document.createElement("strong");
  caption.textContent = section.label;
  heading.append(caption);
  if (section.source === "application_question") {
    const badge = document.createElement("em");
    badge.textContent = section.required ? "필수 지원서 질문" : "선택 지원서 질문";
    heading.append(badge);
  }
  const input = section.key === "headline" ? document.createElement("input") : document.createElement("textarea");
  if (input instanceof HTMLTextAreaElement) input.rows = section.kind === "list" ? 4 : 5;
  input.dataset.packageSectionKey = section.key;
  if (section.maxLength) input.maxLength = section.maxLength;
  input.value = section.kind === "list" ? (section.value || []).join("\n") : (section.value || "");
  const reason = document.createElement("small");
  const minimum = section.kind === "list"
    ? `최소 ${section.minItems || 1}개, 각 ${section.minItemLength || 1}자`
    : `최소 ${section.minLength || 1}자`;
  reason.textContent = `${section.reason || "등록 이력서에서 선택된 공고별 수정 항목입니다."} · ${minimum}`;
  label.append(heading, input, reason);
  return label;
}

function applyJobs(payload, jobId) {
  if (payload.jobs) state.data.jobs = payload.jobs;
  if (payload.detail) {
    state.cache.details.set(Number(jobId), payload.detail);
    const index = state.data.jobs.findIndex((item) => item.id === Number(jobId));
    if (index >= 0) state.data.jobs[index] = payload.job || publicSummaryFromDetail(payload.detail);
  }
  if (payload.workflow) state.data.workflow = payload.workflow;
  if (payload.revisions) state.data.revisions = payload.revisions;
  renderWorkflow();
  renderJobs();
  renderPagination();
  renderDetail(jobId, payload.detail || state.cache.details.get(Number(jobId)));
  loadJobPage({ force: true }).catch((error) => showToast(error.message, true));
  loadWorkflow({ force: true }).catch((error) => showToast(error.message, true));
}

function publicSummaryFromDetail(job) {
  return {
    ...job,
    sources: (job.sources || []).map((source) => ({
      platform: source.platform,
      status: source.status,
      deadline: source.deadline,
      checkedAt: source.checkedAt,
    })),
  };
}

function packageAction(label, className, handler, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", handler);
  return protectBackendControl(button, options);
}

function renderPackagePanel(job) {
  const panel = document.createElement("section");
  panel.className = "package-panel";
  const heading = document.createElement("div");
  heading.className = "package-heading";
  const title = document.createElement("h4");
  title.textContent = "공고별 지원 문서 작업본";
  heading.append(title);
  panel.append(heading);

  if (!job.package) {
    const copy = document.createElement("p");
    copy.textContent = "기본 이력서에서 공고에 연결된 항목을 불러와 직접 수정하는 작업본입니다. 새 경력을 자동으로 작성하거나 직무 적합성을 판정하지 않습니다.";
    if (job.workflow?.stage === "review") {
      const start = packageAction("공고 검토 시작", "primary-button", async () => {
        await saveState(job, { workflowStatus: "reviewing" }, "공고 검토를 시작했습니다.");
      }, { capability: "jobState", job, action: "startReview" });
      panel.append(copy, start);
    } else if (job.workflow?.stage === "draft") {
      const create = packageAction("공고별 작업본 만들기", "primary-button", async () => {
        try {
          const payload = await request(`/api/jobs/${job.id}/package`, { method: "POST", body: "{}" });
          applyJobs(payload, job.id);
          showToast("공고별 작업본을 만들었습니다.");
        } catch (error) { showToast(error.message, true); }
      }, { capability: "packageWorkflow", job, action: "createPackage" });
      const queue = packageAction("에이전트 문서 생성 요청", "secondary-button", () => {
        createCompanionRequest("generate_package", { jobId: job.id });
      }, { capability: "packageGenerationRequest", job, action: "requestPackageGeneration" });
      panel.append(copy, create, queue);
    } else {
      const unavailable = document.createElement("p");
      unavailable.className = "package-frozen";
      unavailable.textContent = "현재 공고 상태에서는 새 작업본을 만들 수 없습니다.";
      panel.append(copy, unavailable);
    }
    return panel;
  }

  const packageValue = job.package;
  const packageLocked = packageValue.refreshAvailable === false;
  title.textContent = `공고별 지원 문서 작업본 · v${packageValue.version}`;
  const badge = document.createElement("span");
  badge.className = `package-state ${packageValue.quality.status === "passed" ? "ready" : "hold"}`;
  badge.textContent = packageStateLabels[packageValue.state] || packageValue.state;
  heading.append(badge);

  if (!isReadOnlyDemo() && ["draft", "quality", "approval"].includes(job.workflow?.stage)) {
    const queue = packageAction("에이전트 문서 생성 요청", "secondary-button", () => {
      createCompanionRequest("generate_package", { jobId: job.id });
    }, { capability: "packageGenerationRequest", job, action: "requestPackageGeneration" });
    panel.append(queue);
  }

  const quality = document.createElement("p");
  quality.className = "package-quality";
  quality.textContent = `작성 완성도 ${Math.round(packageValue.quality.score)}점 · ${packageValue.quality.status === "passed" ? "필수 작성 기준 통과" : "필수 항목 보완 필요"}`;
  panel.append(quality);
  if (packageValue.quality.findings?.length) {
    const findings = document.createElement("ul");
    findings.className = "package-findings";
    for (const item of packageValue.quality.findings) {
      const li = document.createElement("li");
      li.textContent = item.message;
      findings.append(li);
    }
    panel.append(findings);
  }
  const changedSections = (packageValue.diff || []).filter((item) => item.changed);
  if (changedSections.length) {
    const diff = document.createElement("details");
    diff.className = "package-diff";
    const summary = document.createElement("summary");
    summary.textContent = `기본 이력서와 달라진 항목 ${changedSections.length}개`;
    diff.append(summary);
    for (const item of changedSections) {
      const row = document.createElement("article");
      const heading = document.createElement("strong");
      heading.textContent = item.label;
      const before = document.createElement("div");
      before.className = "package-diff-before";
      before.textContent = `수정 전\n${Array.isArray(item.before) ? item.before.join("\n") : item.before || "(비어 있음)"}`;
      const after = document.createElement("div");
      after.className = "package-diff-after";
      after.textContent = `수정 후\n${Array.isArray(item.after) ? item.after.join("\n") : item.after || "(비어 있음)"}`;
      row.append(heading, before, after);
      diff.append(row);
    }
    panel.append(diff);
  }
  if (packageValue.quality.decisions?.length) {
    const decisions = document.createElement("details");
    decisions.className = "package-decisions";
    const summary = document.createElement("summary");
    summary.textContent = "품질 판정 근거 보기";
    decisions.append(summary);
    const list = document.createElement("ul");
    for (const item of packageValue.quality.decisions) {
      const row = document.createElement("li");
      row.textContent = `${item.passed ? "통과" : "보완"} · ${item.message}`;
      list.append(row);
    }
    decisions.append(list);
    panel.append(decisions);
  }

  if (packageValue.refreshRequired) {
    const refreshNotice = document.createElement("div");
    refreshNotice.className = "package-frozen";
    const refreshTitle = document.createElement("strong");
    refreshTitle.textContent = "기준 정보가 변경되어 이 문서를 그대로 제출할 수 없습니다.";
    const refreshReasons = document.createElement("p");
    refreshReasons.textContent = (packageValue.refreshReasons || [])
      .map((item) => typeof item === "string" ? item : item?.message || item?.key || "")
      .filter(Boolean)
      .join(" · ")
      || "기본 이력서, 공고 정보 또는 작성 기준이 변경되었습니다.";
    refreshNotice.append(refreshTitle, refreshReasons);
    if (packageValue.refreshAvailable) {
      refreshNotice.append(packageAction("변경사항을 반영해 새 버전 만들기", "primary-button", async () => {
        try {
          const payload = await request(`/api/jobs/${job.id}/package`, {
            method: "POST",
            body: JSON.stringify({ refreshConfirmed: true }),
          });
          applyJobs(payload, job.id);
          showToast("현재 기준으로 새 문서 버전을 만들었습니다.");
        } catch (error) { showToast(error.message, true); }
      }, { capability: "packageWorkflow", job, action: "refreshPackage" }));
    }
    panel.append(refreshNotice);
  } else if (packageLocked) {
    const lockedNotice = document.createElement("p");
    lockedNotice.className = "package-frozen";
    lockedNotice.textContent = "마감·제외·종료된 공고의 지원 문서는 수정하거나 제출 단계로 이동할 수 없습니다.";
    panel.append(lockedNotice);
  }

  const editable = !packageValue.refreshRequired
    && !packageLocked
    && ["quality_hold", "approval_pending", "approved"].includes(packageValue.state);
  if (editable) {
    const form = document.createElement("div");
    form.className = "package-form";
    if (packageValue.content.protectedFacts?.length) {
      const facts = document.createElement("div");
      facts.className = "protected-facts";
      const factsTitle = document.createElement("strong");
      factsTitle.textContent = "사실 보호 항목 · 공고별 문서에서 수정되지 않습니다";
      facts.append(factsTitle);
      for (const fact of packageValue.content.protectedFacts) {
        const item = document.createElement("span");
        item.textContent = `${fact.label}: ${fact.value}`;
        facts.append(item);
      }
      form.append(facts);
    }
    for (const section of packageValue.content.sections || []) form.append(packageField(section));
    if (!packageValue.content.sections?.length) {
      const empty = document.createElement("p");
      empty.className = "package-frozen";
      empty.textContent = "기본 이력서에서 내용을 입력하고 공고별 수정 허용 항목을 선택해 주세요.";
      form.append(empty);
    }
    const actions = document.createElement("div");
    actions.className = "package-actions";
    actions.append(packageAction("수정 내용 저장", "secondary-button", async () => {
      const lines = (value) => value.split("\n").map((item) => item.trim()).filter(Boolean);
      const sectionDefinitions = new Map((packageValue.content.sections || []).map((section) => [section.key, section]));
      const sections = [...form.querySelectorAll("[data-package-section-key]")].map((input) => {
        const definition = sectionDefinitions.get(input.dataset.packageSectionKey);
        return { key: input.dataset.packageSectionKey, value: definition?.kind === "list" ? lines(input.value) : input.value };
      });
      try {
        const payload = await request(`/api/packages/${packageValue.id}`, {
          method: "PUT",
          body: JSON.stringify({ sections, expectedChecksum: packageValue.checksum }),
        });
        applyJobs(payload, job.id);
        showToast("수정 내용과 이전 버전을 안전하게 저장했습니다.");
      } catch (error) { showToast(error.message, true); }
    }, { capability: "packageWorkflow", job, action: "editPackage" }));
    if (packageValue.state === "approval_pending") {
      actions.append(packageAction("문안 승인·PDF 생성", "primary-button", async () => {
        try {
          const payload = await request(`/api/packages/${packageValue.id}/approve`, {
            method: "POST",
            body: JSON.stringify({ expectedChecksum: packageValue.checksum }),
          });
          applyJobs(payload, job.id);
          showToast("현재 문안으로 PDF를 생성하고 승인했습니다.");
        } catch (error) { showToast(error.message, true); }
      }, { capability: "packageWorkflow", job, action: "approvePackage" }));
    }
    form.append(actions);
    panel.append(form);
  }

  if (packageValue.pdf?.available) {
    const pdf = document.createElement("p");
    pdf.className = "package-pdf";
    pdf.textContent = `PDF 작업본 · ${packageValue.pdf.pages}페이지 · 승인 내용 고정됨`;
    panel.append(pdf);
  }
  if (packageValue.applicationAnswers?.available) {
    const answers = document.createElement("p");
    answers.className = "package-pdf";
    answers.textContent = `${packageValue.applicationAnswers.fileName} · 지원서 질문 답변은 이력서와 별도로 저장됩니다.`;
    panel.append(answers);
  }
  if (packageValue.state === "approved") {
    const manualSubmissionReady = Boolean(
      packageValue.pdf?.available
      && packageValue.approvedChecksum
      && packageValue.approvedChecksum === packageValue.checksum
      && !packageValue.refreshRequired
      && !packageLocked,
    );
    const prepare = packageAction("수기 제출 준비", "primary-button", async () => {
      try {
        const payload = await request(`/api/packages/${packageValue.id}/prepare`, {
          method: "POST",
          body: JSON.stringify({ platform: job.primarySource?.platform || "" }),
        });
        applyJobs(payload, job.id);
        showToast("수기 제출할 PDF를 확정했습니다. 채용 플랫폼에서 직접 지원해 주세요.");
      } catch (error) { showToast(error.message, true); }
    }, { capability: "manualSubmission", job, action: "prepareSubmission" });
    prepare.disabled = prepare.disabled || !manualSubmissionReady;
    if (!prepare.disabled) prepare.title = "승인된 PDF를 확정하고 수기 제출 단계로 이동합니다.";
    else if (!prepare.title) prepare.title = "문안 승인과 PDF 준비 상태를 먼저 확인해 주세요.";
    panel.append(prepare);
  }
  if (packageValue.state === "submit_ready" && !packageLocked) {
    panel.append(packageAction("제출 완료 기록", "primary-button", async () => {
      try {
        const payload = await request(`/api/packages/${packageValue.id}/submitted`, { method: "POST", body: "{}" });
        applyJobs(payload, job.id);
        showToast("확정된 제출본을 기준으로 수기 제출 완료를 기록했습니다.");
      } catch (error) { showToast(error.message, true); }
    }, { capability: "manualSubmission", job, action: "recordSubmitted" }));
  }
  if (packageValue.state === "submitted") {
    const frozen = document.createElement("p");
    frozen.className = "package-frozen";
    frozen.textContent = "제출 완료된 문안과 PDF는 수정할 수 없습니다.";
    panel.append(frozen);
  }
  return panel;
}

async function saveState(job, patch, successMessage = "공고 상태를 저장했습니다.") {
  try {
    const payload = await request(`/api/jobs/${job.id}/state`, { method: "PATCH", body: JSON.stringify(patch) });
    applyJobs(payload, job.id);
    showToast(successMessage);
  } catch (error) {
    showToast(error.message, true);
  }
}

const onboardingStepLabels = [
  "저장 안내", "문서 등록", "문서 분석", "분석 확인", "목표 설정", "지원 조건",
  "검색 전략", "플랫폼", "이력서 권한", "평가 기준", "최종 확인",
];

function splitEntries(value) {
  return String(value || "").split(/[\n,]/).map((item) => item.trim()).filter((item, index, values) => item && values.indexOf(item) === index);
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function inputValue(selector, value) {
  const control = $(selector);
  if (control) control.value = value ?? "";
}

function renderDocumentStatus(kind, selector) {
  const documentValue = state.onboarding.documents.find((item) => item.kind === kind);
  const target = $(selector);
  target.textContent = documentValue
    ? `${documentValue.originalName} · ${(documentValue.size / 1024 / 1024).toFixed(1)}MB`
    : "등록된 문서 없음";
  target.classList.toggle("ready-text", Boolean(documentValue));
  $(`#${kind}DocumentDelete`).hidden = !documentValue;
}

function renderAnalysisReview() {
  const container = $("#analysisReview");
  container.replaceChildren();
  const groups = [
    ["facts", "확인된 사실", "value"],
    ["evidence", "경험·성과 근거", "description"],
    ["sections", "이력서 항목", "value"],
  ];
  for (const [type, headingText, valueField] of groups) {
    const heading = document.createElement("h4");
    heading.textContent = headingText;
    container.append(heading);
    const items = state.onboarding.analysis[type] || [];
    for (const item of items) {
      const review = state.onboarding.analysisReview[type]?.[item.id] || { decision: "pending" };
      const row = document.createElement("article");
      row.className = "analysis-review-row";
      row.dataset.reviewType = type;
      row.dataset.reviewId = item.id;
      const top = document.createElement("div");
      top.className = "analysis-review-heading";
      const label = document.createElement("strong");
      label.textContent = item.label || item.title || item.key;
      const decision = document.createElement("select");
      decision.dataset.reviewDecision = "true";
      for (const [value, text] of [["pending", "선택 필요"], ["use", "그대로 사용"], ["edit", "수정 후 사용"], ["exclude", "제외"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        decision.append(option);
      }
      decision.value = ["use", "edit", "exclude"].includes(review.decision) ? review.decision : "pending";
      top.append(label, decision);
      const editor = document.createElement("textarea");
      editor.rows = type === "evidence" ? 5 : 4;
      editor.dataset.reviewValue = "true";
      const originalValue = item[valueField];
      const reviewedValue = review[valueField] ?? originalValue;
      editor.value = Array.isArray(reviewedValue) ? reviewedValue.join("\n") : reviewedValue || "";
      const source = document.createElement("small");
      if (type === "facts") source.textContent = `출처 위치: ${item.sourceLocator || "문서 내 위치 미기재"} · 신뢰도 ${Math.round(item.confidence || 0)}%`;
      else source.textContent = "등록 문서에서 확인된 내용만 남겨 주세요.";
      row.append(top, editor, source);
      container.append(row);
    }
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "subtle";
      empty.textContent = "분석된 항목이 없습니다.";
      container.append(empty);
    }
  }
}

function renderOnboardingSources() {
  const container = $("#onboardingSources");
  container.replaceChildren();
  const entries = Object.entries(state.onboarding.sources.items || {}).sort((a, b) => Number(a[1].priority) - Number(b[1].priority));
  for (const [key, item] of entries) {
    const row = document.createElement("div");
    row.className = "onboarding-source-row";
    row.dataset.sourceKey = key;
    const name = document.createElement("strong");
    name.textContent = item.label || key;
    const controls = document.createElement("div");
    controls.className = "source-control-grid";
    for (const [field, label] of [["collect", "수집"], ["display", "표시"], ["lifecycleCheck", "마감 확인"]]) {
      const wrapper = document.createElement("label");
      wrapper.className = "inline-check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.sourceField = field;
      input.checked = item[field] !== false && (field !== "collect" || item.collect === true);
      wrapper.append(input, document.createTextNode(` ${label}`));
      controls.append(wrapper);
    }
    const priority = document.createElement("input");
    priority.type = "number";
    priority.dataset.sourceField = "priority";
    priority.value = item.priority;
    priority.title = "대표 링크 우선순위";
    controls.append(priority);
    row.append(name, controls);
    container.append(row);
  }
}

function renderOnboardingSections() {
  const builtin = $("#setupEditableSections");
  builtin.replaceChildren();
  for (const [key, definition] of Object.entries(state.onboarding.builtinSections || {})) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.setupEditableSection = key;
    input.checked = (state.onboarding.resume.editableSections || []).includes(key);
    label.append(input, document.createTextNode(` ${definition.label}`));
    builtin.append(label);
  }
  const custom = $("#setupCustomSections");
  custom.replaceChildren();
  const customItems = (state.onboarding.analysis.sections || []).filter((item) => item.key.startsWith("custom:"));
  for (const item of customItems) {
    const label = document.createElement("label");
    label.className = "custom-permission-row";
    label.dataset.setupCustomPermissionId = item.id;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.onboarding.resume.customPermissions?.[item.id] !== false;
    label.append(input, document.createTextNode(` ${item.label} · 공고별 수정 허용`));
    custom.append(label);
  }
  if (!customItems.length) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = "기존 항목과 겹치지 않는 추가 섹션이 없습니다.";
    custom.append(empty);
  }
}

function renderScoringDimensions() {
  const container = $("#setupScoringDimensions");
  container.replaceChildren();
  for (const item of state.onboarding.search.scoring?.dimensions || []) {
    const row = document.createElement("div");
    row.className = "scoring-row";
    row.dataset.scoringId = item.id;
    const enabledLabel = document.createElement("label");
    enabledLabel.className = "inline-check";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.dataset.scoringField = "enabled";
    enabled.checked = item.enabled !== false;
    enabledLabel.append(enabled, document.createTextNode(` ${item.label}`));
    const weight = document.createElement("input");
    weight.type = "number";
    weight.min = "0";
    weight.max = "100";
    weight.dataset.scoringField = "weight";
    weight.value = item.weight;
    row.append(enabledLabel, weight);
    container.append(row);
  }
  updateScoringWeightTotal();
}

function updateScoringWeightTotal() {
  const enabledRows = $$('[data-scoring-id]').filter((row) => row.querySelector('[data-scoring-field="enabled"]')?.checked);
  const total = enabledRows.reduce((sum, row) => sum + Number(row.querySelector('[data-scoring-field="weight"]')?.value || 0), 0);
  const target = $("#scoringWeightTotal");
  target.textContent = enabledRows.length ? `활성 가중치 합계 ${total} / 100` : "평가 기준 사용 안 함 · 점수를 자동 계산하지 않습니다.";
  target.classList.toggle("invalid-text", enabledRows.length > 0 && Math.abs(total - 100) > 0.0001);
}

function renderQualityCriteria(containerSelector, totalSelector, criteria, scope) {
  const container = $(containerSelector);
  container.replaceChildren();
  for (const item of criteria || defaultDocumentQualityCriteria) {
    const row = document.createElement("div");
    row.className = "scoring-row";
    row.dataset.qualityCriterionId = item.id;
    row.dataset.qualityCriterionScope = scope;
    const enabledLabel = document.createElement("label");
    enabledLabel.className = "inline-check";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.dataset.qualityCriterionField = "enabled";
    enabled.checked = item.enabled === true;
    const requiredCriterion = new Set(["required_sections", "placeholder_free"]).has(item.id);
    enabled.disabled = requiredCriterion || (scope === "settings" && (isReadOnlyDemo() || !state.personalSettings));
    enabledLabel.append(enabled, document.createTextNode(` ${item.label}`));
    const weight = document.createElement("input");
    weight.type = "number";
    weight.min = "0";
    weight.max = "100";
    weight.dataset.qualityCriterionField = "weight";
    weight.value = item.weight;
    weight.disabled = enabled.disabled;
    row.append(enabledLabel, weight);
    container.append(row);
  }
  updateQualityCriteriaTotal(scope, totalSelector);
}

function collectQualityCriteria(scope) {
  return $$(`[data-quality-criterion-scope="${scope}"]`).map((row) => {
    const id = row.dataset.qualityCriterionId;
    const source = (scope === "onboarding" ? state.onboarding?.resume?.qualityCriteria : state.personalSettings?.resume?.quality_rules?.criteria)
      || defaultDocumentQualityCriteria;
    const existing = source.find((item) => item.id === id) || defaultDocumentQualityCriteria.find((item) => item.id === id);
    return {
      id,
      label: existing?.label || id,
      enabled: Boolean(row.querySelector('[data-quality-criterion-field="enabled"]')?.checked),
      weight: Number(row.querySelector('[data-quality-criterion-field="weight"]')?.value || 0),
      ...(new Set(["required_sections", "placeholder_free"]).has(id) ? { required: true } : {}),
    };
  });
}

function updateQualityCriteriaTotal(scope, explicitSelector = "") {
  const rows = $$(`[data-quality-criterion-scope="${scope}"]`);
  const enabled = rows.filter((row) => row.querySelector('[data-quality-criterion-field="enabled"]')?.checked);
  const total = enabled.reduce((sum, row) => sum + Number(row.querySelector('[data-quality-criterion-field="weight"]')?.value || 0), 0);
  const target = $(explicitSelector || (scope === "onboarding" ? "#qualityCriteriaWeightTotal" : "#settingsQualityCriteriaTotal"));
  target.textContent = enabled.length ? `활성 가중치 합계 ${total} / 100` : "최소 한 개 기준을 켜야 합니다.";
  target.classList.toggle("invalid-text", !enabled.length || Math.abs(total - 100) > 0.0001);
}

function renderOnboardingPreview() {
  const target = $("#onboardingPreview");
  const enabledSources = Object.values(state.onboarding.sources.items || {}).filter((item) => item.collect).map((item) => item.label);
  const usedSections = Object.entries(state.onboarding.builtinSections || {})
    .filter(([key]) => (state.onboarding.resume.editableSections || []).includes(key)).map(([, item]) => item.label);
  const cards = [
    ["목표 직무", [state.onboarding.search.primaryRole, ...(state.onboarding.search.secondaryRoles || [])].filter(Boolean).join(" · ") || "입력 필요"],
    ["희망 지역", (state.onboarding.search.regions || []).join(" · ") || "제한 없음"],
    ["수집 플랫폼", enabledSources.join(" · ") || "선택 필요"],
    ["검색 포함어", (state.onboarding.search.includeKeywords || []).join(" · ") || "없음"],
    ["공고 트랙", (state.onboarding.search.tracks || []).join(" · ") || "목표 직무 기준"],
    ["수정 허용 항목", usedSections.join(" · ") || "없음"],
  ];
  target.replaceChildren();
  for (const [label, value] of cards) {
    const card = document.createElement("article");
    const heading = document.createElement("strong");
    heading.textContent = label;
    const copy = document.createElement("p");
    copy.textContent = value;
    card.append(heading, copy);
    target.append(card);
  }
}

function renderOnboarding() {
  const onboarding = state.onboarding;
  $(".tabs").hidden = true;
  $("#jobsScreen").hidden = true;
  $("#resumeScreen").hidden = true;
  $("#settingsScreen").hidden = true;
  $("#onboardingScreen").hidden = false;
  $("#modeBadge").textContent = "초기 설정";
  $("#displayName").textContent = onboarding.profile.displayName || "";
  $("#exampleBanner").hidden = true;
  renderEnvironmentNotice();
  $("#onboardingProgress").textContent = `${onboarding.currentStep} / 11`;
  const steps = $("#onboardingSteps");
  steps.replaceChildren();
  onboardingStepLabels.forEach((labelText, index) => {
    const item = document.createElement("li");
    item.textContent = `${index + 1}. ${labelText}`;
    if (index + 1 === onboarding.currentStep) item.className = "active";
    if (index + 1 < onboarding.currentStep) item.className = "complete";
    steps.append(item);
  });
  $$('[data-onboarding-step]').forEach((panel) => { panel.hidden = Number(panel.dataset.onboardingStep) !== onboarding.currentStep; });
  $("#previousOnboardingStep").hidden = onboarding.currentStep === 1;
  $("#nextOnboardingStep").hidden = onboarding.currentStep === 11;

  $("#onboardingPrivacy").checked = onboarding.privacyAccepted;
  renderDocumentStatus("resume", "#resumeDocumentStatus");
  renderDocumentStatus("portfolio", "#portfolioDocumentStatus");
  $("#agentRequestPath").textContent = onboarding.agentRequestPath;
  $("#analysisStatus").textContent = onboarding.analysis.status === "ready"
    ? `분석 결과를 불러왔습니다 · 사실 ${onboarding.analysis.facts.length}개 · 근거 ${onboarding.analysis.evidence.length}개 · 항목 ${onboarding.analysis.sections.length}개`
    : "문서를 등록한 뒤 Codex·Claude Code 분석 결과를 불러와 주세요.";
  renderAnalysisReview();

  inputValue("#setupDisplayName", onboarding.profile.displayName);
  inputValue("#setupPrimaryRole", onboarding.search.primaryRole);
  inputValue("#setupSecondaryRoles", (onboarding.search.secondaryRoles || []).join(", "));
  inputValue("#setupCareerStage", onboarding.profile.careerStage);
  inputValue("#setupYearsExperience", onboarding.profile.yearsExperience);
  inputValue("#setupCountry", onboarding.profile.country);
  inputValue("#setupTimezone", onboarding.profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  inputValue("#setupCurrency", onboarding.profile.currency);
  inputValue("#setupEmail", onboarding.profile.email);
  inputValue("#setupPhone", onboarding.profile.phone);
  inputValue("#setupAddress", onboarding.profile.address);
  $("#setupIncludeEmail").checked = onboarding.profile.includeEmailInPdf === true;
  $("#setupIncludePhone").checked = onboarding.profile.includePhoneInPdf === true;
  $("#setupIncludeAddress").checked = onboarding.profile.includeAddressInPdf === true;
  inputValue("#setupDesiredWork", (onboarding.search.desiredWork || []).join("\n"));
  inputValue("#setupAvoidedWork", (onboarding.search.avoidedWork || []).join("\n"));
  inputValue("#setupRegions", (onboarding.search.regions || []).join(", "));
  inputValue("#setupEmploymentTypes", (onboarding.profile.employmentTypes || []).join(", "));
  inputValue("#setupWorkModes", (onboarding.profile.workModes || []).join(", "));
  inputValue("#setupExperienceMinimum", onboarding.search.experienceMinimum);
  inputValue("#setupExperienceMaximum", onboarding.search.experienceMaximum);
  inputValue("#setupSalaryMinimum", onboarding.profile.salaryMinimum);
  inputValue("#setupSalaryTarget", onboarding.profile.salaryTarget);
  inputValue("#setupPreferredCompanies", (onboarding.search.preferredCompanies || []).join(", "));
  inputValue("#setupExcludedCompanies", (onboarding.search.excludedCompanies || []).join(", "));
  inputValue("#setupPreferredIndustries", (onboarding.search.preferredIndustries || []).join(", "));
  inputValue("#setupExcludedIndustries", (onboarding.search.excludedIndustries || []).join(", "));
  inputValue("#setupIncludeKeywords", (onboarding.search.includeKeywords || []).join("\n"));
  inputValue("#setupExcludeKeywords", (onboarding.search.excludeKeywords || []).join("\n"));
  inputValue("#setupTracks", (onboarding.search.tracks || []).join(", "));
  $("#setupPreferDirect").checked = onboarding.sources.preferDirectCompany !== false;
  renderOnboardingSources();
  renderOnboardingSections();
  renderScoringDimensions();
  renderQualityCriteria("#setupQualityCriteria", "#qualityCriteriaWeightTotal", onboarding.resume.qualityCriteria, "onboarding");
  inputValue("#setupReviewBelow", onboarding.search.scoring?.reviewBelow ?? 70);
  inputValue("#setupMinimumScore", onboarding.resume.minimumScore ?? 80);
  inputValue("#setupMaximumPages", onboarding.resume.maximumPdfPages ?? 3);
  renderOnboardingPreview();
}

function renderEnvironmentNotice() {
  const inCodespaces = state.data?.environment?.codespaces === true;
  $("#codespacesBanner").hidden = !inCodespaces;
  $("#onboardingStorageTitle").textContent = inCodespaces
    ? "체험 자료는 내 GitHub 임시 공간에 저장됩니다"
    : "개인 자료는 이 컴퓨터에만 저장됩니다";
  $("#onboardingStorageDescription").textContent = inCodespaces
    ? "등록한 문서와 설정은 Git에는 포함되지 않지만 이 Codespace가 삭제될 때까지 GitHub 서버에 남습니다. 기능 확인에는 합성 문서를 사용해 주세요."
    : "등록한 문서, 분석 결과, 설정과 개인 DB는 Git에 포함되지 않는 로컬 비공개 영역에 저장됩니다.";
}

function collectAnalysisReview() {
  const result = { facts: {}, evidence: {}, sections: {} };
  for (const row of $$('[data-review-type]')) {
    const type = row.dataset.reviewType;
    const id = row.dataset.reviewId;
    const value = row.querySelector('[data-review-value="true"]')?.value || "";
    const decision = row.querySelector('[data-review-decision="true"]')?.value || "pending";
    const item = (state.onboarding.analysis[type] || []).find((candidate) => candidate.id === id);
    const field = type === "evidence" ? "description" : "value";
    result[type][id] = { decision, [field]: item?.kind === "list" ? splitEntries(value) : value };
  }
  return result;
}

function collectSourceItems() {
  const result = {};
  for (const row of $$('[data-source-key]')) {
    const key = row.dataset.sourceKey;
    const existing = state.onboarding.sources.items[key];
    const control = (field) => row.querySelector(`[data-source-field="${field}"]`);
    result[key] = {
      ...existing,
      collect: Boolean(control("collect")?.checked),
      display: Boolean(control("display")?.checked),
      lifecycleCheck: Boolean(control("lifecycleCheck")?.checked),
      priority: Number(control("priority")?.value || 0),
    };
  }
  return result;
}

function collectScoringDimensions() {
  return $$('[data-scoring-id]').map((row) => {
    const existing = state.onboarding.search.scoring.dimensions.find((item) => item.id === row.dataset.scoringId);
    return {
      ...existing,
      enabled: Boolean(row.querySelector('[data-scoring-field="enabled"]')?.checked),
      weight: Number(row.querySelector('[data-scoring-field="weight"]')?.value || 0),
    };
  });
}

function collectOnboardingPatch(currentStep) {
  const customPermissions = {};
  for (const row of $$('[data-setup-custom-permission-id]')) customPermissions[row.dataset.setupCustomPermissionId] = Boolean(row.querySelector("input")?.checked);
  return {
    currentStep,
    privacyAccepted: $("#onboardingPrivacy").checked,
    profile: {
      displayName: $("#setupDisplayName").value,
      country: $("#setupCountry").value,
      timezone: $("#setupTimezone").value,
      currency: $("#setupCurrency").value,
      careerStage: $("#setupCareerStage").value,
      yearsExperience: numberOrNull($("#setupYearsExperience").value),
      employmentTypes: splitEntries($("#setupEmploymentTypes").value),
      workModes: splitEntries($("#setupWorkModes").value),
      salaryMinimum: numberOrNull($("#setupSalaryMinimum").value),
      salaryTarget: numberOrNull($("#setupSalaryTarget").value),
      email: $("#setupEmail").value,
      phone: $("#setupPhone").value,
      address: $("#setupAddress").value,
      includeEmailInPdf: $("#setupIncludeEmail").checked,
      includePhoneInPdf: $("#setupIncludePhone").checked,
      includeAddressInPdf: $("#setupIncludeAddress").checked,
    },
    search: {
      primaryRole: $("#setupPrimaryRole").value,
      secondaryRoles: splitEntries($("#setupSecondaryRoles").value),
      desiredWork: splitEntries($("#setupDesiredWork").value),
      avoidedWork: splitEntries($("#setupAvoidedWork").value),
      regions: splitEntries($("#setupRegions").value),
      experienceMinimum: numberOrNull($("#setupExperienceMinimum").value),
      experienceMaximum: numberOrNull($("#setupExperienceMaximum").value),
      includeKeywords: splitEntries($("#setupIncludeKeywords").value),
      excludeKeywords: splitEntries($("#setupExcludeKeywords").value),
      tracks: splitEntries($("#setupTracks").value),
      preferredCompanies: splitEntries($("#setupPreferredCompanies").value),
      excludedCompanies: splitEntries($("#setupExcludedCompanies").value),
      preferredIndustries: splitEntries($("#setupPreferredIndustries").value),
      excludedIndustries: splitEntries($("#setupExcludedIndustries").value),
      scoring: {
        reviewBelow: numberOrNull($("#setupReviewBelow").value) ?? 70,
        dimensions: collectScoringDimensions(),
      },
    },
    sources: {
      preferDirectCompany: $("#setupPreferDirect").checked,
      requireNotClosed: true,
      items: collectSourceItems(),
    },
    resume: {
      editableSections: $$('[data-setup-editable-section]:checked').map((input) => input.dataset.setupEditableSection),
      customPermissions,
      minimumScore: numberOrNull($("#setupMinimumScore").value) ?? 80,
      maximumPdfPages: numberOrNull($("#setupMaximumPages").value) ?? 3,
      qualityCriteria: collectQualityCriteria("onboarding"),
    },
    analysisReview: collectAnalysisReview(),
  };
}

async function saveOnboardingDraft(step) {
  const payload = await request("/api/onboarding", { method: "PATCH", body: JSON.stringify(collectOnboardingPatch(step)) });
  state.onboarding = payload.onboarding;
  state.data.onboarding = payload.onboarding;
  renderOnboarding();
}

async function uploadOnboardingFile(kind, file) {
  if (!file) return;
  const form = new FormData();
  form.append("document", file, file.name);
  const payload = await request(`/api/onboarding/documents?kind=${encodeURIComponent(kind)}`, { method: "POST", body: form });
  state.onboarding = payload.onboarding;
  state.data.onboarding = payload.onboarding;
  renderOnboarding();
  showToast(`${kind === "resume" ? "이력서" : "포트폴리오"}를 등록했습니다.`);
}

async function deleteOnboardingFile(kind) {
  const documentValue = state.onboarding.documents.find((item) => item.kind === kind);
  if (!documentValue) return;
  const payload = await request(`/api/onboarding/documents/${encodeURIComponent(documentValue.id)}`, { method: "DELETE", body: "{}" });
  state.onboarding = payload.onboarding;
  state.data.onboarding = payload.onboarding;
  renderOnboarding();
  showToast(`${kind === "resume" ? "이력서" : "포트폴리오"}를 제거했습니다.`);
}

function bindOnboardingEvents() {
  $("#reloadButton").addEventListener("click", () => window.location.reload());
  $("#setupScoringDimensions").addEventListener("input", updateScoringWeightTotal);
  $("#setupScoringDimensions").addEventListener("change", updateScoringWeightTotal);
  $("#setupQualityCriteria").addEventListener("input", () => updateQualityCriteriaTotal("onboarding"));
  $("#setupQualityCriteria").addEventListener("change", () => updateQualityCriteriaTotal("onboarding"));
  $("#previousOnboardingStep").addEventListener("click", async () => {
    try { await saveOnboardingDraft(Math.max(1, state.onboarding.currentStep - 1)); } catch (error) { showToast(error.message, true); }
  });
  $("#nextOnboardingStep").addEventListener("click", async () => {
    try { await saveOnboardingDraft(Math.min(11, state.onboarding.currentStep + 1)); } catch (error) { showToast(error.message, true); }
  });
  $("#resumeDocumentInput").addEventListener("change", async (event) => {
    try { await uploadOnboardingFile("resume", event.target.files[0]); } catch (error) { showToast(error.message, true); }
    event.target.value = "";
  });
  $("#portfolioDocumentInput").addEventListener("change", async (event) => {
    try { await uploadOnboardingFile("portfolio", event.target.files[0]); } catch (error) { showToast(error.message, true); }
    event.target.value = "";
  });
  $("#resumeDocumentDelete").addEventListener("click", async () => {
    try { await deleteOnboardingFile("resume"); } catch (error) { showToast(error.message, true); }
  });
  $("#portfolioDocumentDelete").addEventListener("click", async () => {
    try { await deleteOnboardingFile("portfolio"); } catch (error) { showToast(error.message, true); }
  });
  $("#copyAgentPrompt").addEventListener("click", async () => {
    const prompt = `이 저장소의 ${state.onboarding.agentRequestPath}를 읽고 등록 문서를 사실 근거만으로 분석해줘. 추측은 추가하지 말고 구조화 결과를 현재 로컬 대시보드의 /api/onboarding/analysis에 등록해줘.`;
    try {
      await navigator.clipboard.writeText(prompt);
      showToast("Codex·Claude Code 요청문을 복사했습니다.");
    } catch {
      showToast("요청문을 복사하지 못했습니다.", true);
    }
  });
  $("#saveAnalysis").addEventListener("click", async () => {
    try {
      const analysis = JSON.parse($("#analysisJson").value || "{}");
      const payload = await request("/api/onboarding/analysis", { method: "PUT", body: JSON.stringify(analysis) });
      state.onboarding = payload.onboarding;
      state.data.onboarding = payload.onboarding;
      renderOnboarding();
      showToast("문서 분석 결과를 불러왔습니다.");
    } catch (error) { showToast(error.message, true); }
  });
  $("#applyAnalysisSuggestions").addEventListener("click", () => {
    const suggested = state.onboarding.analysis.suggested || {};
    if (!$("#setupPrimaryRole").value && suggested.roles?.length) $("#setupPrimaryRole").value = suggested.roles[0];
    if (!$("#setupSecondaryRoles").value && suggested.roles?.length > 1) $("#setupSecondaryRoles").value = suggested.roles.slice(1).join(", ");
    if (!$("#setupIncludeKeywords").value) $("#setupIncludeKeywords").value = (suggested.includeKeywords || []).join("\n");
    if (!$("#setupExcludeKeywords").value) $("#setupExcludeKeywords").value = (suggested.excludeKeywords || []).join("\n");
    if (!$("#setupTracks").value) $("#setupTracks").value = (suggested.tracks || []).join(", ");
    showToast("문서 분석 제안을 입력했습니다. 적용 전 내용을 확인해 주세요.");
  });
  $("#completeOnboarding").addEventListener("click", async () => {
    try {
      await saveOnboardingDraft(11);
      const payload = await request("/api/onboarding/complete", { method: "POST", body: "{}" });
      state.data = payload.dashboard;
      state.onboarding = null;
      state.screen = "jobs";
      renderAll();
      bindEvents();
      showToast("개인 설정을 완료했습니다.");
    } catch (error) { showToast(error.message, true); }
  });
}

function renderResume() {
  const resume = state.data.resume;
  const readiness = $("#resumeReadiness");
  readiness.replaceChildren();
  const readinessTitle = document.createElement("strong");
  readinessTitle.textContent = `이력서 준비도 ${resume.readiness?.score || 0}%`;
  const readinessText = document.createElement("p");
  readinessText.textContent = resume.readiness?.ready
    ? "공고별 작업본을 만들기 위한 기본 정보가 준비되었습니다."
    : (resume.readiness?.missing || []).map((item) => item.message).join(" · ") || "기본 정보를 확인해 주세요.";
  readiness.classList.toggle("ready", Boolean(resume.readiness?.ready));
  readiness.append(readinessTitle, readinessText);

  const assets = $("#resumeAssets");
  assets.replaceChildren();
  for (const asset of resume.assets || []) {
    const row = document.createElement("div");
    row.className = "resume-asset-row";
    const description = document.createElement("div");
    const selected = document.createElement("input");
    selected.type = "checkbox";
    selected.dataset.analysisDocumentId = asset.id;
    selected.disabled = !capabilityWritable("documents") || asset.status === "archived";
    selected.setAttribute("aria-label", `${asset.label || asset.originalName} 분석 선택`);
    const label = document.createElement("strong");
    label.textContent = asset.label || asset.originalName;
    const meta = document.createElement("small");
    meta.textContent = `${asset.kind === "portfolio" ? "포트폴리오" : "이력서"} · ${Math.ceil(Number(asset.size || 0) / 1024)}KB`;
    description.append(label, meta);
    const select = document.createElement("select");
    select.dataset.resumeAssetId = asset.id;
    for (const [value, text] of [["active", "사용"], ["review_required", "검토 필요"], ["archived", "보관"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = asset.status || "active";
    select.disabled = !capabilityWritable("documents");
    select.addEventListener("change", async () => {
      try {
        const payload = await request(`/api/resume/assets/${encodeURIComponent(asset.id)}`, {
          method: "PATCH", body: JSON.stringify({ status: select.value, label: asset.label || asset.originalName }),
        });
        state.data.resume = payload.resume;
        if (payload.jobs) state.data.jobs = payload.jobs;
        if (payload.workflow) state.data.workflow = payload.workflow;
        renderResume();
        renderJobs();
        showToast("문서 자산 상태를 저장했습니다.");
      } catch (error) { showToast(error.message, true); renderResume(); }
    });
    row.append(selected, description, select);
    assets.append(row);
  }
  if (!(resume.assets || []).length) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = "등록된 이력서·포트폴리오 자산이 없습니다.";
    assets.append(empty);
  }
  renderDocumentManager();
  $("#resumeJobFamily").value = resume.jobFamily || "";
  $("#resumeJobRole").value = resume.jobRole || "";
  $("#resumeCareerType").value = resume.careerType || "new";
  $("#resumeCareerStage").value = resume.careerStage || (resume.careerType === "experienced" ? "experienced" : "entry");
  $("#resumeYearsExperience").value = resume.yearsExperience || "";
  $("#resumeYearsExperience").disabled = resume.careerType !== "experienced";
  $("#resumeSchool").value = resume.school || "";
  $("#resumeMajor").value = resume.major || "";
  $("#resumeHeadline").value = resume.headline || "";
  $("#resumeSummary").value = resume.summary || "";
  $("#resumeSkills").value = (resume.skills || []).join("\n");
  $("#resumeHighlights").value = (resume.experienceHighlights || []).join("\n");
  $("#resumeCertificates").value = (resume.certificates || []).join("\n");
  $("#resumeAchievementEvidence").value = resume.achievementEvidence || "";
  $("#resumeRepresentativeExperience").value = resume.representativeExperience || "";
  $("#resumeDirectScope").value = resume.directScope || "";
  $("#resumeCollaborationScope").value = resume.collaborationScope || "";
  $("#resumeCareerDirection").value = resume.careerDirection || "";
  const editable = new Set(resume.editableSections || []);
  $$('[data-editable-section]').forEach((input) => { input.checked = editable.has(input.dataset.editableSection); });
  const structuredContainer = $("#resumeStructuredItems");
  structuredContainer.replaceChildren();
  for (const item of resume.structuredItems || []) structuredContainer.append(renderStructuredResumeItem(item));
  if (!(resume.structuredItems || []).length) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = "구조화 항목이 없습니다. 사용자가 입력하지 않은 경력이나 기술은 자동 생성하지 않습니다.";
    structuredContainer.append(empty);
  }
  const customContainer = $("#resumeCustomSections");
  customContainer.replaceChildren();
  for (const section of resume.customSections || []) {
    const row = document.createElement("div");
    row.className = "custom-section-row";
    row.dataset.customSectionId = section.id;
    row.dataset.customSectionKey = section.key;
    row.dataset.customSectionKind = section.kind;
    const heading = document.createElement("div");
    heading.className = "custom-section-heading";
    const label = document.createElement("strong");
    label.textContent = section.label;
    const editableLabel = document.createElement("label");
    editableLabel.className = "inline-check";
    const editableInput = document.createElement("input");
    editableInput.type = "checkbox";
    editableInput.dataset.customEditable = section.id;
    editableInput.checked = section.editable !== false;
    editableLabel.append(editableInput, document.createTextNode(" 공고별 수정 허용"));
    heading.append(label, editableLabel);
    const input = section.kind === "list" ? document.createElement("textarea") : document.createElement("textarea");
    input.rows = 5;
    input.dataset.customValue = section.id;
    input.value = section.kind === "list" ? (section.value || []).join("\n") : section.value || "";
    row.append(heading, input);
    customContainer.append(row);
  }
  if (!(resume.customSections || []).length) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = "추가 항목이 없습니다.";
    customContainer.append(empty);
  }
  const evidenceContainer = $("#resumeEvidenceItems");
  evidenceContainer.replaceChildren();
  for (const item of resume.evidenceItems || []) {
    const card = document.createElement("article");
    card.className = "evidence-card";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const description = document.createElement("p");
    description.textContent = item.description;
    card.append(title, description);
    if ((item.metrics || []).length) {
      const metrics = document.createElement("small");
      metrics.textContent = `확인된 수치: ${item.metrics.join(" · ")}`;
      card.append(metrics);
    }
    evidenceContainer.append(card);
  }
  if (!(resume.evidenceItems || []).length) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = "확인된 근거가 없습니다.";
    evidenceContainer.append(empty);
  }
  $("#resumeSavedAt").textContent = resume.updatedAt ? `마지막 저장 ${formatDateTime(resume.updatedAt)}` : "";
  for (const control of $("#resumeForm").querySelectorAll("input, textarea, select, button")) {
    control.disabled = !capabilityWritable("resumeManagement") || control.id === "resumeYearsExperience" && resume.careerType !== "experienced";
    if (!capabilityWritable("resumeManagement")) control.title = "현재 실행 모드에서는 이력서 기준을 수정할 수 없습니다.";
  }
}

function structuredField(labelText, field, value = "", { textarea = false, placeholder = "" } = {}) {
  const label = document.createElement("label");
  const title = document.createElement("span");
  title.textContent = labelText;
  const input = textarea ? document.createElement("textarea") : document.createElement("input");
  if (textarea) input.rows = 3;
  input.dataset.structuredField = field;
  input.value = Array.isArray(value) ? value.join("\n") : value || "";
  input.placeholder = placeholder;
  label.append(title, input);
  return label;
}

function renderStructuredResumeItem(item) {
  const card = document.createElement("article");
  card.className = "structured-editor-card";
  card.dataset.structuredId = item.id;
  const header = document.createElement("div");
  header.className = "structured-editor-head";
  const kind = document.createElement("select");
  kind.dataset.structuredField = "kind";
  for (const [value, label] of Object.entries(structuredKindLabels)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    kind.append(option);
  }
  kind.value = item.kind || "experience";
  const activeLabel = document.createElement("label");
  activeLabel.className = "inline-check";
  const active = document.createElement("input");
  active.type = "checkbox";
  active.dataset.structuredField = "active";
  active.checked = item.active !== false;
  activeLabel.append(active, document.createTextNode(" 출력에 사용"));
  const remove = document.createElement("button");
  remove.className = "text-button";
  remove.type = "button";
  remove.textContent = "삭제";
  remove.addEventListener("click", () => {
    state.data.resume.structuredItems = (state.data.resume.structuredItems || []).filter((candidate) => candidate.id !== item.id);
    card.remove();
    const container = $("#resumeStructuredItems");
    if (!container.children.length) {
      const empty = document.createElement("p");
      empty.className = "subtle";
      empty.textContent = "구조화 항목이 없습니다. 사용자가 입력하지 않은 경력이나 기술은 자동 생성하지 않습니다.";
      container.append(empty);
    }
  });
  header.append(kind, activeLabel, remove);
  const grid = document.createElement("div");
  grid.className = "form-grid";
  grid.append(
    structuredField("항목명", "title", item.title, { placeholder: "직책, 학위, 기술, 자격 또는 프로젝트명" }),
    structuredField("기관·회사", "organization", item.organization),
    structuredField("역할·전공", "role", item.role),
    structuredField("지역", "location", item.location),
    structuredField("시작", "startDate", item.startDate, { placeholder: "YYYY 또는 YYYY-MM" }),
    structuredField("종료", "endDate", item.endDate, { placeholder: "YYYY-MM 또는 present" }),
  );
  card.append(header, grid,
    structuredField("설명", "summary", item.summary, { textarea: true }),
    structuredField("주요 내용 · 한 줄에 하나", "highlights", item.highlights, { textarea: true }),
    structuredField("관련 기술 · 한 줄에 하나", "skills", item.skills, { textarea: true }));
  return card;
}

function collectStructuredResumeItems() {
  const lines = (value) => value.split("\n").map((entry) => entry.trim()).filter(Boolean);
  return $$('[data-structured-id]').map((card, index) => {
    const value = (field) => card.querySelector(`[data-structured-field="${field}"]`);
    return {
      id: card.dataset.structuredId,
      kind: value("kind").value,
      title: value("title").value,
      organization: value("organization").value,
      role: value("role").value,
      location: value("location").value,
      startDate: value("startDate").value,
      endDate: value("endDate").value,
      summary: value("summary").value,
      highlights: lines(value("highlights").value),
      skills: lines(value("skills").value),
      sourceRefs: (state.data.resume.structuredItems || []).find((item) => item.id === card.dataset.structuredId)?.sourceRefs || [],
      displayOrder: index + 1,
      active: value("active").checked,
    };
  });
}

function renderSettings() {
  const labels = { profile: "기본 프로필", search: "검색 전략", sources: "플랫폼", resume: "이력서" };
  const checklist = $("#configChecklist");
  checklist.replaceChildren();
  for (const [key, item] of Object.entries(state.data.configStatus.files)) {
    const row = document.createElement("div");
    row.className = "check-row";
    const name = document.createElement("span");
    name.textContent = labels[key] || key;
    const status = document.createElement("span");
    status.className = `check-state ${item.complete ? "ready" : "pending"}`;
    status.textContent = item.complete ? "준비됨" : "설정 필요";
    row.append(name, status);
    checklist.append(row);
  }
  const sources = $("#sourceSettings");
  sources.replaceChildren();
  const editableSources = state.personalSettings?.sources?.items || state.data.sources || {};
  for (const [key, item] of Object.entries(editableSources).sort((a, b) => a[1].priority - b[1].priority)) {
    const row = document.createElement("div");
    row.className = "source-setting";
    row.dataset.settingsSource = key;
    const name = document.createElement("strong");
    name.textContent = item.label || key;
    const controls = document.createElement("div");
    controls.className = "source-setting-controls";
    for (const [field, textValue] of [["collect", "수집"], ["display", "표시"], ["lifecycle_check", "마감 확인"]]) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.sourceField = field;
      checkbox.checked = item[field] !== false && (field !== "collect" || item[field] === true);
      checkbox.disabled = !capabilityWritable("settings") || !state.personalSettings;
      label.append(checkbox, document.createTextNode(textValue));
      controls.append(label);
    }
    const priority = document.createElement("input");
    priority.type = "number";
    priority.dataset.sourceField = "priority";
    priority.value = item.priority;
    priority.setAttribute("aria-label", `${item.label || key} 대표 링크 순서`);
    priority.disabled = !capabilityWritable("settings") || !state.personalSettings;
    controls.append(priority);
    row.append(name, controls);
    sources.append(row);
  }
  const scoring = $("#scoringSettings");
  scoring.replaceChildren();
  const profile = state.data.scoringProfile;
  if (!profile?.configured) {
    const notice = document.createElement("p");
    notice.className = "package-state hold";
    notice.textContent = "평가 기준 설정 필요 · 공고 점수를 자동 계산하지 않습니다.";
    scoring.append(notice);
  } else {
    for (const item of profile.dimensions || []) {
      const row = document.createElement("div");
      row.className = "source-setting";
      const label = document.createElement("strong");
      label.textContent = item.label;
      const weight = document.createElement("span");
      weight.textContent = `가중치 ${item.weight}`;
      row.append(label, weight);
      scoring.append(row);
    }
  }
  if (state.personalSettings) {
    const settings = state.personalSettings;
    $("#settingsDisplayName").value = settings.profile.displayName || "";
    $("#settingsTimezone").value = settings.profile.timezone || "Asia/Seoul";
    $("#settingsTargetRoles").value = (settings.search.targetRoles || []).join("\n");
    $("#settingsTracks").value = (settings.search.tracks || []).join("\n");
    $("#settingsRegions").value = (settings.profile.regions || []).join("\n");
    $("#settingsIncludeKeywords").value = (settings.search.includeKeywords || []).join("\n");
    $("#settingsExcludeKeywords").value = (settings.search.excludeKeywords || []).join("\n");
    $("#settingsDesiredWork").value = (settings.search.desiredWork || []).join("\n");
    $("#settingsAvoidedWork").value = (settings.search.avoidedWork || []).join("\n");
    $("#settingsMinimumScore").value = settings.resume.quality_rules?.minimum_score ?? 80;
    $("#settingsMaximumPages").value = settings.resume.quality_rules?.maximum_pdf_pages ?? 3;
  }
  renderQualityCriteria("#settingsQualityCriteria", "#settingsQualityCriteriaTotal",
    state.personalSettings?.resume?.quality_rules?.criteria || defaultDocumentQualityCriteria, "settings");
  for (const control of $("#personalSettingsForm").querySelectorAll("input, textarea, select, button")) {
    control.disabled = !capabilityWritable("settings") || !state.personalSettings;
    if (!capabilityWritable("settings")) control.title = "현재 실행 모드에서는 개인 설정을 수정할 수 없습니다.";
  }
}

function renderDocumentManager() {
  const replace = $("#personalDocumentReplace");
  if (!replace) return;
  const current = replace.value;
  const first = document.createElement("option");
  first.value = "";
  first.textContent = "새 문서로 추가";
  replace.replaceChildren(first);
  const kind = $("#personalDocumentKind").value;
  const documents = state.personalSettings?.documents || (state.data?.resume?.assets || []);
  for (const documentValue of documents.filter((item) => item.kind === kind && item.active !== false && item.status !== "archived")) {
    const option = document.createElement("option");
    option.value = documentValue.id;
    option.textContent = `${documentValue.originalName || documentValue.label} 교체`;
    replace.append(option);
  }
  replace.value = [...replace.options].some((item) => item.value === current) ? current : "";
  protectBackendControl($("#personalDocumentKind"), { capability: "documents" });
  protectBackendControl(replace, { capability: "documents" });
  protectBackendControl($("#personalDocumentFile"), { capability: "documents" });
  protectBackendControl($("#personalDocumentForm button"), { capability: "documents" });
  protectBackendControl($("#reanalyzeDocuments"), { capability: "documentAnalysisRequest" });
}

function syncFilterControls() {
  $("#searchInput").value = state.filters.search;
  $("#trackFilter").value = state.filters.track;
  $("#platformFilter").value = state.filters.platform;
  $("#statusFilter").value = state.filters.status;
  $("#lifecycleFilter").value = state.filters.lifecycle;
  $("#deadlineFilter").value = state.filters.deadline;
  $("#jobSort").value = state.filters.sort;
  $("#favoriteFilter").checked = state.filters.favorite;
}

function renderSavedFilters() {
  const select = $("#savedFilterSelect");
  const current = select.value;
  const first = document.createElement("option");
  first.value = "";
  first.textContent = "직접 설정";
  select.replaceChildren(first);
  for (const item of state.data.savedFilters || []) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.isDefault ? "★ " : ""}${item.name}`;
    select.append(option);
  }
  select.value = (state.data.savedFilters || []).some((item) => item.id === current) ? current : "";
  protectBackendControl(select, { capability: "savedFilters" });
  protectBackendControl($("#savedFilterName"), { capability: "savedFilters" });
  protectBackendControl($("#savedFilterDefault"), { capability: "savedFilters" });
  protectBackendControl($("#saveCurrentFilter"), { capability: "savedFilters" });
  protectBackendControl($("#deleteSavedFilter"), { capability: "savedFilters" });
  $("#deleteSavedFilter").disabled = isReadOnlyDemo() || !select.value;
}

async function refreshJobFilters() {
  state.pagination.page = 1;
  state.selectedJobId = null;
  await loadJobPage({ force: true });
}

function renderAll() {
  renderEnvironmentNotice();
  $("#lastUpdatedLabel").textContent = `최종 확인 ${formatDateTime(new Date().toISOString())}`;
  if (state.data.mode === "onboarding") {
    state.onboarding = state.data.onboarding;
    renderOnboarding();
    return;
  }
  $(".tabs").hidden = false;
  $("#onboardingScreen").hidden = true;
  setScreen(state.screen);
  $("#displayName").textContent = state.data.profile.displayName || "";
  $("#modeBadge").textContent = state.data.mode === "demo" ? "예시 데이터" : "개인 데이터";
  $("#exampleBanner").hidden = state.data.mode !== "demo";
  fillSelect($("#trackFilter"), state.facets.tracks || []);
  fillSelect($("#platformFilter"), state.facets.platforms || []);
  syncFilterControls();
  renderJobs();
  renderPagination();
  renderWorkflow();
  renderCompanion();
  renderInbox();
  renderSavedFilters();
  renderResume();
  renderSettings();
}

function bindEvents() {
  let searchTimer;
  $$(".tab").forEach((button) => button.addEventListener("click", () => {
    setScreen(button.dataset.screen);
    if (["settings", "resume"].includes(button.dataset.screen) && !isReadOnlyDemo()) {
      loadPersonalSettings().catch((error) => showToast(error.message, true));
    }
  }));
  $("#reloadButton").addEventListener("click", () => {
    refreshDashboardData()
      .then(() => showToast("대시보드를 새로고침했습니다."))
      .catch((error) => showToast(error.message, true));
  });
  $("#jobQuickTabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-quick-kind]");
    if (!button) return;
    const kind = button.dataset.quickKind;
    state.filters.favorite = kind === "favorite";
    state.filters.status = kind === "applied" ? "applied" : kind === "skipped" ? "skipped" : "";
    state.filters.track = kind === "track" ? button.dataset.quickValue || "" : "";
    state.filters.lifecycle = ["applied", "skipped"].includes(kind) ? "all" : "active";
    state.pagination.page = 1;
    syncFilterControls();
    loadJobPage({ force: true }).catch((error) => showToast(error.message, true));
  });
  $("#resetFiltersButton").addEventListener("click", () => {
    state.filters = { search: "", track: "", platform: "", status: "", lifecycle: "active", deadline: "", sort: "score", favorite: false };
    state.pagination.page = 1;
    syncFilterControls();
    loadJobPage({ force: true }).catch((error) => showToast(error.message, true));
  });
  $("#queueJobCollection").addEventListener("click", () => createCompanionRequest("collect_jobs"));
  $("#queueDocumentAnalysis").addEventListener("click", () => createCompanionRequest("analyze_documents"));
  $("#searchInput").addEventListener("input", (event) => {
    state.filters.search = event.target.value;
    renderJobs();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshJobFilters().catch((error) => showToast(error.message, true)), 180);
  });
  $("#trackFilter").addEventListener("change", (event) => { state.filters.track = event.target.value; renderJobs(); refreshJobFilters().catch((error) => showToast(error.message, true)); });
  $("#platformFilter").addEventListener("change", (event) => { state.filters.platform = event.target.value; renderJobs(); refreshJobFilters().catch((error) => showToast(error.message, true)); });
  $("#statusFilter").addEventListener("change", (event) => {
    state.filters.status = event.target.value;
    if (["skipped", "rejected"].includes(state.filters.status) && state.filters.lifecycle === "active") {
      state.filters.lifecycle = "all";
      $("#lifecycleFilter").value = "all";
      showToast("종료·제외 상태를 볼 수 있도록 공고 보기를 전체로 바꿨습니다.");
    }
    renderJobs();
    refreshJobFilters().catch((error) => showToast(error.message, true));
  });
  $("#lifecycleFilter").addEventListener("change", (event) => {
    state.filters.lifecycle = event.target.value;
    if (state.filters.lifecycle === "active" && ["skipped", "rejected"].includes(state.filters.status)) {
      state.filters.status = "";
      $("#statusFilter").value = "";
      showToast("활성 공고를 볼 수 있도록 지원 상태를 전체로 바꿨습니다.");
    }
    renderJobs();
    refreshJobFilters().catch((error) => showToast(error.message, true));
  });
  $("#deadlineFilter").addEventListener("change", (event) => { state.filters.deadline = event.target.value; renderJobs(); refreshJobFilters().catch((error) => showToast(error.message, true)); });
  $("#jobSort").addEventListener("change", (event) => { state.filters.sort = event.target.value; renderJobs(); refreshJobFilters().catch((error) => showToast(error.message, true)); });
  $("#favoriteFilter").addEventListener("change", (event) => { state.filters.favorite = event.target.checked; renderJobs(); refreshJobFilters().catch((error) => showToast(error.message, true)); });
  $("#previousJobPage").addEventListener("click", () => {
    if (state.pagination.page <= 1) return;
    state.pagination.page -= 1;
    loadJobPage({ force: true }).catch((error) => showToast(error.message, true));
  });
  $("#nextJobPage").addEventListener("click", () => {
    if (state.pagination.page >= state.pagination.totalPages) return;
    state.pagination.page += 1;
    loadJobPage({ force: true }).catch((error) => showToast(error.message, true));
  });
  $("#savedFilterSelect").addEventListener("change", (event) => {
    const saved = (state.data.savedFilters || []).find((item) => item.id === event.target.value);
    $("#deleteSavedFilter").disabled = !saved;
    if (!saved) return;
    state.filters = { ...saved.filters };
    $("#savedFilterName").value = saved.name;
    $("#savedFilterDefault").checked = saved.isDefault;
    syncFilterControls();
    renderJobs();
    refreshJobFilters().catch((error) => showToast(error.message, true));
  });
  $("#saveCurrentFilter").addEventListener("click", async () => {
    if (isReadOnlyDemo()) return;
    try {
      const payload = await request("/api/saved-filters", {
        method: "POST",
        body: JSON.stringify({ name: $("#savedFilterName").value, filters: state.filters, isDefault: $("#savedFilterDefault").checked }),
      });
      state.data.savedFilters = payload.savedFilters;
      renderSavedFilters();
      $("#savedFilterSelect").value = payload.savedFilter.id;
      $("#deleteSavedFilter").disabled = false;
      showToast("현재 공고 필터를 저장했습니다.");
    } catch (error) { showToast(error.message, true); }
  });
  $("#deleteSavedFilter").addEventListener("click", async () => {
    const id = $("#savedFilterSelect").value;
    if (isReadOnlyDemo() || !id) return;
    try {
      const payload = await request(`/api/saved-filters/${id}`, { method: "DELETE", body: "{}" });
      state.data.savedFilters = payload.savedFilters;
      $("#savedFilterName").value = "";
      $("#savedFilterDefault").checked = false;
      renderSavedFilters();
      showToast("저장 필터를 삭제했습니다.");
    } catch (error) { showToast(error.message, true); }
  });
  $("#resumeCareerType").addEventListener("change", (event) => {
    $("#resumeYearsExperience").disabled = event.target.value !== "experienced";
  });
  $("#personalDocumentKind").addEventListener("change", renderDocumentManager);
  $("#personalDocumentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isReadOnlyDemo()) return;
    const file = $("#personalDocumentFile").files[0];
    if (!file) return showToast("등록할 PDF 또는 DOCX를 선택해 주세요.", true);
    const form = new FormData();
    form.append("document", file);
    const params = new URLSearchParams({ kind: $("#personalDocumentKind").value });
    if ($("#personalDocumentReplace").value) params.set("replace", $("#personalDocumentReplace").value);
    try {
      const payload = await request(`/api/settings/documents?${params}`, { method: "POST", body: form });
      state.personalSettings ||= {};
      state.personalSettings.documents = payload.documents;
      state.data.resume = payload.resume;
      state.data.companionTasks = payload.tasks;
      $("#personalDocumentFile").value = "";
      renderResume();
      renderCompanion();
      showToast(payload.replacedDocumentId ? "문서를 교체했습니다. 새 문서를 다시 분석해 주세요." : "문서를 등록했습니다. 분석할 문서를 선택해 주세요.");
    } catch (error) { showToast(error.message, true); }
  });
  $("#reanalyzeDocuments").addEventListener("click", () => {
    const documentIds = $$('[data-analysis-document-id]:checked').map((item) => item.dataset.analysisDocumentId);
    if (!documentIds.length) return showToast("다시 분석할 활성 문서를 선택해 주세요.", true);
    createCompanionRequest("analyze_documents", { documentIds });
  });
  $("#personalSettingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isReadOnlyDemo() || !state.personalSettings) return;
    const lineValues = (selector) => $(selector).value.split("\n").map((item) => item.trim()).filter(Boolean);
    const sourceItems = structuredClone(state.personalSettings.sources.items || {});
    for (const row of $$('[data-settings-source]')) {
      const item = sourceItems[row.dataset.settingsSource];
      if (!item) continue;
      for (const input of row.querySelectorAll("[data-source-field]")) {
        item[input.dataset.sourceField] = input.type === "checkbox" ? input.checked : Number(input.value);
      }
    }
    try {
      const payload = await request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          profile: {
            displayName: $("#settingsDisplayName").value,
            timezone: $("#settingsTimezone").value,
            regions: lineValues("#settingsRegions"),
          },
          search: {
            targetRoles: lineValues("#settingsTargetRoles"),
            tracks: lineValues("#settingsTracks"),
            includeKeywords: lineValues("#settingsIncludeKeywords"),
            excludeKeywords: lineValues("#settingsExcludeKeywords"),
            desiredWork: lineValues("#settingsDesiredWork"),
            avoidedWork: lineValues("#settingsAvoidedWork"),
          },
          sources: { ...state.personalSettings.sources, items: sourceItems },
          resume: {
            quality_rules: {
              minimum_score: Number($("#settingsMinimumScore").value),
              maximum_pdf_pages: Number($("#settingsMaximumPages").value),
              criteria: collectQualityCriteria("settings"),
            },
          },
        }),
      });
      state.personalSettings = payload.settings;
      await refreshDashboardData();
      showToast(payload.supersededTaskIds?.length
        ? `개인 설정을 저장했고 이전 입력 기준 결과 ${payload.supersededTaskIds.length}건을 대체 처리했습니다.`
        : "개인 설정을 저장했습니다.");
    } catch (error) { showToast(error.message, true); }
  });
  $("#settingsQualityCriteria").addEventListener("input", () => updateQualityCriteriaTotal("settings"));
  $("#settingsQualityCriteria").addEventListener("change", () => updateQualityCriteriaTotal("settings"));
  $$('[data-add-structured]').forEach((button) => button.addEventListener("click", () => {
    if (isReadOnlyDemo()) return;
    const kind = button.dataset.addStructured;
    const item = {
      id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      kind,
      title: "",
      organization: "",
      role: "",
      location: "",
      startDate: "",
      endDate: "",
      summary: "",
      highlights: [],
      skills: [],
      sourceRefs: [],
      active: true,
    };
    state.data.resume.structuredItems = [...(state.data.resume.structuredItems || []), item];
    const container = $("#resumeStructuredItems");
    if (!container.querySelector('[data-structured-id]')) container.replaceChildren();
    const card = renderStructuredResumeItem(item);
    container.append(card);
    card.querySelector('[data-structured-field="title"]')?.focus();
  }));
  $("#resumeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isReadOnlyDemo()) return;
    const lines = (value) => value.split("\n").map((item) => item.trim()).filter(Boolean);
    try {
      const payload = await request("/api/resume", {
        method: "PUT",
        body: JSON.stringify({
          jobFamily: $("#resumeJobFamily").value,
          jobRole: $("#resumeJobRole").value,
          careerType: $("#resumeCareerType").value,
          careerStage: $("#resumeCareerStage").value,
          yearsExperience: $("#resumeYearsExperience").value,
          school: $("#resumeSchool").value,
          major: $("#resumeMajor").value,
          headline: $("#resumeHeadline").value,
          summary: $("#resumeSummary").value,
          skills: lines($("#resumeSkills").value),
          experienceHighlights: lines($("#resumeHighlights").value),
          certificates: lines($("#resumeCertificates").value),
          achievementEvidence: $("#resumeAchievementEvidence").value,
          representativeExperience: $("#resumeRepresentativeExperience").value,
          directScope: $("#resumeDirectScope").value,
          collaborationScope: $("#resumeCollaborationScope").value,
          careerDirection: $("#resumeCareerDirection").value,
          editableSections: $$('[data-editable-section]:checked').map((input) => input.dataset.editableSection),
          structuredItems: collectStructuredResumeItems(),
          customSections: (state.data.resume.customSections || []).map((section, index) => {
            const row = $$('[data-custom-section-id]').find((item) => item.dataset.customSectionId === section.id);
            const value = row?.querySelector('[data-custom-value]')?.value || "";
            return {
              ...section,
              value: section.kind === "list" ? lines(value) : value,
              displayOrder: section.displayOrder ?? index + 1,
              editable: Boolean(row?.querySelector('[data-custom-editable]')?.checked),
            };
          }),
        }),
      });
      state.data.resume = payload.resume;
      renderResume();
      try {
        await Promise.all([
          loadJobPage({ force: true }),
          loadWorkflow({ force: true }),
        ]);
      } catch (refreshError) {
        showToast(`이력서는 저장됐지만 화면 갱신에 실패했습니다: ${refreshError.message}`, true);
        return;
      }
      showToast("이력서 기준을 저장했습니다.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

async function initialize() {
  try {
    [state.uiContract, state.data] = await Promise.all([
      request("/api/ui-contract"),
      request("/api/bootstrap"),
    ]);
    let workflowPromise = null;
    if (state.data.mode !== "onboarding") {
      const initialFilter = (state.data.savedFilters || []).find((item) => item.isDefault);
      if (initialFilter) state.filters = { ...initialFilter.filters };
      await loadJobPage({ render: false });
    }
    const [hashScreen, query = ""] = window.location.hash.slice(1).split("?");
    const deepLink = new URLSearchParams(query);
    if (hashScreen === "jobs" && Number(deepLink.get("job"))) {
      state.screen = "jobs";
      state.selectedJobId = Number(deepLink.get("job"));
    }
    renderAll();
    if (state.data.mode !== "onboarding") {
      workflowPromise = loadWorkflow();
    }
    if (state.data.mode !== "onboarding" && state.selectedJobId) {
      navigateToJob(state.selectedJobId, deepLink.get("focus") || "");
    }
    if (state.data.mode === "onboarding") bindOnboardingEvents();
    else bindEvents();
    if (workflowPromise) await workflowPromise;
  } catch (error) {
    showToast(error.message, true);
  }
}

initialize();
