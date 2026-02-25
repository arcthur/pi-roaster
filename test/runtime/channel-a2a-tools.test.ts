import { describe, expect, test } from "bun:test";
import { createA2ATools } from "@brewva/brewva-tools";

function fakeContext(sessionId: string): any {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = result.content?.find(
    (part) => part.type === "text" && typeof part.text === "string",
  );
  return text?.text ?? "";
}

describe("channel a2a tools", () => {
  test("agent_send forwards payload and returns assistant text", async () => {
    const tools = createA2ATools({
      runtime: {
        orchestration: {
          a2a: {
            send: async (input) => ({
              ok: true,
              toAgentId: input.toAgentId,
              responseText: `ack:${input.message}`,
            }),
            broadcast: async () => ({ ok: true, results: [] }),
            listAgents: async () => [],
          },
        },
      },
    });

    const send = tools.find((tool) => tool.name === "agent_send");
    expect(send).toBeDefined();

    const result = await send!.execute(
      "tc-1",
      { toAgentId: "mike", message: "ping" },
      undefined,
      undefined,
      fakeContext("session-1"),
    );
    expect(extractText(result)).toBe("ack:ping");
  });

  test("agent_broadcast preserves per-target failures", async () => {
    const tools = createA2ATools({
      runtime: {
        orchestration: {
          a2a: {
            send: async () => ({ ok: false, toAgentId: "na", error: "unused" }),
            broadcast: async (input) => ({
              ok: false,
              results: input.toAgentIds.map((toAgentId, index) => ({
                toAgentId,
                ok: index === 0,
                error: index === 0 ? undefined : "a2a_depth_limit_exceeded",
              })),
            }),
            listAgents: async () => [],
          },
        },
      },
    });

    const broadcast = tools.find((tool) => tool.name === "agent_broadcast");
    expect(broadcast).toBeDefined();

    const result = await broadcast!.execute(
      "tc-2",
      { toAgentIds: ["jack", "mike"], message: "review" },
      undefined,
      undefined,
      fakeContext("session-2"),
    );
    const text = extractText(result);
    expect(text.includes("ok=1 failed=1")).toBe(true);
    expect(text.includes("mike: a2a_depth_limit_exceeded")).toBe(true);
  });

  test("agent_list returns visible agents", async () => {
    const tools = createA2ATools({
      runtime: {
        orchestration: {
          a2a: {
            send: async () => ({ ok: false, toAgentId: "na", error: "unused" }),
            broadcast: async () => ({ ok: true, results: [] }),
            listAgents: async () => [
              { agentId: "jack", status: "active" as const },
              { agentId: "mike", status: "deleted" as const },
            ],
          },
        },
      },
    });

    const list = tools.find((tool) => tool.name === "agent_list");
    expect(list).toBeDefined();

    const result = await list!.execute(
      "tc-3",
      { includeDeleted: true },
      undefined,
      undefined,
      fakeContext("session-3"),
    );
    const text = extractText(result);
    expect(text.includes("jack (active)")).toBe(true);
    expect(text.includes("mike (deleted)")).toBe(true);
  });
});
