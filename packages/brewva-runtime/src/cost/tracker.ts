import type { BrewvaConfig, SessionCostSummary, SessionCostTotals } from "../types.js";

export interface ModelUsageInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

interface UsageContextInput {
  turn: number;
  skill?: string;
}

type CostAlert = SessionCostSummary["alerts"][number];

interface SkillCostState {
  totals: SessionCostTotals;
  usageCount: number;
  turnCount: number;
  lastTurnSeen: number;
}

interface ToolCostState {
  callCount: number;
  allocatedTokens: number;
  allocatedCostUsd: number;
}

interface SessionCostState {
  totals: SessionCostTotals;
  models: Record<string, SessionCostTotals>;
  skills: Record<string, SkillCostState>;
  tools: Record<string, ToolCostState>;
  turnToolCalls: Map<number, Map<string, number>>;
  alerts: CostAlert[];
  sessionThresholdAlerted: boolean;
  sessionCapAlerted: boolean;
  skillCapAlerted: Set<string>;
}

export interface BudgetStatus {
  action: "warn" | "block_tools";
  sessionExceeded: boolean;
  skillExceeded: boolean;
  blocked: boolean;
  reason?: string;
}

export interface RecordUsageResult {
  summary: SessionCostSummary;
  newAlerts: CostAlert[];
}

function emptyTotals(): SessionCostTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };
}

function cloneTotals(input: SessionCostTotals): SessionCostTotals {
  return {
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    totalTokens: input.totalTokens,
    totalCostUsd: input.totalCostUsd,
  };
}

function addTotals(target: SessionCostTotals, usage: ModelUsageInput): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
  target.totalTokens += usage.totalTokens;
  target.totalCostUsd += usage.costUsd;
}

function normalizeTurn(turn: number): number {
  if (!Number.isFinite(turn)) return 0;
  return Math.max(0, Math.trunc(turn));
}

export class SessionCostTracker {
  private readonly config: BrewvaConfig["infrastructure"]["costTracking"];
  private readonly sessions = new Map<string, SessionCostState>();

  constructor(config: BrewvaConfig["infrastructure"]["costTracking"]) {
    this.config = config;
  }

  recordToolCall(sessionId: string, input: { toolName: string; turn: number }): void {
    const state = this.getOrCreate(sessionId);
    const turn = normalizeTurn(input.turn);
    const toolName = input.toolName.trim() || "unknown_tool";

    const toolState = state.tools[toolName] ?? {
      callCount: 0,
      allocatedTokens: 0,
      allocatedCostUsd: 0,
    };
    toolState.callCount += 1;
    state.tools[toolName] = toolState;

    const callsForTurn = state.turnToolCalls.get(turn) ?? new Map<string, number>();
    callsForTurn.set(toolName, (callsForTurn.get(toolName) ?? 0) + 1);
    state.turnToolCalls.set(turn, callsForTurn);

    if (state.turnToolCalls.size > 64) {
      const keepAfter = Math.max(0, turn - 4);
      for (const key of state.turnToolCalls.keys()) {
        if (key < keepAfter) {
          state.turnToolCalls.delete(key);
        }
      }
    }
  }

  recordUsage(sessionId: string, usage: ModelUsageInput, context: UsageContextInput): RecordUsageResult {
    const state = this.getOrCreate(sessionId);
    const newAlerts: CostAlert[] = [];

    addTotals(state.totals, usage);
    const modelTotals = state.models[usage.model] ?? emptyTotals();
    addTotals(modelTotals, usage);
    state.models[usage.model] = modelTotals;

    const skillName = context.skill?.trim() || "(none)";
    const turn = normalizeTurn(context.turn);
    const skillState = state.skills[skillName] ?? {
      totals: emptyTotals(),
      usageCount: 0,
      turnCount: 0,
      lastTurnSeen: -1,
    };
    addTotals(skillState.totals, usage);
    skillState.usageCount += 1;
    if (turn > 0 && turn !== skillState.lastTurnSeen) {
      skillState.turnCount += 1;
      skillState.lastTurnSeen = turn;
    }
    state.skills[skillName] = skillState;

    this.allocateUsageToTools(state, turn, usage);
    this.collectAlerts(state, skillName, newAlerts);

    return {
      summary: this.buildSummary(state),
      newAlerts,
    };
  }

  getSummary(sessionId: string): SessionCostSummary {
    return this.buildSummary(this.getOrCreate(sessionId));
  }

  getSkillTotalTokens(sessionId: string, skillName: string): number {
    const state = this.getOrCreate(sessionId);
    const normalized = skillName.trim() || "(none)";
    const total = state.skills[normalized]?.totals.totalTokens ?? 0;
    return Number.isFinite(total) ? total : 0;
  }

