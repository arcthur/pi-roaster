import { describe, expect, test } from "bun:test";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  createTrustedLocalGovernancePort,
  type BrewvaConfig,
} from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.projection.enabled = false;
  config.infrastructure.toolFailureInjection.enabled = false;
  config.skills.cascade.mode = "off";
  config.skills.overrides.review = {
    dispatch: {
      suggestThreshold: 1,
      autoThreshold: 100,
    },
  };
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

function submitReviewSelection(runtime: BrewvaRuntime, sessionId: string, score = 10) {
  runtime.context.onTurnStart(sessionId, 1);
  return runtime.proposals.submit(sessionId, {
    id: `${sessionId}:selection`,
    kind: "skill_selection",
    issuer: "test.broker",
    subject: "review request",
    payload: {
      selected: [
        {
          name: "review",
          score,
          reason: "semantic:review request",
          breakdown: [{ signal: "semantic_match", term: "review", delta: score }],
        },
      ],
      routingOutcome: "selected",
    },
    evidenceRefs: [buildEvidenceRef(sessionId)],
    createdAt: Date.now(),
  });
}

describe("skill dispatch recommendation", () => {
  test("accepted proposals store a non-blocking suggestion when score is below auto threshold", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("skill-dispatch-suggest"),
      config: createConfig(),
      governancePort: createTrustedLocalGovernancePort(),
    });
    const sessionId = "skill-dispatch-suggest-1";
    const receipt = submitReviewSelection(runtime, sessionId, 10);

    expect(receipt.decision).toBe("accept");
    expect(runtime.skills.getPendingDispatch(sessionId)?.mode).toBe("suggest");
    expect(runtime.skills.getPendingDispatch(sessionId)?.primary?.name).toBe("review");

    const allowed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-allowed",
      toolName: "exec",
      args: { command: "echo allowed" },
    });
    expect(allowed.allowed).toBe(true);
  });

  test("strong selections are marked auto without introducing a separate gate state", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("skill-dispatch-auto"),
      config: createConfig(),
    });
    const sessionId = "skill-dispatch-auto-1";
    submitReviewSelection(runtime, sessionId, 120);

    expect(runtime.skills.getPendingDispatch(sessionId)?.mode).toBe("auto");
  });

  test("empty proposals do not fabricate a kernel recommendation", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("skill-dispatch-empty-selection"),
      config: createConfig(),
    });
    const sessionId = "skill-dispatch-empty-1";

    const receipt = runtime.proposals.submit(sessionId, {
      id: `${sessionId}:selection`,
      kind: "skill_selection",
      issuer: "test.broker",
      subject: "review architecture risks",
      payload: {
        selected: [],
        routingOutcome: "failed",
      },
      evidenceRefs: [buildEvidenceRef(sessionId)],
      createdAt: Date.now(),
    });
    expect(receipt.decision).toBe("defer");
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
  });

  test("loading the primary skill follows and clears the pending recommendation", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("skill-dispatch-follow"),
      config: createConfig(),
    });
    const sessionId = "skill-dispatch-follow-1";
    submitReviewSelection(runtime, sessionId, 10);

    expect(runtime.skills.activate(sessionId, "review").ok).toBe(true);
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
    expect(
      runtime.events.query(sessionId, { type: "skill_routing_followed", last: 1 }),
    ).toHaveLength(1);
  });

  test("loading a different skill records an override and clears the pending recommendation", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("skill-dispatch-override"),
      config: createConfig(),
    });
    const sessionId = "skill-dispatch-override-1";
    submitReviewSelection(runtime, sessionId, 10);

    expect(runtime.skills.activate(sessionId, "design").ok).toBe(true);
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
    expect(
      runtime.events.query(sessionId, { type: "skill_routing_overridden", last: 1 }),
    ).toHaveLength(1);
  });

  test("turn-end reconciliation emits ignored once and clears the pending recommendation", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("skill-dispatch-ignored"),
      config: createConfig(),
    });
    const sessionId = "skill-dispatch-ignored-1";
    submitReviewSelection(runtime, sessionId, 10);

    runtime.skills.reconcilePendingDispatch(sessionId, 1);
    expect(runtime.skills.getPendingDispatch(sessionId)).toBeUndefined();
    expect(
      runtime.events.query(sessionId, { type: "skill_routing_ignored", last: 1 }),
    ).toHaveLength(1);
  });
});
