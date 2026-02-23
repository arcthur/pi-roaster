import type { MemoryEvolvesRelation } from "../memory/types.js";

export interface CognitiveUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface CognitiveTokenBudgetStatus {
  maxTokensPerTurn: number;
  consumedTokens: number;
  remainingTokens: number | null;
  exhausted: boolean;
}

export interface CognitiveInferRelationInput {
  newer: string;
  older: string;
  topic: string;
}

export interface CognitiveInferRelationOutput {
  relation: MemoryEvolvesRelation;
  confidence: number;
  rationale: string;
  usage?: CognitiveUsage;
}

export interface CognitiveRankCandidate {
  id: string;
  statement: string;
}

export interface CognitiveRankInput {
  query: string;
  candidates: CognitiveRankCandidate[];
}

export interface CognitiveRankOutput {
  id: string;
  score: number;
}

export interface CognitiveRankResultEnvelope {
  scores: CognitiveRankOutput[];
  usage?: CognitiveUsage;
}

export type CognitiveRankResult = CognitiveRankOutput[] | CognitiveRankResultEnvelope;

export interface CognitiveReflectInput {
  taskGoal: string;
  strategy: string;
  outcome: "pass" | "fail";
  evidence: string;
}

export interface CognitiveReflectOutput {
  lesson: string;
  adjustedStrategy?: string;
  pattern?: string;
  rootCause?: string;
  recommendation?: string;
  usage?: CognitiveUsage;
}

export interface CognitivePort {
  inferRelation?(
    input: CognitiveInferRelationInput,
  ): CognitiveInferRelationOutput | Promise<CognitiveInferRelationOutput>;
  rankRelevance?(input: CognitiveRankInput): CognitiveRankResult | Promise<CognitiveRankResult>;
  reflectOnOutcome?(
    input: CognitiveReflectInput,
  ): CognitiveReflectOutput | Promise<CognitiveReflectOutput>;
}

/**
 * Convenience no-op port for deterministic-only or disabled-cognitive runtimes.
 */
export class DeterministicCognitivePort implements CognitivePort {}
