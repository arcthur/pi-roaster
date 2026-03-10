import {
  PROACTIVITY_WAKEUP_PREPARED_EVENT_TYPE,
  type BrewvaRuntime,
  type BrewvaStructuredEvent,
} from "@brewva/brewva-runtime";
import { normalizeOptionalString } from "./context-shared.js";

export type ProactivityTriggerSource = "heartbeat";

export interface ProactivityTriggerContext {
  source: ProactivityTriggerSource;
  ruleId: string;
  prompt: string;
  objective?: string;
  contextHints?: string[];
  wakeMode?: string;
  planReason?: string;
  selectionText?: string;
  signalArtifactRefs?: string[];
  preparedAt?: number;
}

const PROACTIVITY_WAKEUP_TTL_MS = 60_000;

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    const normalized = normalizeOptionalString(entry, { emptyValue: undefined });
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

export function recordProactivityWakeup(
  runtime: Pick<BrewvaRuntime, "events">,
  sessionId: string,
  trigger: ProactivityTriggerContext,
): void {
  const preparedAt = Math.max(0, Math.floor(trigger.preparedAt ?? Date.now()));
  runtime.events.record({
    sessionId,
    type: PROACTIVITY_WAKEUP_PREPARED_EVENT_TYPE,
    timestamp: preparedAt,
    payload: {
      source: trigger.source,
      ruleId: trigger.ruleId,
      prompt: trigger.prompt,
      objective: trigger.objective ?? null,
      contextHints: trigger.contextHints ?? [],
      wakeMode: trigger.wakeMode ?? null,
      planReason: trigger.planReason ?? null,
      selectionText: trigger.selectionText ?? null,
      signalArtifactRefs: trigger.signalArtifactRefs ?? [],
      preparedAt,
    },
  });
}

export function readLatestProactivityWakeup(
  runtime: Pick<BrewvaRuntime, "events">,
  sessionId: string,
  prompt: string,
): ProactivityTriggerContext | null {
  const normalizedPrompt = normalizeOptionalString(prompt);
  if (!normalizedPrompt) {
    return null;
  }

  const events = runtime.events.queryStructured(sessionId, {
    type: PROACTIVITY_WAKEUP_PREPARED_EVENT_TYPE,
    last: 4,
  });
  for (const event of events.toReversed()) {
    const trigger = parseProactivityWakeupEvent(event);
    if (!trigger) continue;
    if (trigger.prompt !== normalizedPrompt) continue;
    if (
      typeof trigger.preparedAt === "number" &&
      Date.now() - trigger.preparedAt > PROACTIVITY_WAKEUP_TTL_MS
    ) {
      continue;
    }
    return trigger;
  }
  return null;
}

function parseProactivityWakeupEvent(
  event: BrewvaStructuredEvent,
): ProactivityTriggerContext | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const source = normalizeOptionalString((payload as Record<string, unknown>).source);
  const ruleId = normalizeOptionalString((payload as Record<string, unknown>).ruleId);
  const prompt = normalizeOptionalString((payload as Record<string, unknown>).prompt);
  if (source !== "heartbeat" || !ruleId || !prompt) {
    return null;
  }

  return {
    source,
    ruleId,
    prompt,
    objective: normalizeOptionalString((payload as Record<string, unknown>).objective, {
      emptyValue: undefined,
    }),
    contextHints: normalizeStringArray((payload as Record<string, unknown>).contextHints),
    wakeMode: normalizeOptionalString((payload as Record<string, unknown>).wakeMode, {
      emptyValue: undefined,
    }),
    planReason: normalizeOptionalString((payload as Record<string, unknown>).planReason, {
      emptyValue: undefined,
    }),
    selectionText: normalizeOptionalString((payload as Record<string, unknown>).selectionText, {
      emptyValue: undefined,
    }),
    signalArtifactRefs: normalizeStringArray(
      (payload as Record<string, unknown>).signalArtifactRefs,
    ),
    preparedAt:
      typeof (payload as Record<string, unknown>).preparedAt === "number"
        ? Math.max(0, Math.floor((payload as Record<string, unknown>).preparedAt as number))
        : event.timestamp,
  };
}

export function buildProactivitySelectionText(input: {
  prompt: string;
  trigger?: ProactivityTriggerContext | null;
}): string {
  const parts = [input.prompt.trim()];
  const objective = normalizeOptionalString(input.trigger?.objective, {
    emptyValue: undefined,
  });
  if (objective) {
    parts.push(objective);
  }
  const explicitSelectionText = normalizeOptionalString(input.trigger?.selectionText, {
    emptyValue: undefined,
  });
  if (explicitSelectionText) {
    parts.push(explicitSelectionText);
  }
  for (const hint of input.trigger?.contextHints ?? []) {
    const normalized = normalizeOptionalString(hint, { emptyValue: undefined });
    if (!normalized) continue;
    parts.push(normalized);
  }
  return parts.filter((part) => part.length > 0).join("\n");
}
