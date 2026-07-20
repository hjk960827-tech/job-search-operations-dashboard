const CLOSED = new Set(["closed", "expired", "ended"]);

export function normalizeDeadline(value, field = "deadline", { allowUndefined = false } = {}) {
  if (value === undefined && allowUndefined) return undefined;
  if (value === null || String(value).trim() === "") return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(normalized)) {
    throw Object.assign(new Error(`${field} must be YYYY-MM-DD, null, or blank`), { statusCode: 400 });
  }
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw Object.assign(new Error(`${field} must be a real calendar date`), { statusCode: 400 });
  }
  return normalized;
}

export function dateKey(now = new Date(), timeZone = "Asia/Seoul") {
  const date = new Date(now);
  const partsFor = (zone) => new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  let parts;
  try { parts = partsFor(timeZone || "Asia/Seoul"); } catch { parts = partsFor("Asia/Seoul"); }
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function deadlineDays(deadline, now = new Date(), timeZone = "Asia/Seoul") {
  if (!deadline) return null;
  const current = new Date(`${dateKey(now, timeZone)}T00:00:00Z`);
  const target = new Date(`${deadline}T00:00:00Z`);
  return Math.round((target.getTime() - current.getTime()) / 86_400_000);
}

export function effectiveSource(source, now = new Date(), timeZone = "Asia/Seoul") {
  const days = deadlineDays(source.deadline, now, timeZone);
  const raw = String(source.status || source.lifecycleStatus || "unknown").toLowerCase();
  const status = CLOSED.has(raw) || days !== null && days < 0 ? "closed" : raw === "active" ? "active" : "unknown";
  return { ...source, status, deadlineDays: days };
}

export function deriveJobDeadline(explicitDeadline, sources = [], now = new Date(), timeZone = "Asia/Seoul") {
  if (!sources.length) {
    return { deadline: explicitDeadline || null, deadlineDays: deadlineDays(explicitDeadline, now, timeZone), source: explicitDeadline ? "job" : "" };
  }
  const projected = sources.map((item) => {
    const effectiveDeadline = item.deadline || explicitDeadline || null;
    const status = effectiveSource({ ...item, deadline: effectiveDeadline }, now, timeZone).status;
    return { effectiveDeadline, status, ownDeadline: item.deadline || null };
  });
  const open = projected.filter((item) => item.status !== "closed");
  const candidates = open.length ? open : projected;
  const hasUnknownOpenDeadline = open.some((item) => !item.effectiveDeadline);
  const deadlines = candidates.map((item) => item.effectiveDeadline).filter(Boolean).sort();
  const deadline = hasUnknownOpenDeadline ? null : deadlines.at(-1) || null;
  const fromJob = Boolean(deadline && explicitDeadline && candidates.some((item) => !item.ownDeadline));
  return { deadline, deadlineDays: deadlineDays(deadline, now, timeZone), source: deadline ? fromJob ? "job" : "source" : "" };
}

export function deriveJobLifecycle(storedStatus, sources = [], explicitDeadline = null, now = new Date(), timeZone = "Asia/Seoul") {
  if (!sources.length && deadlineDays(explicitDeadline, now, timeZone) < 0) return "closed";
  const statuses = sources.map((source) => effectiveSource({
    ...source,
    deadline: source.deadline || explicitDeadline || null,
  }, now, timeZone).status);
  if (statuses.length && statuses.every((status) => status === "closed")) return "closed";
  if (statuses.some((status) => status === "active")) return "active";
  const raw = String(storedStatus || "unknown").toLowerCase();
  return CLOSED.has(raw) ? "closed" : raw === "active" ? "active" : "unknown";
}
