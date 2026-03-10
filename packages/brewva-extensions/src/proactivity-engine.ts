import {
  extractEpisodeSessionScope,
  extractStatusSummarySessionScope,
  listCognitionArtifacts,
  parseEpisodeNoteContent,
  parseStatusSummaryPacketContent,
  readCognitionArtifact,
  selectCognitionArtifactsForPrompt,
} from "@brewva/brewva-deliberation";
import { normalizeOptionalString } from "./context-shared.js";

export type ProactivityWakeMode = "always" | "if_signal" | "if_open_loop";

export interface ProactivityRuleInput {
  id: string;
  prompt: string;
  objective?: string;
  contextHints?: string[];
  wakeMode?: ProactivityWakeMode;
  staleAfterMinutes?: number;
}

export interface ProactivityWakeSignal {
  kind: "open_loop" | "episode" | "summary";
  artifactRef: string;
  note: string;
  createdAt: number;
}

export interface ProactivityWakePlan {
  decision: "wake" | "skip";
  reason: string;
  wakeMode: ProactivityWakeMode;
  prompt: string;
  objective?: string;
  contextHints: string[];
  selectionText: string;
  signalArtifactRefs: string[];
  signals: ProactivityWakeSignal[];
}

const OPEN_LOOP_STATUSES = new Set(["blocked", "in_progress", "pending", "retrying", "open"]);
const DEFAULT_SIGNAL_SCAN_LIMIT = 12;

function normalizeHints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const hints: string[] = [];
  for (const entry of value) {
    const normalized = normalizeOptionalString(entry, { emptyValue: undefined });
    if (!normalized || hints.includes(normalized)) continue;
    hints.push(normalized);
  }
  return hints;
}

function resolveWakeMode(value: unknown): ProactivityWakeMode {
  if (value === "if_signal" || value === "if_open_loop") {
    return value;
  }
  return "always";
}