  getBudgetStatus(sessionId: string, skillName?: string): BudgetStatus {
    const state = this.getOrCreate(sessionId);
    const maxSession = this.config.maxCostUsdPerSession;
    const maxSkill = this.config.maxCostUsdPerSkill;
    const action = this.config.actionOnExceed;
    const sessionExceeded = maxSession > 0 && state.totals.totalCostUsd >= maxSession;
    const exceededSkills = this.getExceededSkillNames(state);
    const normalizedSkill = skillName?.trim();
    const skillExceeded = normalizedSkill ? exceededSkills.includes(normalizedSkill) : exceededSkills.length > 0;
    const blocked = action === "block_tools" && (sessionExceeded || skillExceeded);

    let reason: string | undefined;
    if (blocked) {
      if (sessionExceeded && skillExceeded) {
        const skillPart =
          normalizedSkill && maxSkill > 0
            ? `skill '${normalizedSkill}' >= ${maxSkill.toFixed(4)} USD`
            : `skills [${exceededSkills.join(", ")}] >= ${maxSkill.toFixed(4)} USD`;
        reason = `Cost budget exceeded: session >= ${maxSession.toFixed(4)} USD and ${skillPart}.`;
      } else if (sessionExceeded) {
        reason = `Session cost exceeded ${maxSession.toFixed(4)} USD.`;
      } else {
        if (normalizedSkill) {
          reason = `Skill '${normalizedSkill}' cost exceeded ${maxSkill.toFixed(4)} USD.`;
        } else {
          reason = `Skill budget exceeded for [${exceededSkills.join(", ")}] at ${maxSkill.toFixed(4)} USD.`;
        }
      }
    }

    return {
      action,
      sessionExceeded,
      skillExceeded,
      blocked,
      reason,
    };
  }

