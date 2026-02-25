import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, tightenContract } from "@brewva/brewva-runtime";
import type { SkillContract } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
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
      tags: ["x"],
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
      `---\nname: foo\ndescription: base\ntags: [foo]\ntools:\n  required: [read]\n  optional: [edit]\n  denied: [write]\nbudget:\n  max_tool_calls: 50\n  max_tokens: 10000\n---\nbase`,
    );

    mkdirSync(join(workspace, ".brewva", "skills", "project", "foo"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva/skills/project/foo/SKILL.md"),
      `---\nname: foo\ndescription: project\ntags: [foo]\ntools:\n  required: []\n  optional: [write]\n  denied: [exec]\nbudget:\n  max_tool_calls: 30\n  max_tokens: 8000\n---\nproject`,
    );

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const foo = runtime.skills.get("foo");
    expect(foo).toBeDefined();
    expect(foo!.contract.tools.denied).toContain("write");
    expect(foo!.contract.tools.denied).toContain("exec");
    expect(foo!.contract.tools.required).toContain("read");
  });
});
