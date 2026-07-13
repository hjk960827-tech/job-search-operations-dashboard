function sourceSettings(config, platform) {
  return config?.sources?.[platform] || { display: true, priority: 999 };
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isClosed(value) {
  return new Set(["closed", "expired", "ended"]).has(String(value || "").trim().toLowerCase());
}

export function rankSources(sources, config = {}) {
  const preferDirect = config?.primary_selection?.prefer_direct_company !== false;
  const requireNotClosed = config?.primary_selection?.require_not_closed !== false;
  const visible = sources.filter((source) => sourceSettings(config, source.platform).display !== false);
  const eligible = visible.filter((source) => !requireNotClosed || !isClosed(source.status));
  const candidates = eligible.length ? eligible : visible;

  return [...candidates].sort((left, right) => {
    if (preferDirect) {
      const directDelta = Number(right.platform === "direct") - Number(left.platform === "direct");
      if (directDelta) return directDelta;
    }
    const priorityDelta = Number(sourceSettings(config, left.platform).priority ?? 999)
      - Number(sourceSettings(config, right.platform).priority ?? 999);
    if (priorityDelta) return priorityDelta;
    const confidenceDelta = Number(right.confidence || 0) - Number(left.confidence || 0);
    if (confidenceDelta) return confidenceDelta;
    const checkedDelta = timestamp(right.checkedAt) - timestamp(left.checkedAt);
    if (checkedDelta) return checkedDelta;
    return String(left.platform).localeCompare(String(right.platform));
  });
}

export function selectPrimarySource(sources, config = {}) {
  return rankSources(sources, config)[0] || null;
}
