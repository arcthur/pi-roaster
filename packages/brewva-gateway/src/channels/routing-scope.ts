import { normalizeChannelId, type TurnEnvelope } from "@brewva/brewva-runtime/channels";

export type RoutingScopeStrategy = "chat" | "thread";

export function buildRoutingScopeKey(turn: TurnEnvelope, strategy: RoutingScopeStrategy): string {
  const channel = normalizeChannelId(turn.channel) || turn.channel.trim().toLowerCase();
  const conversationId = turn.conversationId.trim();
  if (strategy === "thread") {
    const thread = (turn.threadId ?? "root").trim() || "root";
    return `${channel}:${conversationId}:thread:${thread}`;
  }
  return `${channel}:${conversationId}`;
}

export function buildAgentScopedConversationKey(agentId: string, scopeKey: string): string {
  return `agent:${agentId}:${scopeKey}`;
}
