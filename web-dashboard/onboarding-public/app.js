const state = { data: null, onboarding: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const defaultDocumentQualityCriteria = [
  { id: "required_sections", label: "필수 항목 작성", enabled: true, weight: 35, required: true },
  { id: "content_depth", label: "내용 구체성", enabled: true, weight: 35 },
  { id: "placeholder_free", label: "미확정 문구 제거", enabled: true, weight: 20, required: true },
  { id: "job_focus_coverage", label: "공고 중점 항목 반영", enabled: true, weight: 10 },
  { id: "evidence_traceability", label: "수정 내용의 근거 연결", enabled: false, weight: 0 },
];

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 3000);
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
  $("#onboardingScreen").hidden = false;
  $("#modeBadge").textContent = "초기 설정";
  $("#displayName").textContent = onboarding.profile.displayName || "";
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
      if (!payload.dashboard) throw new Error("개인 설정 완료 결과를 확인할 수 없습니다.");
      window.location.reload();
    } catch (error) { showToast(error.message, true); }
  });
}

async function initialize() {
  try {
    state.data = await request("/api/bootstrap");
    if (state.data.mode !== "onboarding") {
      window.location.reload();
      return;
    }
    state.onboarding = state.data.onboarding;
    renderOnboarding();
    bindOnboardingEvents();
  } catch (error) {
    showToast(error.message, true);
  }
}

initialize();
