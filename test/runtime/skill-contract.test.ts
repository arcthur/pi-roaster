import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BrewvaRuntime,
  mergeOverlayContract,
  parseSkillDocument,
  tightenContract,
  type SkillContract,
} from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("skill contract tightening", () => {
  test("cannot relax denied tools or budgets", () => {
    const base: SkillContract = {
      name: "implementation",
      category: "core",
      routing: { scope: "core" },
      tools: {
        required: ["read"],
        optional: ["edit"],
        denied: ["write"],
      },
      budget: {
        maxToolCalls: 50,
        maxTokens: 100000,
      },
    };

    const merged = tightenContract(base, {
      tools: {
        required: [],
        optional: ["write", "edit"],
        denied: ["exec"],
      },
      budget: {
        maxToolCalls: 10,
        maxTokens: 50000,
      },
      routing: {
        continuityRequired: true,
      },
    });

    expect(merged.tools.optional).toContain("edit");
    expect(merged.tools.optional).not.toContain("write");
    expect(merged.tools.denied).toEqual(expect.arrayContaining(["write", "exec"]));
    expect(merged.budget.maxToolCalls).toBe(10);
    expect(merged.budget.maxTokens).toBe(50000);
    expect(merged.routing?.continuityRequired).toBe(true);
  });

  test("project overlays can add project-required tools without relaxing denials", () => {
    const base: SkillContract = {
      name: "debugging",
      category: "core",
      routing: { scope: "core" },
      tools: {
        required: ["read", "exec"],
        optional: ["grep"],
        denied: ["write"],
      },
      budget: {
        maxToolCalls: 50,
        maxTokens: 100000,
      },
      outputs: [],
      outputContracts: {},
    };

    const merged = mergeOverlayContract(base, {
      tools: {
        required: ["tape_search"],
        optional: ["cost_view"],
        denied: ["process"],
      },
      budget: {
        maxToolCalls: 10,
      },
    });

    expect(merged.tools.required).toEqual(expect.arrayContaining(["read", "exec", "tape_search"]));
    expect(merged.tools.optional).toEqual(expect.arrayContaining(["grep", "cost_view"]));
    expect(merged.tools.denied).toEqual(expect.arrayContaining(["write", "process"]));
    expect(merged.budget.maxToolCalls).toBe(10);
  });

  test("shared merge policies keep dispatch, routing, effect level, and maxParallel aligned", () => {
    const base: SkillContract = {
      name: "implementation",
      category: "core",
      routing: { scope: "core", continuityRequired: false },
      dispatch: {
        gateThreshold: 10,
        autoThreshold: 20,
        defaultMode: "suggest",
      },
      tools: {
        required: ["read"],
        optional: ["exec"],
        denied: [],
      },
      budget: {
        maxToolCalls: 50,
        maxTokens: 100000,
      },
      maxParallel: 5,
      effectLevel: "read_only",
    };

    const override = {
      budget: {
        maxToolCalls: 12,
        maxTokens: 20000,
      },
      dispatch: {
        gateThreshold: 14,
        autoThreshold: 18,
        defaultMode: "gate" as const,
      },
      routing: {
        continuityRequired: true,
      },
      maxParallel: 3,
      effectLevel: "execute" as const,
    };

    const tightened = tightenContract(base, override);
    const merged = mergeOverlayContract(
      {
        ...base,
        outputs: [],
        outputContracts: {},
      },
      override,
    );

    for (const result of [tightened, merged]) {
      expect(result.budget).toEqual({ maxToolCalls: 12, maxTokens: 20000 });
      expect(result.dispatch).toEqual({
        gateThreshold: 14,
        autoThreshold: 20,
        defaultMode: "gate",
      });
      expect(result.routing).toEqual({ scope: "core", continuityRequired: true });
      expect(result.maxParallel).toBe(3);
      expect(result.effectLevel).toBe("execute");
    }
  });
});

