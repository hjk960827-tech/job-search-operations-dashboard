const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  mode: "demo",
  bootstrap: null,
  contract: null,
  jobs: [],
  facets: { tracks: [], platforms: [] },
  workflow: { counts: {}, buckets: {}, total: 0 },
  filters: {
    search: "", track: "", region: "", score: "", status: "", lifecycle: "active",
    deadline: "", platform: "", condition: "", sort: "score", favorite: false,
  },
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
  selectedJobId: null,
  selectedDetail: null,
  activeScreen: "jobs",
  activeQuick: "all",
  reviewStage: "review",
  reviewSearch: "",
  reviewTrack: "",
  workflowBucket: "",
  reviewJobId: null,
  settings: null,
  notifications: { items: [], unreadCount: 0 },
  notificationTab: "all",
  busy: new Set(),
  confirmationAction: null,
  editingPackage: null,
  outcomeJobId: null,
  correctionEventId: null,
  outcomeLedger: null,
  activeResumeEditSection: null,
};

const workflowLabels = {
  new: "신규", reviewing: "검토 중", draft: "작업본", quality: "품질 확인",
  approval: "승인 대기", approved: "승인 완료", ready: "수기 제출 준비",
  applied: "지원 완료", interview: "면접", offer: "제안", skipped: "제외", rejected: "종료",
};
const stageLabels = {
  review: "검토 필요", prepare: "제출 준비", submitted: "제출완료", results: "지원 결과", archive: "보관함",
};
const structuredLabels = {
  experience: "경력", project: "프로젝트", education: "학력", skill: "기술", certification: "자격",
  award: "수상", research: "연구", publication: "논문", training: "교육", volunteer: "봉사",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function lines(value) {
  return String(value || "").split("\n").map((item) => item.trim()).filter(Boolean);
}

function formatDate(value) {
  if (!value) return "미정";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.dataset.error = error ? "true" : "false";
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3600);
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `요청 실패 (${response.status})`);
  return payload;
}

function capability(name) {
  return state.contract?.capabilities?.[name] || { available: false, writable: false };
}

function writable(name) {
  return state.mode === "personal" && capability(name).available && capability(name).writable;
}

function protect(button, { capabilityName, action, job } = {}) {
  if (!button) return button;
  let enabled = true;
  let reason = "";
  if (capabilityName) {
    const item = capability(capabilityName);
    enabled = Boolean(item.available && item.writable && state.mode === "personal");
    if (!enabled) reason = state.mode === "demo" ? "데모에서는 변경할 수 없습니다." : "현재 실행 모드에서 지원하지 않는 기능입니다.";
  }
  if (action) {
    const actionGate = job?.allowedActions?.[action];
    enabled = enabled && Boolean(actionGate?.enabled);
    reason ||= actionGate?.reason || "서버가 이 작업을 허용하지 않았습니다.";
  }
  button.disabled = !enabled;
  button.title = enabled ? "" : reason;
  if (!enabled) button.dataset.disabledReason = reason;
  return button;
}

async function withBusy(key, callback) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  document.body.dataset.busy = "true";
  try { return await callback(); }
  catch (error) { showToast(error.message, true); }
  finally {
    state.busy.delete(key);
    if (!state.busy.size) delete document.body.dataset.busy;
  }
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.hidden = false;
  document.body.classList.add("modal-open");
  modal.querySelector("input:not([type=hidden]), textarea, select, button")?.focus();
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.hidden = true;
  if (!$$('.modal:not([hidden])').length) document.body.classList.remove("modal-open");
}

function confirmAction({ title, description, confirmLabel = "확인", requireCheck = false, checkLabel = "외부 채용 플랫폼에서 실제 작업을 완료했습니다.", checkError = "확인 항목에 동의해 주세요.", action }) {
  $("#confirmationTitle").textContent = title;
  $("#confirmationDescription").textContent = description;
  $("#confirmationConfirmButton").textContent = confirmLabel;
  $("#confirmationCheckRow").hidden = !requireCheck;
  $("#confirmationCheckLabel").textContent = checkLabel;
  $("#confirmationCheck").checked = false;
  state.confirmationAction = { action, requireCheck, checkError };
  openModal("confirmationModal");
}

function setScreen(screen) {
  state.activeScreen = screen;
  const jobs = screen === "jobs";
  $("#jobBoardScreen").hidden = !jobs;
  $("#resumeCreateScreen").hidden = screen !== "resume-create";
  $("#resumeEditScreen").hidden = screen !== "resume-edit";
  $("#resumeReviewScreen").hidden = screen !== "resume-review";
  $("#resumeSubTabs").hidden = jobs;
  $("#jobsScreenButton").classList.toggle("active", jobs);
  $("#resumeManageButton").classList.toggle("active", !jobs);
  $$('[data-screen]').forEach((button) => button.classList.toggle("active", button.dataset.screen === screen));
  $("#resumeManageMenu").hidden = true;
  $("#resumeManageButton").setAttribute("aria-expanded", "false");
  if (screen === "resume-create" || screen === "resume-edit") renderResume();
  if (screen === "resume-review") renderReview();
  location.hash = screen === "jobs" ? "jobs" : screen;
}

function applyEnvironment() {
  $("#modeBadge").textContent = state.mode === "personal" ? "개인 모드" : state.mode === "demo" ? "합성 데모" : "초기 설정";
  $("#modeBadge").dataset.mode = state.mode;
  const notice = $("#environmentNotice");
  if (state.mode === "demo") {
    notice.hidden = false;
    notice.innerHTML = "<strong>합성 데모</strong><span>화면과 흐름을 살펴볼 수 있으며 변경 작업은 저장되지 않습니다.</span>";
  } else notice.hidden = true;
  $("#updatedAt").textContent = `업데이트 ${formatDateTime(state.bootstrap?.resume?.updatedAt || new Date().toISOString())}`;
}

function queryForJobs() {
  const composite = ["applied", "skipped"].includes(state.activeQuick) || Boolean(state.workflowBucket);
  const params = new URLSearchParams({ page: composite ? "1" : String(state.page), pageSize: composite ? "100" : String(state.pageSize) });
  for (const key of ["search", "track", "region", "score", "platform", "status", "lifecycle", "deadline", "condition", "sort"]) {
    if (key === "status" && composite) continue;
    if (state.filters[key]) params.set(key, state.filters[key]);
  }
  if (state.filters.favorite) params.set("favorite", "true");
  return params;
}

async function loadJobs({ keepSelection = true } = {}) {
  const payload = await request(`/api/jobs?${queryForJobs()}`);
  let items = payload.items || [];
  if (state.activeQuick === "applied") items = items.filter((job) => ["applied", "interview", "offer"].includes(job.application?.workflowStatus));
  if (state.activeQuick === "skipped") items = items.filter((job) => ["skipped", "rejected"].includes(job.application?.workflowStatus));
  if (state.workflowBucket) {
    const ids = new Set((state.workflow.buckets?.[state.workflowBucket] || []).map((item) => Number(item.jobId)));
    items = items.filter((job) => ids.has(Number(job.id)));
  }
  state.jobs = items;
  state.facets = payload.facets || state.facets;
  const composite = ["applied", "skipped"].includes(state.activeQuick) || Boolean(state.workflowBucket);
  state.page = composite ? 1 : payload.page || 1;
  state.pageSize = composite ? state.pageSize : payload.pageSize || state.pageSize;
  state.total = composite ? items.length : payload.total || 0;
  state.totalPages = composite ? 1 : payload.totalPages || 1;
  if (!keepSelection || !state.jobs.some((job) => job.id === state.selectedJobId)) state.selectedJobId = state.jobs[0]?.id || null;
  renderJobs();
  if (state.selectedJobId) await selectJob(state.selectedJobId, { openMobile: false });
  else renderJobDetail(null);
}

async function loadWorkflow() {
  const payload = await request("/api/workflow");
  state.workflow = payload.workflow || { counts: {}, buckets: {}, total: 0 };
  renderWorkflowSummary();
}

function renderSelectOptions(select, values, current, labeler = (value) => value) {
  const first = select.options[0]?.outerHTML || '<option value="">전체</option>';
  select.innerHTML = first + values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(labeler(value))}</option>`).join("");
  select.value = current || "";
}

function trackDisplay(track, index = 0) {
  if (state.mode !== "demo") return track;
  return index === 0 ? "주 목표 직무" : index === 1 ? "보조 직무" : "탐색 직무";
}

function renderQuickTabs() {
  const counts = state.facets.counts || {};
  $("#tabCountAll").textContent = counts.total ?? state.total;
  $("#tabCountFavorite").textContent = counts.favorite ?? state.jobs.filter((job) => job.application?.favorite).length;
  $("#tabCountApplied").textContent = counts.applied ?? state.jobs.filter((job) => ["applied", "interview", "offer"].includes(job.application?.workflowStatus)).length;
  $("#tabCountSkipped").textContent = counts.skipped ?? state.jobs.filter((job) => ["skipped", "rejected"].includes(job.application?.workflowStatus)).length;
  const tracks = state.facets.tracks || [];
  $("#trackQuickTabs").innerHTML = tracks.slice(0, 2).map((track, index) => `<button class="quick-tab ${state.activeQuick === `track:${track}` ? "active" : ""}" type="button" data-quick="track:${escapeHtml(track)}"><span>${escapeHtml(trackDisplay(track, index))}</span><strong>${counts.track?.[track] ?? state.jobs.filter((job) => job.track === track).length}</strong></button>`).join("");
  $$('[data-quick]').forEach((button) => button.classList.toggle("active", button.dataset.quick === state.activeQuick));
  protect($("#requestJobCollectionButton"), { capabilityName: "jobCollectionRequest" });
}

function renderWorkflowSummary() {
  const buckets = state.workflow.buckets || {};
  const order = ["review", "quality", "approval", "submission", "complete"];
  const labels = { review: "검토할 공고", quality: "작업본·품질", approval: "승인 대기", submission: "제출 준비", complete: "지원 완료" };
  $("#stateSummary").innerHTML = order.map((key) => {
    const value = buckets[key];
    const count = Array.isArray(value) ? value.length : Number(value?.count || state.workflow.counts?.[key] || 0);
    return `<button type="button" data-workflow-bucket="${key}"><span>${labels[key]}</span><strong>${count}</strong></button>`;
  }).join("");
}

function deadlineView(job) {
  if (!job.deadline) return '<span class="muted">상시·미정</span>';
  const urgent = Number.isFinite(job.deadlineDays) && job.deadlineDays <= 7;
  const overdue = Number.isFinite(job.deadlineDays) && job.deadlineDays < 0;
  return `<span class="deadline ${urgent ? "urgent" : ""} ${overdue ? "overdue" : ""}">${escapeHtml(formatDate(job.deadline))}</span><small>${overdue ? "기한 지남" : Number.isFinite(job.deadlineDays) ? `D-${job.deadlineDays}` : ""}</small>`;
}

function scoreView(job) {
  if (job.score == null) return '<span class="score unset">—</span><small>평가 전</small>';
  const tone = job.score >= 80 ? "high" : job.score >= 70 ? "mid" : "low";
  return `<span class="score ${tone}">${Number(job.score)}</span><small>${job.scoreMode === "scalar" ? "외부 단일 점수" : "평가 점수"}</small>`;
}

function scoreBreakdownHtml(job) {
  const breakdown = job.scoreBreakdown;
  if (!breakdown) return `<p>${job.score == null ? "평가 기준 설정이 필요합니다." : "외부 단일 점수입니다. 축별 판단 이유는 아직 등록되지 않았습니다."}</p>`;
  const dimensions = Array.isArray(breakdown.dimensions)
    ? breakdown.dimensions
    : Object.entries(breakdown).map(([key, value]) => ({ label: value?.label || key, score: value?.score ?? value, reason: value?.reason || "", gaps: value?.gaps || [] }));
  return `<div class="score-breakdown">${dimensions.map((item) => `<div><span>${escapeHtml(item.label || item.key || "평가 항목")}</span><strong>${escapeHtml(item.score ?? "-")}</strong><p>${escapeHtml(item.reason || "판단 이유가 등록되지 않았습니다.")}</p>${item.evidenceIds?.length ? `<small>근거 ${item.evidenceIds.map(escapeHtml).join(" · ")}</small>` : ""}${item.gaps?.length ? `<small>확인할 점: ${item.gaps.map(escapeHtml).join(" · ")}</small>` : ""}</div>`).join("")}</div>`;
}

function cautionHtml(job) {
  const gaps = Array.isArray(job.scoreBreakdown?.dimensions) ? job.scoreBreakdown.dimensions.flatMap((item) => item.gaps || []) : [];
  const cautions = [...gaps];
  if (job.deadlineDays != null && job.deadlineDays <= 7) cautions.push(job.deadlineDays < 0 ? "공고 마감일이 지났습니다." : `마감까지 ${job.deadlineDays}일 남았습니다.`);
  if (job.score != null && job.score < Number(state.bootstrap?.scoreReviewBelow || 70)) cautions.push("사용자 재검토 기준보다 적합도 점수가 낮습니다.");
  return cautions.length ? `<ul>${cautions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p>현재 등록된 주의 항목이 없습니다.</p>";
}

