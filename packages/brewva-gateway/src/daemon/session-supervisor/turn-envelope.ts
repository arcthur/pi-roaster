import type { TruthFact } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import type {
  HeartbeatPromptTrigger,
  SchedulePromptAnchor,
  SchedulePromptTrigger,
  SendPromptTrigger,
} from "../session-backend.js";

export function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function readStringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
  return normalized.length > 0 ? normalized : undefined;
}

function readEnumField<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = record[key];
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

function readPositiveIntegerField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function readTaskSpecField(
  record: Record<string, unknown>,
  key: string,
): SchedulePromptTrigger["taskSpec"] | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.schema !== "brewva.task.v1" || typeof value.goal !== "string" || !value.goal.trim()) {
    return undefined;
  }
  return value as unknown as SchedulePromptTrigger["taskSpec"];
}

function readTruthFactsField(
  record: Record<string, unknown>,
  key: string,
): TruthFact[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is TruthFact => isRecord(entry));
}

function readSchedulePromptAnchor(value: unknown): SchedulePromptAnchor | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readStringField(value, "id");
  if (!id) {
    return undefined;
  }
  return {
    id,
    name: readStringField(value, "name"),
    summary: readStringField(value, "summary"),
    nextSteps: readStringField(value, "nextSteps"),
  };
}

function mapPromptSourceToChannel(source: "gateway" | "heartbeat" | "schedule"): string {
  if (source === "heartbeat") {
    return "heartbeat";
  }
  if (source === "schedule") {
    return "schedule";
  }
  return "gateway";
}

export function buildSessionTurnEnvelope(input: {
  sessionId: string;
  turnId: string;
  prompt: string;
  source: "gateway" | "heartbeat" | "schedule";
  trigger?: SendPromptTrigger;
}): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: input.sessionId,
    turnId: input.turnId,
    channel: mapPromptSourceToChannel(input.source),
    conversationId: input.sessionId,
    timestamp: Date.now(),
    parts: [{ type: "text", text: input.prompt }],
    meta: {
      source: input.source,
      trigger: input.trigger ?? null,
    },
  };
}

export function extractPromptFromEnvelope(envelope: TurnEnvelope): string {
  const parts = envelope.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .filter((part) => part.length > 0);
  return parts.join("\n");
}

export function extractTriggerFromEnvelope(envelope: TurnEnvelope): SendPromptTrigger | undefined {
  if (!isRecord(envelope.meta)) {
    return undefined;
  }
  const raw = envelope.meta.trigger;
  if (!isRecord(raw)) {
    return undefined;
  }
  const kind = readEnumField(raw, "kind", ["heartbeat", "schedule"] as const);
  if (kind === "heartbeat") {
    const ruleId = readStringField(raw, "ruleId");
    if (!ruleId) {
      return undefined;
    }
    const trigger: HeartbeatPromptTrigger = {
      kind: "heartbeat",
      ruleId,
      objective: readStringField(raw, "objective"),
      contextHints: readStringArrayField(raw, "contextHints"),
      wakeMode: readEnumField(raw, "wakeMode", ["always", "if_signal", "if_open_loop"] as const),
      planReason: readStringField(raw, "planReason"),
      selectionText: readStringField(raw, "selectionText"),
      signalArtifactRefs: readStringArrayField(raw, "signalArtifactRefs"),
    };
    return trigger;
  }
  if (kind !== "schedule") {
    return undefined;
  }

  const intentId = readStringField(raw, "intentId");
  const parentSessionId = readStringField(raw, "parentSessionId");
  const runIndex = readPositiveIntegerField(raw, "runIndex");
  const reason = readStringField(raw, "reason");
  const continuityMode = readEnumField(raw, "continuityMode", ["inherit", "fresh"] as const);
  if (!intentId || !parentSessionId || !runIndex || !reason || !continuityMode) {
    return undefined;
  }

  const trigger: SchedulePromptTrigger = {
    kind: "schedule",
    intentId,
    parentSessionId,
    runIndex,
    reason,
    continuityMode,
    timeZone: readStringField(raw, "timeZone"),
    goalRef: readStringField(raw, "goalRef"),
    taskSpec: readTaskSpecField(raw, "taskSpec"),
    truthFacts: readTruthFactsField(raw, "truthFacts"),
    parentAnchor: readSchedulePromptAnchor(raw.parentAnchor),
  };
  return trigger;
}
