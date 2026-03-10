import {
  DELIBERATION_ISSUERS,
  extractEpisodeSessionScope,
  extractStatusSummarySessionScope,
  listCognitionArtifacts,
  parseEpisodeNoteContent,
  parseProcedureNoteContent,
  parseStatusSummaryPacketContent,
  readCognitionArtifact,
  resolveCognitionArtifactsDir,
  selectCognitionArtifactsForPrompt,
  stripArtifactExtension,
  submitExistingCognitionArtifactContextPacket,
} from "@brewva/brewva-deliberation";
import {
  MEMORY_EPISODE_REHYDRATED_EVENT_TYPE,
  MEMORY_EPISODE_REHYDRATION_FAILED_EVENT_TYPE,
  MEMORY_OPEN_LOOP_REHYDRATED_EVENT_TYPE,
  MEMORY_OPEN_LOOP_REHYDRATION_FAILED_EVENT_TYPE,
  MEMORY_PROCEDURE_REHYDRATED_EVENT_TYPE,
  MEMORY_PROCEDURE_REHYDRATION_FAILED_EVENT_TYPE,
  MEMORY_REFERENCE_REHYDRATED_EVENT_TYPE,
  MEMORY_REFERENCE_REHYDRATION_FAILED_EVENT_TYPE,
  MEMORY_SUMMARY_REHYDRATED_EVENT_TYPE,
  MEMORY_SUMMARY_REHYDRATION_FAILED_EVENT_TYPE,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  rankMemoryHydrationCandidates,
  readMemoryAdaptationPolicy,
  type MemoryHydrationStrategy,
} from "./memory-adaptation.js";
import {
  buildProactivitySelectionText,
  readLatestProactivityWakeup,
} from "./proactivity-context.js";

const MEMORY_REFERENCE_PACKET_TTL_MS = 6 * 60 * 60 * 1000;
const MEMORY_PROCEDURE_PACKET_TTL_MS = 8 * 60 * 60 * 1000;
const MEMORY_EPISODE_PACKET_TTL_MS = 5 * 60 * 60 * 1000;
const MEMORY_SUMMARY_PACKET_TTL_MS = 3 * 60 * 60 * 1000;
const MEMORY_OPEN_LOOP_PACKET_TTL_MS = 4 * 60 * 60 * 1000;
const CONTINUATION_PROMPT_REGEX =
  /\b(continue|resume|pick up|pick-up|follow up|follow-up|what next|next step|where were|blocked|carry on)\b/iu;
const OPEN_LOOP_STATUSES = new Set(["blocked", "in_progress", "pending", "retrying", "open"]);
const EMPTY_STATUS_SUMMARY_VALUES = new Set(["", "none", "null", "n/a", "unknown"]);

interface HydrationCandidate {
  strategy: MemoryHydrationStrategy;
  packetKey: string;
  label: string;
  subject: string;
  expiresAt: number;
  artifactRef: string;
  artifact: Awaited<ReturnType<typeof listCognitionArtifacts>>[number];
  content: string;
  baseScore: number;
  metadata: Record<string, unknown>;
}

interface HydratedSessionState {
  packetKeys: Set<string>;
  artifactRefs: Set<string>;
}

function getOrCreateHydratedState(
  store: Map<string, HydratedSessionState>,
  sessionId: string,
): HydratedSessionState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created: HydratedSessionState = {
    packetKeys: new Set<string>(),
    artifactRefs: new Set<string>(),
  };
  store.set(sessionId, created);
  return created;
}

function buildPacketKey(fileName: string): string {
  return `reference:${stripArtifactExtension(fileName)}`;
}

function buildLabel(fileName: string): string {
  return `Reference:${stripArtifactExtension(fileName)}`;
}

function buildSummaryPacketKey(fileName: string): string {
  return `summary:${stripArtifactExtension(fileName)}`;
}

function buildSummaryLabel(fileName: string): string {
  return `Summary:${stripArtifactExtension(fileName)}`;
}

function buildOpenLoopPacketKey(fileName: string): string {
  return `open-loop:${stripArtifactExtension(fileName)}`;
}

function buildOpenLoopLabel(fileName: string): string {
  return `OpenLoop:${stripArtifactExtension(fileName)}`;
}

function buildEpisodePacketKey(fileName: string): string {
  return `episode:${stripArtifactExtension(fileName)}`;
}

function buildEpisodeLabel(fileName: string): string {
  return `Episode:${stripArtifactExtension(fileName)}`;
}

function buildProcedurePacketKey(fileName: string): string {
  return `procedure:${stripArtifactExtension(fileName)}`;
}

function buildProcedureLabel(fileName: string): string {
  return `Procedure:${stripArtifactExtension(fileName)}`;
}

function normalizeSummaryFieldValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (EMPTY_STATUS_SUMMARY_VALUES.has(normalized)) {
    return null;
  }
  return normalized;
}

function isContinuationPrompt(prompt: string): boolean {
  return CONTINUATION_PROMPT_REGEX.test(prompt);
}

function matchesSessionScope(
  content: string,
  sessionId: string,
  kind: "summary" | "episode",
): boolean {
  const sessionScope =
    kind === "summary"
      ? extractStatusSummarySessionScope(content)
      : extractEpisodeSessionScope(content);
  return sessionScope === sessionId;
}

function isOpenLoopSummary(content: string): {
  summaryKind: string | null;
  status: string | null;
  nextAction: string | null;
  blockedOn: string | null;
} | null {
  const parsed = parseStatusSummaryPacketContent(content);
  if (!parsed) return null;
  const summaryKind = normalizeSummaryFieldValue(parsed.summaryKind);
  const status = normalizeSummaryFieldValue(parsed.status);
  const nextAction = normalizeSummaryFieldValue(parsed.fields.next_action);
  const blockedOn = normalizeSummaryFieldValue(parsed.fields.blocked_on);
  const unresolved =
    nextAction !== null ||
    blockedOn !== null ||
    (status !== null && OPEN_LOOP_STATUSES.has(status)) ||
    (summaryKind !== null && summaryKind.startsWith("debug_loop_"));
  if (!unresolved) return null;
  return {
    summaryKind,
    status,
    nextAction,
    blockedOn,
  };
}

async function selectSummaryCandidates(
  runtime: BrewvaRuntime,
  selectionText: string,
  sessionId: string,
): Promise<HydrationCandidate[]> {
  const selected = await selectCognitionArtifactsForPrompt({
    workspaceRoot: runtime.workspaceRoot,
    lane: "summaries",
    prompt: selectionText,
    maxArtifacts: 1,
    scanLimit: 12,
    filterArtifact: ({ content }) => matchesSessionScope(content, sessionId, "summary"),
  });
  return selected
    .filter((match) => parseStatusSummaryPacketContent(match.content) !== null)
    .map((match) => ({
      strategy: "summary",
      artifact: match.artifact,
      artifactRef: match.artifact.artifactRef,
      content: match.content,
      packetKey: buildSummaryPacketKey(match.artifact.fileName),
      label: buildSummaryLabel(match.artifact.fileName),
      subject: `memory_summary:${match.artifact.fileName}`,
      expiresAt: Date.now() + MEMORY_SUMMARY_PACKET_TTL_MS,
      metadata: {
        score: match.score,
        matchedTerms: match.matchedTerms,
      },
      baseScore: match.score,
    }));
}

async function selectEpisodeCandidates(
  runtime: BrewvaRuntime,
  selectionText: string,
  sessionId: string,
): Promise<HydrationCandidate[]> {
  const selected = await selectCognitionArtifactsForPrompt({
    workspaceRoot: runtime.workspaceRoot,
    lane: "summaries",
    prompt: selectionText,
    maxArtifacts: 2,
    scanLimit: 16,
    filterArtifact: ({ content }) => matchesSessionScope(content, sessionId, "episode"),
  });
  const candidates: HydrationCandidate[] = [];
  for (const match of selected) {
    const episode = parseEpisodeNoteContent(match.content);
    if (!episode) {
      continue;
    }
    candidates.push({
      strategy: "episode",
      artifact: match.artifact,
      artifactRef: match.artifact.artifactRef,
      content: match.content,
      packetKey: buildEpisodePacketKey(match.artifact.fileName),
      label: buildEpisodeLabel(match.artifact.fileName),
      subject: `memory_episode:${match.artifact.fileName}`,
      expiresAt: Date.now() + MEMORY_EPISODE_PACKET_TTL_MS,
      metadata: {
        score: match.score,
        matchedTerms: match.matchedTerms,
        episodeKind: episode.episodeKind,
        focus: episode.focus,
      },
      baseScore: match.score,
    });
  }
  return candidates;
}

