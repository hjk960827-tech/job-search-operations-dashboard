const state = {
  data: null,
  selectedJobId: null,
  screen: "jobs",
  filters: { search: "", track: "", platform: "", status: "", lifecycle: "active", favorite: false },
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
  revision_requested: "수정 요청",
  approval_hold: "승인 보류",
  approved: "승인 완료",
  submit_ready: "제출 준비 완료",
  submitted: "제출 완료",
  archived: "보관",
};

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
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "요청을 처리하지 못했습니다.");
  return payload;
}

function setScreen(screen) {
  state.screen = screen;
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.screen === screen));
  $("#jobsScreen").hidden = screen !== "jobs";
  $("#resumeScreen").hidden = screen !== "resume";
  $("#settingsScreen").hidden = screen !== "settings";
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
  return state.data.jobs.filter((job) => {
    if (query && !`${job.companyName} ${job.title} ${job.summary}`.toLowerCase().includes(query)) return false;
    if (state.filters.track && job.track !== state.filters.track) return false;
    if (state.filters.platform && !job.sources.some((source) => source.platform === state.filters.platform)) return false;
    if (state.filters.status && job.application.workflowStatus !== state.filters.status) return false;
    const archived = job.status === "closed" || ["skipped", "rejected"].includes(job.application.workflowStatus);
    if (state.filters.lifecycle === "active" && archived) return false;
    if (state.filters.lifecycle === "archive" && !archived) return false;
    if (state.filters.favorite && !job.application.favorite) return false;
    return true;
  });
}

function createJobCard(job) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `job-card${state.selectedJobId === job.id ? " active" : ""}`;
  const body = document.createElement("div");
  const company = document.createElement("p");
  company.className = "job-company";
  company.textContent = `${job.application.favorite ? "★ " : ""}${job.companyName}`;
  if (job.application.favorite) company.classList.add("favorite-star");
  const title = document.createElement("h3");
  title.textContent = job.title;
  const meta = document.createElement("div");
  meta.className = "job-meta";
  for (const value of [job.track, job.location, job.employmentType, statusLabels[job.application.workflowStatus]]) {
    if (!value) continue;
    const span = document.createElement("span");
    span.textContent = value;
    meta.append(span);
  }
  body.append(company, title, meta);
  const score = document.createElement("span");
  score.className = `job-score${job.score === null ? " empty" : ""}`;
  const reviewBelow = Number(state.data.scoreReviewBelow ?? 86);
  if (job.score !== null && Number(job.score) < reviewBelow) {
    score.classList.add("caution");
    score.title = "적합도 주의";
  }
  score.textContent = job.score === null ? "–" : Math.round(job.score);
  button.append(body, score);
  button.addEventListener("click", () => {
    state.selectedJobId = job.id;
    renderJobs();
    renderDetail(job.id);
  });
  return button;
}

