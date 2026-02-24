import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createExecTool } from "@brewva/brewva-tools";
import { cleanupWorkspace, createWorkspace, runLive } from "./helpers.js";

const runMicrosandboxLive: typeof test = process.env.BREWVA_E2E_MSB === "1" ? runLive : test.skip;

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

async function expectRejected(
  promise: Promise<unknown>,
  expectedMessagePart?: string,
): Promise<void> {
  let rejected = false;
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    rejection = error;
  }
  expect(rejected).toBe(true);
  if (!expectedMessagePart) return;
  const message = rejection instanceof Error ? rejection.message : String(rejection);
  expect(message.includes(expectedMessagePart)).toBe(true);
}

function assertMicrosandboxCliAvailable(): void {
  const probe = spawnSync("msb", ["--version"], { encoding: "utf8" });
  if (probe.status === 0 && !probe.error) return;
  const lines = [
    "BREWVA_E2E_MSB=1 requires microsandbox CLI (`msb`) in PATH.",
    `status: ${probe.status ?? "null"}`,
    `error: ${probe.error ? String(probe.error) : "none"}`,
    `stdout: ${(probe.stdout ?? "").trim()}`,
    `stderr: ${(probe.stderr ?? "").trim()}`,
  ];
  throw new Error(lines.join("\n"));
}

async function pickFreeLocalPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to resolve an ephemeral localhost port.");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const onExit = () => {
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          resolve();
        }
      }
    }, 2_000);

    child.once("exit", onExit);
    try {
      child.kill("SIGTERM");
    } catch {
      child.removeListener("exit", onExit);
      clearTimeout(forceTimer);
      resolve();
    }
  });
}

async function startMicrosandboxServer(
  namespaceDir: string,
  port: number,
): Promise<{
  serverUrl: string;
  stop(): Promise<void>;
}> {
  const child = spawn(
    "msb",
    ["server", "start", "--dev", "--host", "127.0.0.1", "--port", String(port), "-p", namespaceDir],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );

  return await new Promise((resolve, reject) => {
    let settled = false;
    let logs = "";

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimeout);
      child.stdout?.removeListener("data", onChunk);
      child.stderr?.removeListener("data", onChunk);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      handler();
    };

    const onChunk = (chunk: Buffer | string) => {
      logs += chunk.toString();
      if (
        logs.includes(`Server listening on 127.0.0.1:${port}`) ||
        logs.includes("Server listening on")
      ) {
        finish(() =>
          resolve({
            serverUrl: `http://127.0.0.1:${port}`,
            stop: async () => {
              await stopProcess(child);
            },
          }),
        );
      }
    };

    const onError = (error: Error) => {
      finish(() => reject(error));
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() =>
        reject(
          new Error(
            [
              "microsandbox server exited before readiness.",
              `exitCode=${code ?? "null"}`,
              `signal=${signal ?? "none"}`,
              logs.slice(-2_000),
            ].join("\n"),
          ),
        ),
      );
    };

    const readyTimeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            [
              "Timed out waiting for microsandbox server readiness.",
              `port=${port}`,
              logs.slice(-2_000),
            ].join("\n"),
          ),
        ),
      );
    }, 45_000);

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

