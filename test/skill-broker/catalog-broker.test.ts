import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillDocument } from "@brewva/brewva-runtime";
import { CatalogSkillBroker, type SkillBrokerJudge } from "@brewva/brewva-skill-broker";
import { createTestWorkspace } from "../helpers/workspace.js";

function writeCatalog(
  workspace: string,
  input: {
    skills: Array<{
      name: string;
      description: string;
      outputs?: string[];
      consumes?: string[];
      requires?: string[];
      preferredTools?: string[];
      fallbackTools?: string[];
    }>;
  },
): string {
  const brewvaDir = join(workspace, ".brewva");
  mkdirSync(brewvaDir, { recursive: true });
  const filePath = join(brewvaDir, "skills_index.json");
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        generatedAt: "2026-03-06T00:00:00.000Z",
        skills: input.skills.map((entry) => ({
          name: entry.name,
          category: "domain",
          description: entry.description,
          outputs: entry.outputs ?? [],
          preferredTools: entry.preferredTools ?? ["read"],
          fallbackTools: entry.fallbackTools ?? [],
          allowedEffects: ["workspace_read"],
          costHint: "medium",
          stability: "stable",
          composableWith: [],
          consumes: entry.consumes ?? [],
          requires: entry.requires ?? [],
          effectLevel: "read_only",
          routingScope: "domain",
          dispatch: {
            suggestThreshold: 10,
            autoThreshold: 16,
          },
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

describe("catalog skill broker", () => {
  test("reranks shortlist with skill previews before selecting", async () => {
    const workspace = createTestWorkspace("skill-broker-preview");
    writeCatalog(workspace, {
      skills: [
        {
          name: "generic-reviewer",
          description: "General workflow for merge safety and quality work.",
        },
        {
          name: "generic-planner",
          description: "General workflow for merge safety and quality work.",
        },
      ],
    });

    const documents: SkillDocument[] = [
      {
        name: "generic-reviewer",
        description: "General workflow for merge safety and quality work.",
        category: "domain",
        filePath: "/tmp/generic-reviewer/SKILL.md",
        baseDir: "/tmp/generic-reviewer",
        markdown: [
          "# Generic Reviewer",
          "",
          "## Intent",
          "",
          "Assess merge risk and quality audits.",
          "",
          "## Trigger",
          "",
          "- review merge safety",
          "- quality audit requests",
        ].join("\n"),
        contract: {
          name: "generic-reviewer",
          category: "domain",
          effects: { allowedEffects: ["workspace_read"] },
          resources: { defaultLease: { maxToolCalls: 10, maxTokens: 1000 } },
          executionHints: { preferredTools: ["read"], fallbackTools: [] },
        },
        resources: { references: [], scripts: [], heuristics: [], invariants: [] },
        sharedContextFiles: [],
        overlayFiles: [],
      },
      {
        name: "generic-planner",
        description: "General workflow for merge safety and quality work.",
        category: "domain",
        filePath: "/tmp/generic-planner/SKILL.md",
        baseDir: "/tmp/generic-planner",
        markdown: [
          "# Generic Planner",
          "",
          "## Intent",
          "",
          "Plan ambiguous multi-step work.",
          "",
          "## Trigger",
          "",
          "- ambiguous multi-step tasks",
          "- architecture planning",
        ].join("\n"),
        contract: {
          name: "generic-planner",
          category: "domain",
          effects: { allowedEffects: ["workspace_read"] },
          resources: { defaultLease: { maxToolCalls: 10, maxTokens: 1000 } },
          executionHints: { preferredTools: ["read"], fallbackTools: [] },
        },
        resources: { references: [], scripts: [], heuristics: [], invariants: [] },
        sharedContextFiles: [],
        overlayFiles: [],
      },
    ];

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace, documents, judge: null });
    const decision = await broker.select({
      sessionId: "preview-rerank",
      prompt: "run a quality audit and review merge safety before ship",
    });

    expect(decision.routingOutcome).toBe("selected");
    expect(decision.selected[0]?.name).toBe("generic-reviewer");
    expect(decision.trace.shortlisted[0]?.previewScore).toBeGreaterThan(0);
  });

  test("rejects generic skill token collisions such as skill-authoring", async () => {
    const workspace = createTestWorkspace("skill-broker-generic");
    writeCatalog(workspace, {
      skills: [
        {
          name: "skill-authoring",
          description: "Create or update reusable skills for the agent.",
          outputs: ["skill_contract", "skill_spec"],
        },
        {
          name: "design",
          description: "Shape a design spec and execution plan for multi-step engineering work.",
          outputs: ["execution_plan"],
        },
      ],
    });

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace, judge: null });
    const decision = await broker.select({
      sessionId: "generic-collision",
      prompt: "看下现在项目的skill 触发机制是否合理",
    });

    expect(decision.routingOutcome).toBe("empty");
    expect(decision.selected).toEqual([]);
    expect(decision.trace.reason).toBe("catalog_broker_empty");
  });

  test("rejects description-only matches without a strong routing signal", async () => {
    const workspace = createTestWorkspace("skill-broker-description-only");
    writeCatalog(workspace, {
      skills: [
        {
          name: "generic-helper",
          description: "Analyze project mechanism problems and issue summaries.",
        },
        {
          name: "design",
          description: "Shape a design spec and execution plan for multi-step engineering work.",
          outputs: ["execution_plan"],
        },
      ],
    });

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace, judge: null });
    const decision = await broker.select({
      sessionId: "description-only",
      prompt: "analyze project mechanism problem",
    });

    expect(decision.routingOutcome).toBe("empty");
    expect(decision.selected).toEqual([]);
    expect(decision.trace.reason).toBe("catalog_broker_empty");
  });

  test("selects review when prompt contains specific review signals", async () => {
    const workspace = createTestWorkspace("skill-broker-review");
    writeCatalog(workspace, {
      skills: [
        {
          name: "review",
          description: "Review architecture risks, merge safety, and quality audit gaps.",
          outputs: ["findings", "review_decision"],
        },
        {
          name: "design",
          description: "Shape a design spec and execution plan for multi-step engineering work.",
          outputs: ["execution_plan"],
        },
      ],
    });

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace, judge: null });
    const decision = await broker.select({
      sessionId: "review-route",
      prompt: "Review architecture risks, merge safety, and quality audit gaps",
    });

    expect(decision.routingOutcome).toBe("selected");
    expect(decision.selected[0]?.name).toBe("review");
    expect(decision.trace.reason).toBe("catalog_broker_selected");
  });

  test("uses judge full-catalog fallback when lexical shortlist is empty", async () => {
    const workspace = createTestWorkspace("skill-broker-judge-full-catalog");
    writeCatalog(workspace, {
      skills: [
        {
          name: "review",
          description: "Read-only merge safety and quality review workflow.",
          outputs: ["findings", "review_decision"],
        },
        {
          name: "design",
          description: "Shape a design spec and execution plan for engineering work.",
          outputs: ["execution_plan"],
        },
      ],
    });

    const judge: SkillBrokerJudge = {
      async judge(input) {
        expect(input.candidates.map((entry) => entry.name)).toEqual(["review", "design"]);
        return {
          strategy: "mock_judge",
          status: "selected",
          selectedName: "review",
          confidence: "high",
          reason: "semantic multilingual match",
        };
      },
    };

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace, judge });
    const decision = await broker.select({
      sessionId: "review-route-zh",
      prompt: "帮我审查一下这个重构有没有合并风险",
    });

    expect(decision.routingOutcome).toBe("selected");
    expect(decision.selected[0]?.name).toBe("review");
    expect((decision.selected[0]?.score ?? 0) >= 18).toBe(true);
    expect(decision.trace.reason).toBe("catalog_broker_judge_selected_full_catalog");
  });

  test("does not fall back to heuristic when llm judge is skipped", async () => {
    const workspace = createTestWorkspace("skill-broker-no-fallback");
    writeCatalog(workspace, {
      skills: [
        {
          name: "review",
          description: "Review architecture risks, merge safety, and quality audit gaps.",
          outputs: ["findings", "review_decision"],
        },
      ],
    });

    const judge: SkillBrokerJudge = {
      async judge() {
        return {
          strategy: "mock_judge",
          status: "skipped",
          reason: "no_model",
        };
      },
    };

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace, judge });
    const decision = await broker.select({
      sessionId: "no-fallback-session",
      prompt: "Review architecture risks, merge safety, and quality audit gaps",
    });

    expect(decision.routingOutcome).toBe("failed");
    expect(decision.selected).toEqual([]);
    expect(decision.trace.reason).toBe("catalog_broker_judge_skipped:no_model");
  });

  test("writes broker trace under project .brewva", async () => {
    const workspace = createTestWorkspace("skill-broker-trace");
    writeCatalog(workspace, {
      skills: [
        {
          name: "review",
          description: "Review architecture risks and merge safety.",
          outputs: ["findings"],
        },
      ],
    });

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace, judge: null });
    const decision = await broker.select({
      sessionId: "trace-session",
      prompt: "review merge safety",
    });

    const traceDir = join(workspace, ".brewva", "skill-broker", "trace-session");
    expect(existsSync(traceDir)).toBe(true);
    expect(decision.trace.selected[0]?.name).toBe("review");

    const traceFiles = readdirSync(traceDir).filter((entry) => entry.endsWith(".json"));
    expect(traceFiles.length).toBe(1);
    const trace = JSON.parse(readFileSync(join(traceDir, traceFiles[0]!), "utf8")) as {
      routingOutcome?: string;
    };
    expect(trace.routingOutcome).toBe("selected");
  });

  test("allows judge veto to override heuristic selection", async () => {
    const workspace = createTestWorkspace("skill-broker-judge-veto");
    writeCatalog(workspace, {
      skills: [
        {
          name: "review",
          description: "Review architecture risks and merge safety.",
          outputs: ["findings"],
        },
        {
          name: "design",
          description: "Shape a design spec and execution plan for multi-step engineering work.",
          outputs: ["execution_plan"],
        },
      ],
    });

    const judge: SkillBrokerJudge = {
      async judge() {
        return {
          strategy: "test-judge",
          status: "rejected",
          reason: "Prompt is discussing routing design, not requesting a skill workflow.",
          confidence: "high",
        };
      },
    };

    const broker = new CatalogSkillBroker({ workspaceRoot: workspace, judge });
    const decision = await broker.select({
      sessionId: "judge-veto",
      prompt: "看下现在项目的 review skill 触发机制是否合理",
    });

    expect(decision.routingOutcome).toBe("empty");
    expect(decision.selected).toEqual([]);
    expect(decision.trace.reason).toBe("catalog_broker_judge_rejected");
    expect(decision.trace.judge?.strategy).toBe("test-judge");
  });
});
