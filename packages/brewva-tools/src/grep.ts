import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { defineTool } from "./utils/tool.js";

type GrepCase = "smart" | "ignore" | "sensitive";

type GrepRunResult = {
  exitCode: number;
  lines: string[];
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

function clampInt(value: unknown, fallback: number, options: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(options.min, Math.min(options.max, Math.trunc(value)));
}

async function runRipgrep(input: {
  cwd: string;
  args: string[];
  maxLines: number;
  timeoutMs: number;
  signal?: AbortSignal | null;
}): Promise<GrepRunResult> {
  return await new Promise<GrepRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn("rg", input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines: string[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const killChild = (reason: "truncate" | "timeout" | "abort"): void => {
      if (child.exitCode !== null || child.killed) return;
      if (reason === "truncate") truncated = true;
      if (reason === "timeout") timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };

    const timeoutHandle = setTimeout(() => {
      killChild("timeout");
    }, input.timeoutMs);

    const onAbort = (): void => {
      killChild("abort");
    };
    if (input.signal) {
      if (input.signal.aborted) {
        clearTimeout(timeoutHandle);
        killChild("abort");
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (timedOut || truncated) return;
      stdoutBuffer += chunk;
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) {
          lines.push(line);
          if (lines.length >= input.maxLines) {
            killChild("truncate");
            break;
          }
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16_000) {
        stderr = stderr.slice(-16_000);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }
      rejectPromise(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort);
      }

      const exitCode = typeof code === "number" ? code : -1;
      const tail = stdoutBuffer.trimEnd();
      if (tail.length > 0 && lines.length < input.maxLines) {
        lines.push(tail);
      }

      resolvePromise({
        exitCode,
        lines,
        stderr: stderr.trimEnd(),
        truncated,
        timedOut,
      });
    });
  });
}

export function createGrepTool(options: BrewvaToolOptions): ToolDefinition {
  return defineTool({
    name: "grep",
    label: "Grep",
    description: "Search code using ripgrep (rg) with bounded output.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
      glob: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
      case: Type.Optional(
        Type.Union([Type.Literal("smart"), Type.Literal("ignore"), Type.Literal("sensitive")], {
          default: "smart",
        }),
      ),
      fixed: Type.Optional(Type.Boolean({ default: false })),
      max_lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 200 })),
      timeout_ms: Type.Optional(Type.Number({ minimum: 100, maximum: 120000, default: 30000 })),
      workdir: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal) {
      const baseCwd = options.runtime.cwd ?? process.cwd();
      const cwd = params.workdir ? resolve(baseCwd, params.workdir) : baseCwd;
      const maxLines = clampInt(params.max_lines, 200, { min: 1, max: 500 });
      const timeoutMs = clampInt(params.timeout_ms, 30_000, { min: 100, max: 120_000 });

      const query = params.query.trim();
      const paths = (params.paths ?? ["."]).map((entry) => entry.trim()).filter(Boolean);
      const globs = (params.glob ?? []).map((entry) => entry.trim()).filter(Boolean);
      const caseMode: GrepCase = params.case ?? "smart";

      const args: string[] = ["--line-number", "--no-heading", "--color", "never", "--hidden"];

      for (const glob of globs) {
        args.push("--glob", glob);
      }

      if (params.fixed) {
        args.push("--fixed-strings");
      }

      if (caseMode === "ignore") {
        args.push("--ignore-case");
      } else if (caseMode === "sensitive") {
        args.push("--case-sensitive");
      }

      args.push("--", query);
      args.push(...(paths.length > 0 ? paths : ["."]));

      try {
        const result = await runRipgrep({
          cwd,
          args,
          maxLines,
          timeoutMs,
          signal,
        });

        const header = [
          "# Grep",
          `- query: ${query}`,
          `- workdir: ${cwd}`,
          `- paths: ${paths.length > 0 ? paths.join(", ") : "."}`,
          globs.length > 0 ? `- glob: ${globs.join(", ")}` : null,
          `- exit_code: ${result.exitCode}`,
          `- matches_shown: ${result.lines.length}`,
          `- truncated: ${result.truncated}`,
          `- timed_out: ${result.timedOut}`,
        ].filter(Boolean);

        if (result.exitCode === 0) {
          return textResult([...header, "", ...result.lines].join("\n"), {
            ok: true,
            ...result,
          });
        }

        // Exit code 1 means "no matches".
        if (result.exitCode === 1) {
          return textResult([...header, "", "(no matches)"].join("\n"), {
            ok: true,
            ...result,
          });
        }

        const stderr = result.stderr ? `\n\nstderr:\n${result.stderr}` : "";
        return failTextResult([...header, "", "(rg failed)", stderr.trim()].join("\n").trim(), {
          ok: false,
          ...result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const notFound = /ENOENT|not found|spawn rg/i.test(message);
        const hint = notFound ? " (install ripgrep: rg)" : "";
        return failTextResult(`grep failed: ${message}${hint}`, {
          ok: false,
          error: message,
          hint,
        });
      }
    },
  });
}
