import type { ScanConvergenceToolStrategy } from "./session-state.js";

export type ScanConvergenceToolRule =
  | {
      kind: "static";
      strategy: ScanConvergenceToolStrategy;
    }
  | {
      kind: "exec";
    }
  | {
      kind: "skill_chain_control";
    };

function staticRule(strategy: ScanConvergenceToolStrategy): ScanConvergenceToolRule {
  return { kind: "static", strategy };
}

export const SCAN_CONVERGENCE_TOOL_RULES_BY_NAME = {
  read: staticRule("raw_scan"),
  grep: staticRule("raw_scan"),
  read_spans: staticRule("low_signal"),
  look_at: staticRule("low_signal"),
  toc_search: staticRule("low_signal"),
  toc_document: staticRule("low_signal"),
  ast_grep_search: staticRule("low_signal"),
  lsp_goto_definition: staticRule("low_signal"),
  lsp_find_references: staticRule("low_signal"),
  lsp_symbols: staticRule("low_signal"),
  lsp_diagnostics: staticRule("low_signal"),
  lsp_prepare_rename: staticRule("low_signal"),
  tape_info: staticRule("evidence_reuse"),
  tape_search: staticRule("evidence_reuse"),
  task_view_state: staticRule("evidence_reuse"),
  ledger_query: staticRule("evidence_reuse"),
  output_search: staticRule("evidence_reuse"),
  cost_view: staticRule("evidence_reuse"),
  obs_query: staticRule("evidence_reuse"),
  obs_slo_assert: staticRule("evidence_reuse"),
  obs_snapshot: staticRule("evidence_reuse"),
  session_compact: staticRule("progress"),
  skill_load: staticRule("progress"),
  tape_handoff: staticRule("progress"),
  ast_grep_replace: staticRule("progress"),
  lsp_rename: staticRule("progress"),
  process: staticRule("progress"),
  schedule_intent: staticRule("progress"),
  skill_complete: staticRule("progress"),
  skill_route_override: staticRule("progress"),
  task_add_item: staticRule("progress"),
  task_record_blocker: staticRule("progress"),
  task_resolve_blocker: staticRule("progress"),
  task_set_spec: staticRule("progress"),
  task_update_item: staticRule("progress"),
  rollback_last_patch: staticRule("progress"),
  cognition_note: staticRule("progress"),
  exec: { kind: "exec" },
  skill_chain_control: { kind: "skill_chain_control" },
} as const satisfies Record<string, ScanConvergenceToolRule>;

export const SCAN_CONVERGENCE_TOOL_RULE_NAMES = Object.keys(
  SCAN_CONVERGENCE_TOOL_RULES_BY_NAME,
).toSorted();

const SKILL_CHAIN_CONTROL_PROGRESS_ACTIONS = new Set(["start"]);
const SKILL_CHAIN_CONTROL_NEUTRAL_ACTIONS = new Set(["status", "pause", "resume", "cancel"]);
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

function normalizeCommandToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    return "";
  }
  const withoutQuotes = trimmed.replace(/^["']+|["']+$/gu, "");
  const normalized = withoutQuotes.toLowerCase();
  return normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
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

export function isLowSignalExecCommand(input: unknown): boolean {
  if (!input || typeof input !== "object") {
    return false;
  }
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string" || !command.trim()) {
    return false;
  }
  const primaryTokens = collectPrimaryCommandTokens(command);
  if (primaryTokens.length === 0) {
    return false;
  }
  return primaryTokens.every((token) => LOW_SIGNAL_EXEC_PRIMARY_TOKENS.has(token));
}

export function classifyScanConvergenceToolStrategy(
  toolName: string,
  args?: Record<string, unknown>,
): ScanConvergenceToolStrategy {
  const rule =
    SCAN_CONVERGENCE_TOOL_RULES_BY_NAME[
      toolName as keyof typeof SCAN_CONVERGENCE_TOOL_RULES_BY_NAME
    ];
  if (!rule) {
    return "progress";
  }
  if (rule.kind === "static") {
    return rule.strategy;
  }
  if (rule.kind === "exec") {
    return isLowSignalExecCommand(args) ? "low_signal" : "progress";
  }

  const action = typeof args?.action === "string" ? args.action.trim().toLowerCase() : "";
  if (SKILL_CHAIN_CONTROL_PROGRESS_ACTIONS.has(action)) {
    return "progress";
  }
  if (SKILL_CHAIN_CONTROL_NEUTRAL_ACTIONS.has(action)) {
    return "neutral";
  }
  return "neutral";
}

export function listBlockedScanConvergenceTools(): string[] {
  const blocked = Object.entries(SCAN_CONVERGENCE_TOOL_RULES_BY_NAME)
    .filter(
      ([, rule]) =>
        rule.kind === "static" && (rule.strategy === "raw_scan" || rule.strategy === "low_signal"),
    )
    .map(([toolName]) => toolName);
  blocked.push("exec(low_signal)");
  return blocked.toSorted();
}
