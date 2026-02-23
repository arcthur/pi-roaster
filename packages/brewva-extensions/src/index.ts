import { BrewvaRuntime, type BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { registerCompletionGuard } from "./completion-guard.js";
import { registerContextTransform } from "./context-transform.js";
import { registerEventStream } from "./event-stream.js";
import { registerLedgerWriter } from "./ledger-writer.js";
import { registerMemoryBridge } from "./memory-bridge.js";
import { registerNotification } from "./notification.js";
import { registerQualityGate } from "./quality-gate.js";

export interface CreateBrewvaExtensionOptions extends BrewvaRuntimeOptions {
  runtime?: BrewvaRuntime;
  registerTools?: boolean;
}

function registerAllHandlers(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  registerEventStream(pi, runtime);
  registerContextTransform(pi, runtime);
  registerQualityGate(pi, runtime);
  registerLedgerWriter(pi, runtime);
  registerCompletionGuard(pi, runtime);
  registerNotification(pi, runtime);
  registerMemoryBridge(pi, runtime);
}

export function createBrewvaExtension(
  options: CreateBrewvaExtensionOptions = {},
): ExtensionFactory {
  return (pi) => {
    const runtime = options.runtime ?? new BrewvaRuntime(options);

    if (options.registerTools !== false) {
      const tools = buildBrewvaTools({ runtime });
      for (const tool of tools) {
        pi.registerTool(tool);
      }
    }

    registerAllHandlers(pi, runtime);
  };
}

export function brewvaExtension(options: CreateBrewvaExtensionOptions = {}): ExtensionFactory {
  return createBrewvaExtension(options);
}

export {
  createRuntimeCoreBridgeExtension,
  registerRuntimeCoreBridge,
} from "./runtime-core-bridge.js";
export { registerContextTransform } from "./context-transform.js";
export { registerEventStream } from "./event-stream.js";
export { registerQualityGate } from "./quality-gate.js";
export { registerLedgerWriter } from "./ledger-writer.js";
export { registerCompletionGuard } from "./completion-guard.js";
export { registerMemoryBridge } from "./memory-bridge.js";
export { registerNotification } from "./notification.js";
export { createRuntimeChannelTurnBridge } from "./channel-turn-bridge.js";
export { createRuntimeTelegramChannelBridge } from "./telegram-channel-bridge.js";
