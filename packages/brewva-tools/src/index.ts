import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createAstGrepTools } from "./ast-grep.js";
import { createCognitionNoteTool } from "./cognition-note.js";
import { createCostViewTool } from "./cost-view.js";
import { createExecTool } from "./exec.js";
import { createGrepTool } from "./grep.js";
import { createLedgerQueryTool } from "./ledger-query.js";
import { createLookAtTool } from "./look-at.js";
import { createLspTools } from "./lsp.js";
import { createObsQueryTool } from "./observability/obs-query.js";
import { createObsSloAssertTool } from "./observability/obs-slo-assert.js";
import { createObsSnapshotTool } from "./observability/obs-snapshot.js";
import { createOutputSearchTool } from "./output-search.js";
import { createProcessTool } from "./process.js";
import { createReadSpansTool } from "./read-spans.js";
import { createResourceLeaseTool } from "./resource-lease.js";
import { createRollbackLastPatchTool } from "./rollback-last-patch.js";
import { createScheduleIntentTool } from "./schedule-intent.js";
import { createSessionCompactTool } from "./session-compact.js";
import { createSkillChainControlTool } from "./skill-chain-control.js";
import { createSkillCompleteTool } from "./skill-complete.js";
import { createSkillLoadTool } from "./skill-load.js";
import { createTapeTools } from "./tape.js";
import { createTaskLedgerTools } from "./task-ledger.js";
import { createTocTools } from "./toc.js";
import type { BrewvaToolRuntime } from "./types.js";

export interface BuildBrewvaToolsOptions {
  runtime: BrewvaToolRuntime;
}

export function buildBrewvaTools(options: BuildBrewvaToolsOptions): ToolDefinition[] {
  return [
    ...createLspTools({ runtime: options.runtime }),
    ...createTocTools({ runtime: options.runtime }),
    ...createAstGrepTools(),
    createReadSpansTool({ runtime: options.runtime }),
    createLookAtTool(),
    createGrepTool({ runtime: options.runtime }),
    createExecTool({ runtime: options.runtime }),
    createProcessTool(),
    createCostViewTool({ runtime: options.runtime }),
    createCognitionNoteTool({ runtime: options.runtime }),
    createObsQueryTool({ runtime: options.runtime }),
    createObsSloAssertTool({ runtime: options.runtime }),
    createObsSnapshotTool({ runtime: options.runtime }),
    createLedgerQueryTool({ runtime: options.runtime }),
    createOutputSearchTool({ runtime: options.runtime }),
    createScheduleIntentTool({ runtime: options.runtime }),
    ...createTapeTools({ runtime: options.runtime }),
    createSessionCompactTool({ runtime: options.runtime }),
    createResourceLeaseTool({ runtime: options.runtime }),
    createRollbackLastPatchTool({ runtime: options.runtime }),
    createSkillLoadTool({ runtime: options.runtime }),
    createSkillCompleteTool({ runtime: options.runtime }),
    createSkillChainControlTool({ runtime: options.runtime }),
    ...createTaskLedgerTools({ runtime: options.runtime }),
  ];
}

export { createLspTools } from "./lsp.js";
export { createAstGrepTools } from "./ast-grep.js";
export { createResourceLeaseTool } from "./resource-lease.js";
export { createCognitionNoteTool } from "./cognition-note.js";
export { defineBrewvaTool, getBrewvaToolMetadata } from "./utils/tool.js";
// A2A tools require an orchestration adapter and are typically registered by channel extensions
// (for example `createChannelA2AExtension` in `@brewva/brewva-cli`), not by the default bundle.
export { createA2ATools } from "./a2a.js";
export { createLookAtTool } from "./look-at.js";
export { createGrepTool } from "./grep.js";
export { createExecTool } from "./exec.js";
export { createProcessTool } from "./process.js";
export { createReadSpansTool } from "./read-spans.js";
export { createCostViewTool } from "./cost-view.js";
export { createObsQueryTool } from "./observability/obs-query.js";
export { createObsSloAssertTool } from "./observability/obs-slo-assert.js";
export { createObsSnapshotTool } from "./observability/obs-snapshot.js";
export { createLedgerQueryTool } from "./ledger-query.js";
export { createOutputSearchTool } from "./output-search.js";
export { createTocTools } from "./toc.js";
export { createTapeTools } from "./tape.js";
export { createSessionCompactTool } from "./session-compact.js";
export { createRollbackLastPatchTool } from "./rollback-last-patch.js";
export { createScheduleIntentTool } from "./schedule-intent.js";
export { createSkillLoadTool } from "./skill-load.js";
export { createSkillCompleteTool } from "./skill-complete.js";
export { createSkillChainControlTool } from "./skill-chain-control.js";
export { createTaskLedgerTools } from "./task-ledger.js";
export {
  resolveBrewvaModelSelection,
  type BrewvaModelSelection,
  type BrewvaThinkingLevel,
} from "./model-selection.js";
export {
  BASE_BREWVA_TOOL_NAMES,
  BREWVA_TOOL_SURFACE_BY_NAME,
  MANAGED_BREWVA_TOOL_NAMES,
  OPERATOR_BREWVA_TOOL_NAMES,
  SKILL_BREWVA_TOOL_NAMES,
  getBrewvaToolSurface,
  isManagedBrewvaToolName,
  type BrewvaToolSurface,
} from "./surface.js";
export type {
  BrewvaManagedToolDefinition,
  BrewvaToolMetadata,
  BrewvaToolRuntime,
} from "./types.js";
export {
  getToolSessionId,
  readTextBatch,
  recordParallelReadTelemetry,
  resolveAdaptiveBatchSize,
  resolveParallelReadConfig,
  summarizeReadBatch,
  withParallelReadSlot,
} from "./utils/parallel-read.js";
