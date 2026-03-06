import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractToolResultText } from "./tool-output-display.js";

const RAW_SCAN_TOOL_NAMES = new Set(["read", "grep"]);
const LOW_SIGNAL_TOOL_NAMES = new Set([
  "look_at",
  "ast_grep_search",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "lsp_diagnostics",
  "lsp_prepare_rename",
]);
const EVIDENCE_REUSE_TOOL_NAMES = new Set([
  "ledger_query",
  "output_search",
  "tape_info",
  "tape_search",
  "task_view_state",
  "cost_view",
]);
const EXPLICIT_PROGRESS_TOOL_NAMES = new Set([
  "task_set_spec",
  "task_add_item",
  "task_update_item",
  "task_record_blocker",
  "task_resolve_blocker",
  "skill_load",
  "skill_route_override",
  "skill_complete",
  "skill_chain_control",
  "tape_handoff",
  "session_compact",
  "rollback_last_patch",
  "schedule_intent",
  "ast_grep_replace",
  "lsp_rename",
]);
const LOW_SIGNAL_EXEC_PRIMARY_TOKENS = new Set([
  "ls",
  "find",
  "cat",
  "sed",
  "head",
  "tail",
  "wc",
  "tree",
  "rg",
  "grep",
  "awk",
  "cut",
  "sort",
  "uniq",
  "basename",
  "dirname",
  "realpath",
  "readlink",
]);
const COMMAND_PREFIX_TOKENS = new Set(["sudo", "command", "time"]);
const SHELL_WRAPPER_TOKENS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);
const ENV_ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=.*/u;
const MAX_COMMAND_PARSE_DEPTH = 2;

const CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD = 3;
const CONSECUTIVE_INVESTIGATION_ONLY_TURNS_THRESHOLD = 6;
const CONSECUTIVE_SCAN_FAILURES_THRESHOLD = 3;

const SCAN_CONVERGENCE_ARMED_EVENT_TYPE = "scan_convergence_armed";
const SCAN_CONVERGENCE_BLOCKED_EVENT_TYPE = "scan_convergence_blocked_tool";
const SCAN_CONVERGENCE_RESET_EVENT_TYPE = "scan_convergence_reset";

const GUARD_BLOCKER_ID = "guard:scan-convergence";
const GUARD_BLOCKER_SOURCE = "scan_convergence_guard";

type ScanConvergenceReason = "scan_only_turns" | "investigation_only_turns" | "scan_failures";
type ScanConvergenceResetReason = "strategy_shift" | "input_reset";
type ToolStrategyClass = "raw_scan" | "low_signal" | "evidence_reuse" | "progress";

interface ScanConvergenceState {
  currentTurnRawScanToolCalls: number;
  currentTurnLowSignalToolCalls: number;
  currentTurnConvergenceToolCalls: number;
  consecutiveScanOnlyTurns: number;
  consecutiveInvestigationOnlyTurns: number;
  consecutiveScanFailures: number;
  armedReason: ScanConvergenceReason | null;
  executedToolCalls: Set<string>;
  completedConvergenceToolCalls: Set<string>;
  classifiedScanFailureToolCalls: Set<string>;
  toolStrategyByCallId: Map<string, ToolStrategyClass>;
}

function getState(
  statesBySession: Map<string, ScanConvergenceState>,
  sessionId: string,
): ScanConvergenceState {
  const existing = statesBySession.get(sessionId);
  if (existing) return existing;

  const created: ScanConvergenceState = {
    currentTurnRawScanToolCalls: 0,
    currentTurnLowSignalToolCalls: 0,
    currentTurnConvergenceToolCalls: 0,
    consecutiveScanOnlyTurns: 0,
    consecutiveInvestigationOnlyTurns: 0,
    consecutiveScanFailures: 0,
    armedReason: null,
    executedToolCalls: new Set<string>(),
    completedConvergenceToolCalls: new Set<string>(),
    classifiedScanFailureToolCalls: new Set<string>(),
    toolStrategyByCallId: new Map<string, ToolStrategyClass>(),
  };
  statesBySession.set(sessionId, created);
  return created;
}

function normalizeToolName(toolName: unknown): string {
  return typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
}

function isRawScanTool(toolName: unknown): boolean {
  return RAW_SCAN_TOOL_NAMES.has(normalizeToolName(toolName));
}

function normalizeCommandToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "";
  const withoutQuotes = trimmed.replace(/^["']+|["']+$/gu, "");
  const normalized = withoutQuotes.toLowerCase();
  return normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

interface PrimaryCommandDescriptor {
  token: string;
  tokenIndex: number;
  tokens: string[];
}

function resolvePrimaryCommandDescriptor(command: string): PrimaryCommandDescriptor | undefined {
  const tokens = tokenizeCommand(command);
  let envMode = false;

  for (const [tokenIndex, token] of tokens.entries()) {
    const normalizedToken = normalizeCommandToken(token);
    if (!normalizedToken) continue;
    if (ENV_ASSIGNMENT_TOKEN.test(token)) continue;

    if (normalizedToken === "env") {
      envMode = true;
      continue;
    }
    if (envMode && token.startsWith("-")) continue;
    if (COMMAND_PREFIX_TOKENS.has(normalizedToken)) continue;

    return {
      token: normalizedToken,
      tokenIndex,
      tokens,
    };
  }

  return undefined;
}

function resolveShellInlineScript(descriptor: PrimaryCommandDescriptor): string | undefined {
  if (!SHELL_WRAPPER_TOKENS.has(descriptor.token)) {
    return undefined;
  }

  for (let index = descriptor.tokenIndex + 1; index < descriptor.tokens.length; index += 1) {
    const token = descriptor.tokens[index]!;
    if (token === "--") return undefined;

    if (token.startsWith("--")) {
      if (token === "--command") {
        return descriptor.tokens[index + 1];
      }
      if (token.startsWith("--command=")) {
        const inlineScript = token.slice("--command=".length);
        return inlineScript.length > 0 ? inlineScript : undefined;
      }
      continue;
    }

    if (!token.startsWith("-")) {
      return undefined;
    }

    const normalizedFlags = token.replace(/^-+/u, "");
    if (!normalizedFlags) continue;

    const commandIndex = normalizedFlags.indexOf("c");
    if (commandIndex === -1) continue;

    const inlineScript = normalizedFlags.slice(commandIndex + 1);
    if (inlineScript.length > 0) return inlineScript;
    return descriptor.tokens[index + 1];
  }

  return undefined;
}

function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const pushCurrent = () => {
    const normalized = current.trim();
    if (normalized.length > 0) {
      segments.push(normalized);
    }
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ";" || char === "\n") {
      pushCurrent();
      continue;
    }

    if (char === "&" && command[index + 1] === "&") {
      pushCurrent();
      index += 1;
      continue;
    }

    if (char === "|") {
      pushCurrent();
      if (command[index + 1] === "|") {
        index += 1;
      }
      continue;
    }

    current += char;
  }

  pushCurrent();
  return segments;
}

function collectPrimaryCommandTokens(command: string, depth = 0): string[] {
  if (depth > MAX_COMMAND_PARSE_DEPTH) {
    return [];
  }

  const tokens = new Set<string>();
  for (const segment of splitShellCommandSegments(command)) {
    const descriptor = resolvePrimaryCommandDescriptor(segment);
    if (!descriptor) continue;

    const inlineScript = resolveShellInlineScript(descriptor);
    if (!inlineScript) {
      tokens.add(descriptor.token);
      continue;
    }

    const nestedTokens = collectPrimaryCommandTokens(inlineScript, depth + 1);
    if (nestedTokens.length === 0) {
      tokens.add(descriptor.token);
      continue;
    }

    for (const token of nestedTokens) {
      tokens.add(token);
    }
  }

  return [...tokens];
}

function isLowSignalExecCommand(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string" || !command.trim()) return false;

  const primaryTokens = collectPrimaryCommandTokens(command);
  if (primaryTokens.length === 0) return false;
  return primaryTokens.every((token) => LOW_SIGNAL_EXEC_PRIMARY_TOKENS.has(token));
}

function classifyToolStrategy(toolName: unknown, input?: unknown): ToolStrategyClass {
  const normalizedToolName = normalizeToolName(toolName);

  if (isRawScanTool(normalizedToolName)) {
    return "raw_scan";
  }
  if (
    LOW_SIGNAL_TOOL_NAMES.has(normalizedToolName) ||
    (normalizedToolName === "exec" && isLowSignalExecCommand(input))
  ) {
    return "low_signal";
  }
  if (EVIDENCE_REUSE_TOOL_NAMES.has(normalizedToolName)) {
    return "evidence_reuse";
  }
  if (EXPLICIT_PROGRESS_TOOL_NAMES.has(normalizedToolName)) {
    return "progress";
  }
  return "progress";
}

function mergeToolStrategy(
  existing: ToolStrategyClass | undefined,
  next: ToolStrategyClass,
): ToolStrategyClass {
  if (!existing) return next;
  if (next === "progress" && existing !== "progress") {
    return existing;
  }
  return next;
}