function renderJobs() {
  renderQuickTabs();
  renderSelectOptions($("#trackFilter"), state.facets.tracks || [], state.filters.track, (value) => value);
  renderSelectOptions($("#platformFilter"), state.facets.platforms || [], state.filters.platform, (value) => state.bootstrap?.sources?.[value]?.label || value);
  const regions = state.facets.locations || [...new Set(state.jobs.map((job) => job.location).filter(Boolean))].sort();
  renderSelectOptions($("#regionFilter"), regions, state.filters.region);
  $("#resultTitle").textContent = `공고 목록 ${state.total}개`;
  const rows = $("#jobRows");
  if (!state.jobs.length) {
    rows.innerHTML = '<tr><td colspan="12"><div class="empty-state compact"><h3>조건에 맞는 공고가 없습니다</h3><p>필터를 초기화하거나 검색 조건을 바꿔 주세요.</p></div></td></tr>';
  } else {
    rows.innerHTML = state.jobs.map((job) => {
      const status = job.application?.workflowStatus || "new";
      const action = job.workflow?.nextAction?.label || "상세 보기";
      const risk = job.status !== "active" ? "마감 확인" : job.deadlineDays != null && job.deadlineDays <= 7 ? "마감 임박" : job.score != null && job.score < Number(state.bootstrap?.scoreReviewBelow || 70) ? "재검토" : "-";
      const priority = job.workflow?.stage === "review" ? "우선 검토" : job.workflow?.nextAction ? "다음 작업" : job.application?.favorite ? "관심" : "일반";
      const companyInitial = Array.from(String(job.companyName || "?").trim())[0] || "?";
      return `<tr data-job-id="${job.id}" class="${job.id === state.selectedJobId ? "selected" : ""}">
        <td>${scoreView(job)}</td>
        <td><div class="company-row"><button type="button" class="row-favorite ${job.application?.favorite ? "active" : ""}" data-row-favorite="${job.id}" aria-label="${job.application?.favorite ? "관심 해제" : "관심 추가"}">${job.application?.favorite ? "★" : "☆"}</button><span class="company-initial" aria-hidden="true">${escapeHtml(companyInitial)}</span><span><strong>${escapeHtml(job.companyName)}</strong>${job.discovery?.isNew ? '<span class="tiny-badge">NEW</span>' : ""}</span></div></td>
        <td><strong>${escapeHtml(job.title)}</strong><small>${escapeHtml(job.location || "조건 미정")}</small></td>
        <td><span class="tag">${escapeHtml(job.track || "미분류")}</span></td>
        <td>${escapeHtml(job.employmentType || "미정")}</td>
        <td>${deadlineView(job)}</td>
        <td>${escapeHtml(job.package?.state ? workflowLabels[job.package.state] || job.package.state : "미생성")}</td>
        <td>${escapeHtml(priority)}</td>
        <td>${risk}</td>
        <td>${escapeHtml(state.bootstrap?.sources?.[job.primarySource?.platform]?.label || job.primarySource?.platform || "-")}<small>${job.sourceCount > 1 ? `외 ${job.sourceCount - 1}` : ""}</small></td>
        <td><span class="status-pill ${escapeHtml(status)}">${escapeHtml(workflowLabels[status] || status)}</span></td>
        <td><button class="row-action" type="button" data-open-job="${job.id}" aria-label="${escapeHtml(action)}" title="${escapeHtml(action)}">›</button></td>
      </tr>`;
    }).join("");
  }
  $$('[data-row-favorite]', rows).forEach((button) => {
    const job = state.jobs.find((item) => item.id === Number(button.dataset.rowFavorite));
    protect(button, { capabilityName: "jobState", action: "updateJobState", job });
  });
  renderPagination();
}

function renderPagination() {
  $("#pagePrevButton").disabled = state.page <= 1;
  $("#pageNextButton").disabled = state.page >= state.totalPages;
  $("#pageLastButton").disabled = state.page >= state.totalPages;
  const from = Math.max(1, state.page - 2);
  const to = Math.min(state.totalPages, from + 4);
  $("#pageButtons").innerHTML = Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index).map((page) => `<button type="button" data-page="${page}" class="${page === state.page ? "active" : ""}">${page}</button>`).join("");
  $("#pageSizeSelect").value = String(state.pageSize);
}

async function selectJob(id, { openMobile = true } = {}) {
  state.selectedJobId = Number(id);
  $$('[data-job-id]').forEach((row) => row.classList.toggle("selected", Number(row.dataset.jobId) === state.selectedJobId));
  const payload = await request(`/api/jobs/${state.selectedJobId}`);
  state.selectedDetail = payload.detail;
  renderJobDetail(payload.detail);
  if (openMobile && matchMedia("(max-width: 760px)").matches) $("#jobDetail").classList.add("mobile-open");
}

