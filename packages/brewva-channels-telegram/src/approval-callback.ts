import { createHmac, timingSafeEqual } from "node:crypto";

const CALLBACK_PREFIX = "apv1";
const MAX_CALLBACK_DATA_BYTES = 64;
const DEFAULT_SIGNATURE_LENGTH = 16;

export interface ApprovalCallbackPayload {
  requestId: string;
  actionId: string;
}

export interface ApprovalCallbackOptions {
  signatureLength?: number;
  context?: string;
}

function normalizeToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  if (normalized.includes(":")) {
    throw new Error(`${label} must not contain ":"`);
  }
  return normalized;
}

function buildBase(payload: ApprovalCallbackPayload): string {
  return `${CALLBACK_PREFIX}:${payload.requestId}:${payload.actionId}`;
}

function sign(base: string, secret: string, signatureLength: number, context?: string): string {
  const input = context ? `${base}|ctx:${context}` : base;
  const raw = createHmac("sha256", secret).update(input).digest("hex");
  return raw.slice(0, signatureLength);
}

function safeEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function encodeTelegramApprovalCallback(
  payload: ApprovalCallbackPayload,
  secret: string,
  options?: ApprovalCallbackOptions,
): string {
  const requestId = normalizeToken(payload.requestId, "requestId");
  const actionId = normalizeToken(payload.actionId, "actionId");
  const normalizedSecret = normalizeToken(secret, "secret");
  const normalizedSignatureLength = Math.max(
    6,
    Math.min(32, Math.floor(options?.signatureLength ?? DEFAULT_SIGNATURE_LENGTH)),
  );
  const context = options?.context?.trim() || undefined;

  const base = buildBase({ requestId, actionId });
  const signature = sign(base, normalizedSecret, normalizedSignatureLength, context);
  const data = `${base}:${signature}`;
  if (Buffer.byteLength(data, "utf8") > MAX_CALLBACK_DATA_BYTES) {
    throw new Error("callback data exceeds Telegram 64-byte limit");
  }
  return data;
}

export function decodeTelegramApprovalCallback(
  data: string,
  secret: string,
  options?: ApprovalCallbackOptions,
): ApprovalCallbackPayload | null {
  const normalizedData = data.trim();
  const normalizedSecret = secret.trim();
  if (!normalizedData || !normalizedSecret) {
    return null;
  }

  const match = /^apv1:([^:]+):([^:]+):([0-9a-f]+)$/i.exec(normalizedData);
  if (!match) {
    return null;
  }

  const requestId = match[1];
  const actionId = match[2];
  const signature = match[3];
  if (!requestId || !actionId || !signature) {
    return null;
  }
  const normalizedSignatureLength = Math.max(
    6,
    Math.min(32, Math.floor(options?.signatureLength ?? DEFAULT_SIGNATURE_LENGTH)),
  );
  if (signature.length !== normalizedSignatureLength) {
    return null;
  }

  const context = options?.context?.trim() || undefined;
  const base = buildBase({ requestId, actionId });
  const expected = sign(base, normalizedSecret, normalizedSignatureLength, context);
  if (!safeEqual(expected, signature.toLowerCase())) {
    return null;
  }

  return { requestId, actionId };
}
