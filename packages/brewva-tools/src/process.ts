import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { addMilliseconds, differenceInMilliseconds, isBefore } from "date-fns";
import {
  DEFAULT_LOG_TAIL_LINES,
  MAX_POLL_WAIT_MS,
  deleteManagedSession,
  drainSessionOutput,
  getFinishedSession,
  getRunningSession,
  hasPendingOutput,
  listFinishedBackgroundSessions,
  listRunningBackgroundSessions,
  readSessionLog,
  terminateRunningSession,
  type ManagedExecFinishedSession,
  type ManagedExecRunningSession,
} from "./exec-process-registry.js";
import { textResult, type ToolResultVerdict, withVerdict } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const ProcessActionSchema = Type.Union([
  Type.Literal("list"),
  Type.Literal("poll"),
  Type.Literal("log"),
  Type.Literal("write"),
  Type.Literal("kill"),
  Type.Literal("clear"),
  Type.Literal("remove"),
]);

const ProcessSchema = Type.Object({
  action: ProcessActionSchema,
  sessionId: Type.Optional(Type.String()),
  session_id: Type.Optional(Type.String()),
  data: Type.Optional(Type.String()),
  eof: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 0 })),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_POLL_WAIT_MS })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_POLL_WAIT_MS })),
});

function pickSessionId(params: { sessionId?: unknown; session_id?: unknown }): string | undefined {
  const candidate = typeof params.sessionId === "string" ? params.sessionId : params.session_id;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePollTimeoutMs(params: { timeout?: unknown; timeout_ms?: unknown }): number {
  const raw = typeof params.timeout === "number" ? params.timeout : params.timeout_ms;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(MAX_POLL_WAIT_MS, Math.trunc(raw)));
}

function formatRuntimeMs(startedAt: number, endedAt = Date.now()): string {
  const value = Math.max(0, differenceInMilliseconds(endedAt, startedAt));
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatSessionLabel(command: string): string {
  const trimmed = command.trim().replaceAll(/\s+/g, " ");
  if (trimmed.length <= 96) return trimmed;
  return `${trimmed.slice(0, 93)}...`;
}

function renderListLine(input: {
  sessionId: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  command: string;
}): string {
  return `${input.sessionId} ${input.status.padEnd(9, " ")} ${formatRuntimeMs(
    input.startedAt,
    input.endedAt,
  )} :: ${formatSessionLabel(input.command)}`;
}

function normalizeOutputText(value: string, fallback: string): string {
  const text = value.trimEnd();
  return text.length > 0 ? text : fallback;
}

function exitLabel(session: ManagedExecFinishedSession): string {
  if (session.exitSignal) return `signal ${session.exitSignal}`;
  return `code ${session.exitCode ?? 0}`;
}

async function writeToStdin(
  session: ManagedExecRunningSession,
  data: string,
  eof: boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    session.stdin.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (eof) {
    session.stdin.end();
  }
}

async function waitForPollCondition(
  ownerSessionId: string,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) return;
  const deadline = addMilliseconds(Date.now(), timeoutMs).getTime();
  while (isBefore(Date.now(), deadline)) {
    const running = getRunningSession(ownerSessionId, sessionId);
    if (!running) return;
    if (running.exited || hasPendingOutput(running)) return;
    const sleepMs = Math.min(200, Math.max(1, differenceInMilliseconds(deadline, Date.now())));
    await new Promise((resolveNow) => setTimeout(resolveNow, sleepMs));
  }
}

function defaultTailHint(totalLines: number, usingDefaultTail: boolean): string {
  if (!usingDefaultTail || totalLines <= DEFAULT_LOG_TAIL_LINES) return "";
  return `\n\n[showing last ${DEFAULT_LOG_TAIL_LINES} of ${totalLines} lines; pass offset/limit to page]`;
}

function resolveProcessVerdict(
  status: "running" | "completed" | "failed",
): ToolResultVerdict | undefined {
  if (status === "running") return "inconclusive";
  if (status === "failed") return "fail";
  return undefined;
}

