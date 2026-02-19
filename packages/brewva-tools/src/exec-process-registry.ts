import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { getShellConfig } from "@mariozechner/pi-coding-agent";

const MAX_AGGREGATED_OUTPUT_CHARS = 1_000_000;
const TAIL_CHARS = 4_000;
const FINISHED_TTL_MS = 30 * 60 * 1000;

export const DEFAULT_LOG_TAIL_LINES = 200;
export const MAX_POLL_WAIT_MS = 120_000;

export type ManagedExecResultStatus = "completed" | "failed";

interface ManagedExecBase {
  id: string;
  ownerSessionId: string;
  command: string;
  cwd: string;
  startedAt: number;
  pid: number | null;
  backgrounded: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  aggregated: string;
  tail: string;
  truncated: boolean;
  drainCursor: number;
  timedOut: boolean;
  removed: boolean;
}

export interface ManagedExecRunningSession extends ManagedExecBase {
  kind: "running";
  child: ChildProcessWithoutNullStreams;
  stdin: ChildProcessWithoutNullStreams["stdin"];
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export interface ManagedExecFinishedSession extends ManagedExecBase {
  kind: "finished";
  endedAt: number;
  status: ManagedExecResultStatus;
}

export interface ManagedExecStartInput {
  ownerSessionId: string;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutSec?: number;
}

export interface ManagedExecStartResult {
  session: ManagedExecRunningSession;
  completion: Promise<ManagedExecFinishedSession>;
}

export interface SessionLogSlice {
  output: string;
  totalLines: number;
  totalChars: number;
  usingDefaultTail: boolean;
}

const runningSessions = new Map<string, ManagedExecRunningSession>();
const finishedSessions = new Map<string, ManagedExecFinishedSession>();

function cleanupExpiredFinishedSessions(now = Date.now()): void {
  for (const [sessionId, session] of finishedSessions.entries()) {
    if (now - session.endedAt > FINISHED_TTL_MS) {
      finishedSessions.delete(sessionId);
    }
  }
}

function createSessionId(): string {
  return `proc_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

function clampNonNegativeInt(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function appendOutput(session: ManagedExecRunningSession, chunk: Buffer | string): void {
  if (session.removed) return;
  const text = String(chunk);
  if (!text) return;

  session.aggregated += text;
  if (session.aggregated.length > MAX_AGGREGATED_OUTPUT_CHARS) {
    const overflow = session.aggregated.length - MAX_AGGREGATED_OUTPUT_CHARS;
    session.aggregated = session.aggregated.slice(overflow);
    session.drainCursor = Math.max(0, session.drainCursor - overflow);
    session.truncated = true;
  }

  if (session.drainCursor > session.aggregated.length) {
    session.drainCursor = session.aggregated.length;
  }
  session.tail = session.aggregated.slice(-TAIL_CHARS);
}

function finalizeSession(session: ManagedExecRunningSession): ManagedExecFinishedSession {
  if (session.timeoutHandle) {
    clearTimeout(session.timeoutHandle);
    session.timeoutHandle = undefined;
  }
  runningSessions.delete(session.id);

  const status: ManagedExecResultStatus =
    session.exitCode === 0 && session.exitSignal == null && !session.timedOut
      ? "completed"
      : "failed";
  const finished: ManagedExecFinishedSession = {
    id: session.id,
    kind: "finished",
    ownerSessionId: session.ownerSessionId,
    command: session.command,
    cwd: session.cwd,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    pid: session.pid,
    backgrounded: session.backgrounded,
    exited: true,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    aggregated: session.aggregated,
    tail: session.tail,
    truncated: session.truncated,
    drainCursor: session.drainCursor,
    timedOut: session.timedOut,
    removed: session.removed,
    status,
  };

  if (!finished.removed) {
    finishedSessions.set(finished.id, finished);
    cleanupExpiredFinishedSessions();
  }
  return finished;
}

function tryKillByPid(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // fall through
    }
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch {
    if (process.platform === "win32" && signal === "SIGKILL") {
      try {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function terminateRunningSession(
  session: ManagedExecRunningSession,
  force = false,
): boolean {
  if (session.exited) return false;
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  const byPid = session.pid !== null ? tryKillByPid(session.pid, signal) : false;

  if (!byPid) {
    try {
      session.child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export function startManagedExec(input: ManagedExecStartInput): ManagedExecStartResult {
  cleanupExpiredFinishedSessions();

  const id = createSessionId();
  const cwd = resolve(input.cwd);
  const { shell, args } = getShellConfig();
  const child = spawn(shell, [...args, input.command], {
    cwd,
    env: input.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const session: ManagedExecRunningSession = {
    id,
    kind: "running",
    ownerSessionId: input.ownerSessionId,
    command: input.command,
    cwd,
    startedAt: Date.now(),
    pid: child.pid ?? null,
    child,
    stdin: child.stdin,
    backgrounded: false,
    exited: false,
    exitCode: null,
    exitSignal: null,
    aggregated: "",
    tail: "",
    truncated: false,
    drainCursor: 0,
    timedOut: false,
    removed: false,
  };
  runningSessions.set(session.id, session);

  if (typeof input.timeoutSec === "number" && input.timeoutSec > 0) {
    const timeoutMs = Math.trunc(input.timeoutSec * 1000);
    session.timeoutHandle = setTimeout(() => {
      if (session.exited || session.removed) return;
      session.timedOut = true;
      appendOutput(session, `\n\nCommand timed out after ${input.timeoutSec} seconds.`);
      terminateRunningSession(session, true);
    }, timeoutMs);
  }

  const completion = new Promise<ManagedExecFinishedSession>((resolveCompletion) => {
    const settle = (params: {
      exitCode: number | null;
      exitSignal: NodeJS.Signals | null;
      spawnError?: string;
    }) => {
      if (session.exited) return;
      session.exited = true;
      session.exitCode = params.exitCode;
      session.exitSignal = params.exitSignal;
      if (params.spawnError) {
        appendOutput(session, `\n\n${params.spawnError}`);
      }
      resolveCompletion(finalizeSession(session));
    };

    child.stdout.on("data", (chunk) => {
      appendOutput(session, chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendOutput(session, chunk);
    });
    child.on("error", (error) => {
      settle({
        exitCode: null,
        exitSignal: null,
        spawnError: `Failed to spawn command: ${error.message}`,
      });
    });
    child.on("close", (code, signal) => {
      settle({
        exitCode: code ?? null,
        exitSignal: signal ?? null,
      });
    });
  });

  return { session, completion };
}

export function markSessionBackgrounded(ownerSessionId: string, sessionId: string): boolean {
  cleanupExpiredFinishedSessions();
  const running = runningSessions.get(sessionId);
  if (running && running.ownerSessionId === ownerSessionId) {
    running.backgrounded = true;
    return true;
  }
  const finished = finishedSessions.get(sessionId);
  if (finished && finished.ownerSessionId === ownerSessionId) {
    finished.backgrounded = true;
    return true;
  }
  return false;
}

export function listRunningBackgroundSessions(ownerSessionId: string): ManagedExecRunningSession[] {
  cleanupExpiredFinishedSessions();
  return [...runningSessions.values()].filter(
    (session) => session.ownerSessionId === ownerSessionId && session.backgrounded,
  );
}

export function listFinishedBackgroundSessions(
  ownerSessionId: string,
): ManagedExecFinishedSession[] {
  cleanupExpiredFinishedSessions();
  return [...finishedSessions.values()].filter(
    (session) => session.ownerSessionId === ownerSessionId && session.backgrounded,
  );
}

export function getRunningSession(
  ownerSessionId: string,
  sessionId: string,
): ManagedExecRunningSession | undefined {
  cleanupExpiredFinishedSessions();
  const session = runningSessions.get(sessionId);
  if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
  return session;
}

export function getFinishedSession(
  ownerSessionId: string,
  sessionId: string,
): ManagedExecFinishedSession | undefined {
  cleanupExpiredFinishedSessions();
  const session = finishedSessions.get(sessionId);
  if (!session || session.ownerSessionId !== ownerSessionId) return undefined;
  return session;
}

export function hasPendingOutput(
  session: ManagedExecRunningSession | ManagedExecFinishedSession,
): boolean {
  return session.aggregated.length > session.drainCursor;
}

export function drainSessionOutput(
  session: ManagedExecRunningSession | ManagedExecFinishedSession,
): string {
  if (session.drainCursor > session.aggregated.length) {
    session.drainCursor = session.aggregated.length;
  }
  const next = session.aggregated.slice(session.drainCursor);
  session.drainCursor = session.aggregated.length;
  return next;
}

export function readSessionLog(
  session: ManagedExecRunningSession | ManagedExecFinishedSession,
  offset?: number,
  limit?: number,
): SessionLogSlice {
  const normalized = session.aggregated.replaceAll("\r\n", "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }

  const totalLines = lines.length;
  const totalChars = normalized.length;
  const safeOffset =
    typeof offset === "number" && Number.isFinite(offset) ? clampNonNegativeInt(offset) : undefined;
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) ? clampNonNegativeInt(limit) : undefined;
  const usingDefaultTail = safeOffset === undefined && safeLimit === undefined;

  let start = 0;
  let end = totalLines;
  if (safeOffset !== undefined) {
    start = Math.min(safeOffset, totalLines);
  } else if (usingDefaultTail) {
    start = Math.max(0, totalLines - DEFAULT_LOG_TAIL_LINES);
  }
  if (safeLimit !== undefined) {
    end = Math.min(totalLines, start + safeLimit);
  }

  return {
    output: lines.slice(start, end).join("\n"),
    totalLines,
    totalChars,
    usingDefaultTail,
  };
}

export function deleteManagedSession(ownerSessionId: string, sessionId: string): boolean {
  cleanupExpiredFinishedSessions();
  const running = runningSessions.get(sessionId);
  if (running && running.ownerSessionId === ownerSessionId) {
    if (!running.exited) return false;
    running.removed = true;
    runningSessions.delete(sessionId);
    finishedSessions.delete(sessionId);
    return true;
  }

  const finished = finishedSessions.get(sessionId);
  if (finished && finished.ownerSessionId === ownerSessionId) {
    finished.removed = true;
    finishedSessions.delete(sessionId);
    return true;
  }
  return false;
}
