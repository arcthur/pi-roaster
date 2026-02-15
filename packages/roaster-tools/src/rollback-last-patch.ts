import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { RoasterToolOptions } from "./types.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";

function formatRollbackMessage(input: {
  ok: boolean;
  patchSetId?: string;
  restoredPaths: string[];
  failedPaths: string[];
  reason?: string;
}): string {
  if (!input.ok) {
    if (input.reason === "no_patchset") {
      return "No tracked patch set is available to roll back.";
    }
    const failed = input.failedPaths.length > 0 ? input.failedPaths.join(", ") : "(unknown)";
    return `Rollback failed. Could not restore: ${failed}`;
  }

  const lines = [
    `Rolled back patch set: ${input.patchSetId ?? "unknown"}`,
    `Restored files: ${input.restoredPaths.length}`,
  ];
  if (input.restoredPaths.length > 0) {
    lines.push(input.restoredPaths.map((path) => `- ${path}`).join("\n"));
  }
  return lines.join("\n");
}

export function createRollbackLastPatchTool(options: RoasterToolOptions): ToolDefinition<any> {
  return {
    name: "rollback_last_patch",
    label: "Rollback Last Patch",
    description: "Roll back the most recently tracked file mutation patch set for this session.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const rollback = options.runtime.rollbackLastPatchSet(sessionId);
      return textResult(formatRollbackMessage(rollback), {
        ok: rollback.ok,
        patchSetId: rollback.patchSetId,
        restoredPaths: rollback.restoredPaths,
        failedPaths: rollback.failedPaths,
        reason: rollback.reason,
      });
    },
  };
}