function classifyScanFailure(text: string): "out_of_bounds" | "enoent" | "directory" | null {
  const normalized = text.trim();
  if (!normalized) return null;

  if (/offset\s+\d+\s+is\s+beyond\s+end\s+of\s+file/i.test(normalized)) {
    return "out_of_bounds";
  }
  if (/\benoent\b/i.test(normalized) || /no such file or directory/i.test(normalized)) {
    return "enoent";
  }
  if (/\beisdir\b/i.test(normalized) || /is a directory/i.test(normalized)) {
    return "directory";
  }
  return null;
}

function buildArmSummary(reason: ScanConvergenceReason): string {
  if (reason === "scan_only_turns") {
    return "Repeated read/grep-only turns reached the convergence threshold.";
  }
  if (reason === "investigation_only_turns") {
    return "Repeated low-signal investigation turns reached the convergence threshold.";
  }
  return "Repeated read/grep failures reached the convergence threshold.";
}

function buildBlockReason(reason: ScanConvergenceReason): string {
  const trigger =
    reason === "scan_only_turns"
      ? "too many read/grep-only turns"
      : reason === "investigation_only_turns"
        ? "too many low-signal investigation turns"
        : "too many repeated ENOENT/out-of-bounds scan failures";

  return [
    "[Brewva Scan Convergence Guard]",
    `Stop low-signal investigation: ${trigger}.`,
    "",
    "Provide a staged conclusion now:",
    "- summarize what you already checked",
    "- name the missing path, symbol, offset, or blocker",
    "- record the next step via task/blocker tools or handoff",
    "- prefer existing evidence via output_search / ledger_query / tape_search before more reads",
    "",
    "Only resume low-signal retrieval after the strategy changes with a convergence tool.",
  ].join("\n");
}

function buildTaskBlockerMessage(
  reason: ScanConvergenceReason,
  state: ScanConvergenceState,
): string {
  return [
    "[ScanConvergenceGuard]",
    buildArmSummary(reason),
    `consecutive_scan_only_turns=${state.consecutiveScanOnlyTurns}`,
    `consecutive_investigation_only_turns=${state.consecutiveInvestigationOnlyTurns}`,
    `consecutive_scan_failures=${state.consecutiveScanFailures}`,
    "required_next_step=Use task_add_item / task_record_blocker / task_view_state or evidence reuse tools before more low-signal retrieval.",
    "preferred_tools=task_add_item,task_record_blocker,task_view_state,output_search,ledger_query,tape_search,tape_handoff",
  ].join("\n");
}

function recordEvent(
  runtime: BrewvaRuntime,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  runtime.events.record({
    sessionId,
    type,
    payload,
  });
}

function buildToolLifecycleKey(
  toolCallId: unknown,
  normalizedToolName: string,
  suffix: string,
): string {
  if (typeof toolCallId === "string" && toolCallId.trim().length > 0) {
    return `${toolCallId}:${suffix}`;
  }
  return `${normalizedToolName}:anonymous:${suffix}`;
}

function resolveToolStrategy(
  state: ScanConvergenceState,
  toolCallId: unknown,
  toolName: unknown,
  input?: unknown,
): ToolStrategyClass | null {
  const normalizedToolName = normalizeToolName(toolName);
  if (!normalizedToolName) return null;

  const classified = classifyToolStrategy(normalizedToolName, input);
  if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) {
    return classified;
  }

  const strategy = mergeToolStrategy(state.toolStrategyByCallId.get(toolCallId), classified);
  state.toolStrategyByCallId.set(toolCallId, strategy);
  return strategy;
}

function armGuard(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: ScanConvergenceState,
  reason: ScanConvergenceReason,
): void {
  if (state.armedReason === reason) return;
  if (state.armedReason !== null) return;

  state.armedReason = reason;
  runtime.task.recordBlocker(sessionId, {
    id: GUARD_BLOCKER_ID,
    message: buildTaskBlockerMessage(reason, state),
    source: GUARD_BLOCKER_SOURCE,
  });

  recordEvent(runtime, sessionId, SCAN_CONVERGENCE_ARMED_EVENT_TYPE, {
    reason,
    summary: buildArmSummary(reason),
    consecutiveScanOnlyTurns: state.consecutiveScanOnlyTurns,
    consecutiveInvestigationOnlyTurns: state.consecutiveInvestigationOnlyTurns,
    consecutiveScanFailures: state.consecutiveScanFailures,
    blockedStrategy: "low_signal_investigation",
    blockedTools: [...RAW_SCAN_TOOL_NAMES, ...LOW_SIGNAL_TOOL_NAMES, "exec(low_signal)"],
    recommendedStrategyTools: [
      "task_add_item",
      "task_record_blocker",
      "task_view_state",
      "output_search",
      "ledger_query",
      "tape_search",
      "tape_handoff",
    ],
    requiredAction: "staged_conclusion_required",
    thresholds: {
      scanOnlyTurns: CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD,
      investigationOnlyTurns: CONSECUTIVE_INVESTIGATION_ONLY_TURNS_THRESHOLD,
      scanFailures: CONSECUTIVE_SCAN_FAILURES_THRESHOLD,
    },
  });
}