async function selectOpenLoopCandidates(
  runtime: BrewvaRuntime,
  sessionId: string,
  prompt: string,
  trigger?: {
    planReason?: string;
  } | null,
): Promise<HydrationCandidate[]> {
  if (!isContinuationPrompt(prompt) && trigger?.planReason !== "open_loop_signal") {
    return [];
  }
  // Open loops are a semantic filter over the summaries lane, not a separate
  // storage lane. We intentionally read recent summaries and select the latest
  // unresolved status packet that looks resumable.
  const artifacts = (await listCognitionArtifacts(runtime.workspaceRoot, "summaries"))
    .toReversed()
    .slice(0, 12);
  const candidates: HydrationCandidate[] = [];
  for (const artifact of artifacts) {
    const content = await readCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      fileName: artifact.fileName,
    });
    if (!matchesSessionScope(content, sessionId, "summary")) continue;
    const openLoop = isOpenLoopSummary(content);
    if (!openLoop) continue;
    candidates.push({
      strategy: "open_loop",
      artifact,
      artifactRef: artifact.artifactRef,
      content,
      packetKey: buildOpenLoopPacketKey(artifact.fileName),
      label: buildOpenLoopLabel(artifact.fileName),
      subject: `memory_open_loop:${artifact.fileName}`,
      expiresAt: Date.now() + MEMORY_OPEN_LOOP_PACKET_TTL_MS,
      baseScore: Number((1.5 + artifact.createdAt / 1_000_000_000_000).toFixed(6)),
      metadata: {
        summaryKind: openLoop.summaryKind,
        status: openLoop.status,
        nextAction: openLoop.nextAction,
        blockedOn: openLoop.blockedOn,
      },
    });
    break;
  }
  return candidates;
}

function eventTypesForStrategy(strategy: MemoryHydrationStrategy): {
  success: string;
  failure: string;
} {
  switch (strategy) {
    case "episode":
      return {
        success: MEMORY_EPISODE_REHYDRATED_EVENT_TYPE,
        failure: MEMORY_EPISODE_REHYDRATION_FAILED_EVENT_TYPE,
      };
    case "summary":
      return {
        success: MEMORY_SUMMARY_REHYDRATED_EVENT_TYPE,
        failure: MEMORY_SUMMARY_REHYDRATION_FAILED_EVENT_TYPE,
      };
    case "procedure":
      return {
        success: MEMORY_PROCEDURE_REHYDRATED_EVENT_TYPE,
        failure: MEMORY_PROCEDURE_REHYDRATION_FAILED_EVENT_TYPE,
      };
    case "open_loop":
      return {
        success: MEMORY_OPEN_LOOP_REHYDRATED_EVENT_TYPE,
        failure: MEMORY_OPEN_LOOP_REHYDRATION_FAILED_EVENT_TYPE,
      };
    case "reference":
    default:
      return {
        success: MEMORY_REFERENCE_REHYDRATED_EVENT_TYPE,
        failure: MEMORY_REFERENCE_REHYDRATION_FAILED_EVENT_TYPE,
      };
  }
}

async function submitHydrationCandidate(
  runtime: BrewvaRuntime,
  sessionId: string,
  hydratedState: HydratedSessionState,
  candidate: HydrationCandidate,
): Promise<void> {
  const eventTypes = eventTypesForStrategy(candidate.strategy);
  try {
    const receipt = await submitExistingCognitionArtifactContextPacket({
      runtime,
      sessionId,
      issuer: DELIBERATION_ISSUERS.memoryCurator,
      artifact: candidate.artifact,
      label: candidate.label,
      subject: candidate.subject,
      packetKey: candidate.packetKey,
      expiresAt: candidate.expiresAt,
      content: candidate.content,
    });
    if (receipt.receipt.decision === "accept") {
      hydratedState.packetKeys.add(candidate.packetKey);
      hydratedState.artifactRefs.add(candidate.artifactRef);
      runtime.events.record({
        sessionId,
        type: eventTypes.success,
        payload: {
          artifactRef: candidate.artifactRef,
          packetKey: candidate.packetKey,
          ...candidate.metadata,
        },
      });
      return;
    }

    runtime.events.record({
      sessionId,
      type: eventTypes.failure,
      payload: {
        artifactRef: candidate.artifactRef,
        packetKey: candidate.packetKey,
        decision: receipt.receipt.decision,
        reasons: receipt.receipt.reasons,
        ...candidate.metadata,
      },
    });
  } catch (error) {
    runtime.events.record({
      sessionId,
      type: eventTypes.failure,
      payload: {
        artifactRef: candidate.artifactRef,
        packetKey: candidate.packetKey,
        reasons: [error instanceof Error ? error.message : String(error)],
        referenceDir: resolveCognitionArtifactsDir(runtime.workspaceRoot, "reference"),
        summariesDir: resolveCognitionArtifactsDir(runtime.workspaceRoot, "summaries"),
        ...candidate.metadata,
      },
    });
  }
}

