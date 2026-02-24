import { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "./tape/events.js";
import { formatTaskStateBlock } from "./task/ledger.js";
import type { BrewvaEventCategory, SkillSelection, TaskState } from "./types.js";

const DEFAULT_TOOL_FAILURE_MAX_ENTRIES = 3;
const DEFAULT_TOOL_FAILURE_MAX_OUTPUT_CHARS = 300;
const TOOL_FAILURE_ARGS_SUMMARY_CHARS = 140;
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 3.5;

export const ALWAYS_ALLOWED_TOOLS = [
  "skill_complete",
  "skill_load",
  "ledger_query",
  "cost_view",
  "tape_handoff",
  "tape_info",
  "tape_search",
  "session_compact",
  "rollback_last_patch",
  "schedule_intent",
];

export function inferEventCategory(type: string): BrewvaEventCategory {
  if (type === TAPE_ANCHOR_EVENT_TYPE || type === TAPE_CHECKPOINT_EVENT_TYPE) {
    return "state";
  }
  if (
    type.startsWith("session_") ||
    type.startsWith("channel_session_") ||
    type === "session_start" ||
    type === "session_shutdown"
  )
    return "session";
  if (type.startsWith("turn_") || type.startsWith("channel_turn_")) return "turn";
  if (type.includes("tool") || type.startsWith("patch_") || type === "rollback") return "tool";
  if (type.startsWith("context_")) return "context";
  if (type.startsWith("cost_") || type.startsWith("budget_") || type === "cognitive_usage_recorded")
    return "cost";
  if (type.startsWith("verification_")) return "verification";
  if (type.includes("snapshot") || type.includes("resumed") || type.includes("interrupted"))
    return "state";
  return "other";
}

export function buildSkillCandidateBlock(selected: SkillSelection[]): string {
  const skillLines =
    selected.length > 0
      ? selected.map((entry) => `- ${entry.name} (score=${entry.score}, reason=${entry.reason})`)
      : ["- (none)"];
  return ["[Brewva Context]", "Top-K Skill Candidates:", ...skillLines].join("\n");
}

export function buildTaskStateBlock(state: TaskState): string {
  return formatTaskStateBlock(state);
}

function estimateToolFailureBlockTokens(input?: {
  maxEntries?: number;
  maxOutputChars?: number;
}): number {
  const maxEntries = Math.max(1, Math.floor(input?.maxEntries ?? DEFAULT_TOOL_FAILURE_MAX_ENTRIES));
  const maxOutputChars = Math.max(
    32,
    Math.floor(input?.maxOutputChars ?? DEFAULT_TOOL_FAILURE_MAX_OUTPUT_CHARS),
  );

  const perEntryChars = 32 + TOOL_FAILURE_ARGS_SUMMARY_CHARS + maxOutputChars;
  const blockChars = 24 + maxEntries * perEntryChars;
  return Math.max(64, Math.ceil(blockChars / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

export function buildContextSourceTokenLimits(
  maxInjectionTokens: number,
  options: {
    toolFailureInjection?: {
      maxEntries?: number;
      maxOutputChars?: number;
    };
  } = {},
): Record<string, number> {
  const budget = Math.max(64, Math.floor(maxInjectionTokens));
  const fromRatio = (ratio: number, minimum: number, maximum = budget): number => {
    const scaled = Math.floor(budget * ratio);
    return Math.max(minimum, Math.min(maximum, scaled));
  };
  const toolFailureUpperBound = Math.max(96, Math.floor(budget * 0.55));
  const toolFailureFloor = fromRatio(0.12, 96, toolFailureUpperBound);
  const toolFailureEstimated = estimateToolFailureBlockTokens(options.toolFailureInjection);
  const toolFailureLimit = Math.max(
    toolFailureFloor,
    Math.min(toolFailureUpperBound, toolFailureEstimated + 16),
  );

  return {
    "brewva.identity": fromRatio(0.2, 140, 320),
    "brewva.truth": fromRatio(0.18, 96, 420),
    "brewva.task-state": fromRatio(0.15, 96, 360),
    "brewva.tool-failures": toolFailureLimit,
    "brewva.memory": fromRatio(0.52, 220, budget),
  };
}
