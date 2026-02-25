export interface CoordinatorDispatchInput {
  agentId: string;
  task: string;
  reason: "run" | "discuss" | "a2a";
  scopeKey?: string;
  correlationId?: string;
  fromAgentId?: string;
  fromSessionId?: string;
  depth?: number;
  hops?: number;
}

export interface CoordinatorDispatchResult {
  ok: boolean;
  agentId: string;
  responseText: string;
  error?: string;
}

export interface CoordinatorFanOutInput {
  agentIds: string[];
  task: string;
  scopeKey?: string;
}

export interface CoordinatorDiscussInput {
  agentIds: string[];
  topic: string;
  scopeKey?: string;
  maxRounds?: number;
}

export interface CoordinatorA2ASendInput {
  fromSessionId: string;
  fromAgentId?: string;
  toAgentId: string;
  message: string;
  correlationId?: string;
  depth?: number;
  hops?: number;
}

export interface CoordinatorA2ABroadcastInput {
  fromSessionId: string;
  fromAgentId?: string;
  toAgentIds: string[];
  message: string;
  correlationId?: string;
  depth?: number;
  hops?: number;
}

export interface CoordinatorLimits {
  fanoutMaxAgents: number;
  maxDiscussionRounds: number;
  a2aMaxDepth: number;
  a2aMaxHops: number;
}

export interface CoordinatorDependencies {
  limits: CoordinatorLimits;
  dispatch(input: CoordinatorDispatchInput): Promise<CoordinatorDispatchResult>;
  isAgentActive(agentId: string): boolean;
  listAgents(input?: { includeDeleted?: boolean }): Array<{
    agentId: string;
    status: "active" | "deleted";
  }>;
  resolveAgentBySessionId?(sessionId: string): string | undefined;
  forbidSelfA2A?: boolean;
}

export interface CoordinatorFanOutResult {
  ok: boolean;
  results: CoordinatorDispatchResult[];
  error?: string;
}

export interface CoordinatorDiscussionRound {
  round: number;
  agentId: string;
  responseText: string;
}

export interface CoordinatorDiscussResult {
  ok: boolean;
  rounds: CoordinatorDiscussionRound[];
  stoppedEarly: boolean;
  reason?: string;
}

export class ChannelCoordinator {
  private readonly deps: CoordinatorDependencies;

  constructor(deps: CoordinatorDependencies) {
    this.deps = deps;
  }

  async fanOut(input: CoordinatorFanOutInput): Promise<CoordinatorFanOutResult> {
    const uniqueAgentIds = Array.from(new Set(input.agentIds));
    if (uniqueAgentIds.length === 0) {
      return { ok: false, results: [], error: "no_targets" };
    }
    if (uniqueAgentIds.length > this.deps.limits.fanoutMaxAgents) {
      return {
        ok: false,
        results: [],
        error: `fanout_limit_exceeded:${this.deps.limits.fanoutMaxAgents}`,
      };
    }

    const results = await Promise.all(
      uniqueAgentIds.map(async (agentId) => {
        if (!this.deps.isAgentActive(agentId)) {
          return {
            ok: false,
            agentId,
            responseText: "",
            error: "agent_not_active",
          } satisfies CoordinatorDispatchResult;
        }
        return this.deps.dispatch({
          agentId,
          task: input.task,
          reason: "run",
          scopeKey: input.scopeKey,
        });
      }),
    );

    return {
      ok: results.every((entry) => entry.ok),
      results,
    };
  }

