import { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "./tape/events.js";
import { formatTaskStateBlock } from "./task/ledger.js";
import type { BrewvaEventCategory, SkillSelection, TaskState } from "./types.js";

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
  if (type.startsWith("cost_") || type.startsWith("budget_")) return "cost";
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

export function buildContextSourceTokenLimits(maxInjectionTokens: number): Record<string, number> {
  const budget = Math.max(64, Math.floor(maxInjectionTokens));
  const fromRatio = (ratio: number, minimum: number, maximum = budget): number => {
    const scaled = Math.floor(budget * ratio);
    return Math.max(minimum, Math.min(maximum, scaled));
  };

  return {
    "brewva.truth": fromRatio(0.05, 48, 200),
    "brewva.truth-facts": fromRatio(0.12, 72, 320),
    "brewva.viewport-policy": fromRatio(0.12, 96, 320),
    "brewva.task-state": fromRatio(0.15, 96, 360),
    "brewva.viewport": fromRatio(0.7, 240, budget),
    "brewva.skill-candidates": fromRatio(0.28, 64, 320),
    "brewva.compaction-summary": fromRatio(0.45, 120, 600),
    "brewva.ledger-digest": fromRatio(0.2, 96, 360),
    "brewva.working-memory": fromRatio(0.32, 120, 640),
    "brewva.memory-recall": fromRatio(0.28, 96, 520),
  };
}