describe("e2e: microsandbox isolation live", () => {
  runMicrosandboxLive(
    "enforceIsolation routes to live microsandbox and remains fail-closed when server is down",
    async () => {
      assertMicrosandboxCliAvailable();
      const workspace = createWorkspace("microsandbox-isolation-live");
      const namespaceDir = join(workspace, ".msb");
      mkdirSync(namespaceDir, { recursive: true });
      const port = await pickFreeLocalPort();

      let server: { serverUrl: string; stop(): Promise<void> } | undefined;
      try {
        server = await startMicrosandboxServer(namespaceDir, port);

        const events: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
        const runtime = {
          config: {
            security: {
              mode: "permissive",
              sanitizeContext: true,
              execution: {
                backend: "host",
                enforceIsolation: true,
                fallbackToHost: true,
                commandDenyList: [],
                sandbox: {
                  serverUrl: server.serverUrl,
                  defaultImage: "microsandbox/node",
                  memory: 128,
                  cpus: 1,
                  timeout: 20,
                },
              },
            },
          },
          events: {
            record: (event: { type?: string; payload?: Record<string, unknown> }) => {
              events.push(event);
              return undefined;
            },
          },
        };
        const execTool = createExecTool({ runtime: runtime as any });
        const ctx = {
          cwd: workspace,
          sessionManager: {
            getSessionId() {
              return "e2e-microsandbox-isolation";
            },
          },
        };

        const successResult = await execTool.execute(
          "tc-msb-live-success",
          {
            command:
              'pwd && echo "$BREWVA_E2E_ENV" && echo "Authorization: Bearer super-secret-token"',
            workdir: "/",
            env: {
              BREWVA_E2E_ENV: "msb-live-ok",
            },
            timeout: 30,
          },
          undefined,
          undefined,
          ctx as any,
        );

        const successDetails = successResult.details as {
          backend?: string;
          cwd?: string;
          appliedEnvKeys?: string[];
          timeoutSec?: number;
        };
        expect(successDetails.backend).toBe("sandbox");
        expect(successDetails.cwd).toBe("/");
        expect(successDetails.appliedEnvKeys?.includes("BREWVA_E2E_ENV")).toBe(true);
        expect(successDetails.timeoutSec).toBe(30);
        const successText = extractTextContent(successResult);
        expect(successText.includes("msb-live-ok")).toBe(true);
        expect(successText.includes("/")).toBe(true);

        const routedEvent = events.find((event) => event.type === "exec_routed");
        expect(routedEvent).toBeDefined();
        expect(routedEvent?.payload?.configuredBackend).toBe("sandbox");
        expect(routedEvent?.payload?.resolvedBackend).toBe("sandbox");
        expect(routedEvent?.payload?.fallbackToHost).toBe(false);
        expect(routedEvent?.payload?.enforceIsolation).toBe(true);
        const routedPayload = routedEvent?.payload ?? {};
        expect(routedPayload.command).toBeUndefined();
        const redactedCommand = routedPayload.commandRedacted;
        expect(typeof redactedCommand).toBe("string");
        expect((redactedCommand as string).includes("<redacted>")).toBe(true);
        expect((redactedCommand as string).includes("super-secret-token")).toBe(false);

        const standardEvents: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
        const standardRuntime = {
          config: {
            security: {
              mode: "standard",
              sanitizeContext: true,
              execution: {
                backend: "sandbox",
                enforceIsolation: false,
                fallbackToHost: true,
                commandDenyList: [],
                sandbox: {
                  serverUrl: server.serverUrl,
                  defaultImage: "microsandbox/node",
                  memory: 128,
                  cpus: 1,
                  timeout: 20,
                },
              },
            },
          },
          events: {
            record: (event: { type?: string; payload?: Record<string, unknown> }) => {
              standardEvents.push(event);
              return undefined;
            },
          },
        };
        const standardExecTool = createExecTool({ runtime: standardRuntime as any });
        await expectRejected(
          standardExecTool.execute(
            "tc-msb-live-command-failure",
            {
              command: 'node -e "process.exit(7)"',
            },
            undefined,
            undefined,
            ctx as any,
          ),
          "Process exited with code 7",
        );
        expect(standardEvents.some((event) => event.type === "exec_fallback_host")).toBe(false);

        const timeoutStartedAt = Date.now();
        await expectRejected(
          execTool.execute(
            "tc-msb-live-timeout",
            {
              command: 'node -e "setTimeout(() => process.exit(0), 4000)"',
              timeout: 1,
            },
            undefined,
            undefined,
            ctx as any,
          ),
        );
        const timeoutElapsedMs = Date.now() - timeoutStartedAt;
        expect(timeoutElapsedMs).toBeLessThan(3_000);

        const routedEvents = events.filter((event) => event.type === "exec_routed");
        const timeoutRouted = routedEvents[routedEvents.length - 1];
        expect(timeoutRouted?.payload?.requestedTimeoutSec).toBe(1);

        const abortController = new AbortController();
        const abortedExecution = execTool.execute(
          "tc-msb-live-abort",
          {
            command: 'node -e "setTimeout(() => process.exit(0), 20000)"',
          },
          abortController.signal,
          undefined,
          ctx as any,
        );
        setTimeout(() => {
          abortController.abort();
        }, 200);
        await expectRejected(abortedExecution, "Execution aborted by signal.");

        await server.stop();
        server = undefined;

        await expectRejected(
          execTool.execute(
            "tc-msb-live-server-down",
            {
              command: "echo should-block",
            },
            undefined,
            undefined,
            ctx as any,
          ),
          "exec_blocked_isolation",
        );

        expect(events.some((event) => event.type === "exec_blocked_isolation")).toBe(true);
        expect(events.some((event) => event.type === "exec_fallback_host")).toBe(false);
      } finally {
        if (server) {
          await server.stop();
        }
        cleanupWorkspace(workspace);
      }
    },
    300_000,
  );
});
