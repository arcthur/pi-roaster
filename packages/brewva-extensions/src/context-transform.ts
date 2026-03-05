import {
  coerceContextBudgetUsage,
  type ContextCompactionGateStatus,
  type ContextPressureStatus,
  type BrewvaRuntime,
  type SkillSelection,
} from "@brewva/brewva-runtime";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  extractCompactionEntryId,
  extractCompactionSummary,
  formatPercent,
  resolveInjectionScopeId,
} from "./context-shared.js";
import { clearRuntimeTurnClock, observeRuntimeTurnStart } from "./runtime-turn-clock.js";

const CONTEXT_INJECTION_MESSAGE_TYPE = "brewva-context-injection";
const CONTEXT_CONTRACT_MARKER = "[Brewva Context Contract]";
const ROUTING_TRANSLATION_SYSTEM_PROMPT = [
  "You are a routing translation layer.",
  "Translate user input into concise, natural English for downstream skill routing.",
  "Return only the translated English text.",
  "Do not add explanations, markdown, or labels.",
  "Preserve technical terms, tool names, code, and file paths exactly when possible.",
].join(" ");
const SKILL_ROUTING_SYSTEM_PROMPT = [
  "You are a strict skill router.",
  "Choose skills purely by semantic intent from the provided catalog.",
  'Return JSON only in the form: {"skills":[{"name":"...","confidence":0.0,"reason":"..."}]}',
  "confidence must be a number in [0,1].",
  "Never invent skill names that are not in the catalog.",
  'If no skill applies, return {"skills":[]}.',
].join(" ");

export interface RoutingPromptTranslationResult {
  prompt: string;
  translated: boolean;
  status: "translated" | "pass_through" | "failed";
  reason: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costTotal: number;
  };
  error?: string;
}

export interface RoutingSkillSelectionResult {
  selected: SkillSelection[];
  status: "selected" | "empty" | "failed";
  reason: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costTotal: number;
  };
  error?: string;
}

export interface ContextTransformOptions {
  translatePromptForRouting?: (input: {
    prompt: string;
    ctx: ExtensionContext;
  }) => Promise<RoutingPromptTranslationResult>;
  selectSkillsForRouting?: (input: {
    prompt: string;
    ctx: ExtensionContext;
    runtime: BrewvaRuntime;
  }) => Promise<RoutingSkillSelectionResult>;
  autoCompactionWatchdogMs?: number;
}

interface CompactionGateState {
  turnIndex: number;
  lastRuntimeGateRequired: boolean;
  autoCompactionInFlight: boolean;
  autoCompactionWatchdog: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_AUTO_COMPACTION_WATCHDOG_MS = 30_000;
const AUTO_COMPACTION_WATCHDOG_ERROR = "auto_compaction_watchdog_timeout";

function getOrCreateGateState(
  store: Map<string, CompactionGateState>,
  sessionId: string,
): CompactionGateState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created: CompactionGateState = {
    turnIndex: 0,
    lastRuntimeGateRequired: false,
    autoCompactionInFlight: false,
    autoCompactionWatchdog: null,
  };
  store.set(sessionId, created);
  return created;
}

function clearAutoCompactionState(state: CompactionGateState): void {
  state.autoCompactionInFlight = false;
  if (state.autoCompactionWatchdog) {
    clearTimeout(state.autoCompactionWatchdog);
    state.autoCompactionWatchdog = null;
  }
}

function emitRuntimeEvent(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    turn: number;
    type: string;
    payload: Record<string, unknown>;
  },
): void {
  runtime.events.record({
    sessionId: input.sessionId,
    turn: input.turn,
    type: input.type,
    payload: input.payload,
  });
}

function normalizeRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return "unknown_error";
}

function extractTranslationText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const text = content
    .filter(
      (
        item,
      ): item is {
        type: "text";
        text: string;
      } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();

  if (!text) return "";
  if (!text.startsWith("```")) return text;
  const withoutOpening = text.replace(/^```[^\n]*\n/u, "");
  return withoutOpening.replace(/\n```$/u, "").trim();
}

