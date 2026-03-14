import {
  SCAN_CONVERGENCE_ADVISORY_EVENT_TYPE,
  SCAN_CONVERGENCE_RESET_EVENT_TYPE,
  type ContextCompactionGateStatus,
  type ContextInjectionEntry,
} from "@brewva/brewva-runtime";
import type { BuildCapabilityViewResult } from "./capability-view.js";
import { formatPercent } from "./context-shared.js";
import { estimateTokens } from "./tool-output-distiller.js";

const GOVERNANCE_TOKEN_CAP_RATIO = 0.15;
const MIN_GOVERNANCE_TOKEN_CAP = 96;
const MIN_CAPABILITY_VIEW_TOKENS = 48;
const CHARS_PER_TOKEN = 3.5;

export type ContextBlockCategory = "narrative" | "constraint" | "diagnostic";

export interface ComposedContextBlock {
  id: string;
  category: ContextBlockCategory;
  content: string;
  estimatedTokens: number;
}

export interface ContextComposerMetrics {
  totalTokens: number;
  narrativeTokens: number;
  constraintTokens: number;
  diagnosticTokens: number;
  narrativeRatio: number;
}

export interface ContextComposerResult {
  blocks: ComposedContextBlock[];
  content: string;
  metrics: ContextComposerMetrics;
}

export interface ContextComposedEventPayload extends Record<string, unknown> {
  narrativeBlockCount: number;
  constraintBlockCount: number;
  diagnosticBlockCount: number;
  totalTokens: number;
  narrativeTokens: number;
  narrativeRatio: number;
  injectionAccepted: boolean;
}

export interface ContextComposerInput {
  runtime: {
    events: {
      getTapeStatus(sessionId: string): {
        tapePressure: string;
        entriesSinceAnchor: number;
      };
      query?: (
        sessionId: string,
        query: { type?: string; last?: number },
      ) => Array<{
        payload?: Record<string, unknown>;
        turn?: number;
        timestamp: number;
      }>;
    };
  };
  sessionId: string;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason?: string | null;
  capabilityView: BuildCapabilityViewResult;
  admittedEntries: ContextInjectionEntry[];
  injectionAccepted: boolean;
}

const DIAGNOSTIC_CAPABILITY_NAMES = new Set<string>([
  "cost_view",
  "obs_query",
  "obs_slo_assert",
  "obs_snapshot",
  "tape_info",
  "tape_search",
]);

function makeBlock(
  id: string,
  category: ContextBlockCategory,
  content: string,
): ComposedContextBlock | null {
  const normalized = content.trim();
  if (normalized.length === 0) {
    return null;
  }
  return {
    id,
    category,
    content: normalized,
    estimatedTokens: estimateTokens(normalized),
  };
}

function buildCompactionGateBlock(input: {
  pressure: ContextCompactionGateStatus["pressure"];
}): string {
  const usageRatio = input.pressure.usageRatio ?? 0;
  const usagePercent = formatPercent(usageRatio);
  const hardLimitPercent = formatPercent(input.pressure.hardLimitRatio);
  return [
    "[ContextCompactionGate]",
    "Context pressure is critical.",
    `Current usage: ${usagePercent} (hard limit: ${hardLimitPercent}).`,
    "Call tool `session_compact` immediately before any other tool call.",
    "Do not run `session_compact` via `exec` or shell.",
  ].join("\n");
}

function buildCompactionAdvisoryBlock(input: {
  reason: string;
  pressure: ContextCompactionGateStatus["pressure"];
}): string {
  const usageRatio = input.pressure.usageRatio ?? 0;
  const usagePercent = formatPercent(usageRatio);
  const thresholdPercent = formatPercent(input.pressure.compactionThresholdRatio);
  return [
    "[ContextCompactionAdvisory]",
    `Pending compaction request: ${input.reason}.`,
    `Current usage: ${usagePercent} (compact-soon threshold: ${thresholdPercent}).`,
    "Prefer `session_compact` before long tool chains or broad repository scans.",
    "If no further tool work is needed, answer directly instead of compacting first.",
  ].join("\n");
}

function buildOperationalDiagnosticsBlock(input: {
  runtime: ContextComposerInput["runtime"];
  sessionId: string;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason?: string | null;
  requested: string[];
  includeTapeTelemetry: boolean;
}): string {
  const requiredAction = input.gateStatus.required
    ? "session_compact_now"
    : input.pendingCompactionReason
      ? "session_compact_recommended"
      : "none";
  const lines = [
    "[OperationalDiagnostics]",
    `context_pressure: ${input.gateStatus.pressure.level}`,
    `pending_compaction_reason: ${input.pendingCompactionReason ?? "none"}`,
    `required_action: ${requiredAction}`,
  ];
  if (input.requested.length > 0) {
    lines.splice(1, 0, `requested_by: ${input.requested.map((name) => `$${name}`).join(", ")}`);
  }
  if (input.includeTapeTelemetry) {
    const tapeStatus = input.runtime.events.getTapeStatus(input.sessionId);
    lines.push(`tape_pressure: ${tapeStatus.tapePressure}`);
    lines.push(`tape_entries_since_anchor: ${tapeStatus.entriesSinceAnchor}`);
  }
  return lines.join("\n");
}

