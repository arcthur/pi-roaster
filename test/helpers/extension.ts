import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type ExtensionTestHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => unknown;

export function createMockExtensionAPI(): {
  api: ExtensionAPI;
  handlers: Map<string, ExtensionTestHandler[]>;
} {
  const handlers = new Map<string, ExtensionTestHandler[]>();
  const api = {
    on(event: string, handler: ExtensionTestHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

export function invokeHandler<T = unknown>(
  handlers: Map<string, ExtensionTestHandler[]>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): T {
  const list = handlers.get(eventName) ?? [];
  const handler = list[0];
  if (!handler) {
    throw new Error(`Missing handler for event: ${eventName}`);
  }
  return handler(event, ctx) as T;
}

export async function invokeHandlerAsync<T = unknown>(
  handlers: Map<string, ExtensionTestHandler[]>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): Promise<T> {
  const list = handlers.get(eventName) ?? [];
  const handler = list[0];
  if (!handler) {
    throw new Error(`Missing handler for event: ${eventName}`);
  }
  return (await handler(event, ctx)) as T;
}

export function invokeHandlers<T = unknown>(
  handlers: Map<string, ExtensionTestHandler[]>,
  eventName: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  options: { stopOnBlock?: boolean } = {},
): T[] {
  const list = handlers.get(eventName) ?? [];
  const results: T[] = [];

  for (const handler of list) {
    const result = handler(event, ctx) as T;
    results.push(result);

    if (
      options.stopOnBlock &&
      result &&
      typeof result === "object" &&
      "block" in (result as Record<string, unknown>) &&
      (result as Record<string, unknown>).block === true
    ) {
      break;
    }
  }

  return results;
}
