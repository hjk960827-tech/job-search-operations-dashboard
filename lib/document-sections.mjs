// Shared semantic section catalog for onboarding analysis and persisted documents.
export const BUILTIN_SECTION_DEFINITIONS = Object.freeze({
  headline: { label: "헤드라인", kind: "text" },
  summary: { label: "경력 요약", kind: "text" },
  skills: { label: "핵심 기술·역량", kind: "list" },
  experience_highlights: { label: "경력 하이라이트", kind: "list" },
  achievement_evidence: { label: "성과 근거", kind: "text" },
  representative_experience: { label: "대표 경험", kind: "text" },
  direct_scope: { label: "직접 담당 범위", kind: "text" },
  collaboration_scope: { label: "협업 범위", kind: "text" },
  career_direction: { label: "직무 관점 / 일하는 방식", kind: "text" },
});

const SECTION_ALIASES = new Map([
  ["headline", "headline"], ["title", "headline"], ["제목", "headline"], ["헤드라인", "headline"],
  ["summary", "summary"], ["profile", "summary"], ["intro", "summary"], ["소개", "summary"], ["경력요약", "summary"], ["자기소개", "summary"],
  ["skills", "skills"], ["skill", "skills"], ["기술", "skills"], ["역량", "skills"], ["핵심역량", "skills"],
  ["experiencehighlights", "experience_highlights"], ["experience", "experience_highlights"], ["workexperience", "experience_highlights"], ["경력", "experience_highlights"], ["경력사항", "experience_highlights"],
  ["achievements", "achievement_evidence"], ["achievementevidence", "achievement_evidence"], ["성과", "achievement_evidence"], ["성과근거", "achievement_evidence"],
  ["representativeexperience", "representative_experience"], ["대표경험", "representative_experience"],
  ["directscope", "direct_scope"], ["담당업무", "direct_scope"], ["직접담당", "direct_scope"],
  ["collaborationscope", "collaboration_scope"], ["협업", "collaboration_scope"], ["협업범위", "collaboration_scope"],
  ["careerdirection", "career_direction"], ["workingstyle", "career_direction"], ["일하는방식", "career_direction"], ["직무관점", "career_direction"],
]);

export function sectionAliasKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
}

function safeCustomKey(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return `custom:${normalized || fallback}`;
}

export function builtinSectionKey(key, label = "") {
  const direct = String(key || "").trim().slice(0, 100);
  if (Object.hasOwn(BUILTIN_SECTION_DEFINITIONS, direct)) return direct;
  const candidate = direct.startsWith("custom:") ? direct.slice(7) : direct;
  return SECTION_ALIASES.get(sectionAliasKey(candidate)) || SECTION_ALIASES.get(sectionAliasKey(label)) || "";
}

export function builtinSectionKind(key) {
  return BUILTIN_SECTION_DEFINITIONS[String(key || "")]?.kind || "";
}

export function canonicalSectionKey(key, label = "", fallback = "section") {
  const direct = String(key || "").trim().slice(0, 100);
  const builtin = builtinSectionKey(direct, label);
  if (builtin) return builtin;
  const candidate = direct.startsWith("custom:") ? direct.slice(7) : direct;
  return safeCustomKey(candidate || label, fallback);
}
