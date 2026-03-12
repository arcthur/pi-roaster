import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  getSkillOutputContracts,
  listSkillOutputs,
  type BrewvaConfig,
} from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-skill-cascade-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function createConfig(
  mode: BrewvaConfig["skills"]["cascade"]["mode"],
  sourcePriority: BrewvaConfig["skills"]["cascade"]["sourcePriority"] = ["explicit", "dispatch"],
  enabledSources: BrewvaConfig["skills"]["cascade"]["enabledSources"] = sourcePriority,
): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.projection.enabled = false;
  config.infrastructure.toolFailureInjection.enabled = false;
  config.skills.cascade.mode = mode;
  config.skills.cascade.enabledSources = enabledSources;
  config.skills.cascade.sourcePriority = sourcePriority;
  return config;
}

function buildEvidenceRef(sessionId: string) {
  return {
    id: `${sessionId}:broker-trace`,
    sourceType: "broker_trace" as const,
    locator: "broker://test",
    createdAt: Date.now(),
  };
}

function submitSelection(runtime: BrewvaRuntime, sessionId: string, skillName: string) {
  runtime.context.onTurnStart(sessionId, 1);
  return runtime.proposals.submit(sessionId, {
    id: `${sessionId}:selection`,
    kind: "skill_selection",
    issuer: "test.broker",
    subject: `select:${skillName}`,
    payload: {
      selected: [
        {
          name: skillName,
          score: 30,
          reason: `semantic:${skillName}`,
          breakdown: [{ signal: "semantic_match", term: skillName, delta: 30 }],
        },
      ],
      routingOutcome: "selected",
    },
    evidenceRefs: [buildEvidenceRef(sessionId)],
    createdAt: Date.now(),
  });
}

function startExplicitChain(runtime: BrewvaRuntime, sessionId: string, steps: string[]) {
  return runtime.skills.startCascade(sessionId, {
    steps: steps.map((skill) => ({ skill })),
  });
}

function buildSkillOutputs(runtime: BrewvaRuntime, skillName: string): Record<string, unknown> {
  const skill = runtime.skills.get(skillName);
  const outputs = listSkillOutputs(skill?.contract);
  const outputContracts = getSkillOutputContracts(skill?.contract);
  const fixtures: Record<string, unknown> = {
    repository_snapshot: "Repository snapshot covering runtime, tools, CLI, and gateway ownership.",
    impact_map: "Primary impact lands in routing, skill lifecycle, and orchestration boundaries.",
    unknowns: ["No unresolved repository blind spots remain after the inventory pass."],
    root_cause:
      "Cascade completion depended on placeholder artifacts instead of contract-quality outputs.",
    fix_strategy: "Generate contract-shaped artifacts before advancing the cascade.",
    failure_evidence: "Replay log showed repository-analysis finishing with placeholder summaries.",
    design_spec:
      "Keep prerequisite discovery ahead of design work so design decisions start from a stable repository map.",
    execution_plan: [
      "Complete repository-analysis with an informative snapshot and impact map.",
      "Advance the cascade only after downstream contracts can consume those artifacts.",
    ],
    execution_mode_hint: "direct_patch",
    risk_register: [
      {
        risk: "Placeholder artifacts could unblock downstream steps without preserving real task state.",
        mitigation: "Require informative artifacts before skill completion succeeds.",
      },
    ],
    review_report: "Reviewed cascade progression for contract integrity and downstream readiness.",
    review_findings: [
      {
        title: "Contract quality",
        detail: "Downstream steps should only receive informative upstream artifacts.",
      },
    ],
    merge_decision: "needs_changes",
  };

  return Object.fromEntries(
    outputs.map((output: string) => {
      const contract = outputContracts[output];
      if (!contract) {
        return [output, fixtures[output] ?? `${output} artifact generated for ${skillName}`];
      }
      switch (contract.kind) {
        case "enum":
          return [output, fixtures[output] ?? contract.values[0]];
        case "json":
          return [
            output,
            fixtures[output] ?? [{ item: `${output} artifact generated for ${skillName}` }],
          ];
        case "text":
          return [output, fixtures[output] ?? `${output} artifact generated for ${skillName}`];
      }
    }),
  );
}

describe("skill cascade orchestration", () => {
  test("accepted skill_selection proposals still arm a pending dispatch commitment", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("selection-commitment"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-selection-1";

    const receipt = submitSelection(runtime, sessionId, "repository-analysis");
    expect(receipt.decision).toBe("accept");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("repository-analysis");
    expect(runtime.skills.getCascadeIntent(sessionId)?.source).toBe("dispatch");
  });

  test("explicit cascade starts create runtime cascade intent", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("chain-commitment"),
      config: createConfig("assist"),
    });
    const sessionId = "skill-cascade-chain-1";

    const started = startExplicitChain(runtime, sessionId, ["repository-analysis", "review"]);
    expect(started.ok).toBe(true);
    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.source).toBe("explicit");
    expect(intent?.steps.map((step) => step.skill)).toEqual(["repository-analysis", "review"]);
  });

  test("dispatch-disabled cascade source does not block explicit cascade starts", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("explicit-priority"),
      config: createConfig("auto", ["explicit", "dispatch"], ["explicit"]),
    });
    const sessionId = "skill-cascade-explicit-priority";

    const started = startExplicitChain(runtime, sessionId, ["design"]);
    expect(started.ok).toBe(true);
    expect(runtime.skills.getCascadeIntent(sessionId)?.steps.map((step) => step.skill)).toEqual([
      "design",
    ]);
  });

  test("explicit intents still advance after manual completion", () => {
    const runtime = new BrewvaRuntime({
      cwd: createWorkspace("explicit-complete"),
      config: createConfig("auto"),
    });
    const sessionId = "skill-cascade-explicit-complete-1";

    const started = runtime.skills.startCascade(sessionId, {
      steps: [{ skill: "repository-analysis" }, { skill: "review" }],
    });
    expect(started.ok).toBe(true);
    expect(runtime.skills.getActive(sessionId)?.name).toBe("repository-analysis");

    expect(
      runtime.skills.complete(sessionId, buildSkillOutputs(runtime, "repository-analysis")).ok,
    ).toBe(true);
    const intent = runtime.skills.getCascadeIntent(sessionId);
    expect(intent?.cursor).toBe(1);
    expect(runtime.skills.getActive(sessionId)?.name).toBe("review");
  });
});
