import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

describe("Gap remediation: parallel result lifecycle", () => {
  test("detects patch conflicts and supports merged patchset", async () => {
    const runtime = new BrewvaRuntime({ cwd: process.cwd() });
    const sessionId = "parallel-1";

    runtime.session.recordWorkerResult(sessionId, {
      workerId: "w1",
      status: "ok",
      summary: "worker-1",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "a" }],
      },
    });
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "w2",
      status: "ok",
      summary: "worker-2",
      patches: {
        id: "ps-2",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "b" }],
      },
    });

    const conflictReport = runtime.session.mergeWorkerResults(sessionId);
    expect(conflictReport.status).toBe("conflicts");
    expect(conflictReport.conflicts.length).toBe(1);

    runtime.session.clearWorkerResults(sessionId);
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "w1",
      status: "ok",
      summary: "worker-1",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [{ path: "src/a.ts", action: "modify", diffText: "a" }],
      },
    });
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "w2",
      status: "ok",
      summary: "worker-2",
      patches: {
        id: "ps-2",
        createdAt: Date.now(),
        changes: [{ path: "src/b.ts", action: "modify", diffText: "b" }],
      },
    });

    const mergedReport = runtime.session.mergeWorkerResults(sessionId);
    expect(mergedReport.status).toBe("merged");
    expect(mergedReport.mergedPatchSet?.changes.length).toBe(2);
  });
});
