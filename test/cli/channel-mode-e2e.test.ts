import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TELEGRAM_SKILL_NAME,
  runChannelMode,
  type ChannelModeLauncher,
  type RunChannelModeDependencies,
} from "@brewva/brewva-gateway";
import type { ChannelTurnBridge, TurnEnvelope } from "@brewva/brewva-runtime/channels";

function createWorkspace(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-channel-e2e-${prefix}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function writeChannelConfig(workspace: string): string {
  const configPath = join(workspace, ".brewva", "brewva.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        channels: {
          orchestration: {
            enabled: false,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return configPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for channel mode dispatch to complete");
}

function createInboundTurn(): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "telegram-session",
    turnId: "turn-e2e-1",
    channel: "telegram",
    conversationId: "12345",
    timestamp: Date.now(),
    parts: [{ type: "text", text: "hello from channel e2e" }],
  };
}

describe("channel mode e2e-ish dispatch", () => {
  test("telegram inbound turns include the unified telegram skill policy", async () => {
    const workspace = createWorkspace("dispatch");
    const configPath = writeChannelConfig(workspace);
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const capturedPrompts: string[] = [];
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          await input.onInboundTurn(createInboundTurn());
          await waitUntil(() => outboundTurns.length > 0, 3000);
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      collectPromptTurnOutputs: async (_session, prompt) => {
        capturedPrompts.push(prompt);
        return {
          assistantText: "ACK_FROM_FAKE_PROMPT_EXECUTOR",
          toolOutputs: [],
        };
      },
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        enableExtensions: false,
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }

    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toContain("[Brewva Channel Skill Policy]");
    expect(prompt).toContain(`Primary channel skill: ${DEFAULT_TELEGRAM_SKILL_NAME}`);
    expect(prompt).toContain("[channel:telegram] conversation:12345");
    expect(prompt).toContain("hello from channel e2e");
    expect(outboundTurns[0]?.parts).toEqual([
      { type: "text", text: "ACK_FROM_FAKE_PROMPT_EXECUTOR" },
    ]);
  });
});
