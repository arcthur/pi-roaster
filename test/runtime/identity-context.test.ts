import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

function writeIdentity(workspace: string, agentId: string, content: string): string {
  const path = join(workspace, ".brewva", "agents", agentId, "identity.md");
  mkdirSync(join(workspace, ".brewva", "agents", agentId), { recursive: true });
  writeFileSync(path, `${content.trim()}\n`, "utf8");
  return path;
}

describe("Identity context injection", () => {
  test("injects existing identity file for current agent", async () => {
    const workspace = createWorkspace("identity-existing");
    writeIdentity(
      workspace,
      "code-reviewer",
      [
        "## Who I Am",
        "Senior code reviewer focused on correctness and safety.",
        "",
        "## How I Work",
        "- Read code before judging.",
        "- Prefer evidence over intuition.",
        "",
        "## What I Care About",
        "- no_direct_code_changes",
      ].join("\n"),
    );
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      agentId: "Code Reviewer",
    });

    const injection = await runtime.context.buildInjection("identity-existing-1", "review");
    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[PersonaProfile]")).toBe(true);
    expect(injection.text.includes("[WhoIAm]")).toBe(true);
    expect(injection.text.includes("[HowIWork]")).toBe(true);
    expect(injection.text.includes("[WhatICareAbout]")).toBe(true);
    expect(injection.text.includes("agent_id: code-reviewer")).toBe(true);
    expect(injection.text.includes("Senior code reviewer focused on correctness and safety.")).toBe(
      true,
    );
    expect(injection.text.includes("no_direct_code_changes")).toBe(true);
  });

  test("does not inject identity when file is missing", async () => {
    const workspace = createWorkspace("identity-missing");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      agentId: "missing-agent",
    });

    const injection = await runtime.context.buildInjection("identity-missing-1", "continue");
    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[PersonaProfile]")).toBe(false);

    const path = join(workspace, ".brewva", "agents", "missing-agent", "identity.md");
    expect(existsSync(path)).toBe(false);
  });

  test("resolves per-agent file and applies oncePerSession semantics", async () => {
    const workspace = createWorkspace("identity-agent-scope");
    writeIdentity(workspace, "reviewer-a", ["## Who I Am", "Reviewer A"].join("\n"));
    writeIdentity(workspace, "reviewer-b", ["## Who I Am", "Reviewer B"].join("\n"));

    const runtimeA = new BrewvaRuntime({
      cwd: workspace,
      agentId: "reviewer-a",
    });
    const first = await runtimeA.context.buildInjection(
      "identity-agent-scope-1",
      "continue",
      undefined,
      "leaf-a",
    );
    expect(first.text.includes("Reviewer A")).toBe(true);
    expect(first.text.includes("Reviewer B")).toBe(false);

    const second = await runtimeA.context.buildInjection(
      "identity-agent-scope-1",
      "continue",
      undefined,
      "leaf-b",
    );
    expect(second.accepted).toBe(true);
    expect(second.text.includes("[PersonaProfile]")).toBe(false);

    runtimeA.context.markCompacted("identity-agent-scope-1", { fromTokens: 1000, toTokens: 300 });
    const third = await runtimeA.context.buildInjection(
      "identity-agent-scope-1",
      "continue",
      undefined,
      "leaf-c",
    );
    expect(third.accepted).toBe(true);
    expect(third.text.includes("Reviewer A")).toBe(true);

    const runtimeB = new BrewvaRuntime({
      cwd: workspace,
      agentId: "reviewer-b",
    });
    const b = await runtimeB.context.buildInjection("identity-agent-scope-2", "continue");
    expect(b.accepted).toBe(true);
    expect(b.text.includes("Reviewer B")).toBe(true);
    expect(b.text.includes("Reviewer A")).toBe(false);
  });

  test("does not inject identity without persona headings", async () => {
    const workspace = createWorkspace("identity-no-headings");
    writeIdentity(workspace, "reviewer-a", "role: Reviewer A");

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      agentId: "reviewer-a",
    });

    const injection = await runtime.context.buildInjection("identity-no-headings-1", "continue");
    expect(injection.accepted).toBe(true);
    expect(injection.text.includes("[PersonaProfile]")).toBe(false);
  });
});
