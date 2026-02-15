import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { RoasterRuntime, type RoasterRuntimeOptions } from "@pi-roaster/roaster-runtime";
import { buildRoasterTools } from "@pi-roaster/roaster-tools";
import { registerContextTransform } from "./context-transform.js";
import { registerCompletionGuard } from "./completion-guard.js";
import { registerEventStream } from "./event-stream.js";
import { registerLedgerWriter } from "./ledger-writer.js";
import { registerMemory } from "./memory.js";
import { registerNotification } from "./notification.js";
import { registerQualityGate } from "./quality-gate.js";

export interface CreateRoasterExtensionOptions extends RoasterRuntimeOptions {
  runtime?: RoasterRuntime;
  registerTools?: boolean;
}

function registerAllHandlers(pi: ExtensionAPI, runtime: RoasterRuntime): void {
  registerEventStream(pi, runtime);
  registerContextTransform(pi, runtime);
  registerQualityGate(pi, runtime);
  registerLedgerWriter(pi, runtime);
  registerMemory(pi, runtime);
  registerCompletionGuard(pi, runtime);
  registerNotification(pi);
}

export function createRoasterExtension(options: CreateRoasterExtensionOptions = {}): ExtensionFactory {
  return (pi) => {
    const runtime = options.runtime ?? new RoasterRuntime(options);

    if (options.registerTools !== false) {
      const tools = buildRoasterTools({ runtime });
      for (const tool of tools) {
        pi.registerTool(tool);
      }
    }

    registerAllHandlers(pi, runtime);
  };
}

export function roasterExtension(options: CreateRoasterExtensionOptions = {}): ExtensionFactory {
  return createRoasterExtension(options);
}

export { registerContextTransform } from "./context-transform.js";
export { registerEventStream } from "./event-stream.js";
export { registerQualityGate } from "./quality-gate.js";
export { registerLedgerWriter } from "./ledger-writer.js";
export { registerMemory } from "./memory.js";
export { registerCompletionGuard } from "./completion-guard.js";
export { registerNotification } from "./notification.js";
