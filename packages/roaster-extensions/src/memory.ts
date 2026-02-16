import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type ContextBudgetUsage,
  type EvidenceLedgerRow,
  type RoasterRuntime,
} from "@pi-roaster/roaster-runtime";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
  buildFallbackHandoff,
  buildHandoffFromDigest,
  buildHandoffFromRows,
  readRecentRows,
} from "./memory/handoff-builder.js";
import {
  buildHierarchyInjectionBlocks,
  buildNextHierarchy,
  capBlocksByTotalChars,
} from "./memory/hierarchy.js";
import { collectFilePaths } from "./memory/relevance.js";
import { stripLeadingHeader, truncateText } from "./memory/text.js";

const MEMORY_INJECTION_MESSAGE_TYPE = "roaster-memory-injection";
const APPROX_CHARS_PER_TOKEN = 3.5;

function truncateTextToApproxTokenBudget(input: string, maxTokens: number): string {
  const budget = Math.max(1, Math.floor(maxTokens));
  const maxChars = Math.max(1, Math.floor(budget * APPROX_CHARS_PER_TOKEN));
  return truncateText(input, maxChars);
}

interface SessionMemory {
  sessionId: string;
  updatedAt: number;
  lastDigest: string;
  lastHandoff?: string;
}

interface UserMemory {
  updatedAt: number;
  preferences?: string;
  lastDigest?: string;
  lastHandoff?: string;
  handoffHierarchy?: {
    levels: string[][];
  };
}

type SessionHandoffConfig = RoasterRuntime["config"]["infrastructure"]["interruptRecovery"]["sessionHandoff"];

interface HandoffCircuitState {
  turnIndex: number;
  consecutiveFailures: number;
  openUntilTurn: number | null;
}

function memoryDir(cwd: string): string {
  return resolve(cwd, ".orchestrator/memory");
}

function memoryPath(cwd: string, sessionId: string): string {
  return join(memoryDir(cwd), `${sessionId}.json`);
}

function userMemoryDir(): string {
  return resolve(dirname(getAgentDir()), "memory");
}

function userMemoryPath(): string {
  return join(userMemoryDir(), "user-preferences.json");
}

function loadMemory(cwd: string, sessionId: string): SessionMemory | null {
  const path = memoryPath(cwd, sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionMemory;
  } catch {
    return null;
  }
}

function loadUserMemory(): UserMemory | null {
  const path = userMemoryPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UserMemory;
  } catch {
    return null;
  }
}

function saveMemory(cwd: string, value: SessionMemory): void {
  const dir = memoryDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = memoryPath(cwd, value.sessionId);
  const tempPath = `${path}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(tempPath, path);
}

function saveUserMemory(value: UserMemory): void {
  const dir = userMemoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = userMemoryPath();
  const tempPath = `${path}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(tempPath, path);
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function buildScopeKey(sessionId: string, leafId: string | null | undefined): string {
  const normalizedLeaf = typeof leafId === "string" ? leafId.trim() : "";
  return `${sessionId}::${normalizedLeaf.length > 0 ? normalizedLeaf : "root"}`;
}

function clearSessionFingerprints(store: Map<string, string>, sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}

function toBudgetUsage(input: unknown): ContextBudgetUsage | undefined {
  const usage = input as { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) {
    return undefined;
  }
  return {
    tokens: typeof usage.tokens === "number" ? usage.tokens : null,
    contextWindow: usage.contextWindow,
    percent: typeof usage.percent === "number" ? usage.percent : null,
  };
}

function resolveHandoffConfig(runtime: RoasterRuntime): SessionHandoffConfig {
  return runtime.config.infrastructure.interruptRecovery.sessionHandoff;
}

function getOrCreateHandoffState(store: Map<string, HandoffCircuitState>, sessionId: string): HandoffCircuitState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created: HandoffCircuitState = {
    turnIndex: 0,
    consecutiveFailures: 0,
    openUntilTurn: null,
  };
  store.set(sessionId, created);
  return created;
}

function isCircuitOpen(state: HandoffCircuitState): boolean {
  return state.openUntilTurn !== null && state.turnIndex <= state.openUntilTurn;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return "unknown_error";
}

