import type { ChannelCapabilities } from "./capabilities.js";
import type { ApprovalPayload, TurnEnvelope, TurnPart } from "./turn.js";

export interface TurnDeliveryPlan {
  streamMode: "stream" | "buffered";
  approvalMode: "inline" | "text" | "none";
  codeBlockMode: "native" | "plain_text";
  mediaMode: "native" | "link_only";
  threadMode: "native" | "prepend_context";
}

function stripCodeFences(text: string): string {
  return text.replace(/```([\w-]+)?\n?([\s\S]*?)```/g, (_match, _lang, code: string) => {
    const trimmed = code.trimEnd();
    return trimmed.length > 0 ? trimmed : "";
  });
}

function approvalAsText(payload: ApprovalPayload): string {
  const lines = [`Approval required: ${payload.title}`];
  if (payload.detail) {
    lines.push(payload.detail);
  }
  if (payload.actions.length > 0) {
    const actionSummary = payload.actions
      .map((action) => `${action.id} (${action.label})`)
      .join(", ");
    lines.push(`Reply with one of: ${actionSummary}`);
  }
  return lines.join("\n");
}

function toAttachmentSummary(part: Exclude<TurnPart, { type: "text" }>): string {
  if (part.type === "image") {
    return `[image] ${part.uri}`;
  }
  const name = part.name ? ` (${part.name})` : "";
  return `[file${name}] ${part.uri}`;
}

function normalizeTextPart(
  part: TurnPart,
  codeBlockMode: TurnDeliveryPlan["codeBlockMode"],
): TurnPart {
  if (part.type !== "text" || codeBlockMode === "native") {
    return part;
  }
  return {
    type: "text",
    text: stripCodeFences(part.text),
  };
}

export function resolveTurnDeliveryPlan(
  turn: TurnEnvelope,
  capabilities: ChannelCapabilities,
): TurnDeliveryPlan {
  return {
    streamMode: capabilities.streaming ? "stream" : "buffered",
    approvalMode:
      turn.kind === "approval" ? (capabilities.inlineActions ? "inline" : "text") : "none",
    codeBlockMode: capabilities.codeBlocks ? "native" : "plain_text",
    mediaMode: capabilities.multiModal ? "native" : "link_only",
    threadMode: capabilities.threadedReplies ? "native" : "prepend_context",
  };
}

export function prepareTurnForDelivery(
  turn: TurnEnvelope,
  capabilities: ChannelCapabilities,
): TurnEnvelope {
  const plan = resolveTurnDeliveryPlan(turn, capabilities);
  const preparedParts: TurnPart[] = [];

  for (const part of turn.parts) {
    if (part.type === "text") {
      preparedParts.push(normalizeTextPart(part, plan.codeBlockMode));
      continue;
    }
    if (plan.mediaMode === "native") {
      preparedParts.push(part);
      continue;
    }
    preparedParts.push({ type: "text", text: toAttachmentSummary(part) });
  }

  if (plan.approvalMode === "text" && turn.approval) {
    preparedParts.push({ type: "text", text: approvalAsText(turn.approval) });
  }

  if (plan.threadMode === "prepend_context" && turn.threadId) {
    const prefix = `[thread:${turn.threadId}]`;
    const firstTextIndex = preparedParts.findIndex((part) => part.type === "text");
    if (firstTextIndex === -1) {
      preparedParts.unshift({ type: "text", text: prefix });
    } else {
      const first = preparedParts[firstTextIndex];
      if (first && first.type === "text") {
        preparedParts[firstTextIndex] = {
          type: "text",
          text: `${prefix}\n${first.text}`,
        };
      }
    }
  }

  const meta = {
    ...turn.meta,
    deliveryPlan: plan,
  };

  return {
    ...turn,
    parts: preparedParts,
    meta,
  };
}
