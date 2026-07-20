export const DOCUMENT_QUALITY_CRITERIA = Object.freeze([
  { id: "required_sections", label: "필수 항목 작성", weight: 35, enabled: true, required: true },
  { id: "content_depth", label: "내용 구체성", weight: 35, enabled: true },
  { id: "placeholder_free", label: "미확정 문구 제거", weight: 20, enabled: true, required: true },
  { id: "job_focus_coverage", label: "공고 중점 항목 반영", weight: 10, enabled: true },
  { id: "evidence_traceability", label: "수정 내용의 근거 연결", weight: 0, enabled: false },
]);

const CATALOG = new Map(DOCUMENT_QUALITY_CRITERIA.map((item) => [item.id, item]));

export function defaultDocumentQualityCriteria() {
  return DOCUMENT_QUALITY_CRITERIA.map((item) => ({ ...item }));
}

export function validateDocumentQualityCriteria(value, { optional = true } = {}) {
  const issues = [];
  if (value === undefined && optional) return issues;
  if (!Array.isArray(value) || !value.length) return ["resume.quality_rules.criteria must be a non-empty list"];
  const seen = new Set();
  let enabledCount = 0;
  let enabledWeight = 0;
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(`resume.quality_rules.criteria[${index}] must be an object`);
      continue;
    }
    const id = String(item.id || "").trim();
    if (!CATALOG.has(id)) issues.push(`resume.quality_rules.criteria[${index}].id is not supported: ${id || "(empty)"}`);
    if (seen.has(id)) issues.push(`resume.quality_rules.criteria contains a duplicate id: ${id}`);
    seen.add(id);
    if (typeof item.enabled !== "boolean") issues.push(`resume.quality_rules.criteria[${index}].enabled must be true or false`);
    const weight = Number(item.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
      issues.push(`resume.quality_rules.criteria[${index}].weight must be between 0 and 100`);
    }
    if (item.enabled === true && Number.isFinite(weight)) {
      enabledCount += 1;
      enabledWeight += weight;
    }
  }
  for (const definition of DOCUMENT_QUALITY_CRITERIA.filter((item) => item.required)) {
    const configured = value.find((item) => String(item?.id || "") === definition.id);
    if (!configured || configured.enabled !== true) issues.push(`resume.quality_rules.criteria must keep ${definition.id} enabled`);
  }
  if (!enabledCount) issues.push("resume.quality_rules.criteria must enable at least one criterion");
  else if (Math.abs(enabledWeight - 100) > 0.0001) issues.push("resume.quality_rules enabled criterion weights must total 100");
  return issues;
}

export function normalizeDocumentQualityCriteria(value) {
  if (!Array.isArray(value)) return null;
  const validation = validateDocumentQualityCriteria(value, { optional: false });
  if (validation.length) return null;
  return value.map((item) => {
    const definition = CATALOG.get(String(item.id));
    return {
      id: definition.id,
      label: String(item.label || definition.label).trim().slice(0, 120) || definition.label,
      enabled: item.enabled === true,
      weight: Number(item.weight),
      required: definition.required === true,
    };
  });
}