describe("skill document parsing", () => {
  test("fails fast when forbidden tier frontmatter field is present", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-tier-forbidden-"));
    const filePath = join(workspace, "skills", "core", "review", "SKILL.md");
    mkdirSync(join(workspace, "skills", "core", "review"), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "name: review",
        "description: review skill",
        "tier: base",
        "tools:",
        "  required: [read]",
        "  optional: []",
        "  denied: []",
        "budget:",
        "  max_tool_calls: 10",
        "  max_tokens: 10000",
        "outputs: []",
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("tier");
  });

  test("fails fast when forbidden category frontmatter field is present", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-category-forbidden-"));
    const filePath = join(workspace, "skills", "core", "review", "SKILL.md");
    mkdirSync(join(workspace, "skills", "core", "review"), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "name: review",
        "description: review skill",
        "category: core",
        "tools:",
        "  required: [read]",
        "  optional: []",
        "  denied: []",
        "budget:",
        "  max_tool_calls: 10",
        "  max_tokens: 10000",
        "outputs: []",
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("category");
  });

  test("parses continuity-required routing for goal-loop", () => {
    const parsed = parseSkillDocument(
      join(repoRoot(), "skills/domain/goal-loop/SKILL.md"),
      "domain",
    );

    expect(parsed.category).toBe("domain");
    expect(parsed.contract.routing?.scope).toBe("domain");
    expect(parsed.contract.routing?.continuityRequired).toBe(true);
  });

  test("parses overlay resources without exposing routing scope", () => {
    const parsed = parseSkillDocument(
      join(repoRoot(), "skills/project/overlays/review/SKILL.md"),
      "overlay",
    );

    expect(parsed.category).toBe("overlay");
    expect(parsed.contract.routing).toBeUndefined();
    expect(parsed.resources.scripts).toContain("skills/project/scripts/check-skill-dod.sh");
  });

  test("overlay parsing leaves omitted array fields undefined so base contracts can inherit them", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-overlay-inherit-"));
    const filePath = join(workspace, "skills", "project", "overlays", "implementation", "SKILL.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "tools:",
        "  required: [read, edit]",
        "  optional: []",
        "  denied: []",
        "budget:",
        "  max_tool_calls: 10",
        "  max_tokens: 10000",
        "---",
        "# overlay",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseSkillDocument(filePath, "overlay");
    expect(parsed.contract.outputs).toBeUndefined();
    expect(parsed.contract.consumes).toBeUndefined();
    expect(parsed.contract.composableWith).toBeUndefined();

    const merged = mergeOverlayContract(
      {
        name: "implementation",
        category: "core",
        routing: { scope: "core" },
        tools: {
          required: ["read"],
          optional: ["skill_complete"],
          denied: [],
        },
        budget: {
          maxToolCalls: 50,
          maxTokens: 100000,
        },
        outputs: ["change_set"],
        outputContracts: {
          change_set: {
            kind: "informative_text",
            minWords: 3,
            minLength: 18,
          },
        },
        consumes: ["root_cause"],
        composableWith: ["debugging"],
      },
      parsed.contract,
    );

    expect(merged.outputs).toEqual(["change_set"]);
    expect(merged.outputContracts).toEqual({
      change_set: {
        kind: "informative_text",
        minWords: 3,
        minLength: 18,
      },
    });
    expect(merged.consumes).toEqual(["root_cause"]);
    expect(merged.composableWith).toEqual(["debugging"]);
  });

  test("fails fast when non-overlay outputs omit output contracts", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-missing-output-contracts-"));
    const filePath = join(workspace, "skills", "core", "review", "SKILL.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "name: review",
        "description: review skill",
        "tools:",
        "  required: [read]",
        "  optional: []",
        "  denied: []",
        "budget:",
        "  max_tool_calls: 10",
        "  max_tokens: 10000",
        "outputs: [review_report]",
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("output_contracts");
  });

  test("rejects overlays that attempt to replace a base output contract", () => {
    const base: SkillContract = {
      name: "review",
      category: "core",
      routing: { scope: "core" },
      tools: {
        required: ["read"],
        optional: [],
        denied: [],
      },
      budget: {
        maxToolCalls: 50,
        maxTokens: 100000,
      },
      outputs: ["review_report"],
      outputContracts: {
        review_report: {
          kind: "informative_text",
          minWords: 3,
          minLength: 18,
        },
      },
    };

    expect(() =>
      mergeOverlayContract(base, {
        outputs: ["review_report"],
        outputContracts: {
          review_report: {
            kind: "informative_text",
            minWords: 2,
            minLength: 12,
          },
        },
      }),
    ).toThrow("cannot replace the base contract");
  });

  test("accepts equivalent nested output contracts even when object key order differs", () => {
    const base: SkillContract = {
      name: "review",
      category: "core",
      routing: { scope: "core" },
      tools: {
        required: ["read"],
        optional: [],
        denied: [],
      },
      budget: {
        maxToolCalls: 50,
        maxTokens: 100000,
      },
      outputs: ["review_report"],
      outputContracts: {
        review_report: {
          kind: "object",
          required: ["summary", "decision"],
          properties: {
            summary: { kind: "informative_text", minWords: 3, minLength: 18 },
            decision: {
              kind: "one_of",
              variants: [
                { kind: "enum", values: ["approve", "reject"] },
                { kind: "informative_text", minWords: 2 },
              ],
            },
          },
        },
      },
    };

    expect(() =>
      mergeOverlayContract(base, {
        outputs: ["review_report"],
        outputContracts: {
          review_report: {
            properties: {
              decision: {
                variants: [
                  { values: ["approve", "reject"], kind: "enum" },
                  { minWords: 2, kind: "informative_text" },
                ],
                kind: "one_of",
              },
              summary: { minLength: 18, kind: "informative_text", minWords: 3 },
            },
            kind: "object",
            required: ["summary", "decision"],
          },
        },
      }),
    ).not.toThrow();
  });

  test("parses skill-local resources with relative paths", () => {
    const parsed = parseSkillDocument(
      join(repoRoot(), "skills/meta/skill-authoring/SKILL.md"),
      "meta",
    );

    expect(parsed.category).toBe("meta");
    expect(parsed.resources.references).toEqual(
      expect.arrayContaining(["references/output-patterns.md", "references/workflows.md"]),
    );
    expect(parsed.resources.scripts).toEqual(
      expect.arrayContaining([
        "scripts/init_skill.py",
        "scripts/fork_skill.py",
        "scripts/package_skill.py",
        "scripts/quick_validate.py",
      ]),
    );
  });
});

