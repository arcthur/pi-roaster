import { describe, expect, test } from "bun:test";
import { registerToolSurface } from "@brewva/brewva-gateway/runtime-plugins";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import { createMockExtensionAPI, invokeHandlerAsync } from "../helpers/extension.js";

const EMPTY_PARAMETERS = {
  type: "object",
  properties: {},
} as unknown as ToolInfo["parameters"];

function createToolDefinition(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} description`,
    parameters: EMPTY_PARAMETERS,
    async execute() {
      return {
        content: [{ type: "text", text: name }],
        details: {},
      };
    },
  };
}

function registerTools(
  api: ReturnType<typeof createMockExtensionAPI>["api"],
  names: string[],
): void {
  for (const name of names) {
    api.registerTool(createToolDefinition(name));
  }
}

describe("tool surface extension", () => {
  test("activates base and skill-scoped tools from current dispatch state", async () => {
    const extensionApi = createMockExtensionAPI();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "grep",
      "toc_document",
      "exec",
      "skill_complete",
      "skill_route_override",
      "obs_query",
    ]);

    const events: Array<Record<string, unknown>> = [];
    const runtime = {
      config: {
        skills: {
          routing: {
            profile: "standard",
            scopes: ["core", "domain"],
          },
        },
      },
      skills: {
        getActive: () => undefined,
        getPendingDispatch: () => ({
          primary: { name: "debugging" },
          chain: ["debugging"],
        }),
        getCascadeIntent: () => undefined,
        get: (name: string) =>
          name === "debugging"
            ? {
                name,
                contract: {
                  tools: {
                    required: ["read", "grep", "exec"],
                    optional: ["skill_complete"],
                    denied: [],
                  },
                },
              }
            : undefined,
      },
      events: {
        record: (input: Record<string, unknown>) => {
          events.push(input);
        },
      },
    };

    registerToolSurface(extensionApi.api, runtime as any);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "investigate the failure",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s1",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("session_compact");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).toContain("grep");
    expect(extensionApi.activeTools).toContain("exec");
    expect(extensionApi.activeTools).toContain("skill_complete");
    expect(extensionApi.activeTools).toContain("skill_route_override");
    expect(extensionApi.activeTools).not.toContain("obs_query");
    expect(events.some((event) => event.type === "tool_surface_resolved")).toBe(true);
  });

  test("explicit capability requests can surface managed tools for one turn", async () => {
    const extensionApi = createMockExtensionAPI();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "task_view_state",
      "obs_query",
    ]);

    const runtime = {
      config: {
        skills: {
          routing: {
            profile: "standard",
            scopes: ["core", "domain"],
          },
        },
      },
      skills: {
        getActive: () => undefined,
        getPendingDispatch: () => undefined,
        getCascadeIntent: () => undefined,
        get: () => undefined,
      },
      events: {
        record: () => undefined,
      },
    };

    registerToolSurface(extensionApi.api, runtime as any);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $task_view_state and $obs_query to inspect current runtime events.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s2",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("task_view_state");
    expect(extensionApi.activeTools).toContain("obs_query");
  });

  test("tool surface records which requested managed tools were activated", async () => {
    const extensionApi = createMockExtensionAPI();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "task_view_state",
      "obs_query",
    ]);

    const events: Array<Record<string, unknown>> = [];
    const runtime = {
      config: {
        skills: {
          routing: {
            profile: "standard",
            scopes: ["core", "domain"],
          },
        },
      },
      skills: {
        getActive: () => undefined,
        getPendingDispatch: () => undefined,
        getCascadeIntent: () => undefined,
        get: () => undefined,
      },
      events: {
        record: (input: Record<string, unknown>) => {
          events.push(input);
        },
      },
    };

    registerToolSurface(extensionApi.api, runtime as any);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $task_view_state and $obs_query to inspect the current state.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s3",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("task_view_state");
    expect(extensionApi.activeTools).toContain("obs_query");
    const event = events.find((input) => input.type === "tool_surface_resolved") as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(event?.payload?.requestedActivatedToolNames).toEqual(["task_view_state", "obs_query"]);
    expect(event?.payload?.ignoredRequestedToolNames).toEqual([]);
  });

  test("registers missing managed tools on demand before resolving the turn surface", async () => {
    const extensionApi = createMockExtensionAPI();
    registerTools(extensionApi.api, ["read", "edit", "write", "session_compact", "grep", "exec"]);

    const runtime = {
      config: {
        skills: {
          routing: {
            profile: "standard",
            scopes: ["core", "domain"],
          },
        },
      },
      skills: {
        getActive: () => undefined,
        getPendingDispatch: () => ({
          primary: { name: "debugging" },
          chain: ["debugging"],
        }),
        getCascadeIntent: () => undefined,
        get: (name: string) =>
          name === "debugging"
            ? {
                name,
                contract: {
                  tools: {
                    required: ["exec"],
                    optional: ["skill_complete"],
                    denied: [],
                  },
                },
              }
            : undefined,
      },
      events: {
        record: () => undefined,
      },
    };

    const dynamicToolDefinitions = new Map(
      ["skill_load", "skill_complete", "skill_route_override", "obs_query"].map((name) => [
        name,
        createToolDefinition(name),
      ]),
    );

    registerToolSurface(extensionApi.api, runtime as any, {
      dynamicToolDefinitions,
    });
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $obs_query if needed while following the selected skill.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s4",
        },
      },
    );

    expect(extensionApi.api.getAllTools().map((tool) => tool.name)).toContain("skill_load");
    expect(extensionApi.api.getAllTools().map((tool) => tool.name)).toContain("skill_complete");
    expect(extensionApi.api.getAllTools().map((tool) => tool.name)).toContain(
      "skill_route_override",
    );
    expect(extensionApi.api.getAllTools().map((tool) => tool.name)).toContain("obs_query");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).toContain("skill_complete");
    expect(extensionApi.activeTools).toContain("skill_route_override");
    expect(extensionApi.activeTools).toContain("obs_query");
  });
});
