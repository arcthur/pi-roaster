import { describe, expect, test } from "bun:test";
import { buildCapabilityView } from "@brewva/brewva-gateway/runtime-plugins";

describe("capability view", () => {
  test("builds compact capability list with governance-first ordering", () => {
    const result = buildCapabilityView({
      prompt: "continue",
      allTools: [
        {
          name: "exec",
          description: "Run a shell command.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
              },
            },
          },
        },
        {
          name: "session_compact",
          description: "Compact session context.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "tape_search",
          description: "Search tape entries.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
              },
            },
          },
        },
      ],
      activeToolNames: ["exec"],
    });

    expect(result.block.includes("[CapabilityView]")).toBe(true);
    expect(result.block.includes("available_total: 3")).toBe(true);
    expect(result.block.includes("visible_now_count: 1")).toBe(true);
    expect(result.block.includes("visible_now: $exec")).toBe(true);
    expect(result.block.includes("hidden_skill_count: 1")).toBe(true);
    expect(result.block.includes("hidden_operator_count: 0")).toBe(true);
  });

  test("expands capability details from $name requests", () => {
    const result = buildCapabilityView({
      prompt: "inspect $tape_search and $not_exists",
      allTools: [
        {
          name: "tape_search",
          description: "Search tape entries.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
              },
            },
          },
        },
      ],
      activeToolNames: [],
    });

    expect(result.requested).toEqual(["tape_search", "not_exists"]);
    expect(result.expanded).toEqual(["tape_search"]);
    expect(result.missing).toEqual(["not_exists"]);
    expect(result.block.includes("[CapabilityDetail:$tape_search]")).toBe(true);
    expect(result.block.includes("parameters: query")).toBe(true);
    expect(result.block.includes("surface: skill")).toBe(true);
    expect(result.block.includes("visible_now: false")).toBe(true);
    expect(result.block.includes("unknown: $not_exists")).toBe(true);
  });

  test("returns empty block when tool list is empty", () => {
    const result = buildCapabilityView({
      prompt: "$exec",
      allTools: [],
      activeToolNames: [],
    });

    expect(result.block).toBe("");
    expect(result.requested).toHaveLength(0);
    expect(result.expanded).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
  });

  test("does not treat uppercase $NAME tokens as capability requests", () => {
    const result = buildCapabilityView({
      prompt: "env $PATH and $HOME should not expand, but $exec should.",
      allTools: [
        {
          name: "exec",
          description: "Run a shell command.",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      activeToolNames: [],
    });

    expect(result.requested).toEqual(["exec"]);
    expect(result.expanded).toEqual(["exec"]);
    expect(result.missing).toEqual([]);
  });

  test("includes allowed_now and deny_reason when access resolver is provided", () => {
    const result = buildCapabilityView({
      prompt: "inspect $exec",
      allTools: [
        {
          name: "exec",
          description: "Run a shell command.",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      activeToolNames: [],
      resolveAccess: (toolName) => {
        if (toolName === "exec") {
          return { allowed: false, reason: "blocked-for-test" };
        }
        return { allowed: true };
      },
    });

    expect(result.block.includes("allowed_now: false")).toBe(true);
    expect(result.block.includes("deny_reason: blocked-for-test")).toBe(true);
  });

  test("describes hidden operator tools and explicit request hint", () => {
    const result = buildCapabilityView({
      prompt: "continue",
      allTools: [
        {
          name: "skill_load",
          description: "Load a skill.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "obs_query",
          description: "Query runtime events.",
          parameters: { type: "object", properties: {} },
        },
      ],
      activeToolNames: ["skill_load"],
    });

    expect(result.block.includes("hidden_operator_count: 1")).toBe(true);
    expect(
      result.block.includes("operator_hint: operator/full profile keeps these tools visible"),
    ).toBe(true);
  });

  test("describes hidden skill tools when no skill-scoped tool is visible", () => {
    const result = buildCapabilityView({
      prompt: "continue",
      allTools: [
        {
          name: "session_compact",
          description: "Compact session context.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "tape_search",
          description: "Search tape entries.",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
      activeToolNames: ["session_compact"],
    });

    expect(result.block.includes("hidden_skill_count: 1")).toBe(true);
    expect(result.block.includes("skill_hint: load or accept a skill")).toBe(true);
  });
});
