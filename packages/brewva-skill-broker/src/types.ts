import type { ToolEffectClass } from "@brewva/brewva-runtime";
import type {
  SkillDocument,
  SkillRoutingOutcome,
  SkillSelection,
  SkillsIndexEntry,
} from "@brewva/brewva-runtime";
import type { Api, Model } from "@mariozechner/pi-ai";

export interface SkillBrokerCatalog {
  generatedAt?: string;
  skills: SkillsIndexEntry[];
}

export interface SkillBrokerPreview {
  intent?: string;
  trigger?: string;
  boundaries?: string;
}

export interface SkillBrokerJudgeContext {
  model?: Model<Api> | null;
  modelRegistry?: {
    getApiKey(model: Model<Api>): Promise<string | undefined>;
  } | null;
}

export interface SkillBrokerJudgeCandidate {
  name: string;
  description: string;
  outputs: string[];
  consumes: string[];
  requires: string[];
  effectLevel: SkillsIndexEntry["effectLevel"];
  preferredTools: string[];
  fallbackTools: string[];
  allowedEffects: ToolEffectClass[];
  score: number;
  stageOneScore: number;
  previewScore: number;
  boundaryPenalty: number;
  distinctMatchCount: number;
  exactNameMatch: boolean;
  reason: string;
  preview?: SkillBrokerPreview;
}

export type SkillBrokerJudgeConfidence = "low" | "medium" | "high";

export type SkillBrokerJudgeStatus = "selected" | "rejected" | "abstained" | "skipped" | "failed";

export interface SkillBrokerJudgeResult {
  strategy: string;
  status: SkillBrokerJudgeStatus;
  reason: string;
  selectedName?: string | null;
  confidence?: SkillBrokerJudgeConfidence;
  model?: string | null;
  error?: string;
}

export interface SkillBrokerJudgeInput {
  sessionId: string;
  prompt: string;
  activeSkillName?: string | null;
  candidates: SkillBrokerJudgeCandidate[];
  judgeContext?: SkillBrokerJudgeContext;
}

export interface SkillBrokerJudge {
  judge(input: SkillBrokerJudgeInput): SkillBrokerJudgeResult | Promise<SkillBrokerJudgeResult>;
}

export interface SkillBrokerCandidateAssessment {
  name: string;
  score: number;
  stageOneScore: number;
  previewScore: number;
  boundaryPenalty: number;
  distinctMatchCount: number;
  exactNameMatch: boolean;
  selected: boolean;
  reason: string;
  preview?: SkillBrokerPreview;
}

export interface SkillBrokerJudgeTrace {
  strategy: string;
  status: SkillBrokerJudgeStatus;
  reason: string;
  selectedName?: string | null;
  confidence?: SkillBrokerJudgeConfidence;
  model?: string | null;
  error?: string;
}

export interface SkillBrokerTrace {
  brokerVersion: string;
  prompt: string;
  promptHash: string;
  catalogPath: string;
  routingOutcome: SkillRoutingOutcome;
  reason: string;
  selected: SkillSelection[];
  shortlisted: SkillBrokerCandidateAssessment[];
  judge?: SkillBrokerJudgeTrace;
}

export interface SkillBrokerDecision {
  selected: SkillSelection[];
  routingOutcome: SkillRoutingOutcome;
  trace: SkillBrokerTrace;
}

export type SkillBrokerDocumentsSource = SkillDocument[] | (() => SkillDocument[]);

export interface SkillBrokerSelectInput {
  sessionId: string;
  prompt: string;
  activeSkillName?: string | null;
  judgeContext?: SkillBrokerJudgeContext;
}

export interface SkillBroker {
  select(input: SkillBrokerSelectInput): SkillBrokerDecision | Promise<SkillBrokerDecision>;
}