function pickMostRecentVerifierFailure(
  runtime: RoasterRuntime,
  sessionId: string,
): { check: string; command: string; exitCode: number | null; outputSummary: string; ledgerId?: string; timestamp: number } | null {
  const stateStore = runtime.verification?.stateStore;
  if (!stateStore || typeof stateStore.get !== "function") return null;
  const state = stateStore.get(sessionId);
  const checkRuns = state?.checkRuns;
  if (!checkRuns) return null;

  const lastWriteAt = typeof state?.lastWriteAt === "number" ? state.lastWriteAt : 0;
  const failures = Object.entries(checkRuns)
    .filter(([, run]) => run && run.ok === false)
    .filter(([, run]) => !lastWriteAt || run.timestamp >= lastWriteAt)
    .sort((left, right) => (right[1]?.timestamp ?? 0) - (left[1]?.timestamp ?? 0));
  const entry = failures[0];
  if (!entry) return null;

  const [check, run] = entry;
  return {
    check,
    command: run.command,
    exitCode: run.exitCode ?? null,
    outputSummary: typeof run.outputSummary === "string" && run.outputSummary.length > 0 ? run.outputSummary : "(no output)",
    ledgerId: typeof run.ledgerId === "string" && run.ledgerId.length > 0 ? run.ledgerId : undefined,
    timestamp: run.timestamp,
  };
}

function extractLastReferencedFiles(rows: EvidenceLedgerRow[], limit = 5): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();

  for (const row of [...rows].sort((a, b) => b.timestamp - a.timestamp)) {
    const combined = `${row.tool}\n${row.argsSummary}\n${row.outputSummary}`;
    const paths = collectFilePaths(combined);
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      selected.push(path);
      if (selected.length >= limit) return selected;
    }
  }

  return selected;
}

function buildHandoffHardMetricsBlock(input: {
  runtime: RoasterRuntime;
  sessionId: string;
  goal?: string;
  rows: EvidenceLedgerRow[];
  maxChars: number;
}): string {
  const lines: string[] = ["[HandoffHardMetrics]"];

  const taskGoal =
    typeof input.runtime.getTaskState === "function"
      ? input.runtime.getTaskState(input.sessionId).spec?.goal
      : undefined;
  if (typeof taskGoal === "string" && taskGoal.trim().length > 0) {
    lines.push(`taskGoal=${taskGoal.trim()}`);
  } else if (typeof input.goal === "string" && input.goal.trim().length > 0) {
    lines.push(`taskGoal=${input.goal.trim()}`);
  }

  const failure = pickMostRecentVerifierFailure(input.runtime, input.sessionId);
  if (failure) {
    lines.push("verifierFailure:");
    lines.push(`- check=${failure.check}`);
    if (failure.ledgerId) {
      lines.push(`- ledgerId=${failure.ledgerId}`);
    }
    lines.push(`- exitCode=${failure.exitCode ?? "null"}`);
    lines.push(`- command=${failure.command}`);
    lines.push(`- timestamp=${new Date(failure.timestamp).toISOString()}`);
    lines.push("- output:");
    for (const line of failure.outputSummary.split(/\r?\n/).slice(0, 20)) {
      lines.push(`  ${line}`);
    }
  } else {
    lines.push("verifierFailure:");
    lines.push("- (none)");
  }

  const referenced = extractLastReferencedFiles(input.rows, 5);
  lines.push("lastReferencedFiles:");
  if (referenced.length === 0) {
    lines.push("- (none)");
  } else {
    for (const path of referenced) {
      lines.push(`- ${path}`);
    }
  }

  return truncateText(lines.join("\n"), input.maxChars);
}

function applyMemoryInjectionTotalBudget(blocks: string[], maxTotalChars: number): string[] {
  if (blocks.length === 0) return [];
  const selected: string[] = [];
  let remaining = maxTotalChars;
  for (const block of blocks) {
    const cost = block.length + (selected.length > 0 ? 2 : 0);
    if (cost > remaining) {
      continue;
    }
    selected.push(block);
    remaining -= cost;
  }
  return selected;
}

function emitRuntimeEvent(
  runtime: RoasterRuntime,
  input: {
    sessionId: string;
    turn?: number;
    type: string;
    payload: Record<string, unknown>;
  },
): void {
  runtime.recordEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    type: input.type,
    payload: input.payload,
  });
}

