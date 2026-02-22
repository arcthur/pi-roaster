import { createHash } from "node:crypto";
import { normalizeChannelId } from "./channel-id.js";

const SESSION_ID_PREFIX = "channel:";
const SESSION_HASH_LENGTH = 40;

function normalizeToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

export function buildRawConversationKey(channel: string, conversationId: string): string {
  const normalizedChannel = normalizeChannelId(normalizeToken(channel, "channel"));
  if (!normalizedChannel) {
    throw new Error("channel is required");
  }
  const normalizedConversationId = normalizeToken(conversationId, "conversationId");
  return `${normalizedChannel}:${normalizedConversationId}`;
}

export function buildChannelSessionId(channel: string, conversationId: string): string {
  const rawKey = buildRawConversationKey(channel, conversationId);
  const hash = createHash("sha256").update(rawKey).digest("hex");
  return `${SESSION_ID_PREFIX}${hash.slice(0, SESSION_HASH_LENGTH)}`;
}

export function buildChannelDedupeKey(
  channel: string,
  conversationId: string,
  messageId: string,
): string {
  const normalizedMessageId = normalizeToken(messageId, "messageId");
  return `${buildRawConversationKey(channel, conversationId)}:${normalizedMessageId}`;
}
