import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BrewvaRuntime,
  getSkillOutputContracts,
  listSkillAllowedEffects,
  listSkillOutputs,
  mergeOverlayContract,
  parseSkillDocument,
  resolveSkillEffectLevel,
  tightenContract,
  type SkillContract,
  type SkillContractOverride,
} from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

function createContract(
  input: Partial<SkillContract> & Pick<SkillContract, "name" | "category">,
): SkillContract {
  const defaultLease = input.resources?.defaultLease ?? {
    maxToolCalls: 50,
    maxTokens: 100000,
  };
  const hardCeiling = input.resources?.hardCeiling ?? defaultLease;
  return {
    name: input.name,
    category: input.category,
    routing: input.routing,
    dispatch: input.dispatch,
    intent: input.intent,
    effects: input.effects ?? {
      allowedEffects: ["workspace_read"],
      deniedEffects: [],
    },
    resources: input.resources ?? {
      defaultLease,
      hardCeiling,
    },
    executionHints: input.executionHints ?? {
      preferredTools: ["read"],
      fallbackTools: [],
      costHint: "medium",
    },
    composableWith: input.composableWith,
    consumes: input.consumes,
    requires: input.requires,
    stability: input.stability,
    description: input.description,
  };
}

describe("skill contract tightening", () => {
  test("cannot relax denied effects or resource ceilings", () => {
    const base = createContract({
      name: "implementation",
      category: "core",
      routing: { scope: "core" },
      effects: {
        allowedEffects: ["workspace_read", "workspace_write"],
        deniedEffects: ["local_exec"],
      },
      resources: {
        defaultLease: { maxToolCalls: 50, maxTokens: 100000 },
        hardCeiling: { maxToolCalls: 50, maxTokens: 100000 },
      },
      executionHints: {
        preferredTools: ["read", "edit"],
        fallbackTools: ["grep"],
        costHint: "medium",
      },
    });

    const merged = tightenContract(base, {
      effects: {
        allowedEffects: ["workspace_read"],
        deniedEffects: ["external_network"],
      },
      resources: {
        defaultLease: { maxToolCalls: 10, maxTokens: 50000 },
      },
      executionHints: {
        preferredTools: ["read"],
        fallbackTools: ["grep", "write"],
      },
    });

    expect(merged.executionHints?.preferredTools).toEqual(["read"]);
    expect(merged.executionHints?.fallbackTools).toContain("grep");
    expect(merged.executionHints?.fallbackTools).not.toContain("write");
    expect(merged.effects?.allowedEffects).toEqual(["workspace_read"]);
    expect(merged.effects?.deniedEffects).toEqual(
      expect.arrayContaining(["local_exec", "external_network"]),
    );
    expect(merged.resources?.defaultLease).toEqual({ maxToolCalls: 10, maxTokens: 50000 });
    expect(merged.routing).toEqual({ scope: "core" });
  });

  test("project overlays add execution hints and denied effects without replacing output contracts", () => {
    const base = createContract({
      name: "debugging",
      category: "core",
      routing: { scope: "core" },
      intent: {
        outputs: ["root_cause"],
        outputContracts: {
          root_cause: {
            kind: "text",
            minWords: 3,
            minLength: 18,
          },
        },
      },
      effects: {
        allowedEffects: ["workspace_read", "local_exec"],
        deniedEffects: ["workspace_write"],
      },
      executionHints: {
        preferredTools: ["read", "exec"],
        fallbackTools: ["grep"],
        costHint: "medium",
      },
    });

    const merged = mergeOverlayContract(base, {
      effects: {
        allowedEffects: ["workspace_read", "local_exec", "workspace_write"],
        deniedEffects: ["external_network"],
      },
      executionHints: {
        preferredTools: ["tape_search"],
        fallbackTools: ["cost_view"],
      },
    });

    expect(merged.executionHints?.preferredTools).toEqual(
      expect.arrayContaining(["read", "exec", "tape_search"]),
    );
    expect(merged.executionHints?.fallbackTools).toEqual(
      expect.arrayContaining(["grep", "cost_view"]),
    );
    expect(merged.effects?.deniedEffects).toEqual(
      expect.arrayContaining(["workspace_write", "external_network"]),
    );
    expect(merged.effects?.allowedEffects).toEqual(["workspace_read", "local_exec"]);
    expect(listSkillOutputs(merged)).toEqual(["root_cause"]);
    expect(Object.keys(getSkillOutputContracts(merged))).toEqual(["root_cause"]);
  });

  test("preserves completion evidence kinds when overrides only tighten verification level", () => {
    const base = createContract({
      name: "review",
      category: "core",
      routing: { scope: "core" },
      intent: {
        outputs: ["review_report"],
        outputContracts: {
          review_report: {
            kind: "text",
            minWords: 3,
            minLength: 18,
          },
        },
        completionDefinition: {
          verificationLevel: "standard",
          requiredEvidenceKinds: ["ledger", "verification"],
        },
      },
    });

    const tightened = tightenContract(base, {
      intent: {
        completionDefinition: {
          verificationLevel: "quick",
        },
      },
    });
    const overlaid = mergeOverlayContract(base, {
      intent: {
        completionDefinition: {
          verificationLevel: "strict",
        },
      },
    });

    expect(tightened.intent?.completionDefinition).toEqual({
      verificationLevel: "quick",
      requiredEvidenceKinds: ["ledger", "verification"],
    });
    expect(overlaid.intent?.completionDefinition).toEqual({
      verificationLevel: "strict",
      requiredEvidenceKinds: ["ledger", "verification"],
    });
  });

  test("explicit empty allowed effects remain fully sandboxed instead of falling back to read-only", () => {
    const contract = createContract({
      name: "narrator",
      category: "core",
      effects: {
        allowedEffects: [],
        deniedEffects: [],
      },
    });

    expect(listSkillAllowedEffects(contract)).toEqual([]);
    expect(resolveSkillEffectLevel(contract)).toBe("read_only");
  });

  test("shared merge policies keep dispatch, routing, effect tightening, and maxParallel aligned", () => {
    const base = createContract({
      name: "implementation",
      category: "core",
      routing: { scope: "core" },
      dispatch: {
        suggestThreshold: 10,
        autoThreshold: 20,
      },
      effects: {
        allowedEffects: ["workspace_read"],
      },
      resources: {
        defaultLease: { maxToolCalls: 50, maxTokens: 100000, maxParallel: 5 },
        hardCeiling: { maxToolCalls: 50, maxTokens: 100000, maxParallel: 5 },
      },
    });

    const override: SkillContractOverride = {
      resources: {
        defaultLease: { maxToolCalls: 12, maxTokens: 20000, maxParallel: 3 },
      },
      dispatch: {
        suggestThreshold: 14,
        autoThreshold: 18,
      },
      effects: {
        allowedEffects: ["workspace_read", "local_exec"],
      },
    };

    const tightened = tightenContract(base, override);
    const merged = mergeOverlayContract(
      {
        ...base,
        intent: {
          outputs: [],
          outputContracts: {},
        },
      },
      override,
    );

    for (const result of [tightened, merged]) {
      expect(result.resources?.defaultLease).toEqual({
        maxToolCalls: 12,
        maxTokens: 20000,
        maxParallel: 3,
      });
      expect(result.dispatch).toEqual({
        suggestThreshold: 14,
        autoThreshold: 20,
      });
      expect(result.routing).toEqual({ scope: "core" });
      expect(result.resources?.defaultLease?.maxParallel).toBe(3);
      expect(resolveSkillEffectLevel(result)).toBe("read_only");
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
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 20",
        "    max_tokens: 20000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
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
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 20",
        "    max_tokens: 20000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("category");
  });

  test("fails fast when non-overlay skills omit hard_ceiling", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-hard-ceiling-required-"));
    const filePath = join(workspace, "skills", "core", "review", "SKILL.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "name: review",
        "description: review skill",
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("resources.hard_ceiling");
  });

  test("fails fast when hard_ceiling is lower than default_lease", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-hard-ceiling-lower-"));
    const filePath = join(workspace, "skills", "core", "review", "SKILL.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "name: review",
        "description: review skill",
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 8",
        "    max_tokens: 9000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("resources.hard_ceiling");
  });

  test("rejects removed continuity routing metadata", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-continuity-removed-"));
    const filePath = join(workspace, "skills", "domain", "goal-loop", "SKILL.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "name: goal-loop",
        "description: goal loop skill",
        "routing:",
        "  continuity_required: true",
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 20",
        "    max_tokens: 20000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# goal-loop",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "domain")).toThrow("continuity_required");
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
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 20",
        "    max_tokens: 20000",
        "execution_hints:",
        "  preferred_tools: [read, edit]",
        "---",
        "# overlay",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseSkillDocument(filePath, "overlay");
    expect(parsed.contract.intent?.outputs).toBeUndefined();
    expect(parsed.contract.consumes).toBeUndefined();
    expect(parsed.contract.composableWith).toBeUndefined();

    const merged = mergeOverlayContract(
      createContract({
        name: "implementation",
        category: "core",
        routing: { scope: "core" },
        intent: {
          outputs: ["change_set"],
          outputContracts: {
            change_set: {
              kind: "text",
              minWords: 3,
              minLength: 18,
            },
          },
        },
        requires: ["root_cause"],
        consumes: ["root_cause"],
        composableWith: ["debugging"],
      }),
      parsed.contract,
    );

    expect(listSkillOutputs(merged)).toEqual(["change_set"]);
    expect(getSkillOutputContracts(merged)).toEqual({
      change_set: {
        kind: "text",
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
        "intent:",
        "  outputs: [review_report]",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 20",
        "    max_tokens: 20000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("output_contracts");
  });

  test("rejects overlays that attempt to replace a base output contract", () => {
    const base = createContract({
      name: "review",
      category: "core",
      routing: { scope: "core" },
      intent: {
        outputs: ["review_report"],
        outputContracts: {
          review_report: {
            kind: "text",
            minWords: 3,
            minLength: 18,
          },
        },
      },
    });

    expect(() =>
      mergeOverlayContract(base, {
        intent: {
          outputs: ["review_report"],
          outputContracts: {
            review_report: {
              kind: "text",
              minWords: 2,
              minLength: 12,
            },
          },
        },
      }),
    ).toThrow("cannot replace the base contract");
  });

  test("accepts equivalent json output contracts even when object key order differs", () => {
    const base = createContract({
      name: "review",
      category: "core",
      routing: { scope: "core" },
      intent: {
        outputs: ["review_report"],
        outputContracts: {
          review_report: {
            kind: "json",
            minKeys: 1,
            minItems: 1,
          },
        },
      },
    });

    expect(() =>
      mergeOverlayContract(base, {
        intent: {
          outputs: ["review_report"],
          outputContracts: {
            review_report: {
              minItems: 1,
              kind: "json",
              minKeys: 1,
            },
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

    expect(resolveSkillEffectLevel(review.contract)).toBe("read_only");
    expect(review.contract.requires).toEqual([]);
    expect(review.contract.routing?.scope).toBe("core");
    expect(listSkillOutputs(review.contract)).toEqual(
      expect.arrayContaining(["review_report", "review_findings", "merge_decision"]),
    );
    expect(Object.keys(getSkillOutputContracts(review.contract)).toSorted()).toEqual([
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
        const outputs = listSkillOutputs(skill.contract);
        if (outputs.length === 0) {
          return [];
        }
        const contracts = getSkillOutputContracts(skill.contract);
        const uncovered = outputs.filter(
          (name) => !Object.prototype.hasOwnProperty.call(contracts, name),
        );
        return uncovered.length === 0 ? [] : [`${skill.name}:${uncovered.join(",")}`];
      });

    expect(missing).toEqual([]);
  });
});