function renderJobs() {
  const jobs = filteredJobs();
  $("#jobCount").textContent = `${jobs.length}건`;
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

function sourceLabel(platform) {
  return state.data.sources?.[platform]?.label || platform;
}

function renderDetail(jobId) {
  const job = state.data.jobs.find((item) => item.id === jobId);
  const detail = $("#jobDetail");
  detail.replaceChildren();
  if (!job) return;

  const company = document.createElement("p");
  company.className = "detail-company";
  company.textContent = job.companyName;
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
  const summary = document.createElement("p");
  summary.className = "detail-summary";
  summary.textContent = job.summary || "공고 요약이 아직 없습니다.";
  detail.append(company, title, meta, summary);
  if (job.score !== null && Number(job.score) < Number(state.data.scoreReviewBelow ?? 86)) {
    const caution = document.createElement("p");
    caution.className = "package-state hold";
    caution.textContent = "적합도 주의 · 사용자 기준 점수 미만";
    detail.append(caution);
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
    status.textContent = `상태 ${source.status} · 신뢰도 ${source.confidence}`;
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
  statusLabel.append(statusCaption, statusSelect);
  const noteLabel = document.createElement("label");
  const noteCaption = document.createElement("span");
  noteCaption.textContent = "메모";
  const note = document.createElement("textarea");
  note.rows = 4;
  note.maxLength = 2000;
  note.value = job.application.note;
  noteLabel.append(noteCaption, note);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary-button";
  save.textContent = "상태 저장";
  save.addEventListener("click", () => saveState(job, { workflowStatus: statusSelect.value, note: note.value }));
  statePanel.append(statusLabel, noteLabel, save);
  detail.append(statePanel);
  detail.append(renderPackagePanel(job));
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
  reason.textContent = `${section.reason || "등록 이력서에서 선택된 맞춤 수정 항목입니다."} · ${minimum}`;
  label.append(heading, input, reason);
  return label;
}

function applyJobs(payload, jobId) {
  state.data.jobs = payload.jobs;
  renderJobs();
  renderDetail(jobId);
}

function packageAction(label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderPackagePanel(job) {
  const panel = document.createElement("section");
  panel.className = "package-panel";
  const heading = document.createElement("div");
  heading.className = "package-heading";
  const title = document.createElement("h4");
  title.textContent = "맞춤 지원 문서";
  heading.append(title);
  panel.append(heading);

  if (!job.package) {
    const copy = document.createElement("p");
    copy.textContent = "등록한 기본 이력서 중 이 공고와 관련 있고 수정이 허용된 항목만 골라 맞춤 문안을 만듭니다. 실제 제출 전에는 반드시 직접 검토해야 합니다.";
    const create = packageAction("맞춤 문안 시작", "primary-button", async () => {
      try {
        const payload = await request(`/api/jobs/${job.id}/package`, { method: "POST", body: "{}" });
        applyJobs(payload, job.id);
        showToast("맞춤 문안을 만들었습니다.");
      } catch (error) { showToast(error.message, true); }
    });
    panel.append(copy, create);
    return panel;
  }

  const packageValue = job.package;
  const badge = document.createElement("span");
  badge.className = `package-state ${packageValue.quality.status === "passed" ? "ready" : "hold"}`;
  badge.textContent = packageStateLabels[packageValue.state] || packageValue.state;
  heading.append(badge);

  const quality = document.createElement("p");
  quality.className = "package-quality";
  quality.textContent = `품질 점수 ${Math.round(packageValue.quality.score)}점 · ${packageValue.quality.status === "passed" ? "기준 통과" : "보완 필요"}`;
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

  const editable = ["quality_hold", "approval_pending", "revision_requested", "approval_hold", "approved"].includes(packageValue.state);
  if (editable) {
    const form = document.createElement("div");
    form.className = "package-form";
    if (packageValue.content.protectedFacts?.length) {
      const facts = document.createElement("div");
      facts.className = "protected-facts";
      const factsTitle = document.createElement("strong");
      factsTitle.textContent = "사실 보호 항목 · 맞춤 문안에서 수정되지 않습니다";
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
      empty.textContent = "기본 이력서에서 내용을 입력하고 맞춤 수정 허용 항목을 선택해 주세요.";
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
    }));
    if (packageValue.state === "approval_pending") {
      actions.append(packageAction("승인하고 PDF 생성", "primary-button", async () => {
        try {
          const payload = await request(`/api/packages/${packageValue.id}/approve`, { method: "POST", body: "{}" });
          applyJobs(payload, job.id);
          showToast("검증된 PDF를 생성하고 문안을 승인했습니다.");
        } catch (error) { showToast(error.message, true); }
      }));
    }
    form.append(actions);
    panel.append(form);
  }

  if (packageValue.pdf?.available) {
    const pdf = document.createElement("p");
    pdf.className = "package-pdf";
    pdf.textContent = `${packageValue.pdf.fileName} · ${packageValue.pdf.pages}페이지 · 체크섬 ${packageValue.pdf.checksum.slice(0, 12)}`;
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
      && packageValue.approvedChecksum === packageValue.checksum,
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
    });
    prepare.disabled = !manualSubmissionReady;
    prepare.title = manualSubmissionReady
      ? "승인된 PDF를 확정하고 수기 제출 단계로 이동합니다."
      : "문안 승인과 PDF 준비 상태를 먼저 확인해 주세요.";
    panel.append(prepare);
  }
  if (packageValue.state === "submit_ready") {
    panel.append(packageAction("제출 완료 기록", "primary-button", async () => {
      try {
        const payload = await request(`/api/packages/${packageValue.id}/submitted`, { method: "POST", body: "{}" });
        applyJobs(payload, job.id);
        showToast("확정된 제출본을 기준으로 수기 제출 완료를 기록했습니다.");
      } catch (error) { showToast(error.message, true); }
    }));
  }
  if (packageValue.state === "submitted") {
    const frozen = document.createElement("p");
    frozen.className = "package-frozen";
    frozen.textContent = "제출 완료된 문안과 PDF는 수정할 수 없습니다.";
    panel.append(frozen);
  }
  return panel;
}

