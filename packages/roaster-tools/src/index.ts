import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createAstGrepTools } from "./ast-grep.js";
import { createCostViewTool } from "./cost-view.js";
import { createLedgerQueryTool } from "./ledger-query.js";
import { createLookAtTool } from "./look-at.js";
import { createLspTools } from "./lsp.js";
import { createRollbackLastPatchTool } from "./rollback-last-patch.js";
import { createSkillCompleteTool } from "./skill-complete.js";
import { createSkillLoadTool } from "./skill-load.js";
import { createTaskLedgerTools } from "./task-ledger.js";
import type { RoasterToolRuntime } from "./types.js";

export interface BuildRoasterToolsOptions {
  runtime: RoasterToolRuntime;
}

export function buildRoasterTools(options: BuildRoasterToolsOptions): ToolDefinition<any>[] {
  return [
    ...createLspTools(),
    ...createAstGrepTools(),
    createLookAtTool(),
    createCostViewTool({ runtime: options.runtime }),
    createLedgerQueryTool({ runtime: options.runtime }),
    createRollbackLastPatchTool({ runtime: options.runtime }),
    createSkillLoadTool({ runtime: options.runtime }),
    createSkillCompleteTool({ runtime: options.runtime }),
    ...createTaskLedgerTools({ runtime: options.runtime }),
  ];
}

export { createLspTools } from "./lsp.js";
export { createAstGrepTools } from "./ast-grep.js";
export { createLookAtTool } from "./look-at.js";
export { createCostViewTool } from "./cost-view.js";
export { createLedgerQueryTool } from "./ledger-query.js";
export { createRollbackLastPatchTool } from "./rollback-last-patch.js";
export { createSkillLoadTool } from "./skill-load.js";
export { createSkillCompleteTool } from "./skill-complete.js";
export { createTaskLedgerTools } from "./task-ledger.js";
