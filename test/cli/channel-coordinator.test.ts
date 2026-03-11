import { describe, expect, test } from "bun:test";
import { ChannelCoordinator } from "@brewva/brewva-gateway";

describe("channel coordinator", () => {
  test("fanOut limits concurrent dispatch bursts while preserving result order", async () => {
    const agentIds = ["jack", "mike", "rose", "jill", "nina", "omar"];
    const releaseQueue: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const coordinator = new ChannelCoordinator({
      limits: {
        fanoutMaxAgents: agentIds.length,
        maxDiscussionRounds: 3,
        a2aMaxDepth: 4,
        a2aMaxHops: 6,
      },
      dispatch: async (input) =>
        new Promise((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          releaseQueue.push(() => {
            inFlight -= 1;
            resolve({
              ok: true,
              agentId: input.agentId,
              responseText: input.agentId,
            });
          });
        }),
      isAgentActive: () => true,
      listAgents: () => [],
    });

    const resultPromise = coordinator.fanOut({
      agentIds,
      task: "review this",
    });

    await flushMicrotasks();
    expect(releaseQueue).toHaveLength(4);
    expect(maxInFlight).toBe(4);

    while (releaseQueue.length > 0) {
      const batch = releaseQueue.splice(0);
      for (const release of batch) {
        release();
      }
      await flushMicrotasks();
    }

    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(4);
    expect(result.results.map((entry) => entry.agentId)).toEqual(agentIds);
  });

  test("enforces fanout max agents", async () => {
    const coordinator = new ChannelCoordinator({
      limits: {
        fanoutMaxAgents: 2,
        maxDiscussionRounds: 3,
        a2aMaxDepth: 4,
        a2aMaxHops: 6,
      },
      dispatch: async (input) => ({
        ok: true,
        agentId: input.agentId,
        responseText: "ok",
      }),
      isAgentActive: () => true,
      listAgents: () => [],
    });

    const result = await coordinator.fanOut({
      agentIds: ["jack", "mike", "rose"],
      task: "review this",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fanout_limit_exceeded:2");
  });

  test("discussion stops early when agent emits [DONE]", async () => {
    let call = 0;
    const coordinator = new ChannelCoordinator({
      limits: {
        fanoutMaxAgents: 4,
        maxDiscussionRounds: 3,
        a2aMaxDepth: 4,
        a2aMaxHops: 6,
      },
      dispatch: async (input) => {
        call += 1;
        return {
          ok: true,
          agentId: input.agentId,
          responseText: call === 1 ? "[DONE]" : "should not run",
        };
      },
      isAgentActive: () => true,
      listAgents: () => [],
    });

    const result = await coordinator.discuss({
      agentIds: ["jack", "mike"],
      topic: "architecture",
    });
    expect(result.ok).toBe(true);
    expect(result.stoppedEarly).toBe(true);
    expect(result.rounds.length).toBe(1);
  });

  test("a2a blocks self target and depth overflow", async () => {
    const coordinator = new ChannelCoordinator({
      limits: {
        fanoutMaxAgents: 4,
        maxDiscussionRounds: 3,
        a2aMaxDepth: 1,
        a2aMaxHops: 2,
      },
      dispatch: async (input) => ({
        ok: true,
        agentId: input.agentId,
        responseText: "ok",
      }),
      isAgentActive: () => true,
      listAgents: () => [],
      resolveAgentBySessionId: () => "jack",
      forbidSelfA2A: true,
    });

    const selfBlocked = await coordinator.a2aSend({
      fromSessionId: "s1",
      toAgentId: "jack",
      message: "ping",
    });
    expect(selfBlocked.ok).toBe(false);
    expect(selfBlocked.error).toBe("a2a_self_target_blocked");

    const depthBlocked = await coordinator.a2aSend({
      fromSessionId: "s1",
      toAgentId: "mike",
      message: "ping",
      depth: 1,
    });
    expect(depthBlocked.ok).toBe(false);
    expect(depthBlocked.error).toBe("a2a_depth_limit_exceeded");
  });

  test("a2a broadcast enforces fanout limit", async () => {
    const coordinator = new ChannelCoordinator({
      limits: {
        fanoutMaxAgents: 2,
        maxDiscussionRounds: 3,
        a2aMaxDepth: 4,
        a2aMaxHops: 6,
      },
      dispatch: async (input) => ({
        ok: true,
        agentId: input.agentId,
        responseText: "ok",
      }),
      isAgentActive: () => true,
      listAgents: () => [],
    });

    const result = await coordinator.a2aBroadcast({
      fromSessionId: "s1",
      toAgentIds: ["jack", "mike", "rose"],
      message: "ping",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fanout_limit_exceeded:2");
    expect(result.results).toEqual([]);
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