function renderJobDetail(detail) {
  const scroll = $("#detailScroll");
  const footer = $("#detailFooter");
  if (!detail) {
    scroll.innerHTML = '<div class="empty-state"><span>↗</span><h2>공고를 선택해 주세요</h2><p>대표 링크, 출처와 다음 작업을 함께 확인할 수 있습니다.</p></div>';
    footer.hidden = true;
    return;
  }
  const job = detail.job || detail;
  const sources = detail.sources || job.sources || [];
  const packageValue = detail.package || job.package;
  scroll.innerHTML = `<section class="detail-hero">
    <div class="detail-title"><div><p>${escapeHtml(job.track || "미분류")}</p><h2>${escapeHtml(job.title)}</h2><strong>${escapeHtml(job.companyName)}</strong></div>${scoreView(job)}</div>
    <div class="detail-meta"><span>${escapeHtml(job.location || "지역 미정")}</span><span>${escapeHtml(job.employmentType || "고용 형태 미정")}</span><span>${job.deadline ? `마감 ${escapeHtml(formatDate(job.deadline))}` : "마감일 미정"}</span></div>
    <div class="detail-state-actions"><button type="button" data-favorite-job>${job.application?.favorite ? "★ 관심 해제" : "☆ 관심 공고"}</button><button type="button" data-applied-job>${["applied", "interview", "offer"].includes(job.application?.workflowStatus) ? "지원 완료 해제" : "지원 완료"}</button><button type="button" data-skip-job>${["skipped", "rejected"].includes(job.application?.workflowStatus) ? "제외 해제" : "제외"}</button></div>
  </section>
  <section class="detail-section"><h3>공고 요약</h3><p>${escapeHtml(job.summary || "요약 정보가 없습니다.")}</p></section>
  <section class="detail-section"><h3>출처 ${sources.length || job.sourceCount || 0}개</h3><div class="source-list">${sources.map((source) => `<a href="${escapeHtml(source.sourceUrl || source.url || "#")}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(state.bootstrap?.sources?.[source.platform]?.label || source.platform)}</strong><span>${escapeHtml(source.status || "상태 미정")} · ${escapeHtml(formatDate(source.deadline))}</span></a>`).join("") || "<p>등록된 출처가 없습니다.</p>"}</div></section>
  <section class="detail-section"><h3>핵심 적합 포인트</h3>${scoreBreakdownHtml(job)}</section>
  <section class="detail-section"><h3>주의 포인트</h3>${cautionHtml(job)}</section>
  <section class="detail-section"><h3>현재 작업</h3><div class="workflow-card"><strong>${escapeHtml(job.workflow?.label || detail.workflow?.label || "공고 검토")}</strong><p>${escapeHtml(job.workflow?.description || detail.workflow?.description || "다음 작업을 확인해 주세요.")}</p></div></section>
  <section class="detail-section"><h3>맞춤문서</h3>${packageValue ? packageSummary(packageValue) : "<p>아직 이 공고의 작업본이 없습니다.</p>"}</section>`;
  const favorite = $('[data-favorite-job]', scroll);
  const applied = $('[data-applied-job]', scroll);
  const skip = $('[data-skip-job]', scroll);
  protect(favorite, { capabilityName: "jobState", action: "updateJobState", job });
  protect(applied, { capabilityName: "jobState", action: "updateJobState", job });
  protect(skip, { capabilityName: "jobState", action: "updateJobState", job });
  footer.hidden = false;
  footer.innerHTML = detailFooterButtons(job, packageValue);
  bindDetailActions(job, packageValue);
}

function packageSummary(packageValue) {
  return `<div class="package-summary"><div><span>상태</span><strong>${escapeHtml(workflowLabels[packageValue.state] || packageValue.state || "작업 중")}</strong></div><div><span>품질</span><strong>${escapeHtml(packageValue.quality?.score ?? packageValue.qualityScore ?? "확인 전")}</strong></div><div><span>버전</span><strong>${escapeHtml(packageValue.version || packageValue.id || "-")}</strong></div></div>`;
}

function detailFooterButtons(job, packageValue) {
  const next = job.workflow?.nextAction?.type;
  const buttons = ['<button type="button" class="secondary-button" data-open-source>대표 공고 열기</button>'];
  if (next === "start_review") buttons.push('<button type="button" class="primary-button" data-start-review>공고 검토 시작</button>');
  else if (!packageValue) {
    buttons.push('<button type="button" class="primary-button" data-create-package>공고별 작업본 만들기</button>');
    buttons.push('<button type="button" data-request-package>AI 작업본 생성 요청</button>');
  }
  else buttons.push('<button type="button" class="primary-button" data-open-review>이력서 리뷰 열기</button>');
  return buttons.join("");
}

function bindDetailActions(job, packageValue) {
  const root = $("#jobDetail");
  const source = $('[data-open-source]', root);
  source?.addEventListener("click", () => {
    const sources = state.selectedDetail?.sources || [];
    const selectedSource = sources.find((item) => item.isPrimary) || sources[0];
    const url = selectedSource?.sourceUrl || selectedSource?.url;
    if (url) window.open(url, "_blank", "noopener,noreferrer"); else showToast("열 수 있는 출처 링크가 없습니다.", true);
  });
  $('[data-favorite-job]', root)?.addEventListener("click", () => updateJobState(job, { favorite: !job.application?.favorite }));
  $('[data-applied-job]', root)?.addEventListener("click", () => updateJobState(job, { workflowStatus: ["applied", "interview", "offer"].includes(job.application?.workflowStatus) ? "reviewing" : "applied" }));
  $('[data-skip-job]', root)?.addEventListener("click", () => updateJobState(job, { workflowStatus: ["skipped", "rejected"].includes(job.application?.workflowStatus) ? "new" : "skipped" }));
  const start = $('[data-start-review]', root);
  protect(start, { capabilityName: "jobState", action: "startReview", job });
  start?.addEventListener("click", () => updateJobState(job, { workflowStatus: "reviewing" }));
  const create = $('[data-create-package]', root);
  protect(create, { capabilityName: "packageWorkflow", action: "createPackage", job });
  create?.addEventListener("click", () => createPackageForJob(job));
  const packageRequest = $('[data-request-package]', root);
  protect(packageRequest, { capabilityName: "packageGenerationRequest" });
  packageRequest?.addEventListener("click", () => requestCompanion("generate_package", { jobId: job.id }));
  $('[data-open-review]', root)?.addEventListener("click", () => { state.reviewJobId = job.id; setScreen("resume-review"); });
}

async function updateJobState(job, patch) {
  if (!writable("jobState")) return showToast("데모에서는 공고 상태를 변경할 수 없습니다.", true);
  await withBusy(`job:${job.id}`, async () => {
    await request(`/api/jobs/${job.id}/state`, { method: "PATCH", body: JSON.stringify(patch) });
    await Promise.all([loadJobs(), loadWorkflow()]);
    showToast("공고 상태를 저장했습니다.");
  });
}

async function createPackageForJob(job, refreshConfirmed = false) {
  if (!writable("packageWorkflow")) return showToast("개인 모드에서 사용할 수 있습니다.", true);
  await withBusy(`package:${job.id}`, async () => {
    await request(`/api/jobs/${job.id}/package`, { method: "POST", body: JSON.stringify({ refreshConfirmed }) });
    await Promise.all([loadJobs(), loadWorkflow()]);
    state.reviewJobId = job.id;
    setScreen("resume-review");
    showToast("공고별 작업본을 만들었습니다.");
  });
}

function fillResumeForms() {
  const resume = state.bootstrap?.resume || {};
  const values = {
    resumeJobFamily: resume.jobFamily, resumeJobRole: resume.jobRole, resumeYearsExperience: resume.yearsExperience,
    resumeSchool: resume.school, resumeMajor: resume.major, resumeHeadline: resume.headline, resumeSummary: resume.summary,
    resumeSkills: (resume.skills || []).join("\n"), resumeCertificates: (resume.certificates || []).join("\n"),
    editHeadline: resume.headline, editSummary: resume.summary, editSkills: (resume.skills || []).join("\n"),
    editRepresentativeExperience: resume.representativeExperience, editAchievementEvidence: resume.achievementEvidence,
  };
  for (const [id, value] of Object.entries(values)) if (document.getElementById(id)) document.getElementById(id).value = value || "";
  $$('[data-career-type]').forEach((button) => button.classList.toggle("active", button.dataset.careerType === resume.careerType));
  renderEditableChips("skill", resume.skills || []);
  renderEditableChips("certificate", resume.certificates || []);
}

function chipElements(kind) {
  return kind === "skill"
    ? { list: $("#resumeSkillChips"), input: $("#resumeSkillInput"), storage: $("#resumeSkills") }
    : { list: $("#resumeCertificateChips"), input: $("#resumeCertificateInput"), storage: $("#resumeCertificates") };
}

function renderEditableChips(kind, values = lines(chipElements(kind).storage?.value)) {
  const elements = chipElements(kind);
  if (!elements.list || !elements.storage) return;
  const normalized = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  elements.storage.value = normalized.join("\n");
  elements.list.innerHTML = normalized.length
    ? normalized.map((item) => `<span class="resume-removable-chip">${escapeHtml(item)}<button type="button" data-remove-resume-chip="${escapeHtml(kind)}" data-value="${escapeHtml(item)}" aria-label="${escapeHtml(item)} 삭제">×</button></span>`).join("")
    : '<span class="resume-chip-empty">입력된 항목 없음</span>';
}

function addResumeChip(kind) {
  const elements = chipElements(kind);
  const value = elements.input?.value.trim();
  if (!value) return;
  renderEditableChips(kind, [...lines(elements.storage.value), value]);
  elements.input.value = "";
  elements.input.focus();
}

function structuredItemCard(item, index, values) {
  const period = item.startDate ? `${item.startDate}–${item.endDate || "현재"}` : "기간 미입력";
  const meta = [item.organization, item.role, item.engagementType, item.location, period].filter(Boolean).join(" · ");
  return `<article class="resume-experience-card" data-structured-id="${escapeHtml(item.id)}">
    <button type="button" class="resume-drag-handle" data-move-structured="${escapeHtml(item.id)}" data-direction="${index === 0 ? "down" : "up"}" aria-label="순서 이동" ${values.length < 2 ? "disabled" : ""}>⋮⋮</button>
    <div class="resume-experience-main" data-edit-structured="${escapeHtml(item.id)}"><div class="resume-experience-title"><strong>${escapeHtml(item.title || "제목 미입력")}</strong><span>${escapeHtml(structuredLabels[item.kind] || item.kind)}</span></div><small>${escapeHtml(meta)}</small><p>${escapeHtml(item.summary || item.highlights?.[0] || "담당 업무와 대표 프로젝트를 입력해 주세요.")}</p>${item.skills?.length ? `<div class="resume-experience-tools">${item.skills.slice(0, 5).map((skill) => `<span>${escapeHtml(skill)}</span>`).join("")}</div>` : ""}</div>
    <div class="resume-experience-actions"><button type="button" data-edit-structured="${escapeHtml(item.id)}">수정</button><button class="danger" type="button" data-delete-structured="${escapeHtml(item.id)}">삭제</button></div>
  </article>`;
}

function renderDocuments() {
  const resume = state.bootstrap?.resume || {};
  const storedDocuments = state.settings?.documents || resume.sourceDocuments || resume.assets || [];
  const syntheticDocuments = state.mode === "demo" && !storedDocuments.length ? [
    { id: "synthetic-resume-primary", kind: "resume", label: "합성_주기준_이력서.pdf", status: "active", active: true, synthetic: true },
    { id: "synthetic-resume-secondary", kind: "resume", label: "합성_보조기준_이력서.docx", status: "active", active: true, synthetic: true },
    { id: "synthetic-portfolio", kind: "portfolio", label: "합성_포트폴리오.pdf", status: "active", active: true, synthetic: true },
  ] : [];
  const documents = storedDocuments.length ? storedDocuments : syntheticDocuments;
  const byKind = (kind, activeOnly = false) => documents.filter((item) => item.kind === kind && (!activeOnly || item.active !== false && item.status !== "archived"));
  const labelFor = (item) => item.label || item.originalName || item.fileName || (item.kind === "portfolio" ? "포트폴리오" : "기준 이력서");
  const isActive = (item) => item.active !== false && item.status !== "archived";
  const createFileRow = (kind, item) => {
    const title = kind === "resume" ? "기준 이력서" : "포트폴리오";
    if (!item) return `<article class="resume-file-row"><span class="resume-doc-icon">${kind === "resume" ? "PDF" : "FILE"}</span><div><strong>${title}</strong><small>${kind === "resume" ? "PDF·DOCX 파일을 등록해 주세요." : "선택 사항 · 등록하지 않아도 됩니다."}</small></div><span class="resume-file-status">미등록</span><div class="resume-file-actions"><button class="resume-icon-button" type="button" data-replace-document="" data-document-kind="${kind}" title="등록">＋</button></div></article>`;
    const active = isActive(item);
    const open = item.synthetic ? '<button class="resume-icon-button" type="button" disabled title="합성 예시 파일은 열 수 없습니다.">↗</button>' : `<a class="resume-icon-button" href="/api/settings/documents/${encodeURIComponent(item.id)}/file" target="_blank" rel="noopener noreferrer" title="열기">↗</a>`;
    const remove = item.synthetic ? '<button class="resume-icon-button danger" type="button" disabled title="합성 예시는 변경할 수 없습니다.">×</button>' : `<button class="resume-icon-button danger" type="button" data-archive-document="${escapeHtml(item.id)}" title="보관">×</button>`;
    return `<article class="resume-file-row"><span class="resume-doc-icon">${String(labelFor(item)).toLowerCase().endsWith(".docx") ? "DOCX" : "PDF"}</span><div><strong>${title}</strong><small>${escapeHtml(labelFor(item))}</small></div><span class="resume-file-status ${active ? "registered" : ""}">${item.synthetic ? "합성 예시" : active ? "등록됨" : "보관됨"}</span><div class="resume-file-actions">${open}<button class="resume-icon-button" type="button" data-replace-document="${escapeHtml(item.id)}" data-document-kind="${kind}" title="등록 또는 교체">＋</button>${remove}</div></article>`;
  };
  const editFileCard = (item, index, kind) => {
    const active = isActive(item);
    const role = kind === "resume" ? (index === 0 ? "주 기준" : "보조 기준") : "선택 자료";
    const status = item.synthetic ? "합성 예시" : active ? (index === 0 ? "기본값" : "보조 기준") : "보관됨";
    const actions = item.synthetic
      ? '<div class="resume-row-actions"><button class="resume-secondary-button" type="button" disabled>파일 교체</button><button class="resume-text-button" type="button" disabled>비활성</button></div>'
      : `<div class="resume-row-actions"><button class="resume-secondary-button" type="button" data-replace-document="${escapeHtml(item.id)}" data-document-kind="${kind}">파일 교체</button>${active ? `<button class="resume-text-button" type="button" data-archive-document="${escapeHtml(item.id)}">비활성</button>` : `<button class="resume-text-button danger" type="button" data-delete-document="${escapeHtml(item.id)}">삭제</button>`}</div>`;
    return `<article class="resume-edit-file-item"><span class="resume-edit-doc-icon">${kind === "resume" ? "CV" : "PF"}</span><div class="resume-edit-file-main"><div class="resume-edit-badges"><span class="resume-edit-badge ${index === 0 ? "green" : ""}">${role}</span><span class="resume-edit-badge ${index === 0 && active ? "green" : ""}">${status}</span></div><strong>${escapeHtml(labelFor(item))}</strong><small>${active ? "맞춤문서 기준으로 사용할 수 있습니다." : "현재 기준에서 제외된 문서입니다."}</small></div>${actions}</article>`;
  };
  const activeResumes = byKind("resume", true);
  const activePortfolios = byKind("portfolio", true);
  $("#resumeDocumentList").innerHTML = createFileRow("resume", activeResumes[0]);
  $("#portfolioDocumentList").innerHTML = createFileRow("portfolio", activePortfolios[0]);
  $("#editResumeDocumentList").innerHTML = byKind("resume").length ? byKind("resume").map((item, index) => editFileCard(item, index, "resume")).join("") : '<div class="resume-empty-card"><strong>등록된 이력서가 없습니다.</strong><span>이력서 생성에서 주 기준 파일을 먼저 등록해 주세요.</span></div>';
  $("#editPortfolioDocumentList").innerHTML = byKind("portfolio").length ? byKind("portfolio").map((item, index) => editFileCard(item, index, "portfolio")).join("") : '<div class="resume-empty-card"><strong>등록된 포트폴리오가 없습니다.</strong><span>선택 자료이므로 없어도 이력서 준비를 막지 않습니다.</span></div>';
  $("#portfolioEditCount").textContent = `${byKind("portfolio", true).length}개 등록됨`;
  for (const [kind, selector, label] of [["resume", "#resumeDocumentReplace", "새 이력서로 추가"], ["portfolio", "#portfolioDocumentReplace", "새 포트폴리오로 추가"]]) {
    $(selector).innerHTML = `<option value="">${label}</option>` + byKind(kind, true).filter((item) => !item.synthetic).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(labelFor(item))} 교체</option>`).join("");
  }
  $$('[data-replace-document]').forEach((button) => button.addEventListener("click", () => {
    const resumeKind = button.dataset.documentKind === "resume";
    const select = $(resumeKind ? "#resumeDocumentReplace" : "#portfolioDocumentReplace");
    const input = $(resumeKind ? "#resumeDocumentFile" : "#portfolioDocumentFile");
    select.value = button.dataset.replaceDocument || "";
    input.click();
  }));
  $$('[data-archive-document]').forEach((button) => {
    protect(button, { capabilityName: "documents" });
    button.addEventListener("click", () => archiveDocument(button.dataset.archiveDocument));
  });
  $$('[data-delete-document]').forEach((button) => {
    protect(button, { capabilityName: "documents" });
    button.addEventListener("click", () => deleteDocument(button.dataset.deleteDocument));
  });
}

function renderReadiness() {
  const resume = state.bootstrap?.resume || {};
  const readiness = resume.readiness || { score: 0, ready: false, checks: [] };
  const documents = state.settings?.documents || resume.sourceDocuments || resume.assets || [];
  const hasActiveResumeDocument = documents.some((item) => item.kind === "resume" && item.active !== false && item.status !== "archived");
  const readinessChecks = (readiness.checks || []).map((item) => item.key === "resume_asset" && item.ready && !hasActiveResumeDocument
    ? { ...item, label: "사이트 작성 이력서 기준" }
    : item);
  const score = Math.max(0, Math.min(100, Math.round(Number(readiness.score || 0))));
  $("#resumeReadiness").innerHTML = `<div class="resume-readiness-head"><div><h2>맞춤이력서 준비도</h2><strong>${score} / 100</strong></div><span class="${readiness.ready ? "ready" : ""}">${readiness.ready ? "준비됨" : "보강 필요"}</span></div><div class="resume-readiness-bars">${readinessChecks.map((item) => `<div><span>${escapeHtml(item.label)}</span><b><i class="${item.ready ? "complete" : ""}"></i></b><em>${item.ready ? 100 : 0}</em></div>`).join("")}</div>`;
}

function renderCustomSections() {
  const custom = state.bootstrap?.resume?.customSections || [];
  $("#customSectionList").hidden = !custom.length;
  $("#customSectionList").innerHTML = custom.length ? custom.map((section) => `<article class="custom-section-card"><div><strong>${escapeHtml(section.label || section.title || "커스텀 섹션")}</strong><p>${escapeHtml(Array.isArray(section.value) ? section.value.join(" · ") : section.value || "")}</p><span>${section.editable ? "공고별 수정 허용" : "고정"}</span></div><div><button type="button" data-edit-custom="${escapeHtml(section.id)}">수정</button><button type="button" data-delete-custom="${escapeHtml(section.id)}">삭제</button></div></article>`).join("") : '<p class="subtle">추가된 커스텀 섹션이 없습니다.</p>';
}

function openCustomSection(section = {}) {
  $("#customSectionId").value = section.id || "";
  $("#customSectionLabel").value = section.label || "";
  $("#customSectionKind").value = section.kind || "text";
  $("#customSectionValue").value = Array.isArray(section.value) ? section.value.join("\n") : section.value || "";
  $("#customSectionEditable").checked = section.editable !== false;
  openModal("customSectionModal");
}