function normalizeWakeSignalValue(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function buildWakeSelectionText(input: {
  prompt: string;
  objective?: string;
  contextHints: string[];
  signals: ProactivityWakeSignal[];
}): string {
  const parts = [input.prompt.trim()];
  const objective = normalizeOptionalString(input.objective, { emptyValue: undefined });
  if (objective) {
    parts.push(objective);
  }
  for (const hint of input.contextHints) {
    parts.push(hint);
  }
  for (const signal of input.signals.slice(0, 3)) {
    parts.push(signal.note);
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

function isFreshEnough(createdAt: number, staleAfterMs: number | null, now: number): boolean {
  if (staleAfterMs === null) {
    return true;
  }
  return now - createdAt <= staleAfterMs;
}

async function findOpenLoopSignal(input: {
  workspaceRoot: string;
  sessionId: string;
  staleAfterMs: number | null;
  now: number;
}): Promise<ProactivityWakeSignal | null> {
  const artifacts = (await listCognitionArtifacts(input.workspaceRoot, "summaries"))
    .toReversed()
    .slice(0, DEFAULT_SIGNAL_SCAN_LIMIT);
  for (const artifact of artifacts) {
    if (!isFreshEnough(artifact.createdAt, input.staleAfterMs, input.now)) {
      continue;
    }
    const content = await readCognitionArtifact({
      workspaceRoot: input.workspaceRoot,
      lane: "summaries",
      fileName: artifact.fileName,
    });
    if (extractStatusSummarySessionScope(content) !== input.sessionId) {
      continue;
    }
    const parsed = parseStatusSummaryPacketContent(content);
    if (!parsed) {
      continue;
    }
    const status = normalizeWakeSignalValue(parsed.status);
    const nextAction = normalizeOptionalString(parsed.fields.next_action, {
      emptyValue: undefined,
    });
    const blockedOn = normalizeOptionalString(parsed.fields.blocked_on, { emptyValue: undefined });
    const unresolved =
      nextAction !== undefined ||
      blockedOn !== undefined ||
      (status !== null && OPEN_LOOP_STATUSES.has(status)) ||
      (normalizeWakeSignalValue(parsed.summaryKind)?.startsWith("debug_loop_") ?? false);
    if (!unresolved) {
      continue;
    }
    return {
      kind: "open_loop",
      artifactRef: artifact.artifactRef,
      createdAt: artifact.createdAt,
      note: [nextAction, blockedOn].filter(Boolean).join(" | ") || `status=${status ?? "open"}`,
    };
  }
  return null;
}

async function selectEpisodeSignals(input: {
  workspaceRoot: string;
  sessionId: string;
  queryText: string;
  staleAfterMs: number | null;
  now: number;
}): Promise<ProactivityWakeSignal[]> {
  const selected = await selectCognitionArtifactsForPrompt({
    workspaceRoot: input.workspaceRoot,
    lane: "summaries",
    prompt: input.queryText,
    maxArtifacts: 2,
    scanLimit: DEFAULT_SIGNAL_SCAN_LIMIT,
    filterArtifact: ({ content }) => extractEpisodeSessionScope(content) === input.sessionId,
  });
  const signals: ProactivityWakeSignal[] = [];
  for (const match of selected) {
    if (!isFreshEnough(match.artifact.createdAt, input.staleAfterMs, input.now)) {
      continue;
    }
    const episode = parseEpisodeNoteContent(match.content);
    if (!episode) {
      continue;
    }
    const focus = normalizeOptionalString(episode.focus, { emptyValue: undefined });
    const nextAction = normalizeOptionalString(episode.nextAction, { emptyValue: undefined });
    const blockedOn = normalizeOptionalString(episode.blockedOn, { emptyValue: undefined });
    signals.push({
      kind: "episode",
      artifactRef: match.artifact.artifactRef,
      createdAt: match.artifact.createdAt,
      note:
        [focus, nextAction, blockedOn].filter(Boolean).join(" | ") ||
        `episode=${episode.episodeKind ?? "session"}`,
    });
  }
  return signals;
}

async function selectSummarySignals(input: {
  workspaceRoot: string;
  sessionId: string;
  queryText: string;
  staleAfterMs: number | null;
  now: number;
}): Promise<ProactivityWakeSignal[]> {
  const selected = await selectCognitionArtifactsForPrompt({
    workspaceRoot: input.workspaceRoot,
    lane: "summaries",
    prompt: input.queryText,
    maxArtifacts: 2,
    scanLimit: DEFAULT_SIGNAL_SCAN_LIMIT,
    filterArtifact: ({ content }) => extractStatusSummarySessionScope(content) === input.sessionId,
  });
  const signals: ProactivityWakeSignal[] = [];
  for (const match of selected) {
    if (!isFreshEnough(match.artifact.createdAt, input.staleAfterMs, input.now)) {
      continue;
    }
    const summary = parseStatusSummaryPacketContent(match.content);
    if (!summary) {
      continue;
    }
    const goal = normalizeOptionalString(summary.fields.goal, { emptyValue: undefined });
    const nextAction = normalizeOptionalString(summary.fields.next_action, {
      emptyValue: undefined,
    });
    const blockedOn = normalizeOptionalString(summary.fields.blocked_on, {
      emptyValue: undefined,
    });
    signals.push({
      kind: "summary",
      artifactRef: match.artifact.artifactRef,
      createdAt: match.artifact.createdAt,
      note:
        [goal, nextAction, blockedOn].filter(Boolean).join(" | ") ||
        `summary=${summary.summaryKind ?? "session"}`,
    });
  }
  return signals;
}

export async function planHeartbeatWake(input: {
  workspaceRoot: string;
  sessionId: string;
  rule: ProactivityRuleInput;
  now?: number;
}): Promise<ProactivityWakePlan> {
  const now = Math.max(0, Math.floor(input.now ?? Date.now()));
  const wakeMode = resolveWakeMode(input.rule.wakeMode);
  const objective = normalizeOptionalString(input.rule.objective, {
    emptyValue: undefined,
  });
  const contextHints = normalizeHints(input.rule.contextHints);
  const staleAfterMs =
    typeof input.rule.staleAfterMinutes === "number" &&
    Number.isFinite(input.rule.staleAfterMinutes)
      ? Math.max(1, Math.floor(input.rule.staleAfterMinutes)) * 60_000
      : null;

  const baseSelectionText = [input.rule.prompt.trim(), objective, ...contextHints]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");

  const openLoopSignal = await findOpenLoopSignal({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    staleAfterMs,
    now,
  });
  const episodeSignals = await selectEpisodeSignals({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    queryText: baseSelectionText,
    staleAfterMs,
    now,
  });
  const summarySignals = await selectSummarySignals({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    queryText: baseSelectionText,
    staleAfterMs,
    now,
  });

  const signals = [
    ...(openLoopSignal ? [openLoopSignal] : []),
    ...episodeSignals,
    ...summarySignals.filter(
      (signal) => !openLoopSignal || signal.artifactRef !== openLoopSignal.artifactRef,
    ),
  ].slice(0, 4);

  if (wakeMode === "if_open_loop" && !openLoopSignal) {
    return {
      decision: "skip",
      reason: "no_open_loop_signal",
      wakeMode,
      prompt: input.rule.prompt,
      objective,
      contextHints,
      selectionText: baseSelectionText,
      signalArtifactRefs: [],
      signals: [],
    };
  }

  if (wakeMode === "if_signal" && signals.length === 0) {
    return {
      decision: "skip",
      reason: "no_relevant_signal",
      wakeMode,
      prompt: input.rule.prompt,
      objective,
      contextHints,
      selectionText: baseSelectionText,
      signalArtifactRefs: [],
      signals: [],
    };
  }

  return {
    decision: "wake",
    reason: openLoopSignal ? "open_loop_signal" : signals.length > 0 ? "memory_signal" : "always",
    wakeMode,
    prompt: input.rule.prompt,
    objective,
    contextHints,
    selectionText: buildWakeSelectionText({
      prompt: input.rule.prompt,
      objective,
      contextHints,
      signals,
    }),
    signalArtifactRefs: signals.map((signal) => signal.artifactRef),
    signals,
  };
}
