import { TOOL_RESULT_RECORDED_EVENT_TYPE } from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { projectTruthFromToolResult } from "../truth/tool-result-projector.js";
import type { BrewvaStructuredEvent } from "../types.js";
import type { EventPipelineService } from "./event-pipeline.js";
import type { TaskService } from "./task.js";
import type { TruthService } from "./truth.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceTruthProjectionInput(value: unknown): {
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  verdict: "pass" | "fail" | "inconclusive";
  ledgerRow: {
    id: string;
    outputHash: string;
    argsSummary: string;
    outputSummary: string;
  };
  metadata?: Record<string, unknown>;
} | null {
  if (!isRecord(value)) return null;
  const toolName = typeof value.toolName === "string" ? value.toolName.trim() : "";
  const outputText = typeof value.outputText === "string" ? value.outputText : "";
  const verdict = value.verdict;
  const args = isRecord(value.args) ? value.args : {};
  const ledgerRow = isRecord(value.ledgerRow) ? value.ledgerRow : null;
  if (
    !toolName ||
    !ledgerRow ||
    typeof ledgerRow.id !== "string" ||
    typeof ledgerRow.outputHash !== "string" ||
    typeof ledgerRow.argsSummary !== "string" ||
    typeof ledgerRow.outputSummary !== "string"
  ) {
    return null;
  }
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
    return null;
  }

  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  return {
    toolName,
    args,
    outputText,
    verdict,
    ledgerRow: {
      id: ledgerRow.id,
      outputHash: ledgerRow.outputHash,
      argsSummary: ledgerRow.argsSummary,
      outputSummary: ledgerRow.outputSummary,
    },
    metadata,
  };
}

export interface TruthProjectorServiceOptions {
  cwd: RuntimeKernelContext["cwd"];
  getTaskState: RuntimeKernelContext["getTaskState"];
  getTruthState: RuntimeKernelContext["getTruthState"];
  eventPipeline: Pick<EventPipelineService, "subscribeEvents">;
  taskService: Pick<TaskService, "recordTaskBlocker" | "resolveTaskBlocker">;
  truthService: Pick<TruthService, "upsertTruthFact" | "resolveTruthFact">;
}

export class TruthProjectorService {
  constructor(options: TruthProjectorServiceOptions) {
    options.eventPipeline.subscribeEvents((event) => {
      this.handleEvent(options, event);
    });
  }

  private handleEvent(options: TruthProjectorServiceOptions, event: BrewvaStructuredEvent): void {
    if (event.type !== TOOL_RESULT_RECORDED_EVENT_TYPE) {
      return;
    }
    const payload = isRecord(event.payload) ? event.payload : null;
    const projection = coerceTruthProjectionInput(payload?.truthProjection);
    if (!projection) {
      return;
    }

    projectTruthFromToolResult(
      {
        cwd: options.cwd,
        getTaskState: (sessionId) => options.getTaskState(sessionId),
        getTruthState: (sessionId) => options.getTruthState(sessionId),
        upsertTruthFact: (sessionId, input) =>
          options.truthService.upsertTruthFact(sessionId, input),
        resolveTruthFact: (sessionId, truthFactId) =>
          options.truthService.resolveTruthFact(sessionId, truthFactId),
        recordTaskBlocker: (sessionId, input) =>
          options.taskService.recordTaskBlocker(sessionId, input),
        resolveTaskBlocker: (sessionId, blockerId) =>
          options.taskService.resolveTaskBlocker(sessionId, blockerId),
      },
      {
        sessionId: event.sessionId,
        toolName: projection.toolName,
        args: projection.args,
        outputText: projection.outputText,
        verdict: projection.verdict,
        ledgerRow: projection.ledgerRow,
        metadata: projection.metadata,
      },
    );
  }
}
