import { describe, expect, test } from "bun:test";
import { TOOL_GOVERNANCE_BY_NAME } from "@brewva/brewva-runtime";
import {
  buildBrewvaTools,
  createA2ATools,
  getBrewvaToolMetadata,
  getBrewvaToolSurface,
} from "@brewva/brewva-tools";

describe("managed Brewva tool definition metadata", () => {
  test("default Brewva tool bundle attaches surface and governance metadata", () => {
    const runtime = {} as Parameters<typeof buildBrewvaTools>[0]["runtime"];
    const tools = buildBrewvaTools({ runtime });

    for (const tool of tools) {
      const metadata = getBrewvaToolMetadata(tool);
      expect(metadata, `missing metadata for ${tool.name}`).toBeDefined();
      expect(metadata?.surface).toBe(getBrewvaToolSurface(tool.name));
      expect(metadata?.governance).toEqual(TOOL_GOVERNANCE_BY_NAME[tool.name]);
    }
  });

  test("A2A tools attach surface and governance metadata", () => {
    const tools = createA2ATools({
      runtime: {
        orchestration: {
          a2a: {
            send: async () => ({ ok: false, toAgentId: "na", error: "unused" }),
            broadcast: async () => ({ ok: true, results: [] }),
            listAgents: async () => [],
          },
        },
      },
    });

    for (const tool of tools) {
      const metadata = getBrewvaToolMetadata(tool);
      expect(metadata, `missing metadata for ${tool.name}`).toBeDefined();
      expect(metadata?.surface).toBe(getBrewvaToolSurface(tool.name));
      expect(metadata?.governance).toEqual(TOOL_GOVERNANCE_BY_NAME[tool.name]);
    }
  });
});
