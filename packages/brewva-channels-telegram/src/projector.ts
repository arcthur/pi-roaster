import { createHash } from "node:crypto";
import { buildChannelDedupeKey, buildChannelSessionId } from "@brewva/brewva-runtime/channels";
import type { ApprovalPayload, TurnEnvelope, TurnPart } from "@brewva/brewva-runtime/channels";
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
const TELEGRAM_UI_VERSION = "telegram-ui/v1";
const TELEGRAM_UI_CODE_BLOCK = /```([a-z0-9_-]*)\s*\n([\s\S]*?)```/gi;
const TELEGRAM_UI_ACTION_ID_MAX_LENGTH = 12;
const TELEGRAM_UI_REQUEST_PREFIX_MAX_LENGTH = 7;
const TELEGRAM_UI_REQUEST_HASH_LENGTH = 8;

interface TelegramUiAction {
  actionId: string;
  label: string;
  style?: "primary" | "neutral" | "danger";
}

interface TelegramUiActionExtraction {
  actions: TelegramUiAction[];
  rows: string[][];
}

export interface TelegramApprovalStateSnapshot {
  screenId?: string;
  stateKey?: string;
  state?: unknown;
}

interface TelegramUiProjection {
  approval: ApprovalPayload;
  approvalText: string;
  fallbackText: string;
  cleanedText: string;
  actionRows: string[][];
  stateSnapshot?: TelegramApprovalStateSnapshot;
}

export interface TelegramApprovalStateResolveParams {
  conversationId: string;
  requestId: string;
  actionId: string;
}

export interface TelegramApprovalStatePersistParams {
  conversationId: string;
  requestId: string;
  snapshot: TelegramApprovalStateSnapshot;
}

export interface TelegramInboundProjectionOptions {
  callbackSecret?: string;
  includeBotMessages?: boolean;
  now?: () => number;
  resolveApprovalState?: (
    params: TelegramApprovalStateResolveParams,
  ) => TelegramApprovalStateSnapshot | null | undefined;
}

export interface TelegramOutboundRenderOptions {
  inlineApproval?: boolean;
  callbackSecret?: string;
  maxTextLength?: number;
  persistApprovalState?: (params: TelegramApprovalStatePersistParams) => void;
  persistApprovalRouting?: (params: TelegramApprovalRoutingPersistParams) => void;
}

export interface TelegramApprovalRoutingPersistParams {
  conversationId: string;
  requestId: string;
  agentId?: string;
  agentSessionId?: string;
  turnId?: string;
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

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeCallbackToken(value: unknown, maxLength: number): string | undefined {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return undefined;
  const compact = normalized
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!compact) return undefined;
  return compact.slice(0, Math.max(1, maxLength));
}

function normalizeActionStyle(value: unknown): "primary" | "neutral" | "danger" | undefined {
  if (value !== "primary" && value !== "neutral" && value !== "danger") {
    return undefined;
  }
  return value;
}

function summarizeState(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized === "{}" || serialized === "[]") {
      return undefined;
    }
    return serialized.length <= 180 ? serialized : `${serialized.slice(0, 177)}...`;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasOwnProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeApprovalStateSnapshot(value: unknown): TelegramApprovalStateSnapshot | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const screenId = normalizeOptionalText(record.screenId ?? record.screen_id);
  const stateKey = normalizeOptionalText(record.stateKey ?? record.state_key);
  const state = hasOwnProperty(record, "state") ? record.state : undefined;
  if (!screenId && !stateKey && state === undefined) {
    return undefined;
  }
  return {
    ...(screenId ? { screenId } : {}),
    ...(stateKey ? { stateKey } : {}),
    ...(state !== undefined ? { state } : {}),
  };
}

function buildApprovalStateDetail(
  snapshot: TelegramApprovalStateSnapshot | undefined,
): string | undefined {
  if (!snapshot) return undefined;
  const detailLines: string[] = [];
  if (snapshot.screenId) detailLines.push(`screen: ${snapshot.screenId}`);
  if (snapshot.stateKey) detailLines.push(`state_key: ${snapshot.stateKey}`);
  const stateSummary = summarizeState(snapshot.state);
  if (stateSummary) detailLines.push(`state: ${stateSummary}`);
  return detailLines.length > 0 ? detailLines.join("\n") : undefined;
}

