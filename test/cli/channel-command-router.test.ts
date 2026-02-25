import { describe, expect, test } from "bun:test";
import { CommandRouter } from "@brewva/brewva-cli";

describe("channel command router", () => {
  const router = new CommandRouter();

  test("parses new-agent variants", () => {
    expect(router.match("/new-agent jack")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: undefined,
    });
    expect(router.match("/new-agent name=Jack model=openai/gpt-5.3-codex")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: "openai/gpt-5.3-codex",
    });
    expect(router.match("/new-agent name is mike")).toEqual({
      kind: "new-agent",
      agentId: "mike",
      model: undefined,
    });
    expect(router.match("/new-agent name is jack,")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: undefined,
    });
    expect(router.match("/new-agent name is jack model=openai/gpt-5.3-codex")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: "openai/gpt-5.3-codex",
    });
    expect(router.match("/new-agent name is jack, model=openai/gpt-5.3-codex")).toEqual({
      kind: "new-agent",
      agentId: "jack",
      model: "openai/gpt-5.3-codex",
    });
  });

  test("parses run and discuss targets", () => {
    expect(router.match("/run @jack,@mike review this")).toEqual({
      kind: "run",
      agentIds: ["jack", "mike"],
      task: "review this",
    });

    expect(router.match("/discuss @jack,@mike maxRounds=4 design tradeoff")).toEqual({
      kind: "discuss",
      agentIds: ["jack", "mike"],
      topic: "design tradeoff",
      maxRounds: 4,
    });
  });

  test("routes @agent mention", () => {
    expect(router.match("@jack fix this bug")).toEqual({
      kind: "route-agent",
      agentId: "jack",
      task: "fix this bug",
      viaMention: true,
    });
    expect(router.match("@jack, fix this bug")).toEqual({
      kind: "route-agent",
      agentId: "jack",
      task: "fix this bug",
      viaMention: true,
    });
  });

  test("returns syntax error for invalid command shapes", () => {
    expect(router.match("/run @jack")).toEqual({
      kind: "error",
      message: "Usage: /run @a,@b <task>",
    });
    expect(router.match("/focus")).toEqual({
      kind: "error",
      message: "Usage: /focus @agent",
    });
  });
});
