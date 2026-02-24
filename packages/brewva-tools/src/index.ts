import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createAstGrepTools } from "./ast-grep.js";
import { createCostViewTool } from "./cost-view.js";
import { createExecTool } from "./exec.js";
import { createLedgerQueryTool } from "./ledger-query.js";
import { createLookAtTool } from "./look-at.js";
import { createLspTools } from "./lsp.js";
import { createProcessTool } from "./process.js";
import { createRollbackLastPatchTool } from "./rollback-last-patch.js";
import { createScheduleIntentTool } from "./schedule-intent.js";
import { createSessionCompactTool } from "./session-compact.js";
import { createSkillCompleteTool } from "./skill-complete.js";
import { createSkillLoadTool } from "./skill-load.js";
import { createTapeTools } from "./tape.js";
import { createTaskLedgerTools } from "./task-ledger.js";
import type { BrewvaToolRuntime } from "./types.js";

export interface BuildBrewvaToolsOptions {
  runtime: BrewvaToolRuntime;
}

export function buildBrewvaTools(options: BuildBrewvaToolsOptions): ToolDefinition[] {
  return [
    ...createLspTools({ runtime: options.runtime }),
    ...createAstGrepTools({ runtime: options.runtime }),
    createLookAtTool(),
    createExecTool({ runtime: options.runtime }),
    createProcessTool(),
    createCostViewTool({ runtime: options.runtime }),
    createLedgerQueryTool({ runtime: options.runtime }),
    createScheduleIntentTool({ runtime: options.runtime }),
    ...createTapeTools({ runtime: options.runtime }),
    createSessionCompactTool({ runtime: options.runtime }),
    createRollbackLastPatchTool({ runtime: options.runtime }),
    createSkillLoadTool({ runtime: options.runtime }),
    createSkillCompleteTool({ runtime: options.runtime }),
    ...createTaskLedgerTools({ runtime: options.runtime }),
  ];
}

export { createLspTools } from "./lsp.js";
export { createAstGrepTools } from "./ast-grep.js";
export { createLookAtTool } from "./look-at.js";
export { createExecTool } from "./exec.js";
export { createProcessTool } from "./process.js";
export { createCostViewTool } from "./cost-view.js";
export { createLedgerQueryTool } from "./ledger-query.js";
export { createTapeTools } from "./tape.js";
export { createSessionCompactTool } from "./session-compact.js";
export { createRollbackLastPatchTool } from "./rollback-last-patch.js";
export { createScheduleIntentTool } from "./schedule-intent.js";
export { createSkillLoadTool } from "./skill-load.js";
export { createSkillCompleteTool } from "./skill-complete.js";
export { createTaskLedgerTools } from "./task-ledger.js";
