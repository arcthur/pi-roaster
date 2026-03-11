import { describe, expect, test } from "bun:test";
import { writeCognitionArtifact } from "@brewva/brewva-deliberation";
import { planHeartbeatWake } from "@brewva/brewva-gateway/runtime-plugins";
import { createTestWorkspace } from "../helpers/workspace.js";

describe("proactivity engine", () => {
  test("skips if_signal wake-ups when only a foreign session signal exists", async () => {
    const workspace = createTestWorkspace("proactivity-engine-foreign-signal");

    await writeCognitionArtifact({
      workspaceRoot: workspace,
      lane: "summaries",
      name: "foreign-open-loop",
      content: [
        "[StatusSummary]",
        "profile: status_summary",
        "summary_kind: session_summary",
        "status: blocked",
        "session_scope: foreign-session",
        "goal: foreign rollout",
        "next_action: inspect foreign blocker",
      ].join("\n"),
      createdAt: 1_731_000_000_900,
    });

    const plan = await planHeartbeatWake({
      workspaceRoot: workspace,
      sessionId: "target-session",
      rule: {
        id: "nightly-target",
        prompt: "Check project status.",
        wakeMode: "if_signal",
      },
      now: 1_731_000_001_000,
    });

    expect(plan.decision).toBe("skip");
    expect(plan.reason).toBe("no_relevant_signal");
  });

  test("uses same-session open-loop signals to wake continuation work", async () => {
    const workspace = createTestWorkspace("proactivity-engine-same-session");

    await writeCognitionArtifact({
      workspaceRoot: workspace,
      lane: "summaries",
      name: "target-open-loop",
      content: [
        "[StatusSummary]",
        "profile: status_summary",
        "summary_kind: session_summary",
        "status: blocked",
        "session_scope: target-session",
        "goal: target rollout",
        "next_action: inspect target blocker",
      ].join("\n"),
      createdAt: 1_731_000_001_100,
    });

    const plan = await planHeartbeatWake({
      workspaceRoot: workspace,
      sessionId: "target-session",
      rule: {
        id: "nightly-target",
        prompt: "Check project status.",
        wakeMode: "if_signal",
      },
      now: 1_731_000_001_200,
    });

    expect(plan.decision).toBe("wake");
    expect(plan.reason).toBe("open_loop_signal");
    expect(plan.signalArtifactRefs).toHaveLength(1);
  });
});
