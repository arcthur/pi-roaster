import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveProjectBrewvaRootDir,
  type SkillDocument,
  type SkillRoutingOutcome,
  type SkillSelection,
  type SkillSelectionBreakdownEntry,
  type SkillsIndexEntry,
} from "@brewva/brewva-runtime";
import { PiAiSkillBrokerJudge } from "./pi-ai-judge.js";
import type {
  SkillBroker,
  SkillBrokerCandidateAssessment,
  SkillBrokerCatalog,
  SkillBrokerDecision,
  SkillBrokerJudge,
  SkillBrokerJudgeCandidate,
  SkillBrokerJudgeResult,
  SkillBrokerDocumentsSource,
  SkillBrokerPreview,
  SkillBrokerSelectInput,
} from "./types.js";

const BROKER_VERSION = "catalog-broker.v3";
const DEFAULT_MIN_SCORE = 12;
const DEFAULT_SHORTLIST_MIN_SCORE = 6;
const DEFAULT_MIN_MARGIN = 4;
const DEFAULT_K = 4;
const MAX_JUDGE_FALLBACK_CANDIDATES = 32;

const GENERIC_SKILL_TERMS = new Set([
  "skill",
  "skills",
  "tool",
  "tools",
  "workflow",
  "workflows",
  "task",
  "tasks",
  "agent",
  "agents",
]);

const STRONG_MATCH_SIGNALS = new Set<SkillSelectionBreakdownEntry["signal"]>([
  "name_exact",
  "name_token",
  "output_token",
  "consume_token",
  "preview_token",
]);

interface CatalogCacheEntry {
  mtimeMs: number;
  catalog: SkillBrokerCatalog;
}

interface ScoredCandidate {
  entry: SkillsIndexEntry;
  selection: SkillSelection;
  stageOneScore: number;
  previewScore: number;
  boundaryPenalty: number;
  distinctMatchCount: number;
  strongSignalMatchCount: number;
  exactNameMatch: boolean;
  preview?: SkillBrokerPreview;
}

function isEffectLevel(value: unknown): value is SkillsIndexEntry["effectLevel"] {
  if (value === "read_only" || value === "execute" || value === "mutation") {
    return true;
  }
  return false;
}

function assertCatalogEntry(entry: unknown): asserts entry is SkillsIndexEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error("catalog_invalid");
  }
  const candidate = entry as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    throw new Error("catalog_invalid");
  }
  if (typeof candidate.description !== "string") {
    throw new Error("catalog_invalid");
  }
  if (
    !Array.isArray(candidate.outputs) ||
    !candidate.outputs.every((value) => typeof value === "string")
  ) {
    throw new Error("catalog_invalid");
  }
  if (
    !Array.isArray(candidate.preferredTools) ||
    !candidate.preferredTools.every((value) => typeof value === "string")
  ) {
    throw new Error("catalog_invalid");
  }
  if (
    !Array.isArray(candidate.fallbackTools) ||
    !candidate.fallbackTools.every((value) => typeof value === "string")
  ) {
    throw new Error("catalog_invalid");
  }
  if (
    !Array.isArray(candidate.allowedEffects) ||
    !candidate.allowedEffects.every((value) => typeof value === "string")
  ) {
    throw new Error("catalog_invalid");
  }
  if (
    !Array.isArray(candidate.composableWith) ||
    !candidate.composableWith.every((value) => typeof value === "string")
  ) {
    throw new Error("catalog_invalid");
  }
  if (
    !Array.isArray(candidate.consumes) ||
    !candidate.consumes.every((value) => typeof value === "string")
  ) {
    throw new Error("catalog_invalid");
  }
  if (
    !Array.isArray(candidate.requires) ||
    !candidate.requires.every((value) => typeof value === "string")
  ) {
    throw new Error("catalog_invalid");
  }
  if (!isEffectLevel(candidate.effectLevel)) {
    throw new Error("catalog_invalid");
  }
}

