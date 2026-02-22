import { buildChannelDedupeKey, buildChannelSessionId } from "@brewva/brewva-runtime";
import type { ApprovalPayload, TurnEnvelope, TurnPart } from "@brewva/brewva-runtime";
import {
  decodeTelegramApprovalCallback,
  encodeTelegramApprovalCallback,
  type ApprovalCallbackPayload,
} from "./approval-callback.js";
import type {
  TelegramMessage,
  TelegramOutboundRequest,
  TelegramSendMethod,
  TelegramUpdate,
} from "./types.js";

const TELEGRAM_TEXT_LIMIT = 4096;

export interface TelegramInboundProjectionOptions {
  callbackSecret?: string;
  includeBotMessages?: boolean;
  now?: () => number;
}

export interface TelegramOutboundRenderOptions {
  inlineApproval?: boolean;
  callbackSecret?: string;
  maxTextLength?: number;
}

function nowMs(options?: TelegramInboundProjectionOptions): number {
  return options?.now ? options.now() : Date.now();
}

function coerceMessageTimestampMs(
  message: TelegramMessage,
  options?: TelegramInboundProjectionOptions,
): number {
  if (typeof message.date === "number" && Number.isFinite(message.date)) {
    return Math.floor(message.date * 1000);
  }
  return nowMs(options);
}

function coerceConversationId(chatId: number | string): string {
  return String(chatId).trim();
}

function resolveSenderName(message: TelegramMessage): string | undefined {
  const user = message.from;
  if (!user) return undefined;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  const username = user.username?.trim();
  if (username) return `@${username}`;
  return String(user.id);
}

function buildTurnParts(message: TelegramMessage): TurnPart[] {
  const parts: TurnPart[] = [];
  const text = message.text?.trim() || message.caption?.trim();
  if (text) {
    parts.push({ type: "text", text });
  }

  const photos = message.photo ?? [];
  if (photos.length > 0) {
    const selected = photos.reduce((best, current) => {
      if (!best) return current;
      const bestScore = (best.file_size ?? best.width * best.height) || 0;
      const currentScore = (current.file_size ?? current.width * current.height) || 0;
      return currentScore >= bestScore ? current : best;
    }, photos[0]);
    if (selected?.file_id) {
      parts.push({
        type: "image",
        uri: `telegram:file:${selected.file_id}`,
        mimeType: "image/jpeg",
      });
    }
  }

  const documentFileId = message.document?.file_id;
  if (documentFileId) {
    parts.push({
      type: "file",
      uri: `telegram:file:${documentFileId}`,
      name: message.document?.file_name,
      mimeType: message.document?.mime_type,
    });
  }

  const videoFileId = message.video?.file_id;
  if (videoFileId) {
    parts.push({
      type: "file",
      uri: `telegram:file:${videoFileId}`,
      name: message.video?.file_name,
      mimeType: message.video?.mime_type,
    });
  }

  const audioFileId = message.audio?.file_id;
  if (audioFileId) {
    parts.push({
      type: "file",
      uri: `telegram:file:${audioFileId}`,
      name: message.audio?.file_name,
      mimeType: message.audio?.mime_type,
    });
  }

  const voiceFileId = message.voice?.file_id;
  if (voiceFileId) {
    parts.push({
      type: "file",
      uri: `telegram:file:${voiceFileId}`,
      mimeType: message.voice?.mime_type,
    });
  }

  return parts;
}

function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let rest = text;
  let openFence = false;
  let fenceLang = "";

  while (rest.length > maxLength) {
    const candidate = rest.slice(0, maxLength);
    let breakIndex = -1;

    // Try to find a split point outside of a code fence.
    const lines = candidate.split("\n");
    let pos = 0;
    let bestBreak = -1;
    let fenceStateAtBest: boolean = openFence;
    let fenceLangAtBest: string = fenceLang;
    let currentFenceState: boolean = openFence;
    let currentFenceLang: string = fenceLang;

    for (const line of lines) {
      const lineEnd = pos + line.length;
      const fenceMatch = /^```(\w*)/.exec(line.trimStart());
      if (fenceMatch) {
        currentFenceState = !currentFenceState;
        currentFenceLang = currentFenceState ? (fenceMatch[1] ?? "") : "";
      }
      if (
        !currentFenceState &&
        lineEnd >= Math.floor(maxLength * 0.4) &&
        lineEnd < candidate.length
      ) {
        bestBreak = lineEnd + 1; // +1 to include the newline
        fenceStateAtBest = currentFenceState;
        fenceLangAtBest = currentFenceLang;
      }
      pos = lineEnd + 1; // +1 for the newline separator
    }

    if (bestBreak > 0) {
      breakIndex = bestBreak;
      openFence = fenceStateAtBest;
      fenceLang = fenceLangAtBest;
    } else {
      // Fallback: plain newline split or hard cut at maxLength.
      const splitAt = candidate.lastIndexOf("\n");
      breakIndex = splitAt >= Math.floor(maxLength * 0.4) ? splitAt + 1 : maxLength;
      // Recalculate fence state up to the actual break point.
      const segment = rest.slice(0, breakIndex);
      for (const match of segment.matchAll(/^```(\w*)/gm)) {
        openFence = !openFence;
        fenceLang = openFence ? (match[1] ?? "") : "";
      }
    }

    let chunk = rest.slice(0, breakIndex).trimEnd();
    if (openFence) {
      chunk += "\n```";
    }
    chunks.push(chunk);

    rest = rest.slice(breakIndex).trimStart();
    if (openFence) {
      rest = `\`\`\`${fenceLang}\n${rest}`;
    }
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}