function extractApprovalStateSnapshotFromTurnMeta(
  turn: TurnEnvelope,
): TelegramApprovalStateSnapshot | undefined {
  const meta = asRecord(turn.meta);
  if (!meta) return undefined;

  const nested =
    normalizeApprovalStateSnapshot(meta.approvalState) ??
    normalizeApprovalStateSnapshot(meta.approval_state);
  if (nested) {
    return nested;
  }

  const screenId = normalizeOptionalText(meta.approvalScreenId ?? meta.approval_screen_id);
  const stateKey = normalizeOptionalText(meta.approvalStateKey ?? meta.approval_state_key);
  const state = hasOwnProperty(meta, "approvalState") ? meta.approvalState : undefined;
  if (!screenId && !stateKey && state === undefined) {
    return undefined;
  }
  return {
    ...(screenId ? { screenId } : {}),
    ...(stateKey ? { stateKey } : {}),
    ...(state !== undefined ? { state } : {}),
  };
}

function parseUiAction(value: unknown, fallbackIndex: number): TelegramUiAction | null {
  const record = asRecord(value);
  if (!record) return null;

  const actionId =
    normalizeCallbackToken(record.action_id ?? record.id, TELEGRAM_UI_ACTION_ID_MAX_LENGTH) ??
    `a${fallbackIndex}`;
  const label =
    normalizeOptionalText(record.label) ??
    normalizeOptionalText(record.text) ??
    normalizeOptionalText(record.title) ??
    actionId;
  const style = normalizeActionStyle(record.style);

  return {
    actionId,
    label,
    ...(style ? { style } : {}),
  };
}

function extractUiActions(components: unknown): TelegramUiActionExtraction {
  if (!Array.isArray(components)) {
    return { actions: [], rows: [] };
  }

  const dedupedActions = new Map<string, TelegramUiAction>();
  const rowGroups: string[][] = [];
  let fallbackIndex = 1;
  const addAction = (value: unknown): TelegramUiAction | null => {
    const parsed = parseUiAction(value, fallbackIndex);
    if (!parsed) return null;
    fallbackIndex += 1;
    if (!dedupedActions.has(parsed.actionId)) {
      dedupedActions.set(parsed.actionId, parsed);
    }
    return dedupedActions.get(parsed.actionId) ?? parsed;
  };
  const appendRow = (values: unknown[]): void => {
    const row: string[] = [];
    for (const value of values) {
      const action = addAction(value);
      if (!action || row.includes(action.actionId)) continue;
      row.push(action.actionId);
    }
    if (row.length > 0) {
      rowGroups.push(row);
    }
  };

  for (const component of components) {
    const record = asRecord(component);
    if (!record) continue;

    const rows = Array.isArray(record.rows) ? record.rows : [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      appendRow(row);
    }

    if (record.type === "single_select" && Array.isArray(record.options)) {
      appendRow(record.options);
    }

    if (Array.isArray(record.actions)) {
      appendRow(record.actions);
    }
  }

  const actions = [...dedupedActions.values()];
  const rows = rowGroups
    .map((row) => row.filter((actionId) => dedupedActions.has(actionId)))
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    for (const action of actions) {
      rows.push([action.actionId]);
    }
  }
  return { actions, rows };
}

function buildUiRequestId(payload: Record<string, unknown>, actions: TelegramUiAction[]): string {
  const explicitRequestId = normalizeCallbackToken(
    payload.request_id,
    TELEGRAM_UI_ACTION_ID_MAX_LENGTH,
  );
  if (explicitRequestId) {
    return explicitRequestId;
  }

  const screenToken =
    normalizeCallbackToken(payload.screen_id, TELEGRAM_UI_REQUEST_PREFIX_MAX_LENGTH) ?? "ui";
  const seed = JSON.stringify({
    screenId: payload.screen_id ?? null,
    state: payload.state ?? null,
    actions: actions.map((action) => action.actionId),
  });
  const digest = createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, TELEGRAM_UI_REQUEST_HASH_LENGTH);
  return `${screenToken}_${digest}`;
}

