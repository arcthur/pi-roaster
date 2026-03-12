import {
  DEBUG_LOOP_HANDOFF_PERSISTED_EVENT_TYPE,
  DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
  DEBUG_LOOP_TRANSITION_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildDebugLoopHint(options: BrewvaToolOptions, sessionId: string): string {
  const retryEvent = options.runtime.events.list(sessionId, {
    type: DEBUG_LOOP_RETRY_SCHEDULED_EVENT_TYPE,
    last: 1,
  })[0];
  const retryPayload = isRecord(retryEvent?.payload) ? retryEvent.payload : undefined;
  const nextSkill =
    retryPayload && typeof retryPayload.nextSkill === "string" ? retryPayload.nextSkill : null;
  const failureCaseRef =
    retryPayload && typeof retryPayload.failureCaseRef === "string"
      ? retryPayload.failureCaseRef
      : null;
  const debugLoopRef =
    retryPayload && typeof retryPayload.debugLoopRef === "string"
      ? retryPayload.debugLoopRef
      : null;

  if (nextSkill) {
    const details = [
      `Debug loop scheduled. Next step: ${nextSkill} (use skill_load name=${nextSkill}).`,
      failureCaseRef ? `Failure snapshot: ${failureCaseRef}.` : null,
      debugLoopRef ? `Loop state: ${debugLoopRef}.` : null,
    ].filter((entry): entry is string => Boolean(entry));
    return ` ${details.join(" ")}`;
  }

  const handoffEvent = options.runtime.events.list(sessionId, {
    type: DEBUG_LOOP_HANDOFF_PERSISTED_EVENT_TYPE,
    last: 1,
  })[0];
  const handoffPayload = isRecord(handoffEvent?.payload) ? handoffEvent.payload : undefined;
  const handoffRef =
    handoffPayload && typeof handoffPayload.artifactRef === "string"
      ? handoffPayload.artifactRef
      : null;
  const transitionEvent = options.runtime.events.list(sessionId, {
    type: DEBUG_LOOP_TRANSITION_EVENT_TYPE,
    last: 1,
  })[0];
  const transitionPayload = isRecord(transitionEvent?.payload)
    ? transitionEvent.payload
    : undefined;
  const status =
    transitionPayload && typeof transitionPayload.status === "string"
      ? transitionPayload.status
      : null;

  if (handoffRef || status) {
    const details = [
      status ? `Debug loop status: ${status}.` : null,
      handoffRef ? `Handoff packet: ${handoffRef}.` : null,
    ].filter((entry): entry is string => Boolean(entry));
    return details.length > 0 ? ` ${details.join(" ")}` : "";
  }

  return "";
}

export function createSkillCompleteTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "skill_complete",
    label: "Skill Complete",
    description: "Validate skill outputs against contract and complete the active skill.",
    promptSnippet:
      "Validate and complete the active skill after required outputs and verification evidence are ready.",
    promptGuidelines: [
      "Do not call this until required outputs are prepared.",
      "Verification must pass or be intentionally read-only before completion.",
    ],
    parameters: Type.Object({
      outputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const outputs = isRecord(params.outputs) ? params.outputs : {};

      const completion = options.runtime.skills.validateOutputs(sessionId, outputs);
      if (!completion.ok) {
        const details = [
          completion.missing.length > 0
            ? `Missing required outputs: ${completion.missing.join(", ")}`
            : null,
          completion.invalid.length > 0
            ? `Invalid required outputs: ${completion.invalid.map((entry) => entry.name).join(", ")}`
            : null,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join(". ");
        return failTextResult(`Skill completion rejected. ${details}`, {
          ok: false,
          missing: completion.missing,
          invalid: completion.invalid,
        });
      }

      const verification = await options.runtime.verification.verify(sessionId, undefined, {
        executeCommands: options.verification?.executeCommands,
        timeoutMs: options.verification?.timeoutMs,
      });

      if (!verification.passed) {
        return inconclusiveTextResult(
          `Verification gate blocked. Skill not completed: ${verification.missingEvidence.join(", ")}${buildDebugLoopHint(options, sessionId)}`,
          {
            ok: false,
            verification,
          },
        );
      }

      options.runtime.skills.complete(sessionId, outputs);
      const intent = options.runtime.skills.getCascadeIntent
        ? options.runtime.skills.getCascadeIntent(sessionId)
        : undefined;
      const nextStep = intent?.steps[intent.cursor];
      const hasNextStep =
        intent &&
        (intent.status === "pending" || intent.status === "paused") &&
        nextStep &&
        typeof nextStep.skill === "string" &&
        nextStep.skill.length > 0;
      const cascadeHint = hasNextStep
        ? ` Next cascade step: ${nextStep.skill} (use skill_load name=${nextStep.skill}).`
        : "";

      const message =
        (verification.readOnly
          ? "Skill completed (read-only, no verification needed)."
          : "Skill completed and verification gate passed.") + cascadeHint;
      return textResult(message, {
        ok: true,
        verification,
        cascade: intent
          ? {
              status: intent.status,
              cursor: intent.cursor,
              steps: intent.steps.length,
              nextSkill: hasNextStep ? nextStep.skill : null,
              intentId: intent.id,
              source: intent.source,
            }
          : null,
      });
    },
  });
}