async function saveState(job, patch) {
  try {
    const payload = await request(`/api/jobs/${job.id}/state`, { method: "PATCH", body: JSON.stringify(patch) });
    state.data.jobs = payload.jobs;
    renderJobs();
    renderDetail(job.id);
    showToast("공고 상태를 저장했습니다.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderResume() {
  const resume = state.data.resume;
  $("#resumeJobFamily").value = resume.jobFamily || "";
  $("#resumeJobRole").value = resume.jobRole || "";
  $("#resumeCareerType").value = resume.careerType || "new";
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
  $("#resumeFilename").value = resume.filenamePattern || "{name}_resume_{company}.pdf";
  $("#resumeSavedAt").textContent = resume.updatedAt ? `마지막 저장 ${formatDateTime(resume.updatedAt)}` : "";
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
  for (const [key, item] of Object.entries(state.data.sources || {}).sort((a, b) => a[1].priority - b[1].priority)) {
    const row = document.createElement("div");
    row.className = "source-setting";
    const name = document.createElement("strong");
    name.textContent = item.label || key;
    const status = document.createElement("span");
    status.textContent = `${item.collect ? "수집" : "수집 제외"} · ${item.display ? "표시" : "숨김"} · 우선순위 ${item.priority}`;
    row.append(name, status);
    sources.append(row);
  }
}

function renderAll() {
  $("#displayName").textContent = state.data.profile.displayName || "";
  $("#modeBadge").textContent = state.data.mode === "demo" ? "예시 데이터" : "개인 데이터";
  $("#exampleBanner").hidden = state.data.mode !== "demo";
  fillSelect($("#trackFilter"), [...new Set(state.data.jobs.map((job) => job.track))]);
  fillSelect($("#platformFilter"), [...new Set(state.data.jobs.flatMap((job) => job.sources.map((source) => source.platform)))]);
  renderJobs();
  renderResume();
  renderSettings();
}

function bindEvents() {
  $$(".tab").forEach((button) => button.addEventListener("click", () => setScreen(button.dataset.screen)));
  $("#searchInput").addEventListener("input", (event) => { state.filters.search = event.target.value; renderJobs(); });
  $("#trackFilter").addEventListener("change", (event) => { state.filters.track = event.target.value; renderJobs(); });
  $("#platformFilter").addEventListener("change", (event) => { state.filters.platform = event.target.value; renderJobs(); });
  $("#statusFilter").addEventListener("change", (event) => { state.filters.status = event.target.value; renderJobs(); });
  $("#lifecycleFilter").addEventListener("change", (event) => { state.filters.lifecycle = event.target.value; renderJobs(); });
  $("#favoriteFilter").addEventListener("change", (event) => { state.filters.favorite = event.target.checked; renderJobs(); });
  $("#resumeCareerType").addEventListener("change", (event) => {
    $("#resumeYearsExperience").disabled = event.target.value !== "experienced";
  });
  $("#resumeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const lines = (value) => value.split("\n").map((item) => item.trim()).filter(Boolean);
    try {
      const payload = await request("/api/resume", {
        method: "PUT",
        body: JSON.stringify({
          jobFamily: $("#resumeJobFamily").value,
          jobRole: $("#resumeJobRole").value,
          careerType: $("#resumeCareerType").value,
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
          filenamePattern: $("#resumeFilename").value,
        }),
      });
      state.data.resume = payload.resume;
      renderResume();
      showToast("이력서 기준을 저장했습니다.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

async function initialize() {
  try {
    state.data = await request("/api/dashboard");
    renderAll();
    bindEvents();
  } catch (error) {
    showToast(error.message, true);
  }
}

initialize();