function buildExplorationAdvisoryBlock(payload: Record<string, unknown>): string | null {
  const message =
    typeof payload.message === "string"
      ? payload.message.trim()
      : typeof payload.summary === "string"
        ? payload.summary.trim()
        : "";
  if (!message) {
    return null;
  }
  return message;
}

function shouldIncludeOperationalDiagnostics(requested: string[]): string[] {
  return requested.filter((name) => DIAGNOSTIC_CAPABILITY_NAMES.has(name));
}

function compareCategory(left: ContextBlockCategory, right: ContextBlockCategory): number {
  const order: Record<ContextBlockCategory, number> = {
    narrative: 0,
    constraint: 1,
    diagnostic: 2,
  };
  return order[left] - order[right];
}

function buildMetrics(blocks: ComposedContextBlock[]): ContextComposerMetrics {
  let narrativeTokens = 0;
  let constraintTokens = 0;
  let diagnosticTokens = 0;
  for (const block of blocks) {
    if (block.category === "narrative") {
      narrativeTokens += block.estimatedTokens;
      continue;
    }
    if (block.category === "constraint") {
      constraintTokens += block.estimatedTokens;
      continue;
    }
    diagnosticTokens += block.estimatedTokens;
  }
  const totalTokens = narrativeTokens + constraintTokens + diagnosticTokens;
  return {
    totalTokens,
    narrativeTokens,
    constraintTokens,
    diagnosticTokens,
    narrativeRatio: totalTokens > 0 ? narrativeTokens / totalTokens : 0,
  };
}

function truncateContentToTokenBudget(content: string, maxTokens: number): string {
  const maxChars = Math.max(1, Math.floor(Math.max(1, maxTokens) * CHARS_PER_TOKEN));
  if (content.length <= maxChars) {
    return content;
  }
  if (maxChars <= 3) {
    return content.slice(0, maxChars);
  }
  return `${content.slice(0, maxChars - 3)}...`;
}

function rebuildBlock(block: ComposedContextBlock, content: string): ComposedContextBlock | null {
  return makeBlock(block.id, block.category, content);
}

function applyGovernanceBudgetCap(blocks: ComposedContextBlock[]): ComposedContextBlock[] {
  if (blocks.length === 0) {
    return blocks;
  }

  let current = [...blocks];
  let metrics = buildMetrics(current);
  const hasPendingCompactionAdvisory = current.some((block) => block.id === "compaction-advisory");
  const hasCriticalCompactionGate = current.some((block) => block.id === "compaction-gate");
  let governanceTokens = metrics.constraintTokens + metrics.diagnosticTokens;
  const governanceCap = Math.max(
    hasPendingCompactionAdvisory && !hasCriticalCompactionGate
      ? MIN_GOVERNANCE_TOKEN_CAP + 32
      : MIN_GOVERNANCE_TOKEN_CAP,
    Math.floor(metrics.totalTokens * GOVERNANCE_TOKEN_CAP_RATIO),
  );
  if (governanceTokens <= governanceCap) {
    return current;
  }

  current = current.filter((block) => {
    if (block.category !== "diagnostic") {
      return true;
    }
    if (governanceTokens <= governanceCap) {
      return true;
    }
    governanceTokens -= block.estimatedTokens;
    return false;
  });

  if (governanceTokens <= governanceCap) {
    return current;
  }

  current = current.filter((block) => {
    if (block.id !== "compaction-advisory") {
      return true;
    }
    if (governanceTokens <= governanceCap) {
      return true;
    }
    governanceTokens -= block.estimatedTokens;
    return false;
  });

  if (governanceTokens <= governanceCap) {
    return current;
  }

  const capabilityIndex = current.findIndex((block) => block.id === "capability-view");
  if (capabilityIndex < 0) {
    return current;
  }

  const otherGovernanceTokens = current.reduce((sum, block, index) => {
    if (index === capabilityIndex) {
      return sum;
    }
    if (block.category === "constraint" || block.category === "diagnostic") {
      return sum + block.estimatedTokens;
    }
    return sum;
  }, 0);
  const capabilityBudget = Math.max(
    MIN_CAPABILITY_VIEW_TOKENS,
    governanceCap - otherGovernanceTokens,
  );
  const capabilityBlock = current[capabilityIndex]!;
  if (capabilityBlock.estimatedTokens <= capabilityBudget) {
    return current;
  }

  const truncatedCapability = rebuildBlock(
    capabilityBlock,
    truncateContentToTokenBudget(capabilityBlock.content, capabilityBudget),
  );
  if (!truncatedCapability) {
    return current.filter((_, index) => index !== capabilityIndex);
  }

  current[capabilityIndex] = truncatedCapability;
  return current;
}

