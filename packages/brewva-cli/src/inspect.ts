import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  BrewvaRuntime,
  TASK_EVENT_TYPE,
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  TRUTH_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  createTrustedLocalGovernancePort,
  foldTaskLedgerEvents,
  foldTruthLedgerEvents,
  type BrewvaEventRecord,
} from "@brewva/brewva-runtime";
import { formatISO } from "date-fns";

const INSPECT_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  cwd: { type: "string" },
  config: { type: "string" },
  session: { type: "string" },
  json: { type: "boolean" },
} as const;

interface InspectBootstrapPayload {
  extensionsEnabled?: boolean;
  addonsEnabled?: boolean;
  skillBroker?: {
    enabled?: boolean;
    proposalBoundary?: string | null;
  };
  skillLoad?: {
    routingEnabled?: boolean;
    routingScopes?: string[];
    routableSkills?: string[];
    hiddenSkills?: string[];
  };
}

interface InspectVerification {
  timestamp: string | null;
  outcome: string | null;
  level: string | null;
  failedChecks: string[];
  missingEvidence: string[];
  reason: string | null;
}

interface InspectReport {
  sessionId: string;
  workspaceRoot: string;
  hydration: {
    status: "cold" | "ready" | "degraded";
    hydratedAt: string | null;
    latestEventId: string | null;
    issueCount: number;
    issues: Array<{
      eventId: string;
      eventType: string;
      index: number;
      reason: string;
    }>;
  };
  replay: {
    eventCount: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
    anchorCount: number;
    checkpointCount: number;
    tapePressure: string;
    entriesSinceAnchor: number;
  };
  bootstrap: {
    extensionsEnabled: boolean | null;
    addonsEnabled: boolean | null;
    skillBrokerEnabled: boolean | null;
    routingEnabled: boolean | null;
    routingScopes: string[];
    routableSkills: string[];
    hiddenSkills: string[];
  };
  task: {
    goal: string | null;
    phase: string | null;
    health: string | null;
    items: number;
    blockers: number;
    updatedAt: string | null;
  };
  truth: {
    totalFacts: number;
    activeFacts: number;
    updatedAt: string | null;
  };
  skills: {
    activeSkill: string | null;
    completedSkills: string[];
    lastRoutingMode: string | null;
    lastCascadeEvent: string | null;
  };
  verification: InspectVerification;
  ledger: {
    path: string;
    rows: number;
    chainValid: boolean;
    chainReason: string | null;
  };
  projection: {
    enabled: boolean;
    rootDir: string;
    workingPath: string;
    workingExists: boolean;
    unitsPath: string;
    unitsExists: boolean;
    statePath: string;
    stateExists: boolean;
  };
  turnWal: {
    enabled: boolean;
    filePath: string;
    pendingCount: number;
    pendingSessionCount: number;
  };
  snapshots: {
    sessionDir: string;
    sessionDirExists: boolean;
    patchHistoryPath: string;
    patchHistoryExists: boolean;
  };
  consistency: {
    ledgerChain: "ok" | "invalid";
    projectionWorking: "present" | "missing" | "disabled";
    pendingTurnWal: number;
  };
}

function printInspectHelp(): void {
  console.log(`Brewva Inspect - replay-first session inspection

Usage:
  brewva inspect [options]

Options:
  --cwd <path>       Working directory
  --config <path>    Brewva config path (default: .brewva/brewva.json)
  --session <id>     Inspect a specific replay session
  --json             Emit JSON output
  -h, --help         Show help

Examples:
  brewva inspect
  brewva inspect --session <session-id>
  brewva inspect --json --session <session-id>`);
}

