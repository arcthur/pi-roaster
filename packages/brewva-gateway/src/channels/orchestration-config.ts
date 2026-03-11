import type { BrewvaRuntime } from "@brewva/brewva-runtime";

export interface ChannelOrchestrationConfig {
  enabled: boolean;
  scopeStrategy: "chat" | "thread";
  aclModeWhenOwnersEmpty: "open" | "closed";
  owners: {
    telegram: string[];
  };
  limits: {
    fanoutMaxAgents: number;
    maxDiscussionRounds: number;
    a2aMaxDepth: number;
    a2aMaxHops: number;
    maxLiveRuntimes: number;
    idleRuntimeTtlMs: number;
  };
}

export function resolveChannelOrchestrationConfig(
  runtime: BrewvaRuntime,
): ChannelOrchestrationConfig {
  const configured = runtime.config.channels.orchestration;
  return {
    enabled: configured.enabled,
    scopeStrategy: configured.scopeStrategy,
    aclModeWhenOwnersEmpty: configured.aclModeWhenOwnersEmpty,
    owners: {
      telegram: [...configured.owners.telegram],
    },
    limits: {
      fanoutMaxAgents: configured.limits.fanoutMaxAgents,
      maxDiscussionRounds: configured.limits.maxDiscussionRounds,
      a2aMaxDepth: configured.limits.a2aMaxDepth,
      a2aMaxHops: configured.limits.a2aMaxHops,
      maxLiveRuntimes: configured.limits.maxLiveRuntimes,
      idleRuntimeTtlMs: configured.limits.idleRuntimeTtlMs,
    },
  };
}