export function registerMemoryCurator(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const hydratedBySession = new Map<string, HydratedSessionState>();

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const prompt = typeof (event as { prompt?: unknown }).prompt === "string" ? event.prompt : "";
    const proactivityTrigger = readLatestProactivityWakeup(runtime, sessionId, prompt);
    const selectionText = buildProactivitySelectionText({
      prompt,
      trigger: proactivityTrigger,
    });
    const selectedReferences = await selectCognitionArtifactsForPrompt({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      prompt: selectionText,
      maxArtifacts: 3,
    });
    const episodeCandidates = await selectEpisodeCandidates(runtime, selectionText, sessionId);
    const summaryCandidates = await selectSummaryCandidates(runtime, selectionText, sessionId);
    const openLoopCandidates = await selectOpenLoopCandidates(
      runtime,
      sessionId,
      prompt,
      proactivityTrigger,
    );
    const candidates: HydrationCandidate[] = [];

    for (const match of selectedReferences) {
      // Procedure notes are stored in the reference lane on purpose. They are
      // reusable, non-authoritative operator/control-plane sediment, not a
      // separate storage authority that the kernel would need to understand.
      const procedure = parseProcedureNoteContent(match.content);
      candidates.push({
        strategy: procedure ? "procedure" : "reference",
        artifact: match.artifact,
        artifactRef: match.artifact.artifactRef,
        content: match.content,
        packetKey: procedure
          ? buildProcedurePacketKey(match.artifact.fileName)
          : buildPacketKey(match.artifact.fileName),
        label: procedure
          ? buildProcedureLabel(match.artifact.fileName)
          : buildLabel(match.artifact.fileName),
        subject: procedure
          ? `memory_procedure:${match.artifact.fileName}`
          : `memory_reference:${match.artifact.fileName}`,
        expiresAt:
          Date.now() +
          (procedure ? MEMORY_PROCEDURE_PACKET_TTL_MS : MEMORY_REFERENCE_PACKET_TTL_MS),
        metadata: {
          score: match.score,
          matchedTerms: match.matchedTerms,
          noteKind: procedure?.noteKind ?? null,
          lessonKey: procedure?.lessonKey ?? null,
          pattern: procedure?.pattern ?? null,
          triggerSource: proactivityTrigger?.source ?? null,
          triggerRuleId: proactivityTrigger?.ruleId ?? null,
          wakeMode: proactivityTrigger?.wakeMode ?? null,
          planReason: proactivityTrigger?.planReason ?? null,
        },
        baseScore: match.score,
      });
    }
    for (const candidate of episodeCandidates) {
      candidates.push({
        ...candidate,
        metadata: {
          ...candidate.metadata,
          triggerSource: proactivityTrigger?.source ?? null,
          triggerRuleId: proactivityTrigger?.ruleId ?? null,
          wakeMode: proactivityTrigger?.wakeMode ?? null,
          planReason: proactivityTrigger?.planReason ?? null,
        },
      });
    }
    for (const candidate of summaryCandidates) {
      candidates.push({
        strategy: candidate.strategy,
        artifact: candidate.artifact,
        artifactRef: candidate.artifactRef,
        content: candidate.content,
        packetKey: candidate.packetKey,
        label: candidate.label,
        subject: candidate.subject,
        expiresAt: candidate.expiresAt,
        metadata: {
          ...candidate.metadata,
          triggerSource: proactivityTrigger?.source ?? null,
          triggerRuleId: proactivityTrigger?.ruleId ?? null,
          wakeMode: proactivityTrigger?.wakeMode ?? null,
          planReason: proactivityTrigger?.planReason ?? null,
        },
        baseScore: candidate.baseScore,
      });
    }
    for (const candidate of openLoopCandidates) {
      candidates.push({
        strategy: candidate.strategy,
        artifact: candidate.artifact,
        artifactRef: candidate.artifactRef,
        content: candidate.content,
        packetKey: candidate.packetKey,
        label: candidate.label,
        subject: candidate.subject,
        expiresAt: candidate.expiresAt,
        metadata: {
          ...candidate.metadata,
          triggerSource: proactivityTrigger?.source ?? null,
          triggerRuleId: proactivityTrigger?.ruleId ?? null,
          wakeMode: proactivityTrigger?.wakeMode ?? null,
          planReason: proactivityTrigger?.planReason ?? null,
        },
        baseScore: candidate.baseScore,
      });
    }
    if (candidates.length === 0) {
      return undefined;
    }

    const adaptationPolicy = await readMemoryAdaptationPolicy(runtime.workspaceRoot);
    const rankedCandidates = [
      ...candidates.filter((candidate) => candidate.strategy === "open_loop"),
      ...rankMemoryHydrationCandidates(
        candidates.filter((candidate) => candidate.strategy !== "open_loop"),
        adaptationPolicy,
      ),
    ];

    const hydratedState = getOrCreateHydratedState(hydratedBySession, sessionId);

    for (const candidate of rankedCandidates) {
      if (
        hydratedState.packetKeys.has(candidate.packetKey) ||
        hydratedState.artifactRefs.has(candidate.artifactRef)
      ) {
        continue;
      }
      await submitHydrationCandidate(runtime, sessionId, hydratedState, candidate);
    }

    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    hydratedBySession.delete(ctx.sessionManager.getSessionId());
    return undefined;
  });
}
