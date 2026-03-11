import { describe, expect, test } from "bun:test";
import { buildChannelSkillPolicyBlock, DEFAULT_TELEGRAM_SKILL_NAME } from "@brewva/brewva-gateway";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";

function createTurn(channel: string): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "session-1",
    turnId: "turn-1",
    channel,
    conversationId: "conv-1",
    timestamp: 1_700_000_000_000,
    parts: [{ type: "text", text: "hello" }],
  };
}

describe("channel skill policy block", () => {
  test("returns empty policy for non-telegram channels", () => {
    const block = buildChannelSkillPolicyBlock(createTurn("cli"));
    expect(block).toBe("");
  });

  test("renders telegram policy with the unified telegram skill", () => {
    const block = buildChannelSkillPolicyBlock(createTurn("telegram"));
    expect(block).toContain("Channel: telegram");
    expect(block).toContain(`Primary channel skill: ${DEFAULT_TELEGRAM_SKILL_NAME}`);
    expect(block).toContain(`call tool 'skill_load' with name='${DEFAULT_TELEGRAM_SKILL_NAME}'`);
  });

  test("falls back to plain-text policy when telegram skill is unavailable", () => {
    const block = buildChannelSkillPolicyBlock(createTurn("telegram"), {
      skillName: DEFAULT_TELEGRAM_SKILL_NAME,
      hasSkill: false,
      missingSkillNames: [DEFAULT_TELEGRAM_SKILL_NAME],
    });

    expect(block).not.toContain(
      `call tool 'skill_load' with name='${DEFAULT_TELEGRAM_SKILL_NAME}'`,
    );
    expect(block).toContain("Fallback to plain-text response policy for this turn.");
  });
});