function parseThreadId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function buildApprovalFallbackText(payload: ApprovalPayload): string {
  const lines = [`Approval required: ${payload.title}`];
  if (payload.detail) {
    lines.push(payload.detail);
  }
  const choices = payload.actions.map((action) => `${action.id} (${action.label})`).join(", ");
  if (choices) {
    lines.push(`Reply with one of: ${choices}`);
  }
  return lines.join("\n");
}

function buildReplyMarkup(
  approval: ApprovalPayload,
  callbackSecret: string,
  context?: string,
): Record<string, unknown> {
  const inlineKeyboard = approval.actions.map((action) => [
    {
      text: action.label,
      callback_data: encodeTelegramApprovalCallback(
        { requestId: approval.requestId, actionId: action.id },
        callbackSecret,
        context ? { context } : undefined,
      ),
    },
  ]);
  return { inline_keyboard: inlineKeyboard };
}

function buildSendRequest(
  method: TelegramSendMethod,
  params: Record<string, unknown>,
): TelegramOutboundRequest {
  return { method, params };
}

function parseApprovalDecision(
  data: string | undefined,
  callbackSecret: string | undefined,
  context?: string,
): ApprovalCallbackPayload | null {
  if (!data || !callbackSecret) return null;
  return decodeTelegramApprovalCallback(data, callbackSecret, context ? { context } : undefined);
}

function projectCallbackQueryToApprovalTurn(
  update: TelegramUpdate,
  options?: TelegramInboundProjectionOptions,
): TurnEnvelope | null {
  const callback = update.callback_query;
  if (!callback?.message) return null;

  const conversationId = coerceConversationId(callback.message.chat.id);
  if (!conversationId) return null;

  const decision = parseApprovalDecision(callback.data, options?.callbackSecret, conversationId);
  if (!decision) return null;

  const sessionId = buildChannelSessionId("telegram", conversationId);
  const timestamp = coerceMessageTimestampMs(callback.message, options);
  const senderName =
    [callback.from.first_name, callback.from.last_name].filter(Boolean).join(" ").trim() ||
    callback.from.username ||
    String(callback.from.id);

  return {
    schema: "brewva.turn.v1",
    kind: "approval",
    sessionId,
    turnId: `tg:callback:${callback.id}`,
    channel: "telegram",
    conversationId,
    messageId: callback.message.message_id.toString(),
    threadId:
      callback.message.message_thread_id !== undefined
        ? String(callback.message.message_thread_id)
        : undefined,
    timestamp,
    parts: [{ type: "text", text: `approval ${decision.requestId} -> ${decision.actionId}` }],
    approval: {
      requestId: decision.requestId,
      title: "Approval decision",
      actions: [{ id: decision.actionId, label: decision.actionId }],
    },
    meta: {
      updateId: update.update_id,
      callbackQueryId: callback.id,
      decisionActionId: decision.actionId,
      senderId: callback.from.id.toString(),
      senderName,
      senderUsername: callback.from.username ?? null,
    },
  };
}

function projectMessageToUserTurn(
  update: TelegramUpdate,
  message: TelegramMessage,
  options?: TelegramInboundProjectionOptions,
): TurnEnvelope | null {
  if (!options?.includeBotMessages && message.from?.is_bot) {
    return null;
  }

  const conversationId = coerceConversationId(message.chat.id);
  if (!conversationId) return null;

  const parts = buildTurnParts(message);
  if (parts.length === 0) return null;

  const edited = Boolean(update.edited_message);
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: buildChannelSessionId("telegram", conversationId),
    turnId: `tg:${edited ? "edited" : "message"}:${conversationId}:${message.message_id}`,
    channel: "telegram",
    conversationId,
    messageId: String(message.message_id),
    threadId:
      message.message_thread_id !== undefined ? String(message.message_thread_id) : undefined,
    timestamp: coerceMessageTimestampMs(message, options),
    parts,
    meta: {
      updateId: update.update_id,
      chatType: message.chat.type,
      senderId: message.from?.id?.toString() ?? null,
      senderName: resolveSenderName(message) ?? null,
      senderUsername: message.from?.username ?? null,
      edited,
    },
  };
}