function resolveExplorationAdvisoryBlock(input: ContextComposerInput): ComposedContextBlock | null {
  const advisoryEvent = input.runtime.events.query?.(input.sessionId, {
    type: SCAN_CONVERGENCE_ADVISORY_EVENT_TYPE,
    last: 1,
  })?.[0];
  const resetEvent = input.runtime.events.query?.(input.sessionId, {
    type: SCAN_CONVERGENCE_RESET_EVENT_TYPE,
    last: 1,
  })?.[0];
  if (
    advisoryEvent &&
    resetEvent &&
    typeof advisoryEvent.timestamp === "number" &&
    typeof resetEvent.timestamp === "number" &&
    resetEvent.timestamp >= advisoryEvent.timestamp
  ) {
    return null;
  }
  if (!advisoryEvent?.payload || typeof advisoryEvent.payload !== "object") {
    return null;
  }
  const content = buildExplorationAdvisoryBlock(advisoryEvent.payload);
  if (!content) {
    return null;
  }
  return makeBlock("exploration-advisory", "diagnostic", content);
}

export function composeContextBlocks(input: ContextComposerInput): ContextComposerResult {
  const blocks: ComposedContextBlock[] = [];

  if (input.injectionAccepted) {
    for (const entry of input.admittedEntries) {
      const block = makeBlock(`source:${entry.source}:${entry.id}`, entry.category, entry.content);
      if (block) {
        blocks.push(block);
      }
    }
  }

  if (input.gateStatus.required) {
    const gateBlock = makeBlock(
      "compaction-gate",
      "constraint",
      buildCompactionGateBlock({
        pressure: input.gateStatus.pressure,
      }),
    );
    if (gateBlock) {
      blocks.push(gateBlock);
    }
  } else if (input.pendingCompactionReason) {
    const advisoryBlock = makeBlock(
      "compaction-advisory",
      "constraint",
      buildCompactionAdvisoryBlock({
        reason: input.pendingCompactionReason,
        pressure: input.gateStatus.pressure,
      }),
    );
    if (advisoryBlock) {
      blocks.push(advisoryBlock);
    }
  }

  const capabilityBlock = makeBlock("capability-view", "constraint", input.capabilityView.block);
  if (capabilityBlock) {
    blocks.push(capabilityBlock);
  }

  const diagnosticRequests = shouldIncludeOperationalDiagnostics(input.capabilityView.requested);
  const includeTapeTelemetry = diagnosticRequests.length > 0;
  if (
    diagnosticRequests.length > 0 ||
    input.gateStatus.required ||
    !!input.pendingCompactionReason
  ) {
    const diagnosticBlock = makeBlock(
      "operational-diagnostics",
      "diagnostic",
      buildOperationalDiagnosticsBlock({
        runtime: input.runtime,
        sessionId: input.sessionId,
        gateStatus: input.gateStatus,
        pendingCompactionReason: input.pendingCompactionReason,
        requested: diagnosticRequests,
        includeTapeTelemetry,
      }),
    );
    if (diagnosticBlock) {
      blocks.push(diagnosticBlock);
    }
  }

  const explorationAdvisoryBlock = resolveExplorationAdvisoryBlock(input);
  if (explorationAdvisoryBlock) {
    blocks.push(explorationAdvisoryBlock);
  }

  const ordered = applyGovernanceBudgetCap(
    [...blocks].toSorted((left, right) => {
      const categoryDiff = compareCategory(left.category, right.category);
      return categoryDiff;
    }),
  );
  const metrics = buildMetrics(ordered);
  return {
    blocks: ordered,
    content: ordered.map((block) => block.content).join("\n\n"),
    metrics,
  };
}

export function buildContextComposedEventPayload(
  composed: ContextComposerResult,
  injectionAccepted: boolean,
): ContextComposedEventPayload {
  return {
    narrativeBlockCount: composed.blocks.filter((block) => block.category === "narrative").length,
    constraintBlockCount: composed.blocks.filter((block) => block.category === "constraint").length,
    diagnosticBlockCount: composed.blocks.filter((block) => block.category === "diagnostic").length,
    totalTokens: composed.metrics.totalTokens,
    narrativeTokens: composed.metrics.narrativeTokens,
    narrativeRatio: composed.metrics.narrativeRatio,
    injectionAccepted,
  };
}