export function createProcessTool(): ToolDefinition {
  return defineBrewvaTool({
    name: "process",
    label: "Process",
    description:
      "Manage background exec sessions: list, poll output, inspect logs, write stdin, kill.",
    parameters: ProcessSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ownerSessionId = getSessionId(ctx);

      if (params.action === "list") {
        const running = listRunningBackgroundSessions(ownerSessionId).map((session) => ({
          sessionId: session.id,
          status: "running",
          pid: session.pid ?? undefined,
          startedAt: session.startedAt,
          command: session.command,
          cwd: session.cwd,
          tail: session.tail,
          truncated: session.truncated,
        }));
        const finished = listFinishedBackgroundSessions(ownerSessionId).map((session) => ({
          sessionId: session.id,
          status: session.status,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          command: session.command,
          cwd: session.cwd,
          exitCode: session.exitCode ?? undefined,
          exitSignal: session.exitSignal ?? undefined,
          tail: session.tail,
          truncated: session.truncated,
        }));

        const lines = [...running, ...finished]
          .toSorted((left, right) => right.startedAt - left.startedAt)
          .map((session) =>
            renderListLine({
              sessionId: session.sessionId,
              status: session.status,
              startedAt: session.startedAt,
              endedAt: "endedAt" in session ? session.endedAt : undefined,
              command: session.command,
            }),
          );
        return textResult(lines.join("\n") || "No running or recent background sessions.", {
          status: "completed",
          sessions: [...running, ...finished],
        });
      }

      const sessionId = pickSessionId(params);
      if (!sessionId) {
        return textResult(
          "sessionId is required for this action.",
          withVerdict({ status: "failed" }, "fail"),
        );
      }

      if (params.action === "poll") {
        const timeoutMs = resolvePollTimeoutMs(params);
        await waitForPollCondition(ownerSessionId, sessionId, timeoutMs);

        const running = getRunningSession(ownerSessionId, sessionId);
        if (running) {
          if (!running.backgrounded) {
            return textResult(
              `Session ${sessionId} is not backgrounded.`,
              withVerdict({ status: "failed" }, "fail"),
            );
          }
          const output = normalizeOutputText(drainSessionOutput(running), "(no new output)");
          return textResult(
            `${output}\n\nProcess still running.`,
            withVerdict(
              {
                status: "running",
                sessionId,
                pid: running.pid ?? undefined,
                name: formatSessionLabel(running.command),
              },
              "inconclusive",
            ),
          );
        }

        const finished = getFinishedSession(ownerSessionId, sessionId);
        if (!finished) {
          return textResult(
            `No session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }

        const output = normalizeOutputText(drainSessionOutput(finished), "(no new output)");
        return textResult(
          `${output}\n\nProcess exited with ${exitLabel(finished)}.`,
          withVerdict(
            {
              status: finished.status,
              sessionId,
              exitCode: finished.exitCode ?? undefined,
              exitSignal: finished.exitSignal ?? undefined,
              name: formatSessionLabel(finished.command),
            },
            resolveProcessVerdict(finished.status),
          ),
        );
      }

      if (params.action === "log") {
        const running = getRunningSession(ownerSessionId, sessionId);
        const finished = running ? undefined : getFinishedSession(ownerSessionId, sessionId);
        const session = running ?? finished;
        if (!session) {
          return textResult(
            `No session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        if (!session.backgrounded) {
          return textResult(
            `Session ${sessionId} is not backgrounded.`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }

        const log = readSessionLog(session, params.offset, params.limit);
        const content = normalizeOutputText(
          log.output,
          running ? "(no output yet)" : "(no output recorded)",
        );
        const status = running ? "running" : (finished?.status ?? "completed");
        return textResult(
          content + defaultTailHint(log.totalLines, log.usingDefaultTail),
          withVerdict(
            {
              status,
              sessionId,
              totalLines: log.totalLines,
              totalChars: log.totalChars,
              truncated: session.truncated,
              name: formatSessionLabel(session.command),
            },
            resolveProcessVerdict(status),
          ),
        );
      }

      if (params.action === "write") {
        const running = getRunningSession(ownerSessionId, sessionId);
        if (!running) {
          return textResult(
            `No active session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        if (!running.backgrounded) {
          return textResult(
            `Session ${sessionId} is not backgrounded.`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        if (!running.stdin || running.stdin.destroyed) {
          return textResult(
            `Session ${sessionId} stdin is not writable.`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }

        const data = typeof params.data === "string" ? params.data : "";
        try {
          await writeToStdin(running, data, params.eof === true);
          return textResult(
            `Wrote ${data.length} bytes to session ${sessionId}${params.eof ? " (stdin closed)" : ""}.`,
            withVerdict(
              {
                status: "running",
                sessionId,
                name: formatSessionLabel(running.command),
              },
              "inconclusive",
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(
            `Failed to write to session ${sessionId}: ${message}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
      }

      if (params.action === "kill") {
        const running = getRunningSession(ownerSessionId, sessionId);
        if (!running) {
          return textResult(
            `No active session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        if (!running.backgrounded) {
          return textResult(
            `Session ${sessionId} is not backgrounded.`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }

        const terminated = terminateRunningSession(running, true);
        if (!terminated) {
          return textResult(
            `Unable to terminate session ${sessionId}: no active process id or handle.`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        return textResult(
          `Termination requested for session ${sessionId}.`,
          withVerdict(
            {
              status: "failed",
              sessionId,
              name: formatSessionLabel(running.command),
            },
            "fail",
          ),
        );
      }

      if (params.action === "clear") {
        const finished = getFinishedSession(ownerSessionId, sessionId);
        if (!finished) {
          return textResult(
            `No finished session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        deleteManagedSession(ownerSessionId, sessionId);
        return textResult(`Cleared session ${sessionId}.`, { status: "completed" });
      }

      if (params.action === "remove") {
        const running = getRunningSession(ownerSessionId, sessionId);
        if (running) {
          terminateRunningSession(running, true);
          const deadline = addMilliseconds(Date.now(), 3_000).getTime();
          while (!running.exited && isBefore(Date.now(), deadline)) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!running.exited) {
            return textResult(
              `Session ${sessionId} did not exit after termination. Use kill then try remove again.`,
              withVerdict({ status: "failed" }, "fail"),
            );
          }
        }
        const removed = deleteManagedSession(ownerSessionId, sessionId);
        if (!removed) {
          return textResult(
            `No session found for ${sessionId}`,
            withVerdict({ status: "failed" }, "fail"),
          );
        }
        const status = running ? "failed" : "completed";
        return textResult(
          `Removed session ${sessionId}.`,
          withVerdict({ status }, resolveProcessVerdict(status)),
        );
      }

      return textResult(
        `Unknown action: ${String(params.action)}`,
        withVerdict({ status: "failed" }, "fail"),
      );
    },
  });
}
