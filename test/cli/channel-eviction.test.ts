import { describe, expect, test } from "bun:test";
import {
  selectIdleEvictableAgentsByTtl,
  selectLruEvictableAgent,
  type AgentSessionUsage,
} from "@brewva/brewva-cli";

describe("channel agent eviction selection", () => {
  test("selectLruEvictableAgent uses per-agent maxLastUsedAt and excludes in-flight agents", () => {
    const usages: AgentSessionUsage[] = [
      { agentId: "jack", lastUsedAt: 10, inFlightTasks: 0 },
      { agentId: "jack", lastUsedAt: 20, inFlightTasks: 0 },
      { agentId: "mike", lastUsedAt: 5, inFlightTasks: 0 },
      { agentId: "rose", lastUsedAt: 1, inFlightTasks: 1 },
    ];

    expect(selectLruEvictableAgent(usages)).toBe("mike");
  });

  test("selectLruEvictableAgent breaks ties by agentId", () => {
    const usages: AgentSessionUsage[] = [
      { agentId: "mike", lastUsedAt: 10, inFlightTasks: 0 },
      { agentId: "jack", lastUsedAt: 10, inFlightTasks: 0 },
    ];

    expect(selectLruEvictableAgent(usages)).toBe("jack");
  });

  test("selectIdleEvictableAgentsByTtl returns candidates ordered by maxLastUsedAt", () => {
    const usages: AgentSessionUsage[] = [
      { agentId: "jack", lastUsedAt: 0, inFlightTasks: 0 },
      { agentId: "mike", lastUsedAt: 10, inFlightTasks: 0 },
      { agentId: "mike", lastUsedAt: 9, inFlightTasks: 0 },
      { agentId: "rose", lastUsedAt: 10, inFlightTasks: 0 },
      { agentId: "skip", lastUsedAt: 0, inFlightTasks: 1 },
      { agentId: "new", lastUsedAt: 90, inFlightTasks: 0 },
    ];

    expect(selectIdleEvictableAgentsByTtl(usages, 100, 50)).toEqual(["jack", "mike", "rose"]);
  });
});