function shouldBypassRoutingTranslation(prompt: string): boolean {
  if (!/[A-Za-z]/u.test(prompt)) return false;
  const letters = prompt.match(/\p{Letter}/gu);
  if (!letters || letters.length === 0) return false;
  const latinLetters = prompt.match(/[A-Za-z]/g);
  const latinCount = latinLetters?.length ?? 0;
  return latinCount / letters.length >= 0.9;
}

async function translatePromptForSkillRoutingWithModel(input: {
  prompt: string;
  ctx: ExtensionContext;
}): Promise<RoutingPromptTranslationResult> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    return {
      prompt: input.prompt,
      translated: false,
      status: "pass_through",
      reason: "empty_prompt",
    };
  }

  if (shouldBypassRoutingTranslation(prompt)) {
    return {
      prompt: input.prompt,
      translated: false,
      status: "pass_through",
      reason: "english_input",
    };
  }

  const model = input.ctx.model;
  if (!model) {
    return {
      prompt: input.prompt,
      translated: false,
      status: "pass_through",
      reason: "model_unavailable",
    };
  }

  const provider = model.provider;
  const modelId = model.id;
  let apiKey: string | undefined;
  try {
    apiKey = await input.ctx.modelRegistry.getApiKey(model);
  } catch (error) {
    return {
      prompt: input.prompt,
      translated: false,
      status: "failed",
      reason: "api_key_error",
      provider,
      model: modelId,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!apiKey) {
    return {
      prompt: input.prompt,
      translated: false,
      status: "pass_through",
      reason: "api_key_missing",
      provider,
      model: modelId,
    };
  }

  try {
    const response = await complete(
      model,
      {
        systemPrompt: ROUTING_TRANSLATION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: input.prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: Math.min(1024, model.maxTokens),
        reasoningEffort: "minimal",
      },
    );

    const translated = extractTranslationText(response.content);
    if (!translated) {
      return {
        prompt: input.prompt,
        translated: false,
        status: "pass_through",
        reason: "empty_translation",
        provider,
        model: modelId,
        stopReason: response.stopReason,
        usage: {
          input: response.usage.input,
          output: response.usage.output,
          cacheRead: response.usage.cacheRead,
          cacheWrite: response.usage.cacheWrite,
          totalTokens: response.usage.totalTokens,
          costTotal: response.usage.cost.total,
        },
      };
    }

    const changed = translated.trim() !== input.prompt.trim();
    return {
      prompt: translated,
      translated: changed,
      status: "translated",
      reason: changed ? "ok" : "unchanged",
      provider,
      model: modelId,
      stopReason: response.stopReason,
      usage: {
        input: response.usage.input,
        output: response.usage.output,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
        totalTokens: response.usage.totalTokens,
        costTotal: response.usage.cost.total,
      },
    };
  } catch (error) {
    return {
      prompt: input.prompt,
      translated: false,
      status: "failed",
      reason: "translation_error",
      provider,
      model: modelId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) return parsed;
  } catch {
    // noop
  }

  const match = trimmed.match(/\{[\s\S]*\}/u);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSemanticSelections(input: {
  value: unknown;
  allowedSkillNames: Set<string>;
  maxSelections: number;
}): SkillSelection[] {
  if (!Array.isArray(input.value)) return [];

  const bestByName = new Map<string, SkillSelection>();
  for (const entry of input.value) {
    if (!isRecord(entry)) continue;
    const nameRaw = entry.name;
    const confidenceRaw = entry.confidence;
    const reasonRaw = entry.reason;
    if (typeof nameRaw !== "string") continue;
    const name = nameRaw.trim();
    if (!name || !input.allowedSkillNames.has(name)) continue;

    const numericConfidence =
      typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
        ? confidenceRaw
        : typeof confidenceRaw === "string" && confidenceRaw.trim().length > 0
          ? Number(confidenceRaw)
          : NaN;
    if (!Number.isFinite(numericConfidence)) continue;
    const confidence = Math.max(0, Math.min(1, numericConfidence));
    const score = Math.max(0, Math.min(30, Math.round(confidence * 20)));
    if (score <= 0) continue;

    const semanticReason =
      typeof reasonRaw === "string" && reasonRaw.trim().length > 0
        ? reasonRaw.trim()
        : "semantic_match";
    const selected: SkillSelection = {
      name,
      score,
      reason: `semantic:${semanticReason}`,
      breakdown: [
        {
          signal: "semantic_match",
          term: "semantic",
          delta: score,
        },
      ],
    };
    const existing = bestByName.get(name);
    if (!existing || selected.score > existing.score) {
      bestByName.set(name, selected);
    }
  }

  return [...bestByName.values()]
    .toSorted((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(1, input.maxSelections));
}

async function selectSkillsForRoutingWithModel(input: {
  prompt: string;
  ctx: ExtensionContext;
  runtime: BrewvaRuntime;
}): Promise<RoutingSkillSelectionResult> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    return {
      selected: [],
      status: "empty",
      reason: "empty_prompt",
    };
  }

  const skillCatalog = input.runtime.skills.list().map((skill) => ({
    name: skill.name,
    description: skill.description,
    tier: skill.tier,
    outputs: skill.contract.outputs ?? [],
    consumes: skill.contract.consumes ?? [],
  }));
  if (skillCatalog.length === 0) {
    return {
      selected: [],
      status: "empty",
      reason: "skill_catalog_empty",
    };
  }

  const model = input.ctx.model;
  if (!model) {
    return {
      selected: [],
      status: "failed",
      reason: "model_unavailable",
    };
  }

  const provider = model.provider;
  const modelId = model.id;
  let apiKey: string | undefined;
  try {
    apiKey = await input.ctx.modelRegistry.getApiKey(model);
  } catch (error) {
    return {
      selected: [],
      status: "failed",
      reason: "api_key_error",
      provider,
      model: modelId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!apiKey) {
    return {
      selected: [],
      status: "failed",
      reason: "api_key_missing",
      provider,
      model: modelId,
    };
  }

  const maxSelections = Math.max(1, input.runtime.config.skills.selector.k);
  const requestPayload = {
    userPrompt: prompt,
    maxSelections,
    skills: skillCatalog,
  };

  try {
    const response = await complete(
      model,
      {
        systemPrompt: SKILL_ROUTING_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: JSON.stringify(requestPayload) }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: Math.min(1536, model.maxTokens),
        reasoningEffort: "minimal",
      },
    );

    const text = extractTranslationText(response.content);
    const parsed = parseJsonRecord(text);
    if (!parsed) {
      return {
        selected: [],
        status: "failed",
        reason: "invalid_json",
        provider,
        model: modelId,
        stopReason: response.stopReason,
        usage: {
          input: response.usage.input,
          output: response.usage.output,
          cacheRead: response.usage.cacheRead,
          cacheWrite: response.usage.cacheWrite,
          totalTokens: response.usage.totalTokens,
          costTotal: response.usage.cost.total,
        },
      };
    }

    const selected = normalizeSemanticSelections({
      value: parsed.skills,
      allowedSkillNames: new Set(skillCatalog.map((entry) => entry.name)),
      maxSelections,
    });

    return {
      selected,
      status: selected.length > 0 ? "selected" : "empty",
      reason: selected.length > 0 ? "ok" : "no_skill_match",
      provider,
      model: modelId,
      stopReason: response.stopReason,
      usage: {
        input: response.usage.input,
        output: response.usage.output,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
        totalTokens: response.usage.totalTokens,
        costTotal: response.usage.cost.total,
      },
    };
  } catch (error) {
    return {
      selected: [],
      status: "failed",
      reason: "routing_error",
      provider,
      model: modelId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveContextInjection(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    prompt: string;
    usage: ReturnType<typeof coerceContextBudgetUsage>;
    injectionScopeId?: string;
  },
): Promise<{
  text: string;
  accepted: boolean;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
}> {
  return runtime.context.buildInjection(
    input.sessionId,
    input.prompt,
    input.usage,
    input.injectionScopeId,
  );
}

function buildCompactionGateMessage(input: { pressure: ContextPressureStatus }): string {
  const usagePercent = formatPercent(input.pressure.usageRatio);
  const hardLimitPercent = formatPercent(input.pressure.hardLimitRatio);
  const reasonLine = "Context pressure is critical.";
  return [
    "[ContextCompactionGate]",
    reasonLine,
    `Current usage: ${usagePercent} (hard limit: ${hardLimitPercent}).`,
    "Call tool `session_compact` immediately before any other tool call.",
    "Do not run `session_compact` via `exec` or shell.",
  ].join("\n");
}

function buildTapeStatusBlock(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  gateStatus: ContextCompactionGateStatus;
}): string {
  const tapeStatus = input.runtime.events.getTapeStatus(input.sessionId);
  const usagePercent = formatPercent(input.gateStatus.pressure.usageRatio);
  const hardLimitPercent = formatPercent(input.gateStatus.pressure.hardLimitRatio);
  const action = input.gateStatus.required ? "session_compact_now" : "none";
  const tapePressure = tapeStatus.tapePressure;
  const totalEntries = String(tapeStatus.totalEntries);
  const entriesSinceAnchor = String(tapeStatus.entriesSinceAnchor);
  const entriesSinceCheckpoint = String(tapeStatus.entriesSinceCheckpoint);
  const lastAnchorName = tapeStatus.lastAnchor?.name ?? "none";
  const lastAnchorId = tapeStatus.lastAnchor?.id ?? "none";

  return [
    "[TapeStatus]",
    `tape_pressure: ${tapePressure}`,
    `tape_entries_total: ${totalEntries}`,
    `tape_entries_since_anchor: ${entriesSinceAnchor}`,
    `tape_entries_since_checkpoint: ${entriesSinceCheckpoint}`,
    `last_anchor_name: ${lastAnchorName}`,
    `last_anchor_id: ${lastAnchorId}`,
    `context_pressure: ${input.gateStatus.pressure.level}`,
    `context_usage: ${usagePercent}`,
    `context_hard_limit: ${hardLimitPercent}`,
    `compaction_gate_reason: ${input.gateStatus.reason ?? "none"}`,
    `recent_compact_performed: ${input.gateStatus.recentCompaction ? "true" : "false"}`,
    `turns_since_compaction: ${input.gateStatus.turnsSinceCompaction ?? "none"}`,
    `recent_compaction_window_turns: ${input.gateStatus.windowTurns}`,
    `required_action: ${action}`,
  ].join("\n");
}

function buildContextContractBlock(runtime: BrewvaRuntime): string {
  const tapeThresholds = runtime.events.getTapePressureThresholds();
  const hardLimitPercent = formatPercent(runtime.context.getHardLimitRatio());
  const highThresholdPercent = formatPercent(runtime.context.getCompactionThresholdRatio());

  return [
    CONTEXT_CONTRACT_MARKER,
    "You manage two independent resources.",
    "1) State tape:",
    "- use `tape_handoff` for semantic phase boundaries and handoffs.",
    "- use `tape_info` to inspect tape/context pressure.",
    "- use `tape_search` when you need historical recall.",
    `- tape_pressure is based on entries_since_anchor (low=${tapeThresholds.low}, medium=${tapeThresholds.medium}, high=${tapeThresholds.high}).`,
    "2) Message buffer (LLM context window):",
    "- use `session_compact` to reduce message history tokens.",
    `- context_pressure >= high (${highThresholdPercent}) means compact soon.`,
    `- context_pressure == critical (${hardLimitPercent}) means compact immediately.`,
    "Hard rules:",
    "- `tape_handoff` does not reduce message tokens.",
    "- `session_compact` does not change tape state semantics.",
    "- never run `session_compact` through `exec` or shell; call the tool directly.",
    "- if context pressure is critical without recent compaction, runtime blocks non-`session_compact` tools.",
  ].join("\n");
}

function applyContextContract(systemPrompt: unknown, runtime: BrewvaRuntime): string {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  if (base.includes(CONTEXT_CONTRACT_MARKER)) {
    return base;
  }
  const contract = buildContextContractBlock(runtime);
  if (base.trim().length === 0) return contract;
  return `${base}\n\n${contract}`;
}

export function registerContextTransform(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  options: ContextTransformOptions = {},
): void {
  const gateStateBySession = new Map<string, CompactionGateState>();
  const translatePromptForRouting =
    options.translatePromptForRouting ?? translatePromptForSkillRoutingWithModel;
  const selectSkillsForRouting = options.selectSkillsForRouting ?? selectSkillsForRoutingWithModel;
  const autoCompactionWatchdogMs = Math.max(
    1,
    Math.trunc(options.autoCompactionWatchdogMs ?? DEFAULT_AUTO_COMPACTION_WATCHDOG_MS),
  );

  pi.on("turn_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const runtimeTurn = observeRuntimeTurnStart(sessionId, event.turnIndex, event.timestamp);
    state.turnIndex = runtimeTurn;
    runtime.context.onTurnStart(sessionId, runtimeTurn);
    return undefined;
  });

  pi.on("context", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    runtime.context.observeUsage(sessionId, usage);

    if (!runtime.context.checkAndRequestCompaction(sessionId, usage)) {
      return undefined;
    }

    if (ctx.hasUI) {
      if (state.autoCompactionInFlight) {
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_skipped",
          payload: {
            reason: "auto_compaction_in_flight",
          },
        });
        return undefined;
      }

      const pendingReason = runtime.context.getPendingCompactionReason(sessionId);
      const compactionReason = pendingReason ?? "usage_threshold";
      state.autoCompactionInFlight = true;
      if (state.autoCompactionWatchdog) {
        clearTimeout(state.autoCompactionWatchdog);
      }
      state.autoCompactionWatchdog = setTimeout(() => {
        if (!state.autoCompactionInFlight) return;
        clearAutoCompactionState(state);
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_auto_failed",
          payload: {
            reason: compactionReason,
            error: AUTO_COMPACTION_WATCHDOG_ERROR,
            watchdogMs: autoCompactionWatchdogMs,
          },
        });
      }, autoCompactionWatchdogMs);

      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_auto_requested",
        payload: {
          reason: compactionReason,
          usagePercent: usage?.percent ?? null,
          tokens: usage?.tokens ?? null,
        },
      });

      const clearInFlight = () => {
        clearAutoCompactionState(state);
      };
      const recordAutoFailure = (error: unknown) => {
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_auto_failed",
          payload: {
            reason: compactionReason,
            error: normalizeRuntimeError(error),
          },
        });
      };

      try {
        ctx.compact({
          customInstructions: runtime.context.getCompactionInstructions(),
          onComplete: () => {
            clearInFlight();
            emitRuntimeEvent(runtime, {
              sessionId,
              turn: state.turnIndex,
              type: "context_compaction_auto_completed",
              payload: {
                reason: compactionReason,
              },
            });
          },
          onError: (error) => {
            clearInFlight();
            recordAutoFailure(error);
          },
        });
      } catch (error) {
        clearInFlight();
        recordAutoFailure(error);
      }

      return undefined;
    }

    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "context_compaction_skipped",
      payload: {
        reason: "non_interactive_mode",
      },
    });

    return undefined;
  });

  pi.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    const wasGated = state.lastRuntimeGateRequired;
    state.lastRuntimeGateRequired = false;
    clearAutoCompactionState(state);

    runtime.context.markCompacted(sessionId, {
      fromTokens: null,
      toTokens: usage?.tokens ?? null,
      summary: extractCompactionSummary(event),
      entryId: extractCompactionEntryId(event),
    });
    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "session_compact",
      payload: {
        entryId: event.compactionEntry.id,
        fromExtension: event.fromExtension,
      },
    });

    if (wasGated) {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_gate_cleared",
        payload: {
          reason: "session_compact_performed",
        },
      });
    }
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = gateStateBySession.get(sessionId);
    if (state) {
      clearAutoCompactionState(state);
    }
    gateStateBySession.delete(sessionId);
    clearRuntimeTurnClock(sessionId);
    return undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const injectionScopeId = resolveInjectionScopeId(ctx.sessionManager);
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    runtime.context.observeUsage(sessionId, usage);
    const emitGateEvents = (
      gateStatus: ContextCompactionGateStatus,
      reason: "hard_limit",
    ): void => {
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_gate_armed",
        payload: {
          reason,
          usagePercent: gateStatus.pressure.usageRatio,
          hardLimitPercent: gateStatus.pressure.hardLimitRatio,
        },
      });
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "critical_without_compact",
        payload: {
          reason,
          usagePercent: gateStatus.pressure.usageRatio,
          hardLimitPercent: gateStatus.pressure.hardLimitRatio,
          contextPressure: gateStatus.pressure.level,
          requiredTool: "session_compact",
        },
      });
    };

    let gateStatus = runtime.context.getCompactionGateStatus(sessionId, usage);
    if (gateStatus.required) {
      emitGateEvents(gateStatus, "hard_limit");
    }
    const systemPromptWithContract = applyContextContract(
      (event as { systemPrompt?: unknown }).systemPrompt,
      runtime,
    );
    const originalPrompt = event.prompt;

    if (gateStatus.required) {
      state.lastRuntimeGateRequired = true;
      runtime.skills.clearNextSelection(sessionId);
      const skippedReason = "critical_compaction_gate";
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "skill_routing_translation",
        payload: {
          status: "skipped",
          reason: skippedReason,
          translated: false,
          inputChars: originalPrompt.length,
          outputChars: originalPrompt.length,
          provider: null,
          model: null,
          stopReason: null,
          error: null,
        },
      });
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "skill_routing_semantic",
        payload: {
          status: "skipped",
          reason: skippedReason,
          selectedCount: 0,
          selectedSkills: [],
          inputChars: originalPrompt.length,
          provider: null,
          model: null,
          stopReason: null,
          error: null,
        },
      });

      const blocks: string[] = [
        buildTapeStatusBlock({
          runtime,
          sessionId,
          gateStatus,
        }),
        buildCompactionGateMessage({
          pressure: gateStatus.pressure,
        }),
      ];

      return {
        systemPrompt: systemPromptWithContract,
        message: {
          customType: CONTEXT_INJECTION_MESSAGE_TYPE,
          content: blocks.join("\n\n"),
          display: false,
          details: {
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
            gateRequired: true,
            routingTranslation: {
              status: "skipped",
              reason: skippedReason,
              translated: false,
            },
            semanticRouting: {
              status: "skipped",
              reason: skippedReason,
              selectedCount: 0,
            },
          },
        },
      };
    }

    const routingTranslation = await translatePromptForRouting({
      prompt: originalPrompt,
      ctx,
    });
    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "skill_routing_translation",
      payload: {
        status: routingTranslation.status,
        reason: routingTranslation.reason,
        translated: routingTranslation.translated,
        inputChars: originalPrompt.length,
        outputChars: routingTranslation.prompt.length,
        provider: routingTranslation.provider ?? null,
        model: routingTranslation.model ?? null,
        stopReason: routingTranslation.stopReason ?? null,
        error: routingTranslation.error ?? null,
      },
    });
    if (routingTranslation.usage && routingTranslation.model && routingTranslation.provider) {
      runtime.cost.recordAssistantUsage({
        sessionId,
        model: `${routingTranslation.provider}/${routingTranslation.model}`,
        inputTokens: routingTranslation.usage.input,
        outputTokens: routingTranslation.usage.output,
        cacheReadTokens: routingTranslation.usage.cacheRead,
        cacheWriteTokens: routingTranslation.usage.cacheWrite,
        totalTokens: routingTranslation.usage.totalTokens,
        costUsd: routingTranslation.usage.costTotal,
        stopReason: routingTranslation.stopReason,
      });
    }
    const semanticRouting = await selectSkillsForRouting({
      prompt: routingTranslation.prompt,
      ctx,
      runtime,
    });
    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "skill_routing_semantic",
      payload: {
        status: semanticRouting.status,
        reason: semanticRouting.reason,
        selectedCount: semanticRouting.selected.length,
        selectedSkills: semanticRouting.selected.map((entry) => entry.name),
        inputChars: routingTranslation.prompt.length,
        provider: semanticRouting.provider ?? null,
        model: semanticRouting.model ?? null,
        stopReason: semanticRouting.stopReason ?? null,
        error: semanticRouting.error ?? null,
      },
    });
    if (semanticRouting.usage && semanticRouting.model && semanticRouting.provider) {
      runtime.cost.recordAssistantUsage({
        sessionId,
        model: `${semanticRouting.provider}/${semanticRouting.model}`,
        inputTokens: semanticRouting.usage.input,
        outputTokens: semanticRouting.usage.output,
        cacheReadTokens: semanticRouting.usage.cacheRead,
        cacheWriteTokens: semanticRouting.usage.cacheWrite,
        totalTokens: semanticRouting.usage.totalTokens,
        costUsd: semanticRouting.usage.costTotal,
        stopReason: semanticRouting.stopReason,
      });
    }
    runtime.skills.setNextSelection(sessionId, semanticRouting.selected, {
      routingOutcome:
        semanticRouting.status === "selected"
          ? "selected"
          : semanticRouting.status === "empty"
            ? "empty"
            : "failed",
    });

    const injection = await resolveContextInjection(runtime, {
      sessionId,
      prompt: routingTranslation.prompt,
      usage,
      injectionScopeId,
    });
    const gateStatusAfterInjection = runtime.context.getCompactionGateStatus(sessionId, usage);
    if (!gateStatus.required && gateStatusAfterInjection.required) {
      emitGateEvents(gateStatusAfterInjection, "hard_limit");
    }
    gateStatus = gateStatusAfterInjection;
    state.lastRuntimeGateRequired = gateStatus.required;

    const blocks: string[] = [
      buildTapeStatusBlock({
        runtime,
        sessionId,
        gateStatus,
      }),
    ];
    if (gateStatus.required) {
      blocks.push(
        buildCompactionGateMessage({
          pressure: gateStatus.pressure,
        }),
      );
    }
    if (injection.accepted && injection.text.trim().length > 0) {
      blocks.push(injection.text);
    }

    return {
      systemPrompt: systemPromptWithContract,
      message: {
        customType: CONTEXT_INJECTION_MESSAGE_TYPE,
        content: blocks.join("\n\n"),
        display: false,
        details: {
          originalTokens: injection.originalTokens,
          finalTokens: injection.finalTokens,
          truncated: injection.truncated,
          gateRequired: gateStatus.required,
          routingTranslation: {
            status: routingTranslation.status,
            reason: routingTranslation.reason,
            translated: routingTranslation.translated,
          },
          semanticRouting: {
            status: semanticRouting.status,
            reason: semanticRouting.reason,
            selectedCount: semanticRouting.selected.length,
          },
        },
      },
    };
  });
}
