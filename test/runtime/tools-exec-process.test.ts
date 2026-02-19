import { describe, expect, test } from "bun:test";
import { createExecTool, createProcessTool } from "@brewva/brewva-tools";

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return textPart?.text ?? "";
}

function fakeContext(sessionId: string): any {
  return {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

describe("exec/process tool flow", () => {
  test("exec backgrounds and process poll waits for completion", async () => {
    const execTool = createExecTool();
    const processTool = createProcessTool();
    const sessionId = "s13-exec-process";

    const started = await execTool.execute(
      "tc-exec-start",
      {
        command: "node -e \"setTimeout(() => { console.log('done') }, 150)\"",
        yieldMs: 10,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const startDetails = started.details as { status?: string; sessionId?: string };
    expect(startDetails.status).toBe("running");
    expect(typeof startDetails.sessionId).toBe("string");

    const sessionHandle = startDetails.sessionId ?? "";
    const polled = await processTool.execute(
      "tc-exec-poll",
      {
        action: "poll",
        sessionId: sessionHandle,
        timeout: 2_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const pollText = extractTextContent(polled);
    expect(pollText.includes("done")).toBe(true);
    expect((polled.details as { status?: string }).status).toBe("completed");
  });

  test("process kill stops a background session", async () => {
    const execTool = createExecTool();
    const processTool = createProcessTool();
    const sessionId = "s13-process-kill";

    const started = await execTool.execute(
      "tc-exec-start",
      {
        command: "node -e \"setInterval(() => process.stdout.write('tick\\\\n'), 40)\"",
        background: true,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const sessionHandle = (started.details as { sessionId?: string }).sessionId;
    expect(typeof sessionHandle).toBe("string");

    const killed = await processTool.execute(
      "tc-process-kill",
      {
        action: "kill",
        sessionId: sessionHandle,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect((killed.details as { status?: string }).status).toBe("failed");

    const polled = await processTool.execute(
      "tc-process-poll",
      {
        action: "poll",
        sessionId: sessionHandle,
        timeout: 1_000,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const pollStatus = (polled.details as { status?: string }).status;
    expect(pollStatus === "completed" || pollStatus === "failed").toBe(true);
  });

  test("exec throws on non-zero exit code", async () => {
    const execTool = createExecTool();
    const sessionId = "s13-exec-fail";

    expect(
      execTool.execute(
        "tc-exec-fail",
        {
          command: 'node -e "process.exit(2)"',
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      ),
    ).rejects.toThrow("Process exited");
  });
});
