import { resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  deleteManagedSession,
  markSessionBackgrounded,
  startManagedExec,
  terminateRunningSession,
  type ManagedExecFinishedSession,
  type ManagedExecRunningSession,
} from "./exec-process-registry.js";
import { textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineTool } from "./utils/tool.js";

const ExecSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  workdir: Type.Optional(Type.String()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })),
  yield_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })),
  background: Type.Optional(Type.Boolean()),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 7_200 })),
});

const DEFAULT_YIELD_MS = 10_000;

function normalizeCommand(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const command = value.trim();
  return command.length > 0 ? command : undefined;
}

function resolveWorkdir(baseCwd: string, value: unknown): string {
  if (typeof value !== "string") return baseCwd;
  const trimmed = value.trim();
  if (!trimmed) return baseCwd;
  return resolve(baseCwd, trimmed);
}

function resolveYieldMs(params: { yieldMs?: unknown; yield_ms?: unknown }): number {
  const raw = typeof params.yieldMs === "number" ? params.yieldMs : params.yield_ms;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_YIELD_MS;
  return Math.max(0, Math.min(120_000, Math.trunc(raw)));
}

function formatExit(session: ManagedExecFinishedSession): string {
  if (session.exitSignal) return `signal ${session.exitSignal}`;
  return `code ${session.exitCode ?? 0}`;
}

function runningResult(session: ManagedExecRunningSession) {
  const lines = [
    `Command still running (session ${session.id}, pid ${session.pid ?? "n/a"}).`,
    "Use process (list/poll/log/write/kill/clear/remove) for follow-up.",
  ];
  if (session.tail.trim().length > 0) {
    lines.push("", session.tail.trimEnd());
  }
  return textResult(lines.join("\n"), {
    status: "running",
    sessionId: session.id,
    pid: session.pid ?? undefined,
    startedAt: session.startedAt,
    cwd: session.cwd,
    tail: session.tail,
    command: session.command,
  });
}

async function waitForCompletionOrYield(
  completion: Promise<ManagedExecFinishedSession>,
  yieldMs: number,
): Promise<ManagedExecFinishedSession | undefined> {
  if (yieldMs === 0) return undefined;
  const timerTag = Symbol("yield");
  let yieldTimer: ReturnType<typeof setTimeout> | undefined;
  const winner = await Promise.race([
    completion,
    new Promise<symbol>((resolveNow) => {
      yieldTimer = setTimeout(() => resolveNow(timerTag), yieldMs);
    }),
  ]);
  if (winner !== timerTag && yieldTimer !== undefined) {
    clearTimeout(yieldTimer);
  }
  if (winner === timerTag) return undefined;
  return winner as ManagedExecFinishedSession;
}

export function createExecTool(): ToolDefinition {
  return defineTool({
    name: "exec",
    label: "Exec",
    description:
      "Execute shell commands with optional background continuation. Pair with process tool for list/poll/log/kill.",
    parameters: ExecSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const ownerSessionId = getSessionId(ctx);
      const baseCwd =
        typeof ctx.cwd === "string" && ctx.cwd.trim().length > 0 ? ctx.cwd : process.cwd();
      const command = normalizeCommand(params.command);
      if (!command) {
        return textResult("Exec rejected (missing_command).", { status: "failed" });
      }

      const cwd = resolveWorkdir(baseCwd, params.workdir);
      const env = params.env ? { ...process.env, ...params.env } : process.env;
      const timeoutSec = typeof params.timeout === "number" ? params.timeout : undefined;

      let started;
      try {
        started = startManagedExec({
          ownerSessionId,
          command,
          cwd,
          env,
          timeoutSec,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Exec failed to start: ${message}`, {
          status: "failed",
          command,
          cwd,
        });
      }

      const background = params.background === true;
      const yieldMs = background ? 0 : resolveYieldMs(params);
      const onAbort = () => {
        if (background || started.session.backgrounded) return;
        terminateRunningSession(started.session, true);
      };

      if (signal?.aborted) {
        onAbort();
      } else if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        if (background || yieldMs === 0) {
          markSessionBackgrounded(ownerSessionId, started.session.id);
          return runningResult(started.session);
        }

        const finished = await waitForCompletionOrYield(started.completion, yieldMs);
        if (!finished) {
          markSessionBackgrounded(ownerSessionId, started.session.id);
          return runningResult(started.session);
        }

        if (!finished.backgrounded) {
          deleteManagedSession(ownerSessionId, finished.id);
        }

        const output = finished.aggregated.trimEnd() || "(no output)";
        if (finished.status === "completed") {
          return textResult(output, {
            status: "completed",
            exitCode: finished.exitCode ?? 0,
            durationMs: finished.endedAt - finished.startedAt,
            cwd: finished.cwd,
            command: finished.command,
          });
        }

        throw new Error(`${output}\n\nProcess exited with ${formatExit(finished)}.`);
      } finally {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    },
  });
}
