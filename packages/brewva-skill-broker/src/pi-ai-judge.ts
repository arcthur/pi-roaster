import { complete, type AssistantMessage } from "@mariozechner/pi-ai";
import type {
  SkillBrokerJudge,
  SkillBrokerJudgeCandidate,
  SkillBrokerJudgeConfidence,
  SkillBrokerJudgeInput,
  SkillBrokerJudgeResult,
} from "./types.js";

const STRATEGY = "pi_ai_complete";
const DEFAULT_MAX_TOKENS = 320;
const DEFAULT_TEMPERATURE = 0;

interface PiAiJudgeResponse {
  decision?: unknown;
  selectedName?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

export interface PiAiSkillBrokerJudgeOptions {
  completeFn?: typeof complete;
  maxTokens?: number;
  temperature?: number;
}

const SYSTEM_PROMPT = [
  "You are Brewva's control-plane skill routing judge.",
  "Choose at most one skill from the provided shortlist, or choose none.",
  "Be conservative: if the prompt does not clearly match a candidate's immediate intent, choose none.",
  "Do not select skill authoring or skill packaging workflows unless the user explicitly wants to create or update a skill.",
  "Generic words such as skill, tool, workflow, agent, plan, review, and task are weak evidence by themselves.",
  "Treat preview boundaries as negative evidence.",
  "Reply with strict JSON only.",
  'Schema: {"decision":"select"|"none","selectedName":"<candidate name or null>","confidence":"low"|"medium"|"high","reason":"short explanation"}',
].join(" ");

function normalizeConfidence(value: unknown): SkillBrokerJudgeConfidence {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "low";
}

function stringifyModel(model: { provider: string; id: string } | null | undefined): string | null {
  if (!model?.provider || !model.id) return null;
  return `${model.provider}/${model.id}`;
}

function compactCandidate(candidate: SkillBrokerJudgeCandidate): Record<string, unknown> {
  return {
    name: candidate.name,
    description: candidate.description,
    outputs: candidate.outputs,
    consumes: candidate.consumes,
    requires: candidate.requires,
    effectLevel: candidate.effectLevel,
    preferredTools: candidate.preferredTools,
    fallbackTools: candidate.fallbackTools,
    allowedEffects: candidate.allowedEffects,
    stageOneScore: candidate.stageOneScore,
    score: candidate.score,
    exactNameMatch: candidate.exactNameMatch,
    distinctMatchCount: candidate.distinctMatchCount,
    preview: candidate.preview,
    lexicalReason: candidate.reason,
  };
}

function buildJudgePrompt(input: SkillBrokerJudgeInput): string {
  return JSON.stringify(
    {
      task: "Select the single best skill for this user prompt, or none.",
      prompt: input.prompt,
      activeSkillName: input.activeSkillName ?? null,
      candidates: input.candidates.map(compactCandidate),
      rules: [
        "Prefer none when the match is weak or ambiguous.",
        "Use the candidate name exactly if you select one.",
        "Consider multilingual meaning; do not rely on English keyword overlap alone.",
        "A request discussing skill routing or runtime architecture is not the same as asking to create a skill.",
      ],
    },
    null,
    2,
  );
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter(
      (
        part: AssistantMessage["content"][number],
      ): part is Extract<AssistantMessage["content"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part: Extract<AssistantMessage["content"][number], { type: "text" }>) => part.text)
    .join("\n")
    .trim();
}

function extractJsonPayload(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      return candidate;
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return null;
}

function parseJudgeResponse(text: string): PiAiJudgeResponse | null {
  const payload = extractJsonPayload(text);
  if (!payload) return null;
  try {
    return JSON.parse(payload) as PiAiJudgeResponse;
  } catch {
    return null;
  }
}

export class PiAiSkillBrokerJudge implements SkillBrokerJudge {
  private readonly completeFn: typeof complete;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(options: PiAiSkillBrokerJudgeOptions = {}) {
    this.completeFn = options.completeFn ?? complete;
    this.maxTokens = Math.max(64, Math.trunc(options.maxTokens ?? DEFAULT_MAX_TOKENS));
    this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  }

  async judge(input: SkillBrokerJudgeInput): Promise<SkillBrokerJudgeResult> {
    const model = input.judgeContext?.model ?? null;
    const modelRegistry = input.judgeContext?.modelRegistry ?? null;
    const modelRef = stringifyModel(model);

    if (input.candidates.length === 0) {
      return {
        strategy: STRATEGY,
        status: "skipped",
        reason: "empty_shortlist",
        model: modelRef,
      };
    }

    if (!model) {
      return {
        strategy: STRATEGY,
        status: "skipped",
        reason: "no_model",
        model: null,
      };
    }

    if (!modelRegistry) {
      return {
        strategy: STRATEGY,
        status: "skipped",
        reason: "no_model_registry",
        model: modelRef,
      };
    }

    const apiKey = await modelRegistry.getApiKey(model);
    if (!apiKey) {
      return {
        strategy: STRATEGY,
        status: "skipped",
        reason: "no_api_key",
        model: modelRef,
      };
    }

    try {
      const options: {
        apiKey: string;
        maxTokens: number;
        temperature?: number;
      } = {
        apiKey,
        maxTokens: this.maxTokens,
      };
      if (this.temperature !== 0) {
        options.temperature = this.temperature;
      }
      const response = await this.completeFn(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: buildJudgePrompt(input) }],
              timestamp: Date.now(),
            },
          ],
        },
        options,
      );

      if (response.stopReason === "error" || response.stopReason === "aborted") {
        return {
          strategy: STRATEGY,
          status: "failed",
          reason: response.stopReason,
          model: modelRef,
          error: response.errorMessage,
        };
      }

      const parsed = parseJudgeResponse(extractText(response));
      if (!parsed) {
        return {
          strategy: STRATEGY,
          status: "failed",
          reason: "invalid_json",
          model: modelRef,
          error: "Unable to parse judge response",
        };
      }

      const confidence = normalizeConfidence(parsed.confidence);
      const reason =
        typeof parsed.reason === "string" && parsed.reason.trim().length > 0
          ? parsed.reason.trim()
          : "judge_no_reason";

      if (parsed.decision === "none") {
        return {
          strategy: STRATEGY,
          status: "rejected",
          reason,
          selectedName: null,
          confidence,
          model: modelRef,
        };
      }

      if (parsed.decision !== "select") {
        return {
          strategy: STRATEGY,
          status: "failed",
          reason: "invalid_decision",
          model: modelRef,
          error: `Unsupported decision: ${String(parsed.decision)}`,
        };
      }

      const selectedName =
        typeof parsed.selectedName === "string" && parsed.selectedName.trim().length > 0
          ? parsed.selectedName.trim()
          : null;
      const matchedCandidate = input.candidates.find(
        (candidate) => candidate.name === selectedName,
      );
      if (!matchedCandidate) {
        return {
          strategy: STRATEGY,
          status: "abstained",
          reason: "selected_name_not_in_shortlist",
          selectedName,
          confidence,
          model: modelRef,
        };
      }

      if (confidence === "low") {
        return {
          strategy: STRATEGY,
          status: "abstained",
          reason,
          selectedName,
          confidence,
          model: modelRef,
        };
      }

      return {
        strategy: STRATEGY,
        status: "selected",
        reason,
        selectedName,
        confidence,
        model: modelRef,
      };
    } catch (error) {
      return {
        strategy: STRATEGY,
        status: "failed",
        reason: "judge_error",
        model: modelRef,
        error: error instanceof Error ? error.message : "unknown_error",
      };
    }
  }
}
