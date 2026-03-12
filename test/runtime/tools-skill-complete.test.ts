import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createSkillCompleteTool, createSkillLoadTool } from "@brewva/brewva-tools";

function writeSkill(
  filePath: string,
  input: { name: string; outputs: string[]; outputContracts?: string[] },
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${input.name}`,
      `description: ${input.name} skill`,
      "intent:",
      `  outputs: [${input.outputs.join(", ")}]`,
      ...(input.outputContracts && input.outputContracts.length > 0
        ? ["  output_contracts:", ...input.outputContracts.map((line) => `  ${line}`)]
        : []),
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
      `# ${input.name}`,
      "",
      "## Intent",
      "",
      "Test skill.",
    ].join("\n"),
    "utf8",
  );
}

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function fakeContext(sessionId: string): any {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

describe("skill_complete tool", () => {
  test("allows omitted outputs for skills whose contract declares no outputs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-empty-"));
    writeSkill(join(workspace, ".brewva/skills/core/noop/SKILL.md"), {
      name: "noop",
      outputs: [],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-empty-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load",
      { name: "noop" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("Skill completed")).toBe(true);
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
  });

  test("rejects placeholder outputs for built-in design artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-design-"));
    writeSkill(join(workspace, ".brewva/skills/core/design-contract/SKILL.md"), {
      name: "design-contract",
      outputs: ["design_spec", "execution_plan", "execution_mode_hint", "risk_register"],
      outputContracts: [
        "  design_spec:",
        "    kind: text",
        "    min_words: 4",
        "    min_length: 24",
        "  execution_plan:",
        "    kind: json",
        "    min_items: 2",
        "  execution_mode_hint:",
        "    kind: enum",
        "    values: [direct_patch, test_first, coordinated_rollout]",
        "  risk_register:",
        "    kind: json",
        "    min_items: 1",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-design-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-design",
      { name: "design-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-design",
      {
        outputs: {
          design_spec: "test",
          execution_plan: ["a"],
          execution_mode_hint: "direct_patch",
          risk_register: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("Missing required outputs: risk_register");
    expect(text).toContain("Invalid required outputs: design_spec, execution_plan");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("design-contract");
  });

  test("accepts informative built-in design artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-design-valid-"));
    writeSkill(join(workspace, ".brewva/skills/core/design-contract/SKILL.md"), {
      name: "design-contract",
      outputs: ["design_spec", "execution_plan", "execution_mode_hint", "risk_register"],
      outputContracts: [
        "  design_spec:",
        "    kind: text",
        "    min_words: 4",
        "    min_length: 24",
        "  execution_plan:",
        "    kind: json",
        "    min_items: 2",
        "  execution_mode_hint:",
        "    kind: enum",
        "    values: [direct_patch, test_first, coordinated_rollout]",
        "  risk_register:",
        "    kind: json",
        "    min_items: 1",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-design-2";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-design-valid",
      { name: "design-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-design-valid",
      {
        outputs: {
          design_spec:
            "Keep runtime-owned guard semantics in the kernel and move repository discovery ahead of design work.",
          execution_plan: [
            "Promote repository_snapshot and impact_map to required design inputs.",
            "Tighten output validation so placeholder artifacts cannot complete the skill.",
          ],
          execution_mode_hint: "direct_patch",
          risk_register: [
            {
              risk: "Guard resets could still be triggered by non-epistemic control actions.",
              mitigation:
                "Classify lifecycle inspection as neutral and only clear on real strategy shifts.",
            },
          ],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("Skill completed")).toBe(true);
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
  });

  test("rejects placeholder outputs for built-in review artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-review-"));
    writeSkill(join(workspace, ".brewva/skills/core/review-contract/SKILL.md"), {
      name: "review-contract",
      outputs: ["review_report", "review_findings", "merge_decision"],
      outputContracts: [
        "  review_report:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  review_findings:",
        "    kind: json",
        "    min_items: 1",
        "  merge_decision:",
        "    kind: enum",
        "    values: [ready, needs_changes, blocked]",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-review-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-review",
      { name: "review-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-review",
      {
        outputs: {
          review_report: "test",
          review_findings: "summary",
          merge_decision: "needs_changes",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("Invalid required outputs: review_report, review_findings");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("review-contract");
  });

  test("rejects placeholder outputs for built-in implementation artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-implementation-"));
    writeSkill(join(workspace, ".brewva/skills/core/implementation-contract/SKILL.md"), {
      name: "implementation-contract",
      outputs: ["change_set", "files_changed", "verification_evidence"],
      outputContracts: [
        "  change_set:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  files_changed:",
        "    kind: json",
        "    min_items: 1",
        "  verification_evidence:",
        "    kind: json",
        "    min_items: 1",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-implementation-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-implementation",
      { name: "implementation-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-implementation",
      {
        outputs: {
          change_set: "test",
          files_changed: [],
          verification_evidence: "todo",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("Missing required outputs: files_changed");
    expect(text).toContain("Invalid required outputs: change_set, verification_evidence");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("implementation-contract");
  });
});