function resetGuard(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: ScanConvergenceState,
  reason: ScanConvergenceResetReason,
  toolStrategy?: ToolStrategyClass,
): void {
  if (state.armedReason !== null) {
    recordEvent(runtime, sessionId, SCAN_CONVERGENCE_RESET_EVENT_TYPE, {
      reason,
      previousReason: state.armedReason,
      toolStrategy: toolStrategy ?? null,
      consecutiveScanOnlyTurns: state.consecutiveScanOnlyTurns,
      consecutiveInvestigationOnlyTurns: state.consecutiveInvestigationOnlyTurns,
      consecutiveScanFailures: state.consecutiveScanFailures,
    });
    runtime.task.resolveBlocker(sessionId, GUARD_BLOCKER_ID);
  }

  state.currentTurnRawScanToolCalls = 0;
  state.currentTurnLowSignalToolCalls = 0;
  state.currentTurnConvergenceToolCalls = 0;
  state.consecutiveScanOnlyTurns = 0;
  state.consecutiveInvestigationOnlyTurns = 0;
  state.consecutiveScanFailures = 0;
  state.armedReason = null;
}

function clearTurnCounters(state: ScanConvergenceState): void {
  state.currentTurnRawScanToolCalls = 0;
  state.currentTurnLowSignalToolCalls = 0;
  state.currentTurnConvergenceToolCalls = 0;
  state.executedToolCalls.clear();
  state.completedConvergenceToolCalls.clear();
  state.classifiedScanFailureToolCalls.clear();
  state.toolStrategyByCallId.clear();
}

function noteExecutedTool(
  state: ScanConvergenceState,
  toolCallId: unknown,
  toolName: unknown,
  input?: unknown,
): void {
  const normalizedToolName = normalizeToolName(toolName);
  if (!normalizedToolName) return;

  const executionKey = buildToolLifecycleKey(toolCallId, normalizedToolName, "executed");
  if (state.executedToolCalls.has(executionKey)) return;
  state.executedToolCalls.add(executionKey);

  const toolStrategy = resolveToolStrategy(state, toolCallId, normalizedToolName, input);
  if (!toolStrategy) return;

  if (toolStrategy === "raw_scan") {
    state.currentTurnRawScanToolCalls += 1;
    state.currentTurnLowSignalToolCalls += 1;
    return;
  }

  if (toolStrategy === "low_signal") {
    state.currentTurnLowSignalToolCalls += 1;
  }
}

function noteSuccessfulStrategyShift(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: ScanConvergenceState,
  toolCallId: unknown,
  toolName: unknown,
  input?: unknown,
): void {
  const normalizedToolName = normalizeToolName(toolName);
  if (!normalizedToolName) return;

  const toolStrategy = resolveToolStrategy(state, toolCallId, normalizedToolName, input);
  if (!toolStrategy || toolStrategy === "raw_scan" || toolStrategy === "low_signal") {
    return;
  }

  const completionKey = buildToolLifecycleKey(toolCallId, normalizedToolName, "strategy_shift");
  if (state.completedConvergenceToolCalls.has(completionKey)) {
    return;
  }
  state.completedConvergenceToolCalls.add(completionKey);

  if (state.armedReason !== null) {
    resetGuard(runtime, sessionId, state, "strategy_shift", toolStrategy);
  }
  state.currentTurnConvergenceToolCalls += 1;
  state.consecutiveScanFailures = 0;
}

function noteScanFailure(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: ScanConvergenceState,
  toolCallId: unknown,
  toolName: unknown,
  isError: boolean,
  resultText: string,
): void {
  if (!isRawScanTool(toolName)) {
    return;
  }

  if (!isError) {
    state.consecutiveScanFailures = 0;
    return;
  }

  const normalizedToolName = normalizeToolName(toolName);
  if (!normalizedToolName) return;

  const failureKind = classifyScanFailure(resultText);
  if (!failureKind) {
    return;
  }

  const failureKey = buildToolLifecycleKey(toolCallId, normalizedToolName, "scan_failure");
  if (state.classifiedScanFailureToolCalls.has(failureKey)) {
    return;
  }
  state.classifiedScanFailureToolCalls.add(failureKey);

  state.consecutiveScanFailures += 1;
  if (state.consecutiveScanFailures >= CONSECUTIVE_SCAN_FAILURES_THRESHOLD) {
    armGuard(runtime, sessionId, state, "scan_failures");
  }
}

