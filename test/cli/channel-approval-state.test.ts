import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStateStore } from "@brewva/brewva-cli";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-channel-approval-state-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("channel approval state store", () => {
  test("persists and reloads state snapshot", () => {
    const workspace = createWorkspace("persist");
    const store = ApprovalStateStore.create({ workspaceRoot: workspace });

    store.record({
      conversationId: "123",
      requestId: "req-1",
      snapshot: {
        screenId: "screen-1",
        stateKey: "st-1",
        state: { step: 1 },
      },
      recordedAt: 10,
    });

    expect(store.resolve({ conversationId: "123", requestId: "req-1" })).toEqual({
      screenId: "screen-1",
      stateKey: "st-1",
      state: { step: 1 },
    });

    const reloaded = ApprovalStateStore.create({ workspaceRoot: workspace });
    expect(reloaded.resolve({ conversationId: "123", requestId: "req-1" })?.screenId).toBe(
      "screen-1",
    );
  });

  test("generates stateKey and persists large state in blob store", () => {
    const workspace = createWorkspace("large");
    const store = ApprovalStateStore.create({ workspaceRoot: workspace });

    const state = { big: "x".repeat(2000) };
    const result = store.record({
      conversationId: "123",
      requestId: "req-1",
      snapshot: {
        screenId: "screen-1",
        state,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.generatedStateKey).toBe(true);
    expect(result.storedState).toBe(true);
    expect(result.snapshot?.stateKey).toMatch(/^st_[0-9a-f]{12}$/);

    const resolved = store.resolve({ conversationId: "123", requestId: "req-1" });
    expect(resolved).toEqual({
      screenId: "screen-1",
      stateKey: result.snapshot?.stateKey,
      state,
    });

    const blobPath = join(
      workspace,
      ".brewva",
      "channel",
      "approval-state",
      `${result.snapshot?.stateKey}.json`,
    );
    const blob = JSON.parse(readFileSync(blobPath, "utf8")) as { state?: unknown };
    expect(blob.state).toEqual(state);
  });

  test("prunes oldest request ids per conversation", () => {
    const workspace = createWorkspace("prune");
    const store = ApprovalStateStore.create({
      workspaceRoot: workspace,
      maxEntriesPerConversation: 2,
    });

    store.record({
      conversationId: "123",
      requestId: "req-1",
      snapshot: { screenId: "s1" },
      recordedAt: 1,
    });
    store.record({
      conversationId: "123",
      requestId: "req-2",
      snapshot: { screenId: "s2" },
      recordedAt: 2,
    });
    store.record({
      conversationId: "123",
      requestId: "req-3",
      snapshot: { screenId: "s3" },
      recordedAt: 3,
    });

    expect(store.resolve({ conversationId: "123", requestId: "req-1" })).toBeUndefined();
    expect(store.resolve({ conversationId: "123", requestId: "req-2" })?.screenId).toBe("s2");
    expect(store.resolve({ conversationId: "123", requestId: "req-3" })?.screenId).toBe("s3");
  });
});
