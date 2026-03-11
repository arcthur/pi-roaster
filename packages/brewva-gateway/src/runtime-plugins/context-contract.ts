import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { formatPercent } from "./context-shared.js";

const CONTEXT_CONTRACT_MARKER = "[Brewva Context Contract]";

export function buildContextContractBlock(runtime: BrewvaRuntime): string {
  const highThresholdPercent = formatPercent(runtime.context.getCompactionThresholdRatio());
  const hardLimitPercent = formatPercent(runtime.context.getHardLimitRatio());

  return [
    CONTEXT_CONTRACT_MARKER,
    "Operating model:",
    "- `tape_handoff` records durable handoff state; it does not reduce message tokens.",
    "- `session_compact` reduces message-history pressure; it does not rewrite tape semantics.",
    "- If a compaction gate or advisory block appears, follow it before broad tool work.",
    "- Prefer current task state, accepted context packets, and working projection before replaying tape.",
    "Hard rules:",
    "- call `session_compact` directly, never through `exec` or shell wrappers.",
    `- compact soon when context pressure reaches high (${highThresholdPercent}).`,
    `- compact immediately when context pressure becomes critical (${hardLimitPercent}).`,
  ].join("\n");
}

export function applyContextContract(systemPrompt: unknown, runtime: BrewvaRuntime): string {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  if (base.includes(CONTEXT_CONTRACT_MARKER)) {
    return base;
  }
  const contract = buildContextContractBlock(runtime);
  if (base.trim().length === 0) {
    return contract;
  }
  return `${base}\n\n${contract}`;
}

export { CONTEXT_CONTRACT_MARKER };
