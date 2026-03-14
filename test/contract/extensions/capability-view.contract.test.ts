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

    expect(result.block).toContain("[CapabilityView]");
    expect(result.block).toContain("available_total: 3");
    expect(result.block).toContain("visible_now_count: 1");
    expect(result.block).toContain("visible_now: $exec");
    expect(result.block).toContain("visible_postures: observe=0 reversible_mutate=0 commitment=1");
    expect(result.block).toContain("hidden_skill_count: 1");
    expect(result.block).toContain("hidden_operator_count: 0");
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
    expect(result.block).toContain("[CapabilityDetail:$tape_search]");
    expect(result.block).toContain("parameters: query");
    expect(result.block).toContain("surface: skill");
    expect(result.block).toContain("posture: observe");
    expect(result.block).toContain("effects: runtime_observe");
    expect(result.block).toContain("visible_now: false");
    expect(result.block).toContain("unknown: $not_exists");
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

    expect(result.block).toContain("allowed_now: false");
    expect(result.block).toContain("deny_reason: blocked-for-test");
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

    expect(result.block).toContain("hidden_operator_count: 1");
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

    expect(result.block).toContain("hidden_skill_count: 1");
    expect(result.block).toContain("skill_hint: load or accept a skill");
  });

  test("expands posture and effect boundary for reversible tools", () => {
    const result = buildCapabilityView({
      prompt: "inspect $task_set_spec",
      allTools: [
        {
          name: "task_set_spec",
          description: "Set the task specification.",
          parameters: { type: "object", properties: { goal: { type: "string" } } },
        },
      ],
      activeToolNames: [],
    });

    expect(result.block).toContain("[CapabilityDetail:$task_set_spec]");
    expect(result.block).toContain("posture: reversible_mutate");
    expect(result.block).toContain("effects: memory_write");
  });
});