async function saveCustomSections(sections, success = "커스텀 섹션을 저장했습니다.") {
  await withBusy("custom-sections", async () => {
    const payload = await request("/api/resume", { method: "PUT", body: JSON.stringify({ ...state.bootstrap.resume, customSections: sections }) });
    state.bootstrap.resume = payload.resume;
    closeModal("customSectionModal");
    renderResume();
    showToast(success);
  });
}

function renderCriteria() {
  const search = state.settings?.search || {};
  const profile = state.settings?.profile || {};
  const sourceItems = state.settings?.sources?.items || state.bootstrap?.sources || {};
  const rows = [
    ["목표 직무", (search.targetRoles || [state.bootstrap?.resume?.jobRole]).filter(Boolean).join(" · ") || "설정 필요"],
    ["직무 트랙", (search.tracks || []).join(" · ") || "설정 필요"],
    ["희망 지역", (profile.regions || []).join(" · ") || "제한 없음"],
    ["표시 플랫폼", Object.values(sourceItems).filter((item) => item.display).sort((a, b) => a.priority - b.priority).map((item) => item.label).join(" · ") || "설정 필요"],
    ["평가 기준", state.bootstrap?.scoringProfile?.configured ? `${state.bootstrap.scoringProfile.dimensions.length}개 축` : "평가 기준 설정 필요"],
  ];
  $("#appliedCriteria").innerHTML = rows.map(([label, value], index) => `<div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span><b>${index === 0 ? "주 기준" : index === 1 ? "사용자 설정" : "적용 중"}</b></div>`).join("");
}

function openResumeEditSection(section = "profile") {
  const labels = {
    profile: ["기본 프로필", "기본 프로필 수정"],
    career: ["경력 요약", "경력 요약 수정"],
    strengths: ["핵심역량", "핵심역량 수정"],
    evidence: ["대표 경험과 근거", "대표 경험과 근거 수정"],
  };
  state.activeResumeEditSection = labels[section] ? section : "profile";
  $("#resumeEditTextPanel").hidden = false;
  $("#resumeEditTextBadge").textContent = labels[state.activeResumeEditSection][0];
  $("#resumeEditTextTitle").textContent = labels[state.activeResumeEditSection][1];
  $$('[data-resume-edit-panel]').forEach((panel) => { panel.hidden = panel.dataset.resumeEditPanel !== state.activeResumeEditSection; });
  $$('[data-resume-edit-section]').forEach((button) => button.classList.toggle("active", button.dataset.resumeEditSection === state.activeResumeEditSection));
  $("#resumeEditStartButton").hidden = true;
}

function closeResumeEditSection() {
  state.activeResumeEditSection = null;
  $("#resumeEditTextPanel").hidden = true;
  $("#resumeEditStartButton").hidden = false;
  $$('[data-resume-edit-section]').forEach((button) => button.classList.remove("active"));
}

function renderResume() {
  if (!state.bootstrap) return;
  fillResumeForms();
  $("#structuredItemList").innerHTML = (state.bootstrap.resume.structuredItems || []).map(structuredItemCard).join("") || '<div class="resume-empty-card"><strong>등록된 경력이 없습니다.</strong><span>경력 추가 버튼으로 회사, 역할, 업무와 대표 프로젝트를 등록해 주세요.</span></div>';
  renderDocuments();
  renderReadiness();
  renderCustomSections();
  renderCriteria();
  const editItems = state.bootstrap.resume.structuredItems || [];
  $("#editStructuredSummary").innerHTML = editItems.length ? editItems.map((item) => `<button type="button" data-edit-structured="${escapeHtml(item.id)}"><span>${escapeHtml(structuredLabels[item.kind] || item.kind)}</span><strong>${escapeHtml(item.title)}</strong></button>`).join("") : '<p class="subtle">구조화된 항목이 없습니다.</p>';
  const disabled = state.mode !== "personal";
  $$(`#resumeCreateScreen input, #resumeCreateScreen textarea, #resumeCreateScreen select, #resumeCreateScreen button,
      #resumeEditScreen input, #resumeEditScreen textarea, #resumeEditScreen select, #resumeEditScreen button`).forEach((control) => {
    const inspectOnly = control.matches("#resumeEditRefreshButton, #resumeEditGuideButton, #resumeImportCurrentButton, #resumeImportEditButton, #resumeEditStartButton, #resumeEditCancelButton, #openSettingsFromResume, [data-resume-edit-section]");
    if (inspectOnly) return;
    control.disabled = disabled;
    if (disabled) control.title = "데모에서는 변경 내용을 저장할 수 없습니다.";
  });
}

function openStructuredModal(item = {}) {
  $("#structuredItemId").value = item.id || "";
  $("#structuredItemKind").value = item.kind || "experience";
  $("#structuredItemLabel").value = item.title || "";
  $("#structuredItemOrganization").value = item.organization || "";
  $("#structuredItemRole").value = item.role || "";
  $("#structuredItemStartDate").value = item.startDate || "";
  $("#structuredItemEndDate").value = item.endDate || "";
  $("#structuredItemEngagement").value = item.engagementType || "";
  $("#structuredItemLocation").value = item.location || "";
  $("#structuredItemSummary").value = item.summary || "";
  $("#structuredItemHighlights").value = (item.highlights || []).join("\n");
  $("#structuredItemSkills").value = (item.skills || []).join("\n");
  $("#structuredItemLinks").value = (item.portfolioLinks || []).join("\n");
  $("#structuredItemTitle").textContent = `${structuredLabels[item.kind] || structuredLabels.experience} ${item.id ? "수정" : "추가"}`;
  openModal("structuredItemModal");
}

function structuredFromModal() {
  const current = (state.bootstrap.resume.structuredItems || []).find((item) => item.id === $("#structuredItemId").value) || {};
  return {
    ...current,
    id: current.id || `local-${crypto.randomUUID()}`,
    kind: $("#structuredItemKind").value,
    title: $("#structuredItemLabel").value.trim(),
    organization: $("#structuredItemOrganization").value,
    role: $("#structuredItemRole").value,
    engagementType: $("#structuredItemEngagement").value,
    location: $("#structuredItemLocation").value,
    startDate: $("#structuredItemStartDate").value,
    endDate: $("#structuredItemEndDate").value,
    summary: $("#structuredItemSummary").value,
    highlights: lines($("#structuredItemHighlights").value),
    skills: lines($("#structuredItemSkills").value),
    portfolioLinks: lines($("#structuredItemLinks").value),
    sourceRefs: current.sourceRefs || [],
    active: current.active !== false,
  };
}

async function saveStructuredItems(items, success = "구조화 항목을 저장했습니다.") {
  await withBusy("resume-structured", async () => {
    const payload = await request("/api/resume/structured", { method: "PUT", body: JSON.stringify({ structuredItems: items }) });
    state.bootstrap.resume = payload.resume;
    renderResume();
    closeModal("structuredItemModal");
    showToast(success);
  });
}

async function saveResumeBasics({ editOnly = false } = {}) {
  const resume = state.bootstrap.resume;
  const body = editOnly ? {
    ...resume,
    headline: $("#editHeadline").value,
    summary: $("#editSummary").value,
    skills: lines($("#editSkills").value),
    representativeExperience: $("#editRepresentativeExperience").value,
    achievementEvidence: $("#editAchievementEvidence").value,
  } : {
    ...resume,
    jobFamily: $("#resumeJobFamily").value,
    jobRole: $("#resumeJobRole").value,
    careerType: $('[data-career-type].active')?.dataset.careerType || resume.careerType,
    yearsExperience: $("#resumeYearsExperience").value,
    school: $("#resumeSchool").value,
    major: $("#resumeMajor").value,
    headline: $("#resumeHeadline").value,
    summary: $("#resumeSummary").value,
    skills: lines($("#resumeSkills").value),
    certificates: lines($("#resumeCertificates").value),
  };
  await withBusy("resume", async () => {
    const payload = await request("/api/resume", { method: "PUT", body: JSON.stringify(body) });
    state.bootstrap.resume = payload.resume;
    renderResume();
    showToast("이력서 기준을 저장했습니다.");
  });
}

async function uploadDocument(kind, fileSelector, replaceSelector) {
  const file = $(fileSelector).files[0];
  if (!file) return showToast("등록할 PDF 또는 DOCX를 선택해 주세요.", true);
  const form = new FormData();
  form.append("document", file);
  const params = new URLSearchParams({ kind });
  if ($(replaceSelector).value) params.set("replace", $(replaceSelector).value);
  await withBusy("document-upload", async () => {
    const payload = await request(`/api/settings/documents?${params}`, { method: "POST", body: form });
    state.bootstrap.resume = payload.resume;
    state.bootstrap.companionTasks = payload.tasks || state.bootstrap.companionTasks;
    if (state.settings) state.settings.documents = payload.documents;
    $(fileSelector).value = "";
    renderResume();
    showToast(payload.replacedDocumentId ? "문서를 교체했습니다." : "문서를 등록했습니다.");
  });
}

async function deleteDocument(id) {
  confirmAction({
    title: "개인 문서를 완전히 삭제할까요?",
    description: "등록 파일과 연결 정보가 로컬 개인 영역에서 영구 삭제됩니다. 되돌릴 수 없습니다.",
    confirmLabel: "완전히 삭제",
    requireCheck: true,
    checkLabel: "이 문서는 복구할 수 없으며 영구 삭제에 동의합니다.",
    checkError: "영구 삭제 동의 항목을 확인해 주세요.",
    action: async () => {
      const payload = await request(`/api/settings/documents/${encodeURIComponent(id)}/purge`, { method: "DELETE", body: "{}" });
      state.bootstrap.resume = payload.resume;
      if (state.settings) state.settings.documents = payload.documents;
      renderResume();
      showToast("개인 문서를 완전히 삭제했습니다.");
    },
  });
}

