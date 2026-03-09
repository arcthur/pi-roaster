import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { BrewvaRuntime, parseSkillDocument, tightenContract } from "@brewva/brewva-runtime";
import type { SkillContract } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

function listSkillDocuments(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        out.push(fullPath);
      }
    }
  };
  walk(rootDir);
  return out.toSorted();
}

function inferSkillTier(filePath: string): "base" | "pack" | "project" {
  if (filePath.includes(`${sep}base${sep}`)) return "base";
  if (filePath.includes(`${sep}packs${sep}`)) return "pack";
  if (filePath.includes(`${sep}project${sep}`)) return "project";
  throw new Error(`Unknown skill tier for file: ${filePath}`);
}

describe("S-002 denied tool gate", () => {
  test("blocks denied write for active patching skill", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s2";
    const activated = runtime.skills.activate(sessionId, "patching");
    expect(activated.ok).toBe(true);

    const access = runtime.tools.checkAccess(sessionId, "write");
    expect(access.allowed).toBe(false);
  });

  test("keeps denied tool enforcement in permissive mode", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    runtime.config.security.mode = "permissive";

    const sessionId = "s2-disabled";
    const activated = runtime.skills.activate(sessionId, "patching");
    expect(activated.ok).toBe(true);

    const access = runtime.tools.checkAccess(sessionId, "write");
    expect(access.allowed).toBe(false);
  });

  test("blocks removed bash/shell tools with migration hint", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const sessionId = "s2-removed-tools";

    const bash = runtime.tools.checkAccess(sessionId, "bash");
    expect(bash.allowed).toBe(false);
    expect(bash.reason?.includes("removed")).toBe(true);
    expect(bash.reason?.includes("exec")).toBe(true);
    expect(bash.reason?.includes("process")).toBe(true);

    const shell = runtime.tools.checkAccess(sessionId, "shell");
    expect(shell.allowed).toBe(false);
    expect(shell.reason?.includes("removed")).toBe(true);
  });
});