  restore(sessionId: string, snapshot: SessionCostSummary | undefined): void {
    if (!snapshot) return;

    const restoredSkills: SessionCostState["skills"] = {};
    for (const [skillName, skill] of Object.entries(snapshot.skills)) {
      restoredSkills[skillName] = {
        totals: cloneTotals(skill),
        usageCount: Math.max(0, Math.trunc(skill.usageCount)),
        turnCount: Math.max(0, Math.trunc(skill.turns)),
        lastTurnSeen: -1,
      };
    }

    const threshold = this.config.maxCostUsdPerSession * this.config.alertThresholdRatio;
    const sessionThresholdAlerted =
      snapshot.alerts.some((alert) => alert.kind === "session_threshold") ||
      (threshold > 0 && snapshot.totalCostUsd >= threshold);
    const sessionCapAlerted =
      snapshot.alerts.some((alert) => alert.kind === "session_cap") ||
      (this.config.maxCostUsdPerSession > 0 && snapshot.totalCostUsd >= this.config.maxCostUsdPerSession);

    const skillCapAlerted = new Set<string>(
      snapshot.alerts
        .filter((alert) => alert.kind === "skill_cap" && typeof alert.scopeId === "string")
        .map((alert) => alert.scopeId as string),
    );
    if (this.config.maxCostUsdPerSkill > 0) {
      for (const [skillName, skill] of Object.entries(snapshot.skills)) {
        if (skill.totalCostUsd >= this.config.maxCostUsdPerSkill) {
          skillCapAlerted.add(skillName);
        }
      }
    }

    const restored: SessionCostState = {
      totals: cloneTotals(snapshot),
      models: Object.fromEntries(Object.entries(snapshot.models).map(([name, totals]) => [name, cloneTotals(totals)])),
      skills: restoredSkills,
      tools: Object.fromEntries(
        Object.entries(snapshot.tools).map(([name, tool]) => [
          name,
          {
            callCount: Math.max(0, Math.trunc(tool.callCount)),
            allocatedTokens: tool.allocatedTokens,
            allocatedCostUsd: tool.allocatedCostUsd,
          },
        ]),
      ),
      turnToolCalls: new Map<number, Map<string, number>>(),
      alerts: snapshot.alerts.map((alert) => ({ ...alert })),
      sessionThresholdAlerted,
      sessionCapAlerted,
      skillCapAlerted,
    };
    this.sessions.set(sessionId, restored);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private allocateUsageToTools(state: SessionCostState, turn: number, usage: ModelUsageInput): void {
    const callsForTurn = state.turnToolCalls.get(turn);
    const weightedTools = callsForTurn && callsForTurn.size > 0 ? callsForTurn : new Map<string, number>([["llm", 1]]);
    const totalWeight = [...weightedTools.values()].reduce((sum, value) => sum + value, 0);
    if (totalWeight <= 0) return;

    for (const [toolName, weight] of weightedTools.entries()) {
      const ratio = weight / totalWeight;
      const toolState = state.tools[toolName] ?? {
        callCount: 0,
        allocatedTokens: 0,
        allocatedCostUsd: 0,
      };
      toolState.allocatedTokens += usage.totalTokens * ratio;
      toolState.allocatedCostUsd += usage.costUsd * ratio;
      state.tools[toolName] = toolState;
    }
  }

  private collectAlerts(state: SessionCostState, skillName: string, sink: CostAlert[]): void {
    const now = Date.now();
    const maxSession = this.config.maxCostUsdPerSession;
    if (maxSession > 0) {
      const threshold = maxSession * this.config.alertThresholdRatio;
      if (!state.sessionThresholdAlerted && threshold > 0 && state.totals.totalCostUsd >= threshold) {
        const alert: CostAlert = {
          timestamp: now,
          kind: "session_threshold",
          scope: "session",
          costUsd: state.totals.totalCostUsd,
          thresholdUsd: threshold,
        };
        state.alerts.push(alert);
        sink.push(alert);
        state.sessionThresholdAlerted = true;
      }

      if (!state.sessionCapAlerted && state.totals.totalCostUsd >= maxSession) {
        const alert: CostAlert = {
          timestamp: now,
          kind: "session_cap",
          scope: "session",
          costUsd: state.totals.totalCostUsd,
          thresholdUsd: maxSession,
        };
        state.alerts.push(alert);
        sink.push(alert);
        state.sessionCapAlerted = true;
      }
    }

    const maxSkill = this.config.maxCostUsdPerSkill;
    const skillCost = state.skills[skillName]?.totals.totalCostUsd ?? 0;
    if (maxSkill > 0 && skillCost >= maxSkill && !state.skillCapAlerted.has(skillName)) {
      const alert: CostAlert = {
        timestamp: now,
        kind: "skill_cap",
        scope: "skill",
        scopeId: skillName,
        costUsd: skillCost,
        thresholdUsd: maxSkill,
      };
      state.alerts.push(alert);
      sink.push(alert);
      state.skillCapAlerted.add(skillName);
    }
  }

  private buildSummary(state: SessionCostState): SessionCostSummary {
    const budgetStatus = this.getBudgetStatusFromState(state);
    return {
      ...state.totals,
      models: Object.fromEntries(Object.entries(state.models).map(([name, totals]) => [name, { ...totals }])),
      skills: Object.fromEntries(
        Object.entries(state.skills).map(([name, skillState]) => [
          name,
          {
            ...skillState.totals,
            usageCount: skillState.usageCount,
            turns: skillState.turnCount,
          },
        ]),
      ),
      tools: Object.fromEntries(
        Object.entries(state.tools).map(([name, tool]) => [
          name,
          {
            callCount: tool.callCount,
            allocatedTokens: Number(tool.allocatedTokens.toFixed(3)),
            allocatedCostUsd: Number(tool.allocatedCostUsd.toFixed(6)),
          },
        ]),
      ),
      alerts: [...state.alerts],
      budget: budgetStatus,
    };
  }

  private getBudgetStatusFromState(state: SessionCostState): SessionCostSummary["budget"] {
    const sessionExceeded = this.config.maxCostUsdPerSession > 0 && state.totals.totalCostUsd >= this.config.maxCostUsdPerSession;
    const skillExceeded = this.getExceededSkillNames(state).length > 0;
    const blocked = this.config.actionOnExceed === "block_tools" && (sessionExceeded || skillExceeded);
    return {
      action: this.config.actionOnExceed,
      sessionExceeded,
      skillExceeded,
      blocked,
    };
  }

  private getExceededSkillNames(state: SessionCostState): string[] {
    if (this.config.maxCostUsdPerSkill <= 0) {
      return [];
    }
    return Object.entries(state.skills)
      .filter(([, skill]) => skill.totals.totalCostUsd >= this.config.maxCostUsdPerSkill)
      .map(([name]) => name);
  }

  private getOrCreate(sessionId: string): SessionCostState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const created: SessionCostState = {
      totals: emptyTotals(),
      models: {},
      skills: {},
      tools: {},
      turnToolCalls: new Map<number, Map<string, number>>(),
      alerts: [],
      sessionThresholdAlerted: false,
      sessionCapAlerted: false,
      skillCapAlerted: new Set<string>(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }
}