function markHandoffFailure(
  runtime: RoasterRuntime,
  sessionId: string,
  state: HandoffCircuitState,
  config: SessionHandoffConfig,
  reason: string,
  details?: Record<string, unknown>,
): void {
  if (!config.circuitBreaker.enabled) return;

  state.consecutiveFailures += 1;
  if (state.consecutiveFailures < config.circuitBreaker.maxConsecutiveFailures) {
    return;
  }

  state.openUntilTurn = state.turnIndex + config.circuitBreaker.cooldownTurns - 1;
  state.consecutiveFailures = 0;

  emitRuntimeEvent(runtime, {
    sessionId,
    turn: state.turnIndex,
    type: "session_handoff_breaker_opened",
    payload: {
      reason,
      openUntilTurn: state.openUntilTurn,
      cooldownTurns: config.circuitBreaker.cooldownTurns,
      ...details,
    },
  });
}

export function registerMemory(pi: ExtensionAPI, runtime: RoasterRuntime): void {
  const lastInjectionFingerprintBySession = new Map<string, string>();
  const handoffStateBySession = new Map<string, HandoffCircuitState>();
  const latestGoalBySession = new Map<string, string>();
  const handoffConfig = resolveHandoffConfig(runtime);

  pi.on("turn_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateHandoffState(handoffStateBySession, sessionId);
    state.turnIndex = Math.max(state.turnIndex, event.turnIndex);
    if (state.openUntilTurn !== null && state.turnIndex > state.openUntilTurn) {
      state.openUntilTurn = null;
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "session_handoff_breaker_closed",
        payload: {
          reason: "cooldown_elapsed",
        },
      });
    }
    return undefined;
  });

  pi.on("session_compact", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    clearSessionFingerprints(lastInjectionFingerprintBySession, sessionId);
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    clearSessionFingerprints(lastInjectionFingerprintBySession, sessionId);
    handoffStateBySession.delete(sessionId);
    latestGoalBySession.delete(sessionId);
    return undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
    if (prompt.length > 0) {
      latestGoalBySession.set(sessionId, prompt);
    }
    const leafId = ctx.sessionManager.getLeafId?.();
    const injectionScopeId = typeof leafId === "string" ? leafId : undefined;
    const scopeKey = buildScopeKey(sessionId, injectionScopeId);
    const usage = toBudgetUsage(ctx.getContextUsage?.());
    const sessionMemory = loadMemory(ctx.cwd, sessionId);
    const userMemory = loadUserMemory();

    const preferences = userMemory?.preferences?.trim();
    const userHandoff = userMemory?.lastHandoff?.trim();
    const userDigest = userMemory?.lastDigest?.trim();
    const sessionHandoff = sessionMemory?.lastHandoff?.trim();
    const sessionDigest = sessionMemory?.lastDigest?.trim();
    const hierarchyBlocks = buildHierarchyInjectionBlocks({
      hierarchy: userMemory?.handoffHierarchy,
      config: handoffConfig.hierarchy,
      goal: prompt,
    });

    const budgetEnabled = handoffConfig.injectionBudget.enabled;
    const candidateBlocks: string[] = [];
    if (budgetEnabled) {
      if (preferences) {
        candidateBlocks.push(
          truncateText(
            `[UserPreferences]\n${preferences}`,
            handoffConfig.injectionBudget.maxUserPreferencesChars,
          ),
        );
      }

      if (sessionHandoff) {
        candidateBlocks.push(
          truncateText(sessionHandoff, handoffConfig.injectionBudget.maxSessionHandoffChars),
        );
      }

      const cappedHierarchyBlocks = capBlocksByTotalChars(
        hierarchyBlocks,
        handoffConfig.injectionBudget.maxHierarchyChars,
      );
      if (cappedHierarchyBlocks.length > 0) {
        candidateBlocks.push(...cappedHierarchyBlocks);
      }

      if (userHandoff) {
        candidateBlocks.push(
          truncateText(
            `[UserMemoryHandoff]\n${stripLeadingHeader(userHandoff, "[SessionHandoff]")}`,
            handoffConfig.injectionBudget.maxUserHandoffChars,
          ),
        );
      }

      if (sessionDigest) {
        candidateBlocks.push(
          truncateText(
            `[SessionMemory]\n${sessionDigest}`,
            handoffConfig.injectionBudget.maxSessionDigestChars,
          ),
        );
      }

      if (userDigest) {
        candidateBlocks.push(
          truncateText(
            `[UserMemoryDigest]\n${userDigest}`,
            handoffConfig.injectionBudget.maxUserDigestChars,
          ),
        );
      }
    } else {
      if (preferences) {
        candidateBlocks.push(`[UserPreferences]\n${preferences}`);
      }
      if (sessionHandoff) {
        candidateBlocks.push(sessionHandoff);
      }
      if (hierarchyBlocks.length > 0) {
        candidateBlocks.push(...hierarchyBlocks);
      }
      if (userHandoff) {
        candidateBlocks.push(`[UserMemoryHandoff]\n${stripLeadingHeader(userHandoff, "[SessionHandoff]")}`);
      }
      if (sessionDigest) {
        candidateBlocks.push(`[SessionMemory]\n${sessionDigest}`);
      }
      if (userDigest) {
        candidateBlocks.push(`[UserMemoryDigest]\n${userDigest}`);
      }
    }

    const blocks = budgetEnabled
      ? applyMemoryInjectionTotalBudget(candidateBlocks, handoffConfig.injectionBudget.maxTotalChars)
      : candidateBlocks;

    if (blocks.length === 0) {
      clearSessionFingerprints(lastInjectionFingerprintBySession, sessionId);
      return undefined;
    }

    const requestedContent = blocks.join("\n\n");
    const hasViewportTargets =
      typeof runtime.getTaskState === "function"
        ? Boolean(runtime.getTaskState(sessionId).spec?.targets?.files?.length)
        : false;

    const hasRecentFiles =
      typeof runtime.fileChanges?.recentFiles === "function"
        ? runtime.fileChanges.recentFiles(sessionId, 1).length > 0
        : false;
    const viewportLikelyActive = hasViewportTargets || hasRecentFiles;
    const maxInjectionTokens = runtime.config.infrastructure.contextBudget.maxInjectionTokens;
    const shouldClampExperience =
      runtime.config.infrastructure.contextBudget.enabled && viewportLikelyActive && maxInjectionTokens > 0;
    const maxExperienceTokens = Math.max(64, Math.floor(maxInjectionTokens * 0.1));
    const experienceClampedContent = shouldClampExperience
      ? truncateTextToApproxTokenBudget(requestedContent, maxExperienceTokens)
      : requestedContent;
    const planned = runtime.planSupplementalContextInjection(
      sessionId,
      experienceClampedContent,
      usage,
      injectionScopeId,
    );
    if (!planned.accepted) {
      return undefined;
    }

    const content = planned.text;
    const currentFingerprint = fingerprint(content);
    if (lastInjectionFingerprintBySession.get(scopeKey) === currentFingerprint) {
      return undefined;
    }
    runtime.commitSupplementalContextInjection(sessionId, planned.finalTokens, injectionScopeId);
    lastInjectionFingerprintBySession.set(scopeKey, currentFingerprint);

    return {
      message: {
        customType: MEMORY_INJECTION_MESSAGE_TYPE,
        content,
        display: false,
        details: {
          blocks: blocks.length,
          originalTokens: planned.originalTokens,
          finalTokens: planned.finalTokens,
          truncated: planned.truncated,
        },
      },
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateHandoffState(handoffStateBySession, sessionId);
    const sessionMemory = loadMemory(ctx.cwd, sessionId);
    const userMemory = loadUserMemory();
    const goal = latestGoalBySession.get(sessionId);
    const rowsForProof = readRecentRows(runtime, sessionId);

    let digest = "";
    let digestFallbackUsed = false;
    try {
      digest = runtime.getLedgerDigest(sessionId);
    } catch (error) {
      digestFallbackUsed = true;
      digest = sessionMemory?.lastDigest?.trim() ?? userMemory?.lastDigest?.trim() ?? "[EvidenceDigest unavailable]";
      markHandoffFailure(runtime, sessionId, state, handoffConfig, "digest_unavailable", {
        error: normalizeErrorMessage(error),
      });
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "session_handoff_fallback",
        payload: {
          reason: "digest_unavailable",
          fallbackSource: sessionMemory?.lastDigest?.trim() ? "session_digest" : userMemory?.lastDigest?.trim() ? "user_digest" : "placeholder",
          error: normalizeErrorMessage(error),
        },
      });
    }

    let handoffText = "";
    if (!handoffConfig.enabled) {
      const fallback = buildFallbackHandoff({
        digest,
        previousSessionHandoff: sessionMemory?.lastHandoff,
        previousUserHandoff: userMemory?.lastHandoff,
        reason: "handoff_disabled",
        maxSummaryChars: handoffConfig.maxSummaryChars,
      });
      handoffText = fallback.handoff;
    } else if (isCircuitOpen(state)) {
      const fallback = buildFallbackHandoff({
        digest,
        previousSessionHandoff: sessionMemory?.lastHandoff,
        previousUserHandoff: userMemory?.lastHandoff,
        reason: "circuit_open",
        maxSummaryChars: handoffConfig.maxSummaryChars,
      });
      handoffText = fallback.handoff;
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "session_handoff_skipped",
        payload: {
          reason: "circuit_open",
          openUntilTurn: state.openUntilTurn,
          fallbackSource: fallback.source,
        },
      });
    } else {
      try {
        const rows = rowsForProof;
        handoffText =
          rows.length > 0
            ? buildHandoffFromRows({
                rows,
                digest,
                goal,
                relevance: handoffConfig.relevance,
                maxSummaryChars: handoffConfig.maxSummaryChars,
              })
            : buildHandoffFromDigest(digest, handoffConfig.maxSummaryChars);
        state.consecutiveFailures = 0;
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "session_handoff_generated",
          payload: {
            digestFallbackUsed,
            chars: handoffText.length,
            source: rows.length > 0 ? "ledger_rows" : "digest",
            rowCount: rows.length,
            goalChars: goal?.length ?? 0,
            relevanceEnabled: handoffConfig.relevance.enabled,
          },
        });
      } catch (error) {
        const fallback = buildFallbackHandoff({
          digest,
          previousSessionHandoff: sessionMemory?.lastHandoff,
          previousUserHandoff: userMemory?.lastHandoff,
          reason: "handoff_parse_failed",
          maxSummaryChars: handoffConfig.maxSummaryChars,
        });
        handoffText = fallback.handoff;
        markHandoffFailure(runtime, sessionId, state, handoffConfig, "handoff_parse_failed", {
          error: normalizeErrorMessage(error),
        });
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "session_handoff_fallback",
          payload: {
            reason: "handoff_parse_failed",
            fallbackSource: fallback.source,
            error: normalizeErrorMessage(error),
          },
        });
      }
    }

    try {
      const hardMetrics = buildHandoffHardMetricsBlock({
        runtime,
        sessionId,
        goal,
        rows: rowsForProof,
        maxChars: Math.max(120, Math.floor(handoffConfig.maxSummaryChars * 0.45)),
      });
      const combined = [
        "[SessionHandoff]",
        stripLeadingHeader(hardMetrics, "[SessionHandoff]"),
        stripLeadingHeader(handoffText, "[SessionHandoff]"),
      ]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n\n");
      handoffText = truncateText(combined, handoffConfig.maxSummaryChars);
    } catch (error) {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "session_handoff_hard_metrics_failed",
        payload: {
          error: normalizeErrorMessage(error),
        },
      });
      handoffText = truncateText(handoffText, handoffConfig.maxSummaryChars);
    }

    try {
      saveMemory(ctx.cwd, {
        sessionId,
        updatedAt: Date.now(),
        lastDigest: digest,
        lastHandoff: handoffText,
      });
    } catch (error) {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "session_handoff_save_failed",
        payload: {
          scope: "session",
          error: normalizeErrorMessage(error),
        },
      });
    }

    try {
      saveUserMemory({
        updatedAt: Date.now(),
        preferences: userMemory?.preferences,
        lastDigest: digest,
        lastHandoff: handoffText,
        handoffHierarchy: handoffConfig.hierarchy.enabled
          ? buildNextHierarchy({
              current: userMemory?.handoffHierarchy,
              handoffText,
              config: handoffConfig.hierarchy,
            })
          : userMemory?.handoffHierarchy,
      });
    } catch (error) {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "session_handoff_save_failed",
        payload: {
          scope: "user",
          error: normalizeErrorMessage(error),
        },
      });
    }
  });
}
