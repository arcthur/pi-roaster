import { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "./tape/events.js";
import { formatTaskStateBlock } from "./task/ledger.js";
import type {
  BrewvaEventCategory,
  SkillDispatchDecision,
  SkillSelection,
  TaskState,
} from "./types.js";

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
      ? selected.map((entry) => {
          const breakdown = entry.breakdown
            .map((item) => `${item.signal}:${item.term}(${item.delta})`)
            .join("|");
          return `- ${entry.name} (score=${entry.score}, reason=${entry.reason}, breakdown=${breakdown})`;
        })
      : ["- (none)"];
  return ["[Brewva Context]", "Top-K Skill Candidates:", ...skillLines].join("\n");
}

export function buildTaskStateBlock(state: TaskState): string {
  return formatTaskStateBlock(state);
}

export function buildSkillDispatchGateBlock(decision: SkillDispatchDecision): string {
  const primary = decision.primary?.name ?? "(none)";
  const chainText =
    decision.chain.length > 0
      ? decision.chain.join(" -> ")
      : decision.routingOutcome === "failed"
        ? "(unavailable — routing failed)"
        : primary;
  const unresolvedConsumes =
    decision.unresolvedConsumes.length > 0 ? decision.unresolvedConsumes.join(", ") : "(none)";
  const requiredActionLine = decision.primary?.name
    ? `- call tool \`skill_load\` with name=\`${decision.primary.name}\` before non-lifecycle tools`
    : "- call tool `skill_load` with an explicit skill name before non-lifecycle tools";
  return [
    "[SkillDispatchGate]",
    `mode: ${decision.mode}`,
    `primary: ${primary}`,
    `confidence: ${decision.confidence.toFixed(3)}`,
    `reason: ${decision.reason}`,
    `routing_outcome: ${decision.routingOutcome ?? "unknown"}`,
    `chain: ${chainText}`,
    `unresolved_consumes: ${unresolvedConsumes}`,
    "Required action:",
    requiredActionLine,
    "- if intentional bypass, call `skill_route_override` with reason first",
  ].join("\n");
}