  async discuss(input: CoordinatorDiscussInput): Promise<CoordinatorDiscussResult> {
    const uniqueAgentIds = Array.from(new Set(input.agentIds));
    if (uniqueAgentIds.length < 2) {
      return {
        ok: false,
        rounds: [],
        stoppedEarly: true,
        reason: "requires_two_or_more_agents",
      };
    }
    const maxRounds = Math.max(
      1,
      Math.min(
        input.maxRounds ?? this.deps.limits.maxDiscussionRounds,
        this.deps.limits.maxDiscussionRounds,
      ),
    );

    const rounds: CoordinatorDiscussionRound[] = [];
    let context = input.topic;
    let stoppedEarly = false;

    for (let round = 1; round <= maxRounds; round += 1) {
      for (const agentId of uniqueAgentIds) {
        if (!this.deps.isAgentActive(agentId)) {
          rounds.push({
            round,
            agentId,
            responseText: "[REPLY_SKIP] agent_not_active",
          });
          continue;
        }
        const prompt = [
          `Discussion topic: ${input.topic}`,
          `Round: ${round}/${maxRounds}`,
          "Current context:",
          context,
          "If you are done, respond with [DONE] or REPLY_SKIP.",
        ].join("\n");

        const result = await this.deps.dispatch({
          agentId,
          task: prompt,
          reason: "discuss",
          scopeKey: input.scopeKey,
        });
        const responseText = result.ok
          ? result.responseText.trim()
          : `[REPLY_SKIP] ${result.error}`;
        rounds.push({
          round,
          agentId,
          responseText,
        });

        if (isDiscussionStopSignal(responseText)) {
          stoppedEarly = true;
          break;
        }
        if (responseText.length > 0) {
          context = `${context}\n${agentId}: ${responseText}`;
        }
      }
      if (stoppedEarly) break;
    }

    return {
      ok: true,
      rounds,
      stoppedEarly,
    };
  }

  async a2aSend(input: CoordinatorA2ASendInput): Promise<{
    ok: boolean;
    toAgentId: string;
    responseText?: string;
    error?: string;
    depth?: number;
    hops?: number;
  }> {
    const fromAgentId =
      input.fromAgentId ?? this.deps.resolveAgentBySessionId?.(input.fromSessionId);
    const depth = Math.max(0, Math.floor(input.depth ?? 0));
    const hops = Math.max(0, Math.floor(input.hops ?? 0));
    const nextDepth = depth + 1;
    const nextHops = hops + 1;

    if (nextDepth > this.deps.limits.a2aMaxDepth) {
      return {
        ok: false,
        toAgentId: input.toAgentId,
        error: "a2a_depth_limit_exceeded",
        depth: nextDepth,
        hops: nextHops,
      };
    }
    if (nextHops > this.deps.limits.a2aMaxHops) {
      return {
        ok: false,
        toAgentId: input.toAgentId,
        error: "a2a_hops_limit_exceeded",
        depth: nextDepth,
        hops: nextHops,
      };
    }
    if (this.deps.forbidSelfA2A !== false && fromAgentId && fromAgentId === input.toAgentId) {
      return {
        ok: false,
        toAgentId: input.toAgentId,
        error: "a2a_self_target_blocked",
        depth: nextDepth,
        hops: nextHops,
      };
    }
    if (!this.deps.isAgentActive(input.toAgentId)) {
      return {
        ok: false,
        toAgentId: input.toAgentId,
        error: "agent_not_active",
        depth: nextDepth,
        hops: nextHops,
      };
    }

    const dispatch = await this.deps.dispatch({
      agentId: input.toAgentId,
      task: input.message,
      reason: "a2a",
      scopeKey: undefined,
      correlationId: input.correlationId,
      fromAgentId,
      fromSessionId: input.fromSessionId,
      depth: nextDepth,
      hops: nextHops,
    });
    return {
      ok: dispatch.ok,
      toAgentId: input.toAgentId,
      responseText: dispatch.responseText,
      error: dispatch.error,
      depth: nextDepth,
      hops: nextHops,
    };
  }

  async a2aBroadcast(input: CoordinatorA2ABroadcastInput): Promise<{
    ok: boolean;
    error?: string;
    results: Array<{
      toAgentId: string;
      ok: boolean;
      responseText?: string;
      error?: string;
      depth?: number;
      hops?: number;
    }>;
  }> {
    const targetIds = Array.from(new Set(input.toAgentIds));
    if (targetIds.length > this.deps.limits.fanoutMaxAgents) {
      return {
        ok: false,
        error: `fanout_limit_exceeded:${this.deps.limits.fanoutMaxAgents}`,
        results: [],
      };
    }
    const results = await Promise.all(
      targetIds.map((toAgentId) =>
        this.a2aSend({
          ...input,
          toAgentId,
        }),
      ),
    );
    return {
      ok: results.every((entry) => entry.ok),
      results,
    };
  }

  listAgents(input?: {
    includeDeleted?: boolean;
  }): Array<{ agentId: string; status: "active" | "deleted" }> {
    return this.deps.listAgents(input);
  }
}

function isDiscussionStopSignal(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  const upper = normalized.toUpperCase();
  return upper.includes("[DONE]") || upper.includes("REPLY_SKIP");
}