function encodeSessionIdForPath(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function sanitizeSessionIdForPath(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function toIso(timestamp: number | null | undefined): string | null {
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? formatISO(timestamp) : null;
}

function readLatestEventPayload<T extends object>(
  runtime: BrewvaRuntime,
  sessionId: string,
  type: string,
): { payload: T; timestamp: number } | null {
  const event = runtime.events.query(sessionId, { type, last: 1 })[0];
  if (!event?.payload) return null;
  return {
    payload: event.payload as T,
    timestamp: event.timestamp,
  };
}

function buildSkillInspection(events: BrewvaEventRecord[]): InspectReport["skills"] {
  let activeSkill: string | null = null;
  const completedSkills = new Set<string>();
  let lastRoutingMode: string | null = null;
  let lastCascadeEvent: string | null = null;

  for (const event of events) {
    const payload = event.payload;
    if (event.type === "skill_activated" && typeof payload?.skillName === "string") {
      activeSkill = payload.skillName;
      continue;
    }
    if (event.type === "skill_completed" && typeof payload?.skillName === "string") {
      completedSkills.add(payload.skillName);
      if (activeSkill === payload.skillName) {
        activeSkill = null;
      }
      continue;
    }
    if (event.type === "skill_routing_decided" && typeof payload?.mode === "string") {
      lastRoutingMode = payload.mode;
      continue;
    }
    if (event.type.startsWith("skill_cascade_")) {
      lastCascadeEvent = event.type;
    }
  }

  return {
    activeSkill,
    completedSkills: [...completedSkills].toSorted((left, right) => left.localeCompare(right)),
    lastRoutingMode,
    lastCascadeEvent,
  };
}

function buildVerificationInspection(
  runtime: BrewvaRuntime,
  sessionId: string,
): InspectVerification {
  const latest = readLatestEventPayload<Record<string, unknown>>(
    runtime,
    sessionId,
    VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  );
  if (!latest) {
    return {
      timestamp: null,
      outcome: null,
      level: null,
      failedChecks: [],
      missingEvidence: [],
      reason: null,
    };
  }

  const failedChecks = Array.isArray(latest.payload.failedChecks)
    ? latest.payload.failedChecks.filter((value): value is string => typeof value === "string")
    : [];
  const missingEvidence = Array.isArray(latest.payload.missingEvidence)
    ? latest.payload.missingEvidence.filter((value): value is string => typeof value === "string")
    : [];

  return {
    timestamp: toIso(latest.timestamp),
    outcome: typeof latest.payload.outcome === "string" ? latest.payload.outcome : null,
    level: typeof latest.payload.level === "string" ? latest.payload.level : null,
    failedChecks,
    missingEvidence,
    reason:
      typeof latest.payload.reason === "string" && latest.payload.reason.trim().length > 0
        ? latest.payload.reason
        : null,
  };
}

function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function countSessionPendingWal(runtime: BrewvaRuntime, sessionId: string): number {
  return runtime.turnWal.listPending().filter((row) => row.sessionId === sessionId).length;
}

function resolveTargetSession(runtime: BrewvaRuntime, requestedSessionId?: string): string | null {
  if (requestedSessionId && requestedSessionId.trim().length > 0) {
    return requestedSessionId.trim();
  }
  return runtime.events.listReplaySessions(1)[0]?.sessionId ?? null;
}

function buildInspectReport(runtime: BrewvaRuntime, sessionId: string): InspectReport {
  const replaySession =
    runtime.events.listReplaySessions().find((entry) => entry.sessionId === sessionId) ?? null;
  const events = runtime.events.query(sessionId);
  const taskEvents = runtime.events.query(sessionId, { type: TASK_EVENT_TYPE });
  const truthEvents = runtime.events.query(sessionId, { type: TRUTH_EVENT_TYPE });
  const taskState = foldTaskLedgerEvents(taskEvents);
  const truthState = foldTruthLedgerEvents(truthEvents);
  const tapeStatus = runtime.events.getTapeStatus(sessionId);
  const hydration = runtime.session.getHydration(sessionId);
  const bootstrap = readLatestEventPayload<InspectBootstrapPayload>(
    runtime,
    sessionId,
    "session_bootstrap",
  )?.payload;
  const skillState = buildSkillInspection(events);
  const verification = buildVerificationInspection(runtime, sessionId);
  const ledgerChain = runtime.ledger.verifyChain(sessionId);
  const ledgerRows = runtime.ledger.listRows(sessionId);

  const projectionRoot = resolve(runtime.workspaceRoot, runtime.config.projection.dir);
  const projectionWorkingPath = join(
    projectionRoot,
    "sessions",
    `sess_${encodeSessionIdForPath(sessionId)}`,
    runtime.config.projection.workingFile,
  );
  const projectionUnitsPath = join(projectionRoot, "units.jsonl");
  const projectionStatePath = join(projectionRoot, "state.json");

  const walFilePath = resolve(
    runtime.workspaceRoot,
    runtime.config.infrastructure.turnWal.dir,
    "runtime.jsonl",
  );

  const snapshotSessionDir = resolve(
    runtime.workspaceRoot,
    ".orchestrator/snapshots",
    sanitizeSessionIdForPath(sessionId),
  );
  const patchHistoryPath = join(snapshotSessionDir, "patchsets.json");

  return {
    sessionId,
    workspaceRoot: runtime.workspaceRoot,
    hydration: {
      status: hydration.status,
      hydratedAt: toIso(hydration.hydratedAt),
      latestEventId: hydration.latestEventId ?? null,
      issueCount: hydration.issues.length,
      issues: hydration.issues.map((issue) => ({
        eventId: issue.eventId,
        eventType: issue.eventType,
        index: issue.index,
        reason: issue.reason,
      })),
    },
    replay: {
      eventCount: replaySession?.eventCount ?? events.length,
      firstEventAt: toIso(events[0]?.timestamp),
      lastEventAt: toIso(replaySession?.lastEventAt ?? events[events.length - 1]?.timestamp),
      anchorCount: runtime.events.query(sessionId, { type: TAPE_ANCHOR_EVENT_TYPE }).length,
      checkpointCount: runtime.events.query(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE }).length,
      tapePressure: tapeStatus.tapePressure,
      entriesSinceAnchor: tapeStatus.entriesSinceAnchor,
    },
    bootstrap: {
      extensionsEnabled:
        typeof bootstrap?.extensionsEnabled === "boolean" ? bootstrap.extensionsEnabled : null,
      addonsEnabled: typeof bootstrap?.addonsEnabled === "boolean" ? bootstrap.addonsEnabled : null,
      skillBrokerEnabled:
        typeof bootstrap?.skillBroker?.enabled === "boolean" ? bootstrap.skillBroker.enabled : null,
      routingEnabled:
        typeof bootstrap?.skillLoad?.routingEnabled === "boolean"
          ? bootstrap.skillLoad.routingEnabled
          : null,
      routingScopes: Array.isArray(bootstrap?.skillLoad?.routingScopes)
        ? bootstrap.skillLoad.routingScopes.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      routableSkills: Array.isArray(bootstrap?.skillLoad?.routableSkills)
        ? bootstrap.skillLoad.routableSkills.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      hiddenSkills: Array.isArray(bootstrap?.skillLoad?.hiddenSkills)
        ? bootstrap.skillLoad.hiddenSkills.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    },
    task: {
      goal: taskState.spec?.goal ?? null,
      phase: taskState.status?.phase ?? null,
      health: taskState.status?.health ?? null,
      items: taskState.items.length,
      blockers: taskState.blockers.length,
      updatedAt: toIso(taskState.updatedAt),
    },
    truth: {
      totalFacts: truthState.facts.length,
      activeFacts: truthState.facts.filter((fact) => fact.status === "active").length,
      updatedAt: toIso(truthState.updatedAt),
    },
    skills: skillState,
    verification,
    ledger: {
      path: runtime.ledger.getPath(),
      rows: ledgerRows.length,
      chainValid: ledgerChain.valid,
      chainReason: ledgerChain.reason ?? null,
    },
    projection: {
      enabled: runtime.config.projection.enabled,
      rootDir: projectionRoot,
      workingPath: projectionWorkingPath,
      workingExists: pathExists(projectionWorkingPath),
      unitsPath: projectionUnitsPath,
      unitsExists: pathExists(projectionUnitsPath),
      statePath: projectionStatePath,
      stateExists: pathExists(projectionStatePath),
    },
    turnWal: {
      enabled: runtime.config.infrastructure.turnWal.enabled,
      filePath: walFilePath,
      pendingCount: runtime.turnWal.listPending().length,
      pendingSessionCount: countSessionPendingWal(runtime, sessionId),
    },
    snapshots: {
      sessionDir: snapshotSessionDir,
      sessionDirExists: pathExists(snapshotSessionDir),
      patchHistoryPath,
      patchHistoryExists: pathExists(patchHistoryPath),
    },
    consistency: {
      ledgerChain: ledgerChain.valid ? "ok" : "invalid",
      projectionWorking: !runtime.config.projection.enabled
        ? "disabled"
        : pathExists(projectionWorkingPath)
          ? "present"
          : "missing",
      pendingTurnWal: countSessionPendingWal(runtime, sessionId),
    },
  };
}

function printInspectText(report: InspectReport): void {
  const lines = [
    `Session: ${report.sessionId}`,
    `Workspace: ${report.workspaceRoot}`,
    "",
    `Hydration: status=${report.hydration.status} issues=${report.hydration.issueCount} hydratedAt=${report.hydration.hydratedAt ?? "n/a"}`,
    `Replay: events=${report.replay.eventCount} first=${report.replay.firstEventAt ?? "n/a"} last=${report.replay.lastEventAt ?? "n/a"}`,
    `Replay: anchors=${report.replay.anchorCount} checkpoints=${report.replay.checkpointCount} tapePressure=${report.replay.tapePressure} entriesSinceAnchor=${report.replay.entriesSinceAnchor}`,
    `Bootstrap: extensions=${renderNullableBoolean(report.bootstrap.extensionsEnabled)} addons=${renderNullableBoolean(report.bootstrap.addonsEnabled)} broker=${renderNullableBoolean(report.bootstrap.skillBrokerEnabled)}`,
    `Bootstrap: routingEnabled=${renderNullableBoolean(report.bootstrap.routingEnabled)} scopes=${renderList(report.bootstrap.routingScopes)}`,
    `Task: phase=${report.task.phase ?? "n/a"} health=${report.task.health ?? "n/a"} items=${report.task.items} blockers=${report.task.blockers} updatedAt=${report.task.updatedAt ?? "n/a"}`,
    `Task: goal=${report.task.goal ?? "n/a"}`,
    `Truth: active=${report.truth.activeFacts}/${report.truth.totalFacts} updatedAt=${report.truth.updatedAt ?? "n/a"}`,
    `Skills: active=${report.skills.activeSkill ?? "none"} completed=${renderList(report.skills.completedSkills)} routingMode=${report.skills.lastRoutingMode ?? "n/a"} cascade=${report.skills.lastCascadeEvent ?? "n/a"}`,
    `Verification: outcome=${report.verification.outcome ?? "n/a"} level=${report.verification.level ?? "n/a"} failed=${renderList(report.verification.failedChecks)} missing=${renderList(report.verification.missingEvidence)}`,
    `Ledger: rows=${report.ledger.rows} chain=${report.ledger.chainValid ? "valid" : "invalid"} path=${report.ledger.path}`,
    `Projection: enabled=${report.projection.enabled ? "yes" : "no"} working=${report.consistency.projectionWorking} path=${report.projection.workingPath}`,
    `Turn WAL: enabled=${report.turnWal.enabled ? "yes" : "no"} pending=${report.turnWal.pendingCount} sessionPending=${report.turnWal.pendingSessionCount} file=${report.turnWal.filePath}`,
    `Snapshots: sessionDir=${report.snapshots.sessionDirExists ? "present" : "missing"} patchHistory=${report.snapshots.patchHistoryExists ? "present" : "missing"} path=${report.snapshots.patchHistoryPath}`,
    `Consistency: ledger=${report.consistency.ledgerChain} projectionWorking=${report.consistency.projectionWorking} pendingTurnWal=${report.consistency.pendingTurnWal}`,
  ];

  if (report.ledger.chainReason) {
    lines.push(`Ledger reason: ${report.ledger.chainReason}`);
  }
  if (report.hydration.latestEventId) {
    lines.push(`Hydration latestEventId: ${report.hydration.latestEventId}`);
  }
  if (report.hydration.issues.length > 0) {
    for (const issue of report.hydration.issues.slice(0, 5)) {
      lines.push(
        `Hydration issue: index=${issue.index} type=${issue.eventType} event=${issue.eventId} reason=${issue.reason}`,
      );
    }
  }
  if (report.bootstrap.routableSkills.length > 0) {
    lines.push(`Routable skills: ${report.bootstrap.routableSkills.join(", ")}`);
  }
  if (report.bootstrap.hiddenSkills.length > 0) {
    lines.push(`Hidden skills: ${report.bootstrap.hiddenSkills.join(", ")}`);
  }
  if (report.verification.reason) {
    lines.push(`Verification reason: ${report.verification.reason}`);
  }

  console.log(lines.join("\n"));
}

function renderNullableBoolean(value: boolean | null): string {
  if (value === null) return "n/a";
  return value ? "yes" : "no";
}

function renderList(values: string[]): string {
  return values.length > 0 ? values.join(",") : "none";
}

export async function runInspectCli(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: INSPECT_PARSE_OPTIONS,
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printInspectHelp();
    return 0;
  }

  const runtime = new BrewvaRuntime({
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
    governancePort: createTrustedLocalGovernancePort(),
  });
  const targetSessionId = resolveTargetSession(
    runtime,
    typeof parsed.values.session === "string" ? parsed.values.session : undefined,
  );
  if (!targetSessionId) {
    console.error("Error: no replayable session found.");
    return 1;
  }

  const report = buildInspectReport(runtime, targetSessionId);
  if (parsed.values.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printInspectText(report);
  }
  return 0;
}

export { buildInspectReport };