export function projectTelegramUpdateToTurn(
  update: TelegramUpdate,
  options?: TelegramInboundProjectionOptions,
): TurnEnvelope | null {
  if (update.callback_query) {
    return projectCallbackQueryToApprovalTurn(update, options);
  }
  const message = update.message ?? update.edited_message;
  if (!message) return null;
  return projectMessageToUserTurn(update, message, options);
}

export function buildTelegramInboundDedupeKey(update: TelegramUpdate): string | null {
  if (update.callback_query?.id) {
    return `telegram:callback:${update.callback_query.id}`;
  }

  if (update.message) {
    const conversationId = coerceConversationId(update.message.chat.id);
    if (!conversationId) return null;
    return buildChannelDedupeKey("telegram", conversationId, String(update.message.message_id));
  }

  if (update.edited_message) {
    const conversationId = coerceConversationId(update.edited_message.chat.id);
    if (!conversationId) return null;
    return buildChannelDedupeKey(
      "telegram",
      conversationId,
      `edit:${update.edited_message.message_id}:${update.update_id}`,
    );
  }

  return null;
}

export function renderTurnToTelegramRequests(
  turn: TurnEnvelope,
  options: TelegramOutboundRenderOptions = {},
): TelegramOutboundRequest[] {
  const maxTextLength = Math.max(1, Math.floor(options.maxTextLength ?? TELEGRAM_TEXT_LIMIT));
  const chatId = turn.conversationId;
  const messageThreadId = parseThreadId(turn.threadId);
  const requests: TelegramOutboundRequest[] = [];

  const textParts = turn.parts.filter(
    (part): part is Extract<TurnPart, { type: "text" }> => part.type === "text",
  );
  const mediaParts = turn.parts.filter((part) => part.type !== "text");
  const appendSplitSendMessage = (text: string, replyMarkup?: Record<string, unknown>): void => {
    for (const [index, chunk] of splitText(text, maxTextLength).entries()) {
      if (!chunk) continue;
      requests.push(
        buildSendRequest("sendMessage", {
          chat_id: chatId,
          text: chunk,
          ...(index === 0 && replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
        }),
      );
    }
  };
  const hasApprovalHint = (): boolean =>
    requests.some(
      (entry) =>
        entry.method === "sendMessage" &&
        typeof entry.params.text === "string" &&
        entry.params.text.includes("Reply with one of:"),
    );

  for (const textPart of textParts) {
    for (const chunk of splitText(textPart.text, maxTextLength)) {
      if (!chunk) continue;
      requests.push(
        buildSendRequest("sendMessage", {
          chat_id: chatId,
          text: chunk,
          ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
        }),
      );
    }
  }

  for (const part of mediaParts) {
    if (part.type === "image") {
      requests.push(
        buildSendRequest("sendPhoto", {
          chat_id: chatId,
          photo: part.uri,
          ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
        }),
      );
      continue;
    }
    requests.push(
      buildSendRequest("sendDocument", {
        chat_id: chatId,
        document: part.uri,
        ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
      }),
    );
  }

  if (turn.kind === "approval" && turn.approval) {
    const inlineEnabled = options.inlineApproval !== false;
    const callbackSecret = options.callbackSecret?.trim();
    const fallbackText = buildApprovalFallbackText(turn.approval);
    const baseText = turn.parts.find(
      (part): part is Extract<TurnPart, { type: "text" }> => part.type === "text",
    )?.text;
    const approvalText = baseText?.trim() || fallbackText;

    if (inlineEnabled && callbackSecret) {
      try {
        const markup = buildReplyMarkup(turn.approval, callbackSecret, chatId);
        const firstTextIdx = requests.findIndex((entry) => entry.method === "sendMessage");
        if (firstTextIdx >= 0) {
          requests[firstTextIdx] = buildSendRequest("sendMessage", {
            ...requests[firstTextIdx]!.params,
            reply_markup: markup,
          });
        } else {
          appendSplitSendMessage(approvalText, markup);
        }
      } catch {
        if (!hasApprovalHint()) {
          appendSplitSendMessage(fallbackText);
        }
      }
    } else if (!hasApprovalHint()) {
      appendSplitSendMessage(fallbackText);
    }
  }

  return requests;
}