function projectTelegramUiBlock(text: string): TelegramUiProjection | null {
  TELEGRAM_UI_CODE_BLOCK.lastIndex = 0;
  for (const match of text.matchAll(TELEGRAM_UI_CODE_BLOCK)) {
    const language = (match[1] ?? "").trim().toLowerCase();
    const body = (match[2] ?? "").trim();
    if (!body) continue;
    if (
      language &&
      language !== "telegram-ui" &&
      language !== "telegram_ui" &&
      language !== "json"
    ) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const payload = asRecord(parsed);
    if (!payload) continue;
    if (normalizeOptionalText(payload.version) !== TELEGRAM_UI_VERSION) {
      continue;
    }

    const { actions, rows } = extractUiActions(payload.components);
    if (actions.length === 0) {
      continue;
    }

    const requestId = buildUiRequestId(payload, actions);
    const title =
      normalizeOptionalText(payload.text) ??
      normalizeOptionalText(payload.title) ??
      "Choose an action";
    const fallbackCandidate = normalizeOptionalText(payload.fallback_text);
    const stateSnapshot = normalizeApprovalStateSnapshot({
      screenId: payload.screen_id,
      stateKey: payload.state_key,
      ...(hasOwnProperty(payload, "state") ? { state: payload.state } : {}),
    });

    const detailLines: string[] = [];
    const stateDetail = buildApprovalStateDetail(stateSnapshot);
    if (stateDetail) detailLines.push(stateDetail);
    if (fallbackCandidate) detailLines.push(fallbackCandidate);

    const approvalActions: ApprovalPayload["actions"] = actions.map((action) => {
      const mapped: ApprovalPayload["actions"][number] = {
        id: action.actionId,
        label: action.label,
      };
      if (action.style) {
        mapped.style = action.style;
      }
      return mapped;
    });

    const approval: ApprovalPayload = {
      requestId,
      title,
      ...(detailLines.length > 0 ? { detail: detailLines.join("\n") } : {}),
      actions: approvalActions,
    };

    const fullMatch = match[0] ?? "";
    const matchStart = match.index ?? 0;
    const cleanedText =
      `${text.slice(0, matchStart)}${text.slice(matchStart + fullMatch.length)}`.trim();
    const fallbackText = fallbackCandidate ?? buildApprovalFallbackText(approval);
    const approvalText = cleanedText || normalizeOptionalText(payload.text) || fallbackText;

    return {
      approval,
      approvalText,
      fallbackText,
      cleanedText,
      actionRows: rows,
      ...(stateSnapshot ? { stateSnapshot } : {}),
    };
  }
  return null;
}

