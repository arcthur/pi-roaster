import {
  DELIBERATION_ISSUERS,
  listCognitionArtifacts,
  parseStatusSummaryPacketContent,
  readCognitionArtifact,
  resolveCognitionArtifactsDir,
  selectCognitionArtifactsForPrompt,
  submitExistingCognitionArtifactContextPacket,
} from "@brewva/brewva-deliberation";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MEMORY_REFERENCE_PACKET_TTL_MS = 6 * 60 * 60 * 1000;
const MEMORY_SUMMARY_PACKET_TTL_MS = 3 * 60 * 60 * 1000;
const MEMORY_OPEN_LOOP_PACKET_TTL_MS = 4 * 60 * 60 * 1000;
const MEMORY_REFERENCE_REHYDRATED_EVENT_TYPE = "memory_reference_rehydrated";
const MEMORY_REFERENCE_REHYDRATION_FAILED_EVENT_TYPE = "memory_reference_rehydration_failed";
const MEMORY_SUMMARY_REHYDRATED_EVENT_TYPE = "memory_summary_rehydrated";
const MEMORY_SUMMARY_REHYDRATION_FAILED_EVENT_TYPE = "memory_summary_rehydration_failed";
const MEMORY_OPEN_LOOP_REHYDRATED_EVENT_TYPE = "memory_open_loop_rehydrated";
const MEMORY_OPEN_LOOP_REHYDRATION_FAILED_EVENT_TYPE = "memory_open_loop_rehydration_failed";
const CONTINUATION_PROMPT_REGEX =
  /\b(continue|resume|pick up|pick-up|follow up|follow-up|what next|next step|where were|blocked|carry on)\b/iu;
const OPEN_LOOP_STATUSES = new Set(["blocked", "in_progress", "pending", "retrying", "open"]);
const EMPTY_STATUS_SUMMARY_VALUES = new Set(["", "none", "null", "n/a", "unknown"]);

type MemoryHydrationStrategy = "reference" | "summary" | "open_loop";

interface HydrationCandidate {
  strategy: MemoryHydrationStrategy;
  packetKey: string;
  label: string;
  subject: string;
  expiresAt: number;
  artifactRef: string;
  artifact: Awaited<ReturnType<typeof listCognitionArtifacts>>[number];
  content: string;
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

function stripArtifactExtension(fileName: string): string {
  return fileName.replace(/\.(?:md|txt|json)$/u, "");
}

function buildPacketKey(fileName: string): string {
  return `reference:${fileName.replace(/\.(?:md|txt|json)$/u, "")}`;
}

function buildLabel(fileName: string): string {
  return `Reference:${fileName.replace(/\.(?:md|txt|json)$/u, "")}`;
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

function normalizeStatusSummaryValue(value: string | null | undefined): string | null {
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

function isOpenLoopSummary(content: string): {
  summaryKind: string | null;
  status: string | null;
  nextAction: string | null;
  blockedOn: string | null;
} | null {
  const parsed = parseStatusSummaryPacketContent(content);
  if (!parsed) return null;
  const summaryKind = normalizeStatusSummaryValue(parsed.summaryKind);
  const status = normalizeStatusSummaryValue(parsed.status);
  const nextAction = normalizeStatusSummaryValue(parsed.fields.next_action);
  const blockedOn = normalizeStatusSummaryValue(parsed.fields.blocked_on);
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
  prompt: string,
): Promise<HydrationCandidate[]> {
  const selected = await selectCognitionArtifactsForPrompt({
    workspaceRoot: runtime.workspaceRoot,
    lane: "summaries",
    prompt,
    maxArtifacts: 1,
    scanLimit: 12,
  });
  return selected.map((match) => ({
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
  }));
}

async function selectOpenLoopCandidates(
  runtime: BrewvaRuntime,
  prompt: string,
): Promise<HydrationCandidate[]> {
  if (!isContinuationPrompt(prompt)) {
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
    case "summary":
      return {
        success: MEMORY_SUMMARY_REHYDRATED_EVENT_TYPE,
        failure: MEMORY_SUMMARY_REHYDRATION_FAILED_EVENT_TYPE,
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
    const selectedReferences = await selectCognitionArtifactsForPrompt({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      prompt,
    });

    const candidates: HydrationCandidate[] = [
      ...selectedReferences.map((match) => ({
        strategy: "reference" as const,
        artifact: match.artifact,
        artifactRef: match.artifact.artifactRef,
        content: match.content,
        packetKey: buildPacketKey(match.artifact.fileName),
        label: buildLabel(match.artifact.fileName),
        subject: `memory_reference:${match.artifact.fileName}`,
        expiresAt: Date.now() + MEMORY_REFERENCE_PACKET_TTL_MS,
        metadata: {
          score: match.score,
          matchedTerms: match.matchedTerms,
        },
      })),
      ...(await selectSummaryCandidates(runtime, prompt)),
      ...(await selectOpenLoopCandidates(runtime, prompt)),
    ];
    if (candidates.length === 0) {
      return undefined;
    }

    const hydratedState = getOrCreateHydratedState(hydratedBySession, sessionId);

    for (const candidate of candidates) {
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
