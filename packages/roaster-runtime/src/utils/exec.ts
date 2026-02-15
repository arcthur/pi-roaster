import { spawn } from "node:child_process";

export interface ShellRunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunShellCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputChars?: number;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 30))}\n...[truncated ${text.length - maxChars} chars]`;
}

export function runShellCommand(command: string, options: RunShellCommandOptions): Promise<ShellRunResult> {
  const maxOutputChars = options.maxOutputChars ?? 200_000;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onData = (chunk: Buffer, target: "stdout" | "stderr"): void => {
      const text = chunk.toString("utf8");
      if (target === "stdout") stdout += text;
      else stderr += text;

      if (stdout.length > maxOutputChars) stdout = truncate(stdout, maxOutputChars);
      if (stderr.length > maxOutputChars) stderr = truncate(stderr, maxOutputChars);
    };

    child.stdout?.on("data", (chunk) => onData(chunk as Buffer, "stdout"));
    child.stderr?.on("data", (chunk) => onData(chunk as Buffer, "stderr"));

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // If SIGTERM doesn't work quickly, SIGKILL.
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, Math.max(0, options.timeoutMs));
    timeout.unref();

    const finish = (exitCode: number | null): void => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };

    child.on("error", (error) => {
      stderr = `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim();
      finish(null);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}

