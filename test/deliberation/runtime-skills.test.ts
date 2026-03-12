import { describe, expect, test } from "bun:test";
import {
  buildSkillsIndex,
  listAvailableOutputs,
  planChainForRuntimeSelection,
  toSkillsIndexEntry,
} from "@brewva/brewva-deliberation";
import type { SkillDocument } from "@brewva/brewva-runtime";

type SkillRuntime = Parameters<typeof planChainForRuntimeSelection>[0]["runtime"];

function createSkillDocument(input: {
  name: string;
  outputs?: string[];
  requires?: string[];
  composableWith?: string[];
}): SkillDocument {
  return {
    name: input.name,
    description: `${input.name} description`,
    category: "core",
    filePath: `/tmp/${input.name}.md`,
    baseDir: "/tmp",
    markdown: `# ${input.name}`,
    contract: {
      name: input.name,
      category: "core",
      intent: {
        outputs: input.outputs ?? [],
      },
      effects: {
        allowedEffects: ["workspace_read"],
      },
      resources: {
        defaultLease: {
          maxToolCalls: 4,
          maxTokens: 8000,
        },
        hardCeiling: {
          maxToolCalls: 4,
          maxTokens: 8000,
        },
      },
      executionHints: {
        preferredTools: ["read"],
        fallbackTools: [],
        costHint: "medium",
      },
      requires: input.requires ?? [],
      composableWith: input.composableWith ?? [],
      stability: "stable",
      dispatch: {
        suggestThreshold: 12,
        autoThreshold: 18,
      },
      routing: {
        scope: "core",
      },
    },
    resources: {
      references: [],
      scripts: [],
      heuristics: [],
      invariants: [],
    },
    sharedContextFiles: [],
    overlayFiles: [],
  };
}

describe("deliberation runtime skill helpers", () => {
  test("toSkillsIndexEntry preserves contract-facing routing metadata", () => {
    const entry = toSkillsIndexEntry(
      createSkillDocument({
        name: "implementation",
        outputs: ["change_set", "files_changed"],
        requires: ["root_cause"],
        composableWith: ["debugging"],
      }),
    );

    expect(entry.name).toBe("implementation");
    expect(entry.outputs).toEqual(["change_set", "files_changed"]);
    expect(entry.requires).toEqual(["root_cause"]);
    expect(entry.routingScope).toBe("core");
  });

  test("planChainForRuntimeSelection uses current outputs to avoid redundant prerequisites", () => {
    const debugging = createSkillDocument({
      name: "debugging",
      outputs: ["root_cause"],
    });
    const implementation = createSkillDocument({
      name: "implementation",
      outputs: ["change_set"],
      requires: ["root_cause"],
      composableWith: ["debugging"],
    });
    const skills = [debugging, implementation];
    const runtime = {
      skills: {
        list() {
          return skills;
        },
        getOutputs(sessionId: string, skillName: string) {
          if (sessionId === "with-output" && skillName === "debugging") {
            return {
              root_cause: "parsed stack trace",
            };
          }
          return undefined;
        },
      },
    } as unknown as SkillRuntime;

    expect(buildSkillsIndex(runtime).map((entry) => entry.name)).toEqual([
      "debugging",
      "implementation",
    ]);
    expect(listAvailableOutputs(runtime, "with-output")).toEqual(["root_cause"]);

    const plannedWithoutOutput = planChainForRuntimeSelection({
      runtime,
      sessionId: "without-output",
      primarySkillName: "implementation",
    });
    expect(plannedWithoutOutput?.result.chain).toEqual(["debugging", "implementation"]);

    const plannedWithOutput = planChainForRuntimeSelection({
      runtime,
      sessionId: "with-output",
      primarySkillName: "implementation",
    });
    expect(plannedWithOutput?.result.chain).toEqual(["implementation"]);
  });
});