export function registerScanConvergenceGuard(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const statesBySession = new Map<string, ScanConvergenceState>();

  pi.on("input", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = statesBySession.get(sessionId);
    if (state) {
      resetGuard(runtime, sessionId, state, "input_reset");
      statesBySession.delete(sessionId);
    }
    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(statesBySession, sessionId);
    const toolName = normalizeToolName(event.toolName);
    const strategy = classifyToolStrategy(toolName, (event as { input?: unknown }).input);
    const activeSkill = runtime.skills.getActive(sessionId);

    if (typeof event.toolCallId === "string") {
      state.toolStrategyByCallId.set(event.toolCallId, strategy);
    }

    if (strategy !== "raw_scan" && strategy !== "low_signal") {
      return undefined;
    }

    if (state.armedReason === null) {
      return undefined;
    }

    const reason = buildBlockReason(state.armedReason);
    recordEvent(runtime, sessionId, SCAN_CONVERGENCE_BLOCKED_EVENT_TYPE, {
      toolCallId: event.toolCallId,
      toolName,
      toolStrategy: strategy,
      reason: state.armedReason,
      blockMessage: reason,
      consecutiveScanOnlyTurns: state.consecutiveScanOnlyTurns,
      consecutiveInvestigationOnlyTurns: state.consecutiveInvestigationOnlyTurns,
      consecutiveScanFailures: state.consecutiveScanFailures,
      requiredAction: "staged_conclusion_required",
    });
    recordEvent(runtime, sessionId, "tool_call_blocked", {
      toolName,
      toolStrategy: strategy,
      skill: activeSkill?.name ?? null,
      reason,
    });

    return {
      block: true,
      reason,
    };
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(statesBySession, sessionId);
    noteExecutedTool(state, event.toolCallId, event.toolName, (event as { args?: unknown }).args);
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(statesBySession, sessionId);
    const toolInput = (event as { input?: unknown }).input;
    noteExecutedTool(state, event.toolCallId, event.toolName, toolInput);
    if (!event.isError) {
      noteSuccessfulStrategyShift(
        runtime,
        sessionId,
        state,
        event.toolCallId,
        event.toolName,
        toolInput,
      );
    }
    noteScanFailure(
      runtime,
      sessionId,
      state,
      event.toolCallId,
      event.toolName,
      event.isError,
      extractToolResultText(event),
    );
    return undefined;
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(statesBySession, sessionId);
    if (!event.isError) {
      noteSuccessfulStrategyShift(runtime, sessionId, state, event.toolCallId, event.toolName);
    }
    noteScanFailure(
      runtime,
      sessionId,
      state,
      event.toolCallId,
      event.toolName,
      event.isError,
      extractToolResultText((event as { result?: unknown }).result),
    );
    return undefined;
  });

  pi.on("turn_end", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = statesBySession.get(sessionId);
    if (!state) return undefined;

    if (state.currentTurnConvergenceToolCalls > 0) {
      if (state.armedReason === null) {
        state.consecutiveScanOnlyTurns = 0;
        state.consecutiveInvestigationOnlyTurns = 0;
        state.consecutiveScanFailures = 0;
      }
      clearTurnCounters(state);
      return undefined;
    }

    if (state.currentTurnLowSignalToolCalls > 0) {
      state.consecutiveInvestigationOnlyTurns += 1;

      const scanOnlyTurn =
        state.currentTurnRawScanToolCalls > 0 &&
        state.currentTurnRawScanToolCalls === state.currentTurnLowSignalToolCalls;
      if (scanOnlyTurn) {
        state.consecutiveScanOnlyTurns += 1;
        if (state.consecutiveScanOnlyTurns >= CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD) {
          armGuard(runtime, sessionId, state, "scan_only_turns");
        }
      } else {
        state.consecutiveScanOnlyTurns = 0;
      }

      if (
        state.consecutiveInvestigationOnlyTurns >= CONSECUTIVE_INVESTIGATION_ONLY_TURNS_THRESHOLD
      ) {
        armGuard(runtime, sessionId, state, "investigation_only_turns");
      }
    }

    clearTurnCounters(state);
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    statesBySession.delete(sessionId);
    return undefined;
  });
}
