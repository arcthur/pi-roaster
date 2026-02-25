import { createA2ATools } from "@brewva/brewva-tools";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

export interface ChannelA2AAdapter {
  send(input: {
    fromSessionId: string;
    fromAgentId?: string;
    toAgentId: string;
    message: string;
    correlationId?: string;
    depth?: number;
    hops?: number;
  }): Promise<{
    ok: boolean;
    toAgentId: string;
    responseText?: string;
    error?: string;
    depth?: number;
    hops?: number;
  }>;
  broadcast(input: {
    fromSessionId: string;
    fromAgentId?: string;
    toAgentIds: string[];
    message: string;
    correlationId?: string;
    depth?: number;
    hops?: number;
  }): Promise<{
    ok: boolean;
    error?: string;
    results: Array<{
      toAgentId: string;
      ok: boolean;
      responseText?: string;
      error?: string;
      depth?: number;
      hops?: number;
    }>;
  }>;
  listAgents(input?: { includeDeleted?: boolean }): Promise<
    Array<{
      agentId: string;
      status: "active" | "deleted";
    }>
  >;
}

export function createChannelA2AExtension(options: {
  adapter: ChannelA2AAdapter;
}): ExtensionFactory {
  return (pi) => {
    const tools = createA2ATools({
      runtime: {
        orchestration: {
          a2a: options.adapter,
        },
      },
    });
    for (const tool of tools) {
      pi.registerTool(tool);
    }
  };
}