describe("repository catalog contracts", () => {
  test("runtime loads the new v2 catalog names", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    expect(runtime.skills.get("repository-analysis")).toBeDefined();
    expect(runtime.skills.get("design")).toBeDefined();
    expect(runtime.skills.get("implementation")).toBeDefined();
    expect(runtime.skills.get("runtime-forensics")).toBeDefined();
    expect(runtime.skills.get("skill-authoring")).toBeDefined();
  });

  test("review remains read_only and standalone by contract", () => {
    const review = parseSkillDocument(join(repoRoot(), "skills/core/review/SKILL.md"), "core");

    expect(review.contract.effectLevel).toBe("read_only");
    expect(review.contract.requires).toEqual([]);
    expect(review.contract.routing?.scope).toBe("core");
    expect(review.contract.outputs).toEqual(
      expect.arrayContaining(["review_report", "review_findings", "merge_decision"]),
    );
    expect(Object.keys(review.contract.outputContracts ?? {}).toSorted()).toEqual([
      "merge_decision",
      "review_findings",
      "review_report",
    ]);
  });

  test("built-in base skills declare explicit output contracts for every declared output", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const missing = runtime.skills
      .list()
      .filter((skill) => skill.category !== "overlay")
      .flatMap((skill) => {
        const outputs = skill.contract.outputs ?? [];
        if (outputs.length === 0) {
          return [];
        }
        const contracts = skill.contract.outputContracts ?? {};
        const uncovered = outputs.filter(
          (name) => !Object.prototype.hasOwnProperty.call(contracts, name),
        );
        return uncovered.length === 0 ? [] : [`${skill.name}:${uncovered.join(",")}`];
      });

    expect(missing).toEqual([]);
  });
});