async function archiveDocument(id) {
  confirmAction({
    title: "문서를 보관할까요?",
    description: "원문은 개인 영역에서 보관 상태가 되며 활성 분석 대상에서 제외됩니다.",
    confirmLabel: "보관",
    action: async () => {
      const payload = await request(`/api/settings/documents/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
      state.bootstrap.resume = payload.resume;
      if (state.settings) state.settings.documents = payload.documents;
      renderResume();
      showToast("문서를 보관했습니다.");
    },
  });
}

async function requestCompanion(kind, extra = {}) {
  if (!writable("companionQueue")) return showToast("개인 모드의 로컬 에이전트 작업에서 사용할 수 있습니다.", true);
  await withBusy(`companion:${kind}`, async () => {
    const payload = await request("/api/companion/tasks", { method: "POST", body: JSON.stringify({ kind, ...extra }) });
    state.bootstrap.companionTasks = payload.tasks;
    showToast(payload.deduplicated ? "같은 요청이 있어 기존 작업을 유지했습니다." : "로컬 에이전트 요청을 만들었습니다.");
  });
}

async function loadSettings() {
  if (state.mode !== "personal") {
    state.settings = {
      profile: { displayName: state.bootstrap.profile?.displayName || "", regions: [] },
      search: { targetRoles: [state.bootstrap.resume?.jobRole].filter(Boolean), tracks: state.facets.tracks || [], includeKeywords: [], excludeKeywords: [] },
      sources: { items: state.bootstrap.sources || {} },
      documents: state.bootstrap.resume?.sourceDocuments || [],
    };
    return;
  }
  const payload = await request("/api/settings");
  state.settings = payload.settings;
}

function renderSettings() {
  const settings = state.settings || {};
  $("#settingsDisplayName").value = settings.profile?.displayName || "";
  $("#settingsTargetRoles").value = (settings.search?.targetRoles || []).join("\n");
  $("#settingsTracks").value = (settings.search?.tracks || []).join("\n");
  $("#settingsRegions").value = (settings.profile?.regions || []).join("\n");
  $("#settingsIncludeKeywords").value = (settings.search?.includeKeywords || []).join("\n");
  $("#settingsExcludeKeywords").value = (settings.search?.excludeKeywords || []).join("\n");
  $("#settingsMinimumScore").value = settings.resume?.quality_rules?.minimum_score ?? 80;
  $("#settingsMaximumPages").value = settings.resume?.quality_rules?.maximum_pdf_pages ?? 3;
  const dimensions = settings.search?.scoring?.dimensions || state.bootstrap.scoringProfile?.dimensions || [];
  $("#scoringProfileSummary").innerHTML = `<h3>공고 평가 기준</h3>${dimensions.length ? `<div class="criteria-list">${dimensions.map((item) => `<div><span>${escapeHtml(item.label || item.key)}</span><strong>${escapeHtml(item.enabled === false ? "사용 안 함" : `가중치 ${item.weight ?? 0}`)}</strong></div>`).join("")}</div>` : '<p class="subtle">평가축을 설정하지 않으면 공고 점수를 자동 계산하지 않습니다.</p>'}`;
  const items = settings.sources?.items || {};
  $("#sourceSettings").innerHTML = `<h3>플랫폼 설정</h3><div class="source-settings-head"><span>플랫폼</span><span>수집</span><span>표시</span><span>마감 확인</span><span>우선순위</span></div>${Object.entries(items).map(([key, item]) => `<div class="source-settings-row" data-source-key="${escapeHtml(key)}"><strong>${escapeHtml(item.label || key)}</strong><input data-source-field="collect" type="checkbox" ${item.collect ? "checked" : ""}><input data-source-field="display" type="checkbox" ${item.display ? "checked" : ""}><input data-source-field="lifecycle_check" type="checkbox" ${item.lifecycle_check ? "checked" : ""}><input data-source-field="priority" type="number" min="0" max="999" value="${Number(item.priority || 0)}"></div>`).join("")}`;
  const disabled = state.mode !== "personal";
  $$('input, textarea, select, button', $("#settingsForm")).forEach((control) => { control.disabled = disabled; });
}

async function saveSettings() {
  const sourceItems = structuredClone(state.settings.sources?.items || {});
  $$('[data-source-key]').forEach((row) => {
    const item = sourceItems[row.dataset.sourceKey];
    if (!item) return;
    $$('[data-source-field]', row).forEach((input) => { item[input.dataset.sourceField] = input.type === "checkbox" ? input.checked : Number(input.value); });
  });
  const payload = await request("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      profile: { displayName: $("#settingsDisplayName").value.trim(), regions: lines($("#settingsRegions").value) },
      search: {
        targetRoles: lines($("#settingsTargetRoles").value), tracks: lines($("#settingsTracks").value),
        includeKeywords: lines($("#settingsIncludeKeywords").value), excludeKeywords: lines($("#settingsExcludeKeywords").value),
      },
      sources: { ...state.settings.sources, items: sourceItems },
      resume: { quality_rules: { ...state.settings.resume?.quality_rules, minimum_score: Number($("#settingsMinimumScore").value), maximum_pdf_pages: Number($("#settingsMaximumPages").value) } },
    }),
  });
  state.settings = payload.settings;
  if (payload.dashboard) state.bootstrap = payload.dashboard;
  closeModal("settingsModal");
  await Promise.all([loadJobs({ keepSelection: false }), loadWorkflow()]);
  showToast("개인 설정을 저장했습니다.");
}

async function loadNotifications() {
  if (state.mode !== "personal" || !capability("localNotifications").available) {
    state.notifications = state.bootstrap?.inbox || { items: [], unreadCount: 0 };
    renderNotifications();
    return;
  }
  const payload = await request("/api/inbox?limit=100");
  state.notifications = payload.inbox;
  renderNotifications();
}

function notificationCategory(item) {
  const type = String(item.type || item.kind || "");
  if (/package|resume|document|approval|quality/.test(type)) return "document";
  if (/follow|deadline/.test(type)) return "deadline";
  if (/outcome|interview|offer|reject/.test(type)) return "result";
  return "job";
}

function notificationItem(item) {
  return `<button type="button" class="notification-item ${item.readAt ? "read" : "unread"}" data-notification-id="${item.id}" data-notification-job="${item.jobId || ""}"><span class="notification-dot"></span><span><strong>${escapeHtml(item.title || item.label || "알림")}</strong><p>${escapeHtml(item.message || item.body || "")}</p><small>${escapeHtml(formatDateTime(item.createdAt || item.dueAt))}</small></span></button>`;
}

function renderNotifications() {
  const inbox = state.notifications || { items: [], unreadCount: 0 };
  $("#notificationBadge").hidden = !inbox.unreadCount;
  $("#notificationBadge").textContent = Math.min(99, inbox.unreadCount || 0);
  $("#notificationUnreadPill").textContent = `읽지 않음 ${inbox.unreadCount || 0}`;
  const tabs = [["all", "전체"], ["job", "공고"], ["document", "문서"], ["deadline", "일정"], ["result", "결과"]];
  $("#notificationDrawerTabs").innerHTML = tabs.map(([key, label]) => `<button type="button" data-notification-tab="${key}" class="${state.notificationTab === key ? "active" : ""}">${label}</button>`).join("");
  const filtered = (inbox.items || []).filter((item) => state.notificationTab === "all" || notificationCategory(item) === state.notificationTab);
  const html = filtered.length ? filtered.map(notificationItem).join("") : '<div class="empty-state compact"><p>표시할 알림이 없습니다.</p></div>';
  $("#notificationDrawerList").innerHTML = html;
  const search = $("#notificationSearchInput")?.value.trim().toLowerCase() || "";
  const full = (inbox.items || []).filter((item) => !search || `${item.title} ${item.message}`.toLowerCase().includes(search));
  $("#notificationFullList").innerHTML = full.length ? full.map(notificationItem).join("") : '<div class="empty-state compact"><p>표시할 알림이 없습니다.</p></div>';
  protect($("#notificationMarkAllButton"), { capabilityName: "markAllNotificationsRead" });
  protect($("#notificationModalMarkAllButton"), { capabilityName: "markAllNotificationsRead" });
}

async function markNotification(id, jobId) {
  if (state.mode === "personal" && capability("localNotifications").writable) {
    await request(`/api/inbox/${id}/read`, { method: "POST", body: "{}" });
    await loadNotifications();
  }
  if (jobId) {
    setScreen("jobs");
    await selectJob(Number(jobId));
  }
}

async function markAllNotifications() {
  if (!writable("markAllNotificationsRead")) return showToast("이 버전에서는 모두 읽음 처리가 아직 연결되지 않았습니다.", true);
  await withBusy("notifications-all", async () => {
    const payload = await request("/api/inbox/read-all", { method: "POST", body: "{}" });
    state.notifications = payload.inbox;
    renderNotifications();
    showToast("모든 알림을 읽음 처리했습니다.");
  });
}

function isArchivedReviewJob(job) {
  return job.lifecycleStatus && job.lifecycleStatus !== "active"
    || new Set(["skipped", "rejected"]).has(job.application?.status)
    || new Set(["skipped", "rejected"]).has(job.workflow?.stage);
}

function matchesReviewStage(job, stage) {
  const archived = isArchivedReviewJob(job);
  const submitted = job.package?.state === "submitted";
  if (stage === "archive") return archived;
  if (archived) return false;
  if (stage === "submitted" || stage === "results") return submitted;
  if (stage === "prepare") return !submitted && new Set(["approved", "submit_ready"]).has(job.package?.state);
  return !submitted && !new Set(["approved", "submit_ready"]).has(job.package?.state);
}

function reviewStage(job) {
  if (isArchivedReviewJob(job)) return "archive";
  if (job.package?.state === "submitted") return "submitted";
  if (new Set(["approved", "submit_ready"]).has(job.package?.state)) return "prepare";
  return "review";
}

function reviewJobs() {
  return state.reviewJobs || state.jobs;
}

async function loadReviewJobs() {
  const params = new URLSearchParams({ page: "1", pageSize: "100", lifecycle: "all", sort: "recent" });
  const payload = await request(`/api/jobs?${params}`);
  state.reviewJobs = payload.items || [];
  if (!state.reviewJobId || !state.reviewJobs.some((job) => job.id === state.reviewJobId)) {
    state.reviewJobId = state.reviewJobs.find((job) => job.package)?.id || state.reviewJobs[0]?.id || null;
  }
}

async function renderReview() {
  if (!state.reviewJobs) await loadReviewJobs();
  const all = reviewJobs();
  const stages = ["review", "prepare", "submitted", "results", "archive"];
  if (!stages.includes(state.reviewStage)) state.reviewStage = "review";
  $("#reviewStageTabs").innerHTML = stages.map((stage) => `<button type="button" data-review-stage="${stage}" class="${state.reviewStage === stage ? "active" : ""}"><span>${stageLabels[stage]}</span><strong>${all.filter((job) => matchesReviewStage(job, stage)).length}</strong></button>`).join("");
  $("#reviewFilters").innerHTML = '<input id="reviewSearchInput" type="search" placeholder="회사·포지션 검색"><select id="reviewTrackFilter"><option value="">전체 직무 트랙</option></select>';
  const filtered = all.filter((job) => matchesReviewStage(job, state.reviewStage)
    && (!state.reviewTrack || job.track === state.reviewTrack)
    && (!state.reviewSearch || `${job.companyName} ${job.title}`.toLowerCase().includes(state.reviewSearch.toLowerCase())));
  $("#reviewCount").textContent = `${filtered.length}건`;
  if (!filtered.some((job) => job.id === state.reviewJobId)) state.reviewJobId = filtered[0]?.id || null;
  $("#reviewJobList").innerHTML = filtered.length ? filtered.map((job) => `<button type="button" class="review-job-card ${job.id === state.reviewJobId ? "active" : ""}" data-review-job="${job.id}"><span class="review-stage-dot ${state.reviewStage}"></span><span><strong>${escapeHtml(job.companyName)}</strong><b>${escapeHtml(job.title)}</b><small>${escapeHtml(stageLabels[state.reviewStage])} · ${escapeHtml(job.track || "미분류")}</small></span>${job.package?.quality ? `<em>${Math.round(Number(job.package.quality.score || 0))}</em>` : ""}</button>`).join("") : '<div class="empty-state compact"><p>이 단계의 작업이 없습니다.</p></div>';
  renderSelectOptions($("#reviewTrackFilter"), [...new Set(all.map((job) => job.track).filter(Boolean))], state.reviewTrack);
  $("#reviewSearchInput").value = state.reviewSearch;
  $("#reviewSearchInput").addEventListener("input", (event) => {
    state.reviewSearch = event.target.value.trim();
    clearTimeout(renderReview.searchTimer);
    renderReview.searchTimer = setTimeout(async () => { await renderReview(); $("#reviewSearchInput")?.focus(); }, 180);
  });
  $("#reviewTrackFilter").addEventListener("change", (event) => { state.reviewTrack = event.target.value; renderReview(); });
  if (state.reviewJobId) await renderReviewDetail(state.reviewJobId);
  else $("#reviewDetail").innerHTML = '<div class="empty-state"><h2>이 단계의 작업이 없습니다</h2><p>다른 탭을 선택하거나 공고 상태를 변경해 주세요.</p></div>';
}

function packageSections(packageValue) {
  return packageValue?.content?.sections || [];
}

async function renderReviewDetail(jobId) {
  const payload = await request(`/api/jobs/${jobId}`);
  const job = payload.detail;
  state.reviewJobId = Number(jobId);
  state.reviewDetail = job;
  const packageValue = job.package;
  $$('[data-review-job]').forEach((button) => button.classList.toggle("active", Number(button.dataset.reviewJob) === state.reviewJobId));
  if (!packageValue) {
    $("#reviewDetail").innerHTML = `<div class="review-detail-head"><div><p>${escapeHtml(job.companyName)}</p><h2>${escapeHtml(job.title)}</h2></div><span class="status-pill">${escapeHtml(stageLabels[state.reviewStage] || stageLabels[reviewStage(job)])}</span></div><div class="empty-state"><h3>아직 공고별 작업본이 없습니다</h3><p>공고 검토를 시작한 뒤 기준 이력서에서 작업본을 만듭니다.</p><div class="empty-state-actions"><button id="reviewCreatePackageButton" class="primary-button" type="button">공고별 작업본 만들기</button><button id="reviewRequestPackageButton" type="button">AI 작업본 생성 요청</button></div></div><section id="outcomeLedgerArea" class="outcome-ledger" aria-label="지원 결과와 후속조치"></section>`;
    const button = $("#reviewCreatePackageButton");
    protect(button, { capabilityName: "packageWorkflow", action: "createPackage", job });
    button?.addEventListener("click", () => createPackageForJob(job));
    const requestButton = $("#reviewRequestPackageButton");
    protect(requestButton, { capabilityName: "packageGenerationRequest" });
    requestButton?.addEventListener("click", () => requestCompanion("generate_package", { jobId: job.id }));
    await renderOutcomeLedger(job);
    return;
  }
  const sections = packageSections(packageValue);
  const findings = packageValue.quality?.findings || [];
  $("#reviewDetail").innerHTML = `<div class="review-detail-head"><div><p>${escapeHtml(job.companyName)}</p><h2>${escapeHtml(job.title)}</h2><span>${escapeHtml(job.track || "미분류")} · v${escapeHtml(packageValue.version)}</span></div><div><span class="quality-score">${Math.round(Number(packageValue.quality?.score || 0))}</span><small>${escapeHtml(workflowLabels[packageValue.state] || packageValue.state)}</small></div></div>
    ${packageValue.refreshRequired ? `<div class="review-warning"><strong>기준 정보가 변경되었습니다.</strong><p>${escapeHtml((packageValue.refreshReasons || []).map((item) => item.message || item.key || item).join(" · "))}</p></div>` : ""}
    <div class="review-document">${sections.map((section) => `<section><header><h3>${escapeHtml(section.label)}</h3>${section.changed ? '<span>수정됨</span>' : ""}</header>${Array.isArray(section.value) ? `<ul>${section.value.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p>${escapeHtml(section.value || "내용 없음")}</p>`}</section>`).join("") || "<p>표시할 작성 항목이 없습니다.</p>"}</div>
    <section class="review-findings"><h3>품질 확인</h3>${findings.length ? `<ul>${findings.map((item) => `<li>${escapeHtml(item.message || item)}</li>`).join("")}</ul>` : "<p>현재 발견된 필수 보완 항목이 없습니다.</p>"}</section>
    <div class="review-actions">
      <button type="button" data-review-compare>수정 전/후 비교</button>
      <button type="button" data-review-edit>직접 수정</button>
      <button type="button" data-review-revise>보완 요청</button>
      <button type="button" data-review-hold>${packageValue.reviewStatus === "on_hold" ? "보류 해제" : "보류"}</button>
      ${packageValue.state === "approved" ? '<button type="button" data-review-cancel-approval>승인 취소</button>' : ""}
      ${packageValue.state === "submit_ready" ? '<button type="button" data-review-cancel-prepare>제출 준비 취소</button>' : ""}
      <button type="button" class="primary-button" data-review-primary>${packageValue.state === "approval_pending" ? "문안 승인·PDF 생성" : packageValue.state === "approved" ? "수기 제출 준비" : packageValue.state === "submit_ready" ? "제출 완료 기록" : packageValue.state === "submitted" ? "지원 결과 기록" : "수정 내용 저장"}</button>
    </div>
    <section id="outcomeLedgerArea" class="outcome-ledger" aria-label="지원 결과와 후속조치"></section>`;
  bindReviewActions(job, packageValue);
  await renderOutcomeLedger(job);
}

async function renderOutcomeLedger(job) {
  const root = $("#outcomeLedgerArea");
  if (!root) return;
  if (state.mode !== "personal" || !capability("applicationResults").available) {
    root.innerHTML = '<header><h3>지원 결과와 후속조치</h3></header><p class="subtle">개인 모드에서 제출을 기록한 뒤 결과와 일정을 관리할 수 있습니다.</p>';
    return;
  }
  let outcomes;
  try {
    outcomes = (await request(`/api/jobs/${job.id}/outcomes`)).outcomes;
  } catch (error) {
    root.innerHTML = `<header><h3>지원 결과와 후속조치</h3></header><p class="subtle">${escapeHtml(error.message)}</p>`;
    return;
  }
  state.outcomeLedger = outcomes;
  state.outcomeJobId = Number(job.id);
  const events = outcomes.events || [];
  const followUps = outcomes.followUps || [];
  root.innerHTML = `<header><div><h3>지원 결과와 후속조치</h3><p>기존 기록은 삭제하지 않고 새 결과·교정·일정을 이어서 남깁니다.</p></div><div><button type="button" data-add-outcome>결과 추가</button><button type="button" data-add-follow-up>후속조치 추가</button></div></header>
    <div class="outcome-ledger-grid">
      <section><h4>결과 기록</h4>${events.length ? events.map((event) => `<article class="ledger-card ${event.corrected ? "corrected" : ""}"><div><strong>${escapeHtml(event.label || event.type)}</strong><span>${escapeHtml(formatDateTime(event.occurredAt))}${event.correctionOfEventId ? ` · #${event.correctionOfEventId} 교정` : ""}</span></div><p>${escapeHtml(event.summary || "메모 없음")}</p>${event.correctionReason ? `<small>교정 이유: ${escapeHtml(event.correctionReason)}</small>` : ""}<footer>${event.evidence?.available ? `<a href="${escapeHtml(event.evidence.url)}" target="_blank" rel="noopener noreferrer">증빙 보기</a>` : `<span>${escapeHtml(event.evidence?.label || "증빙 없음")}</span>`}<button type="button" data-correct-outcome="${event.id}">바로잡기</button></footer></article>`).join("") : '<p class="subtle">기록된 지원 결과가 없습니다.</p>'}</section>
      <section><h4>후속조치</h4>${followUps.length ? followUps.map((item) => `<article class="ledger-card"><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(formatDate(item.dueAt))} · ${item.status === "pending" ? "예정" : item.status === "completed" ? "완료" : "취소"}</span></div>${item.status === "pending" ? `<footer><button type="button" data-follow-up-action="complete" data-follow-up-id="${escapeHtml(item.id)}">완료</button><button type="button" data-follow-up-action="cancel" data-follow-up-id="${escapeHtml(item.id)}">취소</button></footer>` : ""}</article>`).join("") : '<p class="subtle">등록된 후속조치가 없습니다.</p>'}</section>
    </div>`;
  const addOutcome = $('[data-add-outcome]', root);
  const addFollowUp = $('[data-add-follow-up]', root);
  protect(addOutcome, { capabilityName: "applicationResults" });
  protect(addFollowUp, { capabilityName: "applicationResults" });
  addOutcome?.addEventListener("click", () => openOutcome(job.id));
  addFollowUp?.addEventListener("click", () => openFollowUp(job.id));
  $$('[data-correct-outcome]', root).forEach((button) => {
    protect(button, { capabilityName: "applicationResults" });
    button.addEventListener("click", () => openOutcomeCorrection(job.id, Number(button.dataset.correctOutcome)));
  });
  $$('[data-follow-up-action]', root).forEach((button) => {
    protect(button, { capabilityName: "applicationResults" });
    button.addEventListener("click", () => transitionFollowUpAction(button.dataset.followUpId, button.dataset.followUpAction));
  });
}

function bindReviewActions(job, packageValue) {
  $('[data-review-compare]')?.addEventListener("click", () => openComparison(packageValue));
  const edit = $('[data-review-edit]');
  protect(edit, { capabilityName: "packageWorkflow", action: "editPackage", job });
  edit?.addEventListener("click", () => openPackageEditor(packageValue));
  const revise = $('[data-review-revise]');
  protect(revise, { capabilityName: "packageReviewTransitions" });
  revise?.addEventListener("click", () => transitionPackageReview(packageValue, "revision_requested"));
  const hold = $('[data-review-hold]');
  protect(hold, { capabilityName: "packageReviewTransitions" });
  hold?.addEventListener("click", () => transitionPackageReview(packageValue, packageValue.reviewStatus === "on_hold" ? "active" : "on_hold"));
  const cancelApproval = $('[data-review-cancel-approval]');
  protect(cancelApproval, { capabilityName: "packageReviewTransitions" });
  cancelApproval?.addEventListener("click", () => transitionPackageReview(packageValue, "cancel_approval"));
  const cancelPrepare = $('[data-review-cancel-prepare]');
  protect(cancelPrepare, { capabilityName: "cancelSubmissionPreparation" });
  cancelPrepare?.addEventListener("click", () => cancelPreparation(packageValue));
  const primary = $('[data-review-primary]');
  if (packageValue.state === "approval_pending") {
    protect(primary, { capabilityName: "packageWorkflow", action: "approvePackage", job });
    primary.addEventListener("click", () => approvePackageAction(job, packageValue));
  } else if (packageValue.state === "approved") {
    protect(primary, { capabilityName: "manualSubmission", action: "prepareSubmission", job });
    primary.addEventListener("click", () => preparePackageAction(job, packageValue));
  } else if (packageValue.state === "submit_ready") {
    protect(primary, { capabilityName: "manualSubmission", action: "recordSubmitted", job });
    primary.addEventListener("click", () => submitPackageAction(job, packageValue));
  } else if (packageValue.state === "submitted") {
    protect(primary, { capabilityName: "applicationResults" });
    primary.addEventListener("click", () => openOutcome(job.id));
  } else {
    protect(primary, { capabilityName: "packageWorkflow", action: "editPackage", job });
    primary.addEventListener("click", () => openPackageEditor(packageValue));
  }
}

function openComparison(packageValue) {
  const changed = (packageValue.diff || []).filter((item) => item.changed);
  $("#comparisonContent").innerHTML = changed.length ? changed.map((item) => `<section><h3>${escapeHtml(item.label)}</h3><div><strong>수정 전</strong><p>${escapeHtml(Array.isArray(item.before) ? item.before.join("\n") : item.before || "비어 있음")}</p></div><div><strong>수정 후</strong><p>${escapeHtml(Array.isArray(item.after) ? item.after.join("\n") : item.after || "비어 있음")}</p></div></section>`).join("") : '<div class="empty-state"><p>기준 이력서와 달라진 항목이 없습니다.</p></div>';
  openModal("comparisonModal");
}

function findSection(packageValue, keys) {
  return packageSections(packageValue).find((item) => keys.includes(item.key));
}

function openPackageEditor(packageValue) {
  state.editingPackage = packageValue;
  $("#packageEditFields").innerHTML = packageSections(packageValue).map((section) => `<label><span>${escapeHtml(section.label)}</span><textarea data-package-edit-key="${escapeHtml(section.key)}" data-package-edit-kind="${escapeHtml(section.kind)}" rows="${section.kind === "list" ? 6 : 5}" ${section.maxLength ? `maxlength="${Number(section.maxLength)}"` : ""}>${escapeHtml(Array.isArray(section.value) ? section.value.join("\n") : section.value || "")}</textarea><small>${escapeHtml(section.reason || "사용자가 수정하도록 허용한 공고별 항목입니다.")}</small></label>`).join("") || '<p class="subtle">수정이 허용된 항목이 없습니다.</p>';
  openModal("packageEditModal");
}

async function savePackageEdit() {
  const packageValue = state.editingPackage;
  if (!packageValue) return;
  const sections = $$('[data-package-edit-key]').map((input) => ({ key: input.dataset.packageEditKey, value: input.dataset.packageEditKind === "list" ? lines(input.value) : input.value }));
  await withBusy(`package-edit:${packageValue.id}`, async () => {
    await request(`/api/packages/${packageValue.id}`, { method: "PUT", body: JSON.stringify({ sections, expectedChecksum: packageValue.checksum }) });
    closeModal("packageEditModal");
    state.reviewJobs = null;
    await loadReviewJobs();
    await renderReviewDetail(packageValue.jobId || state.reviewJobId);
    showToast("작업본을 저장하고 승인 상태를 다시 확인했습니다.");
  });
}

async function transitionPackageReview(packageValue, status) {
  await withBusy(`package-transition:${packageValue.id}`, async () => {
    await request(`/api/packages/${packageValue.id}/review`, { method: "PATCH", body: JSON.stringify({ status }) });
    state.reviewJobs = null;
    await loadReviewJobs();
    await renderReview();
    showToast(status === "on_hold" ? "작업본을 보류했습니다." : status === "active" ? "보류를 해제했습니다." : status === "cancel_approval" ? "문안 승인을 취소했습니다." : "보완 요청 상태로 변경했습니다.");
  });
}

async function cancelPreparation(packageValue) {
  confirmAction({
    title: "수기 제출 준비를 취소할까요?", description: "고정된 제출용 복사본을 제거하고 승인 완료 상태로 되돌립니다.", confirmLabel: "제출 준비 취소",
    action: async () => {
      await request(`/api/packages/${packageValue.id}/cancel-prepare`, { method: "POST", body: "{}" });
      state.reviewJobs = null; await loadReviewJobs(); await renderReviewDetail(state.reviewJobId); showToast("수기 제출 준비를 취소했습니다.");
    },
  });
}

async function approvePackageAction(job, packageValue) {
  confirmAction({
    title: "현재 문안을 승인할까요?", description: "승인된 체크섬으로 PDF를 생성하며 이후 수정하면 승인이 초기화됩니다.", confirmLabel: "승인·PDF 생성",
    action: async () => {
      await request(`/api/packages/${packageValue.id}/approve`, { method: "POST", body: JSON.stringify({ expectedChecksum: packageValue.checksum }) });
      state.reviewJobs = null; await loadReviewJobs(); await renderReviewDetail(job.id); showToast("문안을 승인하고 PDF를 생성했습니다.");
    },
  });
}

async function preparePackageAction(job, packageValue) {
  confirmAction({
    title: "수기 제출본을 확정할까요?", description: "승인된 PDF를 고정하고 외부 채용 플랫폼에서 직접 제출할 준비를 합니다.", confirmLabel: "수기 제출 준비",
    action: async () => {
      await request(`/api/packages/${packageValue.id}/prepare`, { method: "POST", body: JSON.stringify({ platform: job.primarySource?.platform || "" }) });
      state.reviewJobs = null; await loadReviewJobs(); await renderReviewDetail(job.id); showToast("수기 제출본을 확정했습니다.");
    },
  });
}

async function submitPackageAction(job, packageValue) {
  confirmAction({
    title: "실제 제출 완료를 기록할까요?", description: "외부 채용 플랫폼에서 직접 지원을 완료한 경우에만 기록합니다.", confirmLabel: "제출 완료 기록", requireCheck: true,
    checkError: "실제 외부 제출 완료 여부를 확인해 주세요.",
    action: async () => {
      await request(`/api/packages/${packageValue.id}/submitted`, { method: "POST", body: "{}" });
      state.reviewJobs = null; await loadReviewJobs(); await renderReviewDetail(job.id); showToast("수기 제출 완료를 기록했습니다.");
    },
  });
}

function openOutcome(jobId) {
  state.outcomeJobId = Number(jobId);
  $("#outcomeType").innerHTML = (state.bootstrap.outcomeEventTypes || []).map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join("");
  $("#outcomeOccurredAt").value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("#outcomeNote").value = "";
  $("#outcomeEvidence").value = "";
  openModal("outcomeModal");
}

async function saveOutcome() {
  const body = {
    type: $("#outcomeType").value,
    occurredAt: new Date($("#outcomeOccurredAt").value).toISOString(),
    summary: $("#outcomeNote").value,
    evidence: { kind: $("#outcomeChannel").value === "email" ? "email" : $("#outcomeChannel").value === "platform" ? "portal" : "manual_note", label: $("#outcomeChannel").selectedOptions[0]?.textContent || "사용자 확인" },
  };
  await withBusy(`outcome:${state.outcomeJobId}`, async () => {
    const payload = await request(`/api/jobs/${state.outcomeJobId}/outcomes`, { method: "POST", body: JSON.stringify(body) });
    if (payload.inbox) { state.notifications = payload.inbox; renderNotifications(); }
    const file = $("#outcomeEvidence").files[0];
    if (file) {
      if (!writable("outcomeEvidenceUpload")) throw new Error("결과는 저장됐지만 증빙 파일을 저장할 수 없습니다.");
      const form = new FormData(); form.append("evidence", file);
      await request(`/api/outcomes/${payload.event.id}/evidence`, { method: "POST", body: form });
    }
    closeModal("outcomeModal");
    state.reviewJobs = null; await loadReviewJobs(); await renderReviewDetail(state.outcomeJobId);
    showToast("지원 결과를 기록했습니다.");
  });
}

function outcomeTypeOptions(selected = "") {
  return (state.bootstrap.outcomeEventTypes || []).map((item) => `<option value="${escapeHtml(item.value)}" ${item.value === selected ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
}

function localDateTimeValue(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function openOutcomeCorrection(jobId, eventId) {
  const event = (state.outcomeLedger?.events || []).find((item) => item.id === eventId);
  if (!event) return showToast("바로잡을 결과 기록을 찾지 못했습니다.", true);
  state.outcomeJobId = Number(jobId);
  state.correctionEventId = Number(eventId);
  $("#outcomeCorrectionType").innerHTML = outcomeTypeOptions(event.type);
  $("#outcomeCorrectionOccurredAt").value = localDateTimeValue();
  $("#outcomeCorrectionReason").value = "";
  $("#outcomeCorrectionSummary").value = event.summary || "";
  openModal("outcomeCorrectionModal");
}

async function saveOutcomeCorrection() {
  if (!state.outcomeJobId || !state.correctionEventId) return;
  const body = {
    type: $("#outcomeCorrectionType").value,
    occurredAt: new Date($("#outcomeCorrectionOccurredAt").value).toISOString(),
    reason: $("#outcomeCorrectionReason").value,
    summary: $("#outcomeCorrectionSummary").value,
    evidence: { kind: "manual_note", label: "사용자 교정 확인" },
  };
  await withBusy(`outcome-correction:${state.correctionEventId}`, async () => {
    const payload = await request(`/api/jobs/${state.outcomeJobId}/outcomes/${state.correctionEventId}/corrections`, { method: "POST", body: JSON.stringify(body) });
    if (payload.inbox) { state.notifications = payload.inbox; renderNotifications(); }
    closeModal("outcomeCorrectionModal");
    state.reviewJobs = null;
    await loadReviewJobs();
    await renderReviewDetail(state.outcomeJobId);
    showToast("기존 기록을 보존하고 교정 기록을 추가했습니다.");
  });
}

function openFollowUp(jobId) {
  state.outcomeJobId = Number(jobId);
  $("#followUpName").value = "";
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  $("#followUpDueAt").value = localDateTimeValue(tomorrow).slice(0, 10);
  openModal("followUpModal");
}

async function saveFollowUp() {
  await withBusy(`follow-up:${state.outcomeJobId}`, async () => {
    const payload = await request(`/api/jobs/${state.outcomeJobId}/follow-ups`, { method: "POST", body: JSON.stringify({ title: $("#followUpName").value, dueAt: $("#followUpDueAt").value }) });
    if (payload.inbox) { state.notifications = payload.inbox; renderNotifications(); }
    closeModal("followUpModal");
    await renderReviewDetail(state.outcomeJobId);
    showToast(payload.deduplicated ? "같은 후속조치가 이미 있습니다." : "후속조치를 저장했습니다.");
  });
}

async function transitionFollowUpAction(id, action) {
  await withBusy(`follow-up:${id}`, async () => {
    const payload = await request(`/api/follow-ups/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
    if (payload.inbox) { state.notifications = payload.inbox; renderNotifications(); }
    await renderReviewDetail(state.outcomeJobId || state.reviewJobId);
    showToast(action === "complete" ? "후속조치를 완료했습니다." : "후속조치를 취소했습니다.");
  });
}

function filterInputChanged(event) {
  state.filters = {
    ...state.filters,
    search: $("#searchInput").value.trim(),
    track: $("#trackFilter").value,
    region: $("#regionFilter").value,
    score: $("#scoreFilter").value,
    status: $("#statusFilter").value,
    lifecycle: $("#lifecycleFilter").value,
    deadline: $("#deadlineFilter").value,
    platform: $("#platformFilter").value,
    condition: $("#conditionFilter").value,
    sort: $("#sortFilter").value,
  };
  if (event?.target?.id === "lifecycleFilter" && state.filters.lifecycle === "active" && ["skipped", "rejected"].includes(state.filters.status)) {
    state.filters.status = "";
    $("#statusFilter").value = "";
  } else if (["applied", "interview", "offer", "skipped", "rejected"].includes(state.filters.status)) {
    state.filters.lifecycle = "all";
    $("#lifecycleFilter").value = "all";
  }
  state.workflowBucket = "";
  state.page = 1;
  loadJobs({ keepSelection: false }).catch((error) => showToast(error.message, true));
}

function resetFilters() {
  state.filters = { search: "", track: "", region: "", score: "", status: "", lifecycle: "active", deadline: "", platform: "", condition: "", sort: "score", favorite: false };
  state.activeQuick = "all";
  for (const [id, value] of Object.entries({ searchInput: "", trackFilter: "", regionFilter: "", scoreFilter: "", statusFilter: "", lifecycleFilter: "active", deadlineFilter: "", platformFilter: "", conditionFilter: "", sortFilter: "score" })) {
    if (document.getElementById(id)) document.getElementById(id).value = value;
  }
  state.page = 1;
  loadJobs({ keepSelection: false }).catch((error) => showToast(error.message, true));
}

function applyQuickFilter(value) {
  state.activeQuick = value;
  state.workflowBucket = "";
  state.filters.favorite = false;
  state.filters.status = "";
  state.filters.track = "";
  if (value.startsWith("track:")) state.filters.track = value.slice(6);
  else if (value === "favorite") state.filters.favorite = true;
  else if (value === "applied") { state.filters.status = "applied"; state.filters.lifecycle = "all"; }
  else if (value === "skipped") { state.filters.status = "skipped"; state.filters.lifecycle = "all"; }
  $("#trackFilter").value = state.filters.track;
  $("#statusFilter").value = state.filters.status;
  $("#lifecycleFilter").value = state.filters.lifecycle;
  state.page = 1;
  loadJobs({ keepSelection: false }).catch((error) => showToast(error.message, true));
}

function applyWorkflowBucket(bucket) {
  state.workflowBucket = bucket;
  state.activeQuick = "all";
  state.filters.status = "";
  state.filters.lifecycle = bucket === "complete" ? "all" : "active";
  $("#statusFilter").value = state.filters.status;
  $("#lifecycleFilter").value = state.filters.lifecycle;
  state.page = 1;
  loadJobs({ keepSelection: false }).catch((error) => showToast(error.message, true));
}

function savedFilterPayload() {
  return { ...state.filters };
}

function renderSavedFilters() {
  const saved = state.bootstrap?.savedFilters || [];
  $("#savedFilterSelect").innerHTML = '<option value="">직접 설정</option>' + saved.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.isDefault ? " · 시작" : ""}</option>`).join("");
  protect($("#saveCurrentFilter"), { capabilityName: "savedFilters" });
  protect($("#deleteSavedFilter"), { capabilityName: "savedFilters" });
}

async function saveCurrentFilter() {
  const name = $("#savedFilterName").value.trim();
  if (!name) return showToast("저장할 필터 이름을 입력해 주세요.", true);
  const id = $("#savedFilterSelect").value;
  const url = id ? `/api/saved-filters/${encodeURIComponent(id)}` : "/api/saved-filters";
  const payload = await request(url, { method: id ? "PUT" : "POST", body: JSON.stringify({ name, filters: savedFilterPayload(), isDefault: $("#savedFilterDefault").checked }) });
  state.bootstrap.savedFilters = payload.savedFilters;
  renderSavedFilters();
  $("#savedFilterSelect").value = payload.savedFilter.id;
  showToast(id ? "저장 필터를 수정했습니다." : "현재 필터를 저장했습니다.");
}

async function deleteCurrentFilter() {
  const id = $("#savedFilterSelect").value;
  if (!id) return showToast("삭제할 저장 필터를 선택해 주세요.", true);
  const payload = await request(`/api/saved-filters/${id}`, { method: "DELETE", body: "{}" });
  state.bootstrap.savedFilters = payload.savedFilters;
  renderSavedFilters();
  showToast("저장 필터를 삭제했습니다.");
}

function applySavedFilter(id) {
  const item = (state.bootstrap.savedFilters || []).find((candidate) => candidate.id === id);
  if (!item) {
    $("#savedFilterName").value = "";
    $("#savedFilterDefault").checked = false;
    return;
  }
  $("#savedFilterName").value = item.name;
  $("#savedFilterDefault").checked = Boolean(item.isDefault);
  state.filters = { ...state.filters, ...item.filters };
  state.activeQuick = "all";
  const mapping = { searchInput: "search", trackFilter: "track", regionFilter: "region", scoreFilter: "score", statusFilter: "status", lifecycleFilter: "lifecycle", deadlineFilter: "deadline", platformFilter: "platform", conditionFilter: "condition", sortFilter: "sort" };
  for (const [idValue, key] of Object.entries(mapping)) if (document.getElementById(idValue)) document.getElementById(idValue).value = state.filters[key] || "";
  state.page = 1;
  loadJobs({ keepSelection: false }).catch((error) => showToast(error.message, true));
}

function bindGlobalEvents() {
  $("#jobsScreenButton").addEventListener("click", () => setScreen("jobs"));
  $("#resumeManageButton").addEventListener("click", () => {
    const menu = $("#resumeManageMenu");
    menu.hidden = !menu.hidden;
    $("#resumeManageButton").setAttribute("aria-expanded", String(!menu.hidden));
  });
  $$('[data-screen]').forEach((button) => button.addEventListener("click", () => setScreen(button.dataset.screen)));
  document.addEventListener("click", (event) => {
    if (!$("#resumeManageNav").contains(event.target)) { $("#resumeManageMenu").hidden = true; $("#resumeManageButton").setAttribute("aria-expanded", "false"); }
    const close = event.target.closest("[data-close-modal]"); if (close) closeModal(close.dataset.closeModal);
    const favorite = event.target.closest("[data-row-favorite]");
    if (favorite) {
      event.stopPropagation();
      const jobValue = state.jobs.find((item) => item.id === Number(favorite.dataset.rowFavorite));
      if (jobValue) updateJobState(jobValue, { favorite: !jobValue.application?.favorite });
      return;
    }
    const job = event.target.closest("[data-open-job], [data-job-id]"); if (job && !event.target.closest("a")) selectJob(Number(job.dataset.openJob || job.dataset.jobId)).catch((error) => showToast(error.message, true));
    const quick = event.target.closest("[data-quick]"); if (quick) applyQuickFilter(quick.dataset.quick);
    const page = event.target.closest("[data-page]"); if (page) { state.page = Number(page.dataset.page); loadJobs().catch((error) => showToast(error.message, true)); }
    const stage = event.target.closest("[data-review-stage]"); if (stage) { state.reviewStage = stage.dataset.reviewStage; state.reviewJobId = null; renderReview().catch((error) => showToast(error.message, true)); }
    const reviewJob = event.target.closest("[data-review-job]"); if (reviewJob) renderReviewDetail(Number(reviewJob.dataset.reviewJob)).catch((error) => showToast(error.message, true));
    const editItem = event.target.closest("[data-edit-structured]"); if (editItem) openStructuredModal(state.bootstrap.resume.structuredItems.find((item) => item.id === editItem.dataset.editStructured));
    const deleteItem = event.target.closest("[data-delete-structured]"); if (deleteItem) saveStructuredItems(state.bootstrap.resume.structuredItems.filter((item) => item.id !== deleteItem.dataset.deleteStructured), "항목을 삭제했습니다.");
    const moveItem = event.target.closest("[data-move-structured]"); if (moveItem) {
      const items = [...(state.bootstrap.resume.structuredItems || [])];
      const from = items.findIndex((item) => item.id === moveItem.dataset.moveStructured);
      const to = from + (moveItem.dataset.direction === "up" ? -1 : 1);
      if (from >= 0 && to >= 0 && to < items.length) { [items[from], items[to]] = [items[to], items[from]]; saveStructuredItems(items, "항목 순서를 저장했습니다."); }
    }
    const editCustom = event.target.closest("[data-edit-custom]"); if (editCustom) openCustomSection((state.bootstrap.resume.customSections || []).find((item) => item.id === editCustom.dataset.editCustom));
    const deleteCustom = event.target.closest("[data-delete-custom]"); if (deleteCustom) saveCustomSections((state.bootstrap.resume.customSections || []).filter((item) => item.id !== deleteCustom.dataset.deleteCustom), "커스텀 섹션을 삭제했습니다.");
    const removeChip = event.target.closest("[data-remove-resume-chip]");
    if (removeChip) {
      const kind = removeChip.dataset.removeResumeChip;
      const elements = chipElements(kind);
      renderEditableChips(kind, lines(elements.storage.value).filter((item) => item !== removeChip.dataset.value));
    }
    const notification = event.target.closest("[data-notification-id]"); if (notification) markNotification(notification.dataset.notificationId, notification.dataset.notificationJob).catch((error) => showToast(error.message, true));
    const tab = event.target.closest("[data-notification-tab]"); if (tab) { state.notificationTab = tab.dataset.notificationTab; renderNotifications(); }
    const bucket = event.target.closest("[data-workflow-bucket]"); if (bucket) applyWorkflowBucket(bucket.dataset.workflowBucket);
  });
  $("#notificationButton").addEventListener("click", () => { const drawer = $("#notificationDrawer"); drawer.hidden = !drawer.hidden; $("#notificationButton").setAttribute("aria-expanded", String(!drawer.hidden)); });
  $("#notificationDrawerCloseButton").addEventListener("click", () => { $("#notificationDrawer").hidden = true; $("#notificationButton").setAttribute("aria-expanded", "false"); });
  $("#notificationOpenAllButton").addEventListener("click", () => { $("#notificationDrawer").hidden = true; openModal("notificationModal"); });
  $("#notificationMarkAllButton").addEventListener("click", markAllNotifications);
  $("#notificationModalMarkAllButton").addEventListener("click", markAllNotifications);
  $("#notificationSearchInput").addEventListener("input", renderNotifications);
  $("#settingsButton").addEventListener("click", async () => { await loadSettings(); renderSettings(); openModal("settingsModal"); });
  $("#openSettingsFromResume").addEventListener("click", async () => { await loadSettings(); renderSettings(); openModal("settingsModal"); });
  $("#reloadButton").addEventListener("click", () => initialize({ preserveScreen: true }));
  $("#requestJobCollectionButton").addEventListener("click", () => requestCompanion("collect_jobs"));
  $("#detailCloseButton").addEventListener("click", () => $("#jobDetail").classList.remove("mobile-open"));
  $("#filterForm").addEventListener("submit", (event) => event.preventDefault());
  let searchTimer;
  $("#searchInput").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(filterInputChanged, 220); });
  for (const id of ["trackFilter", "regionFilter", "scoreFilter", "statusFilter", "lifecycleFilter", "deadlineFilter", "platformFilter", "conditionFilter", "sortFilter"]) $(id.startsWith("#") ? id : `#${id}`).addEventListener("change", filterInputChanged);
  $("#resetFiltersButton").addEventListener("click", resetFilters);
  $("#pagePrevButton").addEventListener("click", () => { if (state.page > 1) { state.page--; loadJobs(); } });
  $("#pageNextButton").addEventListener("click", () => { if (state.page < state.totalPages) { state.page++; loadJobs(); } });
  $("#pageLastButton").addEventListener("click", () => { state.page = state.totalPages; loadJobs(); });
  $("#pageSizeSelect").addEventListener("change", (event) => { state.pageSize = Number(event.target.value); state.page = 1; loadJobs({ keepSelection: false }); });
  $("#saveCurrentFilter").addEventListener("click", () => withBusy("saved-filter", saveCurrentFilter));
  $("#deleteSavedFilter").addEventListener("click", () => withBusy("delete-filter", deleteCurrentFilter));
  $("#savedFilterSelect").addEventListener("change", (event) => applySavedFilter(event.target.value));
  $("#settingsForm").addEventListener("submit", (event) => { event.preventDefault(); withBusy("settings", saveSettings); });
  $$('[data-career-type]').forEach((button) => button.addEventListener("click", () => { $$('[data-career-type]').forEach((item) => item.classList.remove("active")); button.classList.add("active"); }));
  $$('[data-add-item]').forEach((button) => button.addEventListener("click", () => openStructuredModal({ kind: button.dataset.addItem })));
  $("#resumeSkillAddButton").addEventListener("click", () => addResumeChip("skill"));
  $("#resumeCertificateAddButton").addEventListener("click", () => addResumeChip("certificate"));
  $("#resumeSkillInput").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addResumeChip("skill"); } });
  $("#resumeCertificateInput").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addResumeChip("certificate"); } });
  $("#structuredItemForm").addEventListener("submit", (event) => { event.preventDefault(); const item = structuredFromModal(); const current = state.bootstrap.resume.structuredItems || []; saveStructuredItems(current.some((candidate) => candidate.id === item.id) ? current.map((candidate) => candidate.id === item.id ? item : candidate) : [...current, item]); });
  $("#resumeBasicsForm").addEventListener("submit", (event) => { event.preventDefault(); saveResumeBasics(); });
  $("#resumeEditForm").addEventListener("submit", (event) => { event.preventDefault(); saveResumeBasics({ editOnly: true }); });
  $("#resumeEditCancelButton").addEventListener("click", () => { fillResumeForms(); closeResumeEditSection(); });
  $("#resumeEditStartButton").addEventListener("click", () => openResumeEditSection("profile"));
  $$('[data-resume-edit-section]').forEach((button) => button.addEventListener("click", () => openResumeEditSection(button.dataset.resumeEditSection)));
  $("#resumeEditGuideButton").addEventListener("click", () => { const panel = $("#resumeEditGuidePanel"); panel.hidden = !panel.hidden; $("#resumeEditGuideButton").setAttribute("aria-expanded", String(!panel.hidden)); });
  const restoreCurrentResume = () => { fillResumeForms(); renderResume(); showToast("현재 적용 중인 이력서 기준을 불러왔습니다."); };
  $("#resumeImportCurrentButton").addEventListener("click", restoreCurrentResume);
  $("#resumeImportEditButton").addEventListener("click", restoreCurrentResume);
  $("#resumeEditRefreshButton").addEventListener("click", () => initialize({ preserveScreen: true }));
  $("#editStructuredInCreateButton").addEventListener("click", () => setScreen("resume-create"));
  $("#resumeUploadForm").addEventListener("submit", (event) => { event.preventDefault(); uploadDocument("resume", "#resumeDocumentFile", "#resumeDocumentReplace"); });
  $("#portfolioUploadForm").addEventListener("submit", (event) => { event.preventDefault(); uploadDocument("portfolio", "#portfolioDocumentFile", "#portfolioDocumentReplace"); });
  $("#resumeDocumentFile").addEventListener("change", () => { if ($("#resumeDocumentFile").files[0]) uploadDocument("resume", "#resumeDocumentFile", "#resumeDocumentReplace"); });
  $("#portfolioDocumentFile").addEventListener("change", () => { if ($("#portfolioDocumentFile").files[0]) uploadDocument("portfolio", "#portfolioDocumentFile", "#portfolioDocumentReplace"); });
  $("#requestDocumentAnalysisButton").addEventListener("click", () => requestCompanion("analyze_documents", { documentIds: (state.settings?.documents || []).filter((item) => item.status !== "archived").map((item) => item.id) }));
  $("#supplementOpenButton").addEventListener("click", () => { const resume = state.bootstrap.resume; $("#supplementAchievement").value = resume.achievementEvidence || ""; $("#supplementExperience").value = resume.representativeExperience || ""; $("#supplementDirectScope").value = resume.directScope || ""; $("#supplementCollaboration").value = resume.collaborationScope || ""; openModal("supplementModal"); });
  $("#supplementForm").addEventListener("submit", (event) => { event.preventDefault(); const resume = state.bootstrap.resume; state.bootstrap.resume = { ...resume, achievementEvidence: $("#supplementAchievement").value, representativeExperience: $("#supplementExperience").value, directScope: $("#supplementDirectScope").value, collaborationScope: $("#supplementCollaboration").value }; closeModal("supplementModal"); saveResumeBasics({ editOnly: true }); });
  $("#customSectionAddButton").addEventListener("click", () => openCustomSection());
  $("#customSectionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const current = state.bootstrap.resume.customSections || [];
    const id = $("#customSectionId").value || crypto.randomUUID();
    const existing = current.find((item) => item.id === id);
    const kind = $("#customSectionKind").value;
    const section = { ...existing, id, key: existing?.key || `custom:${id}`, label: $("#customSectionLabel").value.trim(), kind, value: kind === "list" ? lines($("#customSectionValue").value) : $("#customSectionValue").value, editable: $("#customSectionEditable").checked, displayOrder: existing?.displayOrder || current.length + 1, sourceRefs: existing?.sourceRefs || [] };
    saveCustomSections(existing ? current.map((item) => item.id === id ? section : item) : [...current, section]);
  });
  $("#packageEditForm").addEventListener("submit", (event) => { event.preventDefault(); savePackageEdit(); });
  $("#outcomeForm").addEventListener("submit", (event) => { event.preventDefault(); saveOutcome(); });
  $("#outcomeCorrectionForm").addEventListener("submit", (event) => { event.preventDefault(); saveOutcomeCorrection(); });
  $("#followUpForm").addEventListener("submit", (event) => { event.preventDefault(); saveFollowUp(); });
  $("#confirmationCancelButton").addEventListener("click", () => { state.confirmationAction = null; closeModal("confirmationModal"); });
  $("#confirmationConfirmButton").addEventListener("click", async () => {
    const pending = state.confirmationAction;
    if (!pending) return;
    if (pending.requireCheck && !$("#confirmationCheck").checked) return showToast(pending.checkError, true);
    state.confirmationAction = null; closeModal("confirmationModal"); await withBusy("confirmation", pending.action);
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setScreen("jobs"); $("#searchInput").focus(); }
    if (event.key === "Escape") { $$('.modal:not([hidden])').forEach((modal) => closeModal(modal.id)); $("#notificationDrawer").hidden = true; $("#resumeManageMenu").hidden = true; }
  });
}

async function initialize({ preserveScreen = false } = {}) {
  await withBusy("initialize", async () => {
    const bootstrap = await request("/api/bootstrap");
    state.bootstrap = bootstrap;
    state.mode = bootstrap.mode;
    state.contract = bootstrap.uiContract || (await request("/api/ui-contract"));
    state.notifications = bootstrap.inbox || { items: [], unreadCount: 0 };
    applyEnvironment();
    if (state.mode === "onboarding") {
      $("#onboardingRedirectScreen").hidden = false;
      $("#jobBoardScreen").hidden = true;
      return;
    }
    $("#onboardingRedirectScreen").hidden = true;
    await Promise.all([loadJobs(), loadWorkflow(), loadNotifications(), loadSettings()]);
    renderSavedFilters();
    renderResume();
    if (!preserveScreen) {
      const hash = location.hash.slice(1);
      setScreen(["resume-create", "resume-edit", "resume-review"].includes(hash) ? hash : "jobs");
    } else setScreen(state.activeScreen);
  });
}

bindGlobalEvents();
initialize().catch((error) => {
  $("#actionNotice").hidden = false;
  $("#actionNotice").textContent = `대시보드를 시작하지 못했습니다: ${error.message}`;
  showToast(error.message, true);
});