export interface CatalogSkillBrokerOptions {
  workspaceRoot: string;
  catalogPath?: string;
  traceDir?: string;
  documents?: SkillBrokerDocumentsSource;
  judge?: SkillBrokerJudge | null;
  k?: number;
  minScore?: number;
  shortlistMinScore?: number;
  minMargin?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimDoubledSuffix(value: string): string {
  if (value.length < 3) return value;
  const last = value.at(-1);
  const previous = value.at(-2);
  if (!last || !previous || last !== previous) return value;
  return value.slice(0, -1);
}

function expandTokenVariants(token: string): string[] {
  const out = new Set<string>();
  const normalized = token.trim().toLowerCase();
  if (!normalized) return [];
  out.add(normalized);
  if (normalized.endsWith("ies") && normalized.length > 4) {
    out.add(`${normalized.slice(0, -3)}y`);
  }
  if (normalized.endsWith("ing") && normalized.length > 5) {
    const stem = trimDoubledSuffix(normalized.slice(0, -3));
    out.add(stem);
  }
  if (normalized.endsWith("ed") && normalized.length > 4) {
    const stem = trimDoubledSuffix(normalized.slice(0, -2));
    out.add(stem);
  }
  if (normalized.endsWith("es") && normalized.length > 4) {
    out.add(normalized.slice(0, -2));
  }
  if (normalized.endsWith("s") && normalized.length > 3) {
    out.add(normalized.slice(0, -1));
  }
  return [...out].filter((entry) => entry.length > 1);
}

function extractTokens(value: string): string[] {
  const raw = normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (const token of raw) {
    for (const variant of expandTokenVariants(token)) {
      out.add(variant);
    }
  }
  return [...out];
}

function extractScoringTerms(value: string): string[] {
  return extractTokens(value).filter((token) => !GENERIC_SKILL_TERMS.has(token));
}

function normalizeHeading(value: string): string {
  return normalizeText(value).replace(/\s+/g, " ");
}

function extractHeadingSection(markdown: string, headings: string[]): string | undefined {
  const normalizedTargets = new Set(headings.map((entry) => normalizeHeading(entry)));
  const lines = markdown.split(/\r?\n/);
  let activeHeadingLevel: number | null = null;
  let collecting = false;
  const buffer: string[] = [];

  for (const line of lines) {
    const headingMatch = /^(#{2,4})\s+(.*)$/.exec(line.trim());
    if (headingMatch) {
      const hashes = headingMatch[1];
      const title = headingMatch[2];
      if (!hashes || !title) {
        continue;
      }
      const level = hashes.length;
      if (collecting && activeHeadingLevel !== null && level <= activeHeadingLevel) {
        break;
      }
      if (normalizedTargets.has(normalizeHeading(title))) {
        collecting = true;
        activeHeadingLevel = level;
        continue;
      }
    }
    if (!collecting) continue;
    buffer.push(line);
  }

  const text = buffer.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function buildPreview(skill: SkillDocument): SkillBrokerPreview | undefined {
  const preview: SkillBrokerPreview = {
    intent: extractHeadingSection(skill.markdown, ["Intent"]),
    trigger: extractHeadingSection(skill.markdown, ["Trigger"]),
    boundaries: extractHeadingSection(skill.markdown, [
      "When not to use",
      "Do not use",
      "Skip",
      "Scope guardrails",
    ]),
  };
  if (!preview.intent && !preview.trigger && !preview.boundaries) {
    return undefined;
  }
  return preview;
}

function buildExactNameMatch(
  promptText: string,
  skillName: string,
  breakdown: SkillSelectionBreakdownEntry[],
): boolean {
  const normalizedPrompt = normalizeText(promptText);
  const normalizedSkillName = normalizeText(skillName);
  if (!normalizedPrompt || !normalizedSkillName) return false;
  if (!normalizedPrompt.includes(normalizedSkillName)) return false;
  breakdown.push({
    signal: "name_exact",
    term: normalizedSkillName,
    delta: 20,
  });
  return true;
}

function scoreTerms(input: {
  promptTokens: Set<string>;
  terms: string[];
  signal: SkillSelectionBreakdownEntry["signal"];
  delta: number;
  cap: number;
  breakdown: SkillSelectionBreakdownEntry[];
  matchedTerms: Set<string>;
  matchedSignals: Set<SkillSelectionBreakdownEntry["signal"]>;
}): number {
  const seen = new Set<string>();
  let total = 0;
  for (const term of input.terms) {
    if (seen.has(term) || !input.promptTokens.has(term)) continue;
    if (total >= input.cap) break;
    const applied = Math.min(input.delta, input.cap - total);
    if (applied <= 0) break;
    input.breakdown.push({
      signal: input.signal,
      term,
      delta: applied,
    });
    input.matchedTerms.add(term);
    input.matchedSignals.add(input.signal);
    total += applied;
    seen.add(term);
  }
  return total;
}

function applyPreviewScoring(input: {
  promptTokens: Set<string>;
  breakdown: SkillSelectionBreakdownEntry[];
  matchedSignals: Set<SkillSelectionBreakdownEntry["signal"]>;
  preview?: SkillBrokerPreview;
}): { score: number; penalty: number } {
  if (!input.preview) {
    return { score: 0, penalty: 0 };
  }

  let score = 0;
  const matchedTerms = new Set<string>();
  score += scoreTerms({
    promptTokens: input.promptTokens,
    terms: extractScoringTerms(input.preview.trigger ?? ""),
    signal: "preview_token",
    delta: 5,
    cap: 15,
    breakdown: input.breakdown,
    matchedTerms,
    matchedSignals: input.matchedSignals,
  });
  score += scoreTerms({
    promptTokens: input.promptTokens,
    terms: extractScoringTerms(input.preview.intent ?? ""),
    signal: "preview_token",
    delta: 3,
    cap: 9,
    breakdown: input.breakdown,
    matchedTerms,
    matchedSignals: input.matchedSignals,
  });

  const penaltyTerms = extractScoringTerms(input.preview.boundaries ?? "");
  const seenPenaltyTerms = new Set<string>();
  let penalty = 0;
  for (const term of penaltyTerms) {
    if (seenPenaltyTerms.has(term) || !input.promptTokens.has(term)) continue;
    if (penalty >= 8) break;
    const applied = Math.min(4, 8 - penalty);
    input.breakdown.push({
      signal: "preview_boundary",
      term,
      delta: -applied,
    });
    penalty += applied;
    seenPenaltyTerms.add(term);
  }

  return { score, penalty };
}

function assessCandidate(
  prompt: string,
  promptTokens: Set<string>,
  entry: SkillsIndexEntry,
  minScore: number,
  preview?: SkillBrokerPreview,
): ScoredCandidate | null {
  const breakdown: SkillSelectionBreakdownEntry[] = [];
  const matchedTerms = new Set<string>();
  const matchedSignals = new Set<SkillSelectionBreakdownEntry["signal"]>();
  let score = 0;

  const exactNameMatch = buildExactNameMatch(prompt, entry.name, breakdown);
  if (exactNameMatch) {
    for (const token of extractScoringTerms(entry.name)) {
      matchedTerms.add(token);
    }
    score += 20;
  }

  score += scoreTerms({
    promptTokens,
    terms: extractScoringTerms(entry.name),
    signal: "name_token",
    delta: 7,
    cap: 14,
    breakdown,
    matchedTerms,
    matchedSignals,
  });
  score += scoreTerms({
    promptTokens,
    terms: extractScoringTerms(entry.description),
    signal: "description_token",
    delta: 3,
    cap: 9,
    breakdown,
    matchedTerms,
    matchedSignals,
  });
  score += scoreTerms({
    promptTokens,
    terms: entry.outputs.flatMap((output) => extractScoringTerms(output)),
    signal: "output_token",
    delta: 4,
    cap: 12,
    breakdown,
    matchedTerms,
    matchedSignals,
  });
  score += scoreTerms({
    promptTokens,
    terms: [...new Set([...entry.requires, ...entry.consumes])].flatMap((consume) =>
      extractScoringTerms(consume),
    ),
    signal: "consume_token",
    delta: 3,
    cap: 6,
    breakdown,
    matchedTerms,
    matchedSignals,
  });
  score += scoreTerms({
    promptTokens,
    terms: [...new Set([...entry.preferredTools, ...entry.fallbackTools])].flatMap((toolName) =>
      extractScoringTerms(toolName),
    ),
    signal: "tool_token",
    delta: 2,
    cap: 4,
    breakdown,
    matchedTerms,
    matchedSignals,
  });

  if (!exactNameMatch && matchedTerms.size < 2) {
    return null;
  }
  if (score < minScore) {
    return null;
  }

  const stageOneScore = score;
  const previewAssessment = applyPreviewScoring({
    promptTokens,
    breakdown,
    matchedSignals,
    preview,
  });
  score += previewAssessment.score;
  score -= previewAssessment.penalty;

  const strongSignalMatchCount = [...matchedSignals].filter((signal) =>
    STRONG_MATCH_SIGNALS.has(signal),
  ).length;
  if (!exactNameMatch && strongSignalMatchCount === 0) {
    return null;
  }

  return {
    entry,
    selection: {
      name: entry.name,
      score,
      reason: breakdown.map((item) => `${item.signal}:${item.term}`).join(", "),
      breakdown,
    },
    stageOneScore,
    previewScore: previewAssessment.score,
    boundaryPenalty: previewAssessment.penalty,
    distinctMatchCount: matchedTerms.size,
    strongSignalMatchCount,
    exactNameMatch,
    preview,
  };
}

function buildJudgeCandidate(candidate: ScoredCandidate): SkillBrokerJudgeCandidate {
  return {
    name: candidate.entry.name,
    description: candidate.entry.description,
    outputs: candidate.entry.outputs,
    consumes: candidate.entry.consumes,
    requires: candidate.entry.requires,
    effectLevel: candidate.entry.effectLevel,
    preferredTools: candidate.entry.preferredTools,
    fallbackTools: candidate.entry.fallbackTools,
    allowedEffects: candidate.entry.allowedEffects,
    score: candidate.selection.score,
    stageOneScore: candidate.stageOneScore,
    previewScore: candidate.previewScore,
    boundaryPenalty: candidate.boundaryPenalty,
    distinctMatchCount: candidate.distinctMatchCount,
    exactNameMatch: candidate.exactNameMatch,
    reason: candidate.selection.reason,
    preview: candidate.preview,
  };
}

function buildJudgeOnlyCandidate(
  entry: SkillsIndexEntry,
  preview?: SkillBrokerPreview,
): ScoredCandidate {
  return {
    entry,
    selection: {
      name: entry.name,
      score: 0,
      reason: "judge_full_catalog_fallback",
      breakdown: [],
    },
    stageOneScore: 0,
    previewScore: 0,
    boundaryPenalty: 0,
    distinctMatchCount: 0,
    strongSignalMatchCount: 0,
    exactNameMatch: false,
    preview,
  };
}

function appendJudgeReason(
  selection: SkillSelection,
  judge: SkillBrokerJudgeResult,
): SkillSelection {
  const judgeReason = `judge:${judge.strategy}:${judge.reason}`;
  const judgeScore = judge.confidence === "high" ? 24 : judge.confidence === "medium" ? 18 : 12;
  return {
    ...selection,
    score: Math.max(selection.score, judgeScore),
    reason: selection.reason ? `${selection.reason}, ${judgeReason}` : judgeReason,
  };
}

function resolveFallbackSelection(input: {
  shortlisted: ScoredCandidate[];
  minScore: number;
  minMargin: number;
}): { selected: SkillSelection[]; reason: string } {
  const top = input.shortlisted[0];
  const second = input.shortlisted[1];
  const topMargin =
    top && second ? top.selection.score - second.selection.score : (top?.selection.score ?? 0);
  const isConfident =
    !!top &&
    top.selection.score >= input.minScore &&
    top.strongSignalMatchCount > 0 &&
    (top.exactNameMatch || topMargin >= input.minMargin);

  if (!isConfident) {
    return {
      selected: [],
      reason: top ? "catalog_broker_low_confidence" : "catalog_broker_empty",
    };
  }

  return {
    selected: input.shortlisted.map((entry) => entry.selection),
    reason: "catalog_broker_selected",
  };
}

function buildAssessment(
  candidate: ScoredCandidate,
  selectedNames: Set<string>,
): SkillBrokerCandidateAssessment {
  return {
    name: candidate.selection.name,
    score: candidate.selection.score,
    stageOneScore: candidate.stageOneScore,
    previewScore: candidate.previewScore,
    boundaryPenalty: candidate.boundaryPenalty,
    distinctMatchCount: candidate.distinctMatchCount,
    exactNameMatch: candidate.exactNameMatch,
    selected: selectedNames.has(candidate.selection.name),
    reason: candidate.selection.reason,
    preview: candidate.preview,
  };
}

export class CatalogSkillBroker implements SkillBroker {
  private readonly catalogPath: string;
  private readonly traceDir: string;
  private readonly judge: SkillBrokerJudge | null;
  private readonly k: number;
  private readonly minScore: number;
  private readonly shortlistMinScore: number;
  private readonly minMargin: number;
  private cache: CatalogCacheEntry | null = null;

  constructor(private readonly options: CatalogSkillBrokerOptions) {
    this.catalogPath =
      options.catalogPath ??
      join(resolveProjectBrewvaRootDir(options.workspaceRoot), "skills_index.json");
    this.traceDir =
      options.traceDir ?? join(resolveProjectBrewvaRootDir(options.workspaceRoot), "skill-broker");
    this.judge = options.judge === undefined ? new PiAiSkillBrokerJudge() : options.judge;
    this.k = Math.max(1, Math.trunc(options.k ?? DEFAULT_K));
    this.minScore = Math.max(1, Math.trunc(options.minScore ?? DEFAULT_MIN_SCORE));
    this.shortlistMinScore = Math.max(
      1,
      Math.min(this.minScore, Math.trunc(options.shortlistMinScore ?? DEFAULT_SHORTLIST_MIN_SCORE)),
    );
    this.minMargin = Math.max(0, Math.trunc(options.minMargin ?? DEFAULT_MIN_MARGIN));
  }

  async select(input: SkillBrokerSelectInput): Promise<SkillBrokerDecision> {
    try {
      const catalog = await this.loadCatalog();
      const promptTokens = new Set(extractTokens(input.prompt));
      const previewByName = this.buildPreviewMap();
      const candidates = catalog.skills
        .filter((entry) => entry.name !== (input.activeSkillName?.trim() || ""))
        .map((entry) =>
          assessCandidate(
            input.prompt,
            promptTokens,
            entry,
            this.shortlistMinScore,
            previewByName.get(entry.name),
          ),
        )
        .filter((entry): entry is ScoredCandidate => entry !== null)
        .toSorted((left, right) => {
          if (right.selection.score !== left.selection.score) {
            return right.selection.score - left.selection.score;
          }
          if (right.strongSignalMatchCount !== left.strongSignalMatchCount) {
            return right.strongSignalMatchCount - left.strongSignalMatchCount;
          }
          if (right.distinctMatchCount !== left.distinctMatchCount) {
            return right.distinctMatchCount - left.distinctMatchCount;
          }
          return left.selection.name.localeCompare(right.selection.name);
        });

      const shortlisted = candidates.slice(0, this.k);
      const fallback = resolveFallbackSelection({
        shortlisted,
        minScore: this.minScore,
        minMargin: this.minMargin,
      });
      const judgePool =
        shortlisted.length > 0
          ? shortlisted
          : catalog.skills
              .filter((entry) => entry.name !== (input.activeSkillName?.trim() || ""))
              .slice(0, MAX_JUDGE_FALLBACK_CANDIDATES)
              .map((entry) => buildJudgeOnlyCandidate(entry, previewByName.get(entry.name)));

      let selected = this.judge ? [] : fallback.selected;
      let reason = this.judge ? "catalog_broker_waiting_for_judge" : fallback.reason;
      let judgeTrace: SkillBrokerDecision["trace"]["judge"];
      let routingOutcome: SkillRoutingOutcome = this.judge
        ? "empty"
        : selected.length > 0
          ? "selected"
          : "empty";

      if (this.judge) {
        const judgeResult = await this.judge.judge({
          sessionId: input.sessionId,
          prompt: input.prompt,
          activeSkillName: input.activeSkillName,
          candidates: judgePool.map(buildJudgeCandidate),
          judgeContext: input.judgeContext,
        });
        judgeTrace = {
          strategy: judgeResult.strategy,
          status: judgeResult.status,
          reason: judgeResult.reason,
          selectedName: judgeResult.selectedName,
          confidence: judgeResult.confidence,
          model: judgeResult.model,
          error: judgeResult.error,
        };

        if (judgeResult.status === "selected" && judgeResult.selectedName) {
          const judged = judgePool.find(
            (entry) => entry.selection.name === judgeResult.selectedName,
          );
          if (judged) {
            selected = [appendJudgeReason(judged.selection, judgeResult)];
            reason =
              shortlisted.length > 0
                ? "catalog_broker_judge_selected"
                : "catalog_broker_judge_selected_full_catalog";
            routingOutcome = "selected";
          }
        } else if (judgeResult.status === "rejected" || judgeResult.status === "abstained") {
          selected = [];
          reason =
            judgeResult.status === "rejected"
              ? "catalog_broker_judge_rejected"
              : "catalog_broker_judge_abstained";
          routingOutcome = "empty";
        } else if (judgeResult.status === "skipped" || judgeResult.status === "failed") {
          selected = [];
          reason = `catalog_broker_judge_${judgeResult.status}:${judgeResult.reason}`;
          routingOutcome = "failed";
        }
      }

      const selectedNames = new Set(selected.map((entry) => entry.name));
      const trace = {
        brokerVersion: BROKER_VERSION,
        prompt: input.prompt,
        promptHash: sha256(normalizeText(input.prompt)),
        catalogPath: this.catalogPath,
        routingOutcome,
        reason,
        selected,
        shortlisted: shortlisted.map((entry) => buildAssessment(entry, selectedNames)),
        judge: judgeTrace,
      };
      this.writeTrace(input.sessionId, trace);
      return {
        selected,
        routingOutcome,
        trace,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      const trace = {
        brokerVersion: BROKER_VERSION,
        prompt: input.prompt,
        promptHash: sha256(normalizeText(input.prompt)),
        catalogPath: this.catalogPath,
        routingOutcome: "failed" as const,
        reason: `catalog_broker_failed:${message}`,
        selected: [],
        shortlisted: [],
      };
      this.writeTrace(input.sessionId, trace);
      return {
        selected: [],
        routingOutcome: "failed",
        trace,
      };
    }
  }

  private async loadCatalog(): Promise<SkillBrokerCatalog> {
    if (!existsSync(this.catalogPath)) {
      throw new Error(`catalog_missing:${this.catalogPath}`);
    }
    const currentMtimeMs = (await stat(this.catalogPath)).mtimeMs;
    if (this.cache && this.cache.mtimeMs === currentMtimeMs) {
      return this.cache.catalog;
    }
    const parsed = JSON.parse(await readFile(this.catalogPath, "utf8")) as SkillBrokerCatalog;
    if (!parsed || !Array.isArray(parsed.skills)) {
      throw new Error("catalog_invalid");
    }
    for (const entry of parsed.skills) {
      assertCatalogEntry(entry);
    }
    this.cache = {
      mtimeMs: currentMtimeMs,
      catalog: parsed,
    };
    return parsed;
  }

  private buildPreviewMap(): Map<string, SkillBrokerPreview> {
    const documentsSource = this.options.documents;
    if (!documentsSource) {
      return new Map();
    }
    const documents = typeof documentsSource === "function" ? documentsSource() : documentsSource;
    const out = new Map<string, SkillBrokerPreview>();
    for (const document of documents) {
      const preview = buildPreview(document);
      if (!preview) continue;
      out.set(document.name, preview);
    }
    return out;
  }

  private writeTrace(sessionId: string, trace: SkillBrokerDecision["trace"]): void {
    const sessionDir = join(this.traceDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = join(sessionDir, `${Date.now()}-${trace.promptHash.slice(0, 8)}.json`);
    writeFileSync(filePath, JSON.stringify(trace, null, 2), "utf8");
  }
}