function buildReplyMarkup(
  approval: ApprovalPayload,
  callbackSecret: string,
  context?: string,
  actionRows?: string[][],
): Record<string, unknown> {
  const actionById = new Map(approval.actions.map((action) => [action.id, action]));
  const resolvedRows =
    actionRows && actionRows.length > 0
      ? actionRows
          .map((row) =>
            row
              .map((actionId) => actionById.get(actionId))
              .filter(
                (action): action is ApprovalPayload["actions"][number] => action !== undefined,
              ),
          )
          .filter((row): row is ApprovalPayload["actions"] => row.length > 0)
      : approval.actions.map((action) => [action]);
  const inlineKeyboard = resolvedRows.map((row) =>
    row.map((action) => ({
      text: action.label,
      callback_data: encodeTelegramApprovalCallback(
        { requestId: approval.requestId, actionId: action.id },
        callbackSecret,
        context ? { context } : undefined,
      ),
    })),
  );
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
  const restoredState = normalizeApprovalStateSnapshot(
    options?.resolveApprovalState?.({
      conversationId,
      requestId: decision.requestId,
      actionId: decision.actionId,
    }),
  );
  const stateDetail = buildApprovalStateDetail(restoredState);
  const partText = [`approval ${decision.requestId} -> ${decision.actionId}`];
  if (stateDetail) {
    partText.push(stateDetail);
  }
  if (restoredState?.stateKey) {
    partText.push(`state_path: .brewva/channel/approval-state/${restoredState.stateKey}.json`);
  }

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
    parts: [{ type: "text", text: partText.join("\n") }],
    approval: {
      requestId: decision.requestId,
      title: "Approval decision",
      ...(stateDetail ? { detail: stateDetail } : {}),
      actions: [{ id: decision.actionId, label: decision.actionId }],
    },
    meta: {
      updateId: update.update_id,
      callbackQueryId: callback.id,
      decisionActionId: decision.actionId,
      senderId: callback.from.id.toString(),
      senderName,
      senderUsername: callback.from.username ?? null,
      ...(restoredState?.screenId ? { approvalScreenId: restoredState.screenId } : {}),
      ...(restoredState?.stateKey ? { approvalStateKey: restoredState.stateKey } : {}),
      ...(restoredState?.state !== undefined ? { approvalState: restoredState.state } : {}),
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
  const normalizedTextParts: Extract<TurnPart, { type: "text" }>[] = [];
  const uiProjections: TelegramUiProjection[] = [];
  for (const textPart of textParts) {
    let normalizedText = textPart.text;
    if (turn.kind === "assistant") {
      while (true) {
        const projected = projectTelegramUiBlock(normalizedText);
        if (!projected) break;
        uiProjections.push(projected);
        if (projected.cleanedText === normalizedText) {
          break;
        }
        normalizedText = projected.cleanedText;
      }
    }
    const cleaned = normalizedText.trim();
    if (cleaned.length > 0) {
      normalizedTextParts.push({ type: "text", text: cleaned });
    }
  }
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

  for (const textPart of normalizedTextParts) {
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

  const approvalEntries: Array<{ payload: ApprovalPayload; projection?: TelegramUiProjection }> =
    [];
  if (turn.kind === "approval" && turn.approval) {
    approvalEntries.push({ payload: turn.approval });
  } else {
    for (const projection of uiProjections) {
      approvalEntries.push({ payload: projection.approval, projection });
    }
  }

  const turnMetaApprovalState =
    turn.kind === "approval" ? extractApprovalStateSnapshotFromTurnMeta(turn) : undefined;
  const turnMeta = asRecord(turn.meta);
  const originAgentId =
    turnMeta && typeof turnMeta.agentId === "string" ? normalizeOptionalText(turnMeta.agentId) : "";
  const originAgentSessionId =
    turnMeta && typeof turnMeta.agentSessionId === "string"
      ? normalizeOptionalText(turnMeta.agentSessionId)
      : "";
  for (const [index, approvalEntry] of approvalEntries.entries()) {
    const approvalPayload = approvalEntry.payload;
    const projection = approvalEntry.projection;
    const inlineEnabled = options.inlineApproval !== false;
    const callbackSecret = options.callbackSecret?.trim();
    const fallbackText = projection?.fallbackText ?? buildApprovalFallbackText(approvalPayload);
    const baseText = projection
      ? projection.approvalText
      : normalizedTextParts.find(
          (part): part is Extract<TurnPart, { type: "text" }> => part.type === "text",
        )?.text;
    const approvalText = baseText?.trim() || fallbackText;
    const approvalActionText = projection?.approval.title?.trim() || approvalText;
    const avoidDuplicateHint = turn.kind === "approval";

    if (inlineEnabled && callbackSecret) {
      try {
        if (options.persistApprovalRouting) {
          try {
            options.persistApprovalRouting({
              conversationId: chatId,
              requestId: approvalPayload.requestId,
              agentId: originAgentId || undefined,
              agentSessionId: originAgentSessionId || undefined,
              turnId: turn.turnId,
            });
          } catch {
            // Best effort routing persistence; do not break inline approvals.
          }
        }

        const markup = buildReplyMarkup(
          approvalPayload,
          callbackSecret,
          chatId,
          projection?.actionRows,
        );
        const snapshot = projection?.stateSnapshot ?? turnMetaApprovalState;
        if (snapshot) {
          options.persistApprovalState?.({
            conversationId: chatId,
            requestId: approvalPayload.requestId,
            snapshot,
          });
        }

        const firstTextIdx = requests.findIndex((request) => request.method === "sendMessage");
        if (index === 0 && firstTextIdx >= 0) {
          requests[firstTextIdx] = buildSendRequest("sendMessage", {
            ...requests[firstTextIdx]!.params,
            reply_markup: markup,
          });
        } else {
          appendSplitSendMessage(approvalActionText, markup);
        }
      } catch {
        if (!avoidDuplicateHint || !hasApprovalHint()) {
          appendSplitSendMessage(fallbackText);
        }
      }
    } else if (!avoidDuplicateHint || !hasApprovalHint()) {
      appendSplitSendMessage(fallbackText);
    }
  }

  return requests;
}