describe("S-006 three-layer contract tightening", () => {
  test("project contract cannot relax base contract", async () => {
    const base: SkillContract = {
      name: "foo",
      tier: "base",
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
        maxTokens: 100000,
      },
    });

    expect(merged.tools.optional).toContain("edit");
    expect(merged.tools.optional).not.toContain("write");
    expect(merged.tools.denied).toContain("write");
    expect(merged.tools.denied).toContain("exec");
    expect(merged.budget.maxToolCalls).toBe(10);
  });

  test("higher tier keeps stricter contract when overriding", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-s6-"));
    mkdirSync(join(workspace, ".brewva"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify({
        skills: {
          packs: [],
          disabled: [],
          overrides: {},
          selector: { k: 4 },
        },
      }),
    );

    mkdirSync(join(workspace, ".brewva", "skills", "base", "foo"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/base/foo/SKILL.md"),
      `---\nname: foo\ndescription: base\ntags: [foo]\ntools:\n  required: [read]\n  optional: [edit]\n  denied: [write]\nbudget:\n  max_tool_calls: 50\n  max_tokens: 10000\noutputs: [base_output]\nconsumes: []\n---\nbase`,
    );

    mkdirSync(join(workspace, ".brewva", "skills", "project", "foo"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/project/foo/SKILL.md"),
      `---\nname: foo\ndescription: project\ntags: [foo]\ntools:\n  required: []\n  optional: [write]\n  denied: [exec]\nbudget:\n  max_tool_calls: 30\n  max_tokens: 8000\noutputs: [project_output]\nconsumes: []\n---\nproject`,
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const foo = runtime.skills.get("foo");
    expect(foo).toBeDefined();
    expect(foo!.contract.tools.denied).toContain("write");
    expect(foo!.contract.tools.denied).toContain("exec");
    expect(foo!.contract.tools.required).toContain("read");
  });
});

describe("skill contract and dispatch parsing", () => {
  test("fails fast when forbidden tier frontmatter field is present", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-tier-forbidden-"));
    const filePath = join(workspace, "skills", "base", "review", "SKILL.md");
    mkdirSync(join(workspace, "skills", "base", "review"), { recursive: true });
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

    expect(() => parseSkillDocument(filePath, "base")).toThrow("tier");
  });

  test("fails fast when required outputs field is missing", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-missing-outputs-"));
    const filePath = join(workspace, "skills", "base", "review", "SKILL.md");
    mkdirSync(join(workspace, "skills", "base", "review"), { recursive: true });
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
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "base")).toThrow("outputs");
  });

  test("fails fast when camelCase budget keys are present", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-budget-camelcase-"));
    const filePath = join(workspace, "skills", "base", "review", "SKILL.md");
    mkdirSync(join(workspace, "skills", "base", "review"), { recursive: true });
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
        "  maxToolCalls: 10",
        "  maxTokens: 10000",
        "outputs: []",
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "base")).toThrow("maxToolCalls");
  });

  test("fails fast when camelCase dispatch keys are present", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-dispatch-camelcase-"));
    const filePath = join(workspace, "skills", "base", "review", "SKILL.md");
    mkdirSync(join(workspace, "skills", "base", "review"), { recursive: true });
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
        "dispatch:",
        "  gateThreshold: 12",
        "outputs: []",
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "base")).toThrow("gateThreshold");
  });

  test("fails fast when camelCase composableWith is present", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-composable-camelcase-"));
    const filePath = join(workspace, "skills", "base", "review", "SKILL.md");
    mkdirSync(join(workspace, "skills", "base", "review"), { recursive: true });
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
        "composableWith: [execution]",
        "outputs: []",
        "consumes: []",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "base")).toThrow("composableWith");
  });

  test("parses dispatch frontmatter with defaults", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-dispatch-"));
    const filePath = join(workspace, "skills", "base", "verify", "SKILL.md");
    mkdirSync(join(workspace, "skills", "base", "verify"), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "name: verify",
        "description: verify skill",
        "tags: [verify]",
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
        "# verify",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseSkillDocument(filePath, "base");
    expect(parsed.contract.dispatch).toEqual({
      gateThreshold: 10,
      autoThreshold: 16,
      defaultMode: "suggest",
    });
  });

  test("tightens dispatch thresholds from override", () => {
    const base: SkillContract = {
      name: "review",
      tier: "base",
      dispatch: {
        gateThreshold: 10,
        autoThreshold: 16,
        defaultMode: "suggest",
      },
      tools: {
        required: ["read"],
        optional: [],
        denied: [],
      },
      budget: {
        maxToolCalls: 10,
        maxTokens: 10_000,
      },
    };

    const merged = tightenContract(base, {
      dispatch: {
        gateThreshold: 12,
        autoThreshold: 20,
        defaultMode: "gate",
      },
    });

    expect(merged.dispatch).toEqual({
      gateThreshold: 12,
      autoThreshold: 20,
      defaultMode: "gate",
    });
  });

  test("repository skills parse without trigger metadata field", () => {
    const skillFiles = listSkillDocuments(join(repoRoot(), "skills"));
    expect(skillFiles.length).toBeGreaterThan(0);

    for (const filePath of skillFiles) {
      const parsed = parseSkillDocument(filePath, inferSkillTier(filePath));
      expect((parsed.contract as unknown as Record<string, unknown>).triggers).toBeUndefined();
      expect(parsed.contract.dispatch).toBeDefined();
    }
  });

  test("telegram pack skills declare composable handoff", () => {
    const behaviorPath = join(
      repoRoot(),
      "skills",
      "packs",
      "telegram-channel-behavior",
      "SKILL.md",
    );
    const interactivePath = join(
      repoRoot(),
      "skills",
      "packs",
      "telegram-interactive-components",
      "SKILL.md",
    );

    const behavior = parseSkillDocument(behaviorPath, "pack");
    const interactive = parseSkillDocument(interactivePath, "pack");

    expect(behavior.contract.composableWith).toContain("telegram-interactive-components");
    expect(interactive.contract.composableWith).toContain("telegram-channel-behavior");
  });

  test("goal-loop and recovery declare bounded loop handoff contract", () => {
    const goalLoopPath = join(repoRoot(), "skills", "packs", "goal-loop", "SKILL.md");
    const recoveryPath = join(repoRoot(), "skills", "base", "recovery", "SKILL.md");

    const goalLoop = parseSkillDocument(goalLoopPath, "pack");
    const recovery = parseSkillDocument(recoveryPath, "base");

    expect(goalLoop.contract.outputs).toEqual(
      expect.arrayContaining([
        "loop_intent",
        "iteration_report",
        "convergence_evidence",
        "delivery_summary",
        "loop_handoff",
      ]),
    );
    expect(goalLoop.contract.composableWith).toContain("recovery");

    expect(recovery.contract.requires).toEqual(expect.arrayContaining(["iteration_report"]));
    expect(recovery.contract.consumes).toEqual(
      expect.arrayContaining(["failure_evidence", "current_plan", "constraints"]),
    );
    expect(recovery.contract.outputs).toEqual(
      expect.arrayContaining(["recovery_plan", "blocker_evidence", "next_skill_hint"]),
    );
    expect(recovery.contract.composableWith).toContain("goal-loop");
    expect(recovery.contract.effectLevel).toBe("read_only");
  });

  test("zca structured output declares bounded validation contract", () => {
    const skillPath = join(
      repoRoot(),
      "skills",
      "packs",
      "zca-structured-output",
      "SKILL.md",
    );

    const parsed = parseSkillDocument(skillPath, "pack");

    expect(parsed.contract.effectLevel).toBe("execute");
    expect(parsed.contract.tools.required).toEqual(expect.arrayContaining(["read", "exec"]));
    expect(parsed.contract.tools.denied).toEqual(
      expect.arrayContaining(["edit", "write", "process"]),
    );
    expect(parsed.contract.outputs).toBeDefined();
    expect(parsed.contract.outputs?.every((output) => output.startsWith("zca_"))).toBe(true);
    expect(parsed.contract.consumes).not.toContain("task_state");
    expect(parsed.contract.composableWith).toEqual(
      expect.arrayContaining(["planning", "verification", "recovery"]),
    );
  });
});
