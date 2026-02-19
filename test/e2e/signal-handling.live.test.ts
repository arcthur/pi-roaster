import { describe, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  cleanupWorkspace,
  createWorkspace,
  latestEventFile,
  parseEventFile,
  repoRoot,
  runLive,
  writeMinimalConfig,
} from "./helpers.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForEventType(
  workspace: string,
  eventType: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const eventFile = latestEventFile(workspace);
    if (eventFile) {
      const events = parseEventFile(eventFile);
      if (events.some((event) => event.type === eventType)) {
        return eventFile;
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for event type: ${eventType}`);
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for child process exit after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("e2e: signal handling", () => {
  runLive("SIGINT emits session_interrupted and exits with code 130", async () => {
    const workspace = createWorkspace("signal");
    writeMinimalConfig(workspace);

    const child = spawn(
      "bun",
      [
        "run",
        "start",
        "--cwd",
        workspace,
        "--print",
        "Read every file in the current directory recursively and list all filenames.",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    try {
      await waitForEventType(workspace, "session_start", 30_000);
      await delay(500);

      const killed = child.kill("SIGINT");
      expect(killed).toBe(true);

      const exit = await waitForExit(child, 60_000);
      expect(exit.code).toBe(130);

      const eventFile = latestEventFile(workspace);
      expect(eventFile).toBeDefined();
      const events = parseEventFile(eventFile!, { strict: true });
      expect(events.some((event) => event.type === "session_interrupted")).toBe(true);
    } catch (error) {
      const message = [
        error instanceof Error ? error.message : String(error),
        "[signal.live] stdout:",
        stdout.trim(),
        "[signal.live] stderr:",
        stderr.trim(),
      ].join("\n");
      throw new Error(message);
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      cleanupWorkspace(workspace);
    }
  });

  runLive("SIGINT in json mode does not emit final bundle", async () => {
    const workspace = createWorkspace("signal-json");
    writeMinimalConfig(workspace);

    const child = spawn(
      "bun",
      [
        "run",
        "start",
        "--cwd",
        workspace,
        "--mode",
        "json",
        "Read every file in the current directory recursively and list all filenames.",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    try {
      await waitForEventType(workspace, "session_start", 30_000);
      await delay(500);

      const killed = child.kill("SIGINT");
      expect(killed).toBe(true);

      const exit = await waitForExit(child, 60_000);
      expect(exit.code).toBe(130);

      expect(stdout.includes("\"type\":\"brewva_event_bundle\"")).toBe(false);
      expect(stdout.includes("\"schema\":\"brewva.stream.v1\"")).toBe(false);

      const eventFile = latestEventFile(workspace);
      expect(eventFile).toBeDefined();
      const events = parseEventFile(eventFile!, { strict: true });
      expect(events.some((event) => event.type === "session_interrupted")).toBe(true);
    } catch (error) {
      const message = [
        error instanceof Error ? error.message : String(error),
        "[signal-json.live] stdout:",
        stdout.trim(),
        "[signal-json.live] stderr:",
        stderr.trim(),
      ].join("\n");
      throw new Error(message);
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      cleanupWorkspace(workspace);
    }
  });
});
