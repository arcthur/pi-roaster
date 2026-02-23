import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { TaskSpec } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  return mkdtempSync(join(tmpdir(), `brewva-${name}-`));
}

describe("Viewport LoopPolicy (SNR-driven)", () => {
  test("does not inject viewport policy blocks on default profile", async () => {
    const workspace = createWorkspace("viewport-policy-skip");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "viewport-policy-skip-1";

    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      join(workspace, "src/irrelevant.ts"),
      [
        "export const value = 1;",
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const spec: TaskSpec = {
      schema: "brewva.task.v1",
      goal: "Fix failing runtime tests",
      targets: { files: ["src/irrelevant.ts"] },
    };
    runtime.task.setSpec(sessionId, spec);

    const injection = await runtime.context.buildInjection(sessionId, "run");
    expect(injection.text.includes("[ViewportPolicy]")).toBe(false);
    expect(injection.text.includes("[Viewport]")).toBe(false);

    const viewport = runtime.events.query(sessionId, { type: "viewport_built" });
    expect(viewport.length).toBe(0);

    const policy = runtime.events.query(sessionId, {
      type: "viewport_policy_evaluated",
    });
    expect(policy.length).toBe(0);
  });

  test("keeps task-state injection without neighborhood probe details", async () => {
    const workspace = createWorkspace("viewport-policy-no-neighborhood");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "viewport-policy-no-neighborhood-1";

    mkdirSync(join(workspace, "src"), { recursive: true });

    const writeModule = (name: string, symbols: string[]): void => {
      writeFileSync(
        join(workspace, `src/${name}.ts`),
        symbols.map((symbol) => `export const ${symbol} = "${symbol.toLowerCase()}";`).join("\n"),
        "utf8",
      );
    };

    writeModule("m1", ["A1", "A2", "A3", "A4", "A5", "A6"]);
    writeModule("m2", ["B1", "B2", "B3", "B4", "B5", "B6"]);
    writeModule("m3", ["C1", "C2", "C3", "C4", "C5", "C6"]);
    writeModule("m4", ["D1", "D2", "D3", "D4", "D5", "D6"]);

    writeFileSync(
      join(workspace, "src/foo.ts"),
      [
        'import { A1, A2, A3, A4, A5, A6 } from "./m1";',
        'import { B1, B2, B3, B4, B5, B6 } from "./m2";',
        'import { C1, C2, C3, C4, C5, C6 } from "./m3";',
        'import { D1, D2, D3, D4, D5, D6 } from "./m4";',
        "",
        "export function foo(): string {",
        "  return `${A1}${B1}${C1}${D1}`;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const spec: TaskSpec = {
      schema: "brewva.task.v1",
      goal: "Fix foo wiring",
      targets: { files: ["src/foo.ts"] },
    };
    runtime.task.setSpec(sessionId, spec);

    const injection = await runtime.context.buildInjection(sessionId, "run");
    expect(injection.text.includes("[Viewport]")).toBe(false);
    expect(injection.text.includes("[TaskLedger]")).toBe(true);
    expect(injection.text.includes("neighborhood:")).toBe(false);

    const viewport = runtime.events.query(sessionId, { type: "viewport_built" });
    expect(viewport.length).toBe(0);
  });
});
