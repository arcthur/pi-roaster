import { describe, expect, test } from "bun:test";
import { runObservabilityQuery } from "../../packages/brewva-tools/src/observability/shared.js";

describe("observability shared query", () => {
  test("single-type queries prefilter at the event store boundary", () => {
    const listCalls: Array<{ sessionId: string; query?: { type?: string } }> = [];
    const runtime = {
      events: {
        list(sessionId: string, query?: { type?: string }) {
          listCalls.push({ sessionId, query });
          return [
            {
              id: "evt-1",
              sessionId,
              type: "tool_result_recorded",
              timestamp: 10,
              payload: { rawTokens: 5 },
            },
          ];
        },
      },
    };

    const result = runObservabilityQuery(
      runtime as never,
      "obs-shared-1",
      {
        types: ["tool_result_recorded"],
        where: {},
        windowMinutes: null,
        last: null,
        metric: null,
        aggregation: null,
      },
      20,
    );

    expect(result.matchCount).toBe(1);
    expect(listCalls).toEqual([
      {
        sessionId: "obs-shared-1",
        query: { type: "tool_result_recorded" },
      },
    ]);
  });
});
