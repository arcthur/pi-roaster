export interface AgentSessionUsage {
  agentId: string;
  lastUsedAt: number;
  inFlightTasks: number;
}

type AgentUsageAggregate = {
  maxLastUsedAt: number;
  hasInFlight: boolean;
};

function normalizeTimestamp(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : 0;
}

function normalizeInFlight(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function aggregateUsage(usages: AgentSessionUsage[]): Map<string, AgentUsageAggregate> {
  const aggregated = new Map<string, AgentUsageAggregate>();
  for (const entry of usages) {
    const agentId = entry.agentId.trim();
    if (!agentId) continue;
    const lastUsedAt = normalizeTimestamp(entry.lastUsedAt);
    const inFlight = normalizeInFlight(entry.inFlightTasks) > 0;
    const existing = aggregated.get(agentId);
    if (!existing) {
      aggregated.set(agentId, {
        maxLastUsedAt: lastUsedAt,
        hasInFlight: inFlight,
      });
      continue;
    }
    existing.maxLastUsedAt = Math.max(existing.maxLastUsedAt, lastUsedAt);
    existing.hasInFlight = existing.hasInFlight || inFlight;
  }
  return aggregated;
}

export function selectIdleEvictableAgentsByTtl(
  usages: AgentSessionUsage[],
  now: number,
  ttlMs: number,
): string[] {
  const normalizedNow = normalizeTimestamp(now);
  const normalizedTtl = Math.max(1, normalizeTimestamp(ttlMs));
  const aggregated = aggregateUsage(usages);
  const candidates: Array<{ agentId: string; maxLastUsedAt: number }> = [];
  for (const [agentId, entry] of aggregated.entries()) {
    if (entry.hasInFlight) continue;
    if (normalizedNow - entry.maxLastUsedAt < normalizedTtl) continue;
    candidates.push({ agentId, maxLastUsedAt: entry.maxLastUsedAt });
  }
  return candidates
    .toSorted(
      (left, right) =>
        left.maxLastUsedAt - right.maxLastUsedAt || left.agentId.localeCompare(right.agentId),
    )
    .map((entry) => entry.agentId);
}

export function selectLruEvictableAgent(usages: AgentSessionUsage[]): string | null {
  const aggregated = aggregateUsage(usages);
  let bestAgentId: string | null = null;
  let bestLastUsedAt = Number.POSITIVE_INFINITY;
  for (const [agentId, entry] of aggregated.entries()) {
    if (entry.hasInFlight) continue;
    if (entry.maxLastUsedAt < bestLastUsedAt) {
      bestLastUsedAt = entry.maxLastUsedAt;
      bestAgentId = agentId;
      continue;
    }
    if (
      entry.maxLastUsedAt === bestLastUsedAt &&
      bestAgentId &&
      agentId.localeCompare(bestAgentId) < 0
    ) {
      bestAgentId = agentId;
    }
  }
  return bestAgentId;
}
