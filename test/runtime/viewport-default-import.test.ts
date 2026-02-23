import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { TaskSpec } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  return mkdtempSync(join(tmpdir(), `brewva-${name}-`));
}

describe("Viewport neighborhood probe", () => {
  test("does not inject viewport blocks on default profile", async () => {
    const workspace = createWorkspace("viewport-default-import");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "viewport-default-1";

    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      join(workspace, "src/bar.ts"),
      ["export default function greet(name: string): string {", "  return `hi ${name}`;", "}"].join(
        "\n",
      ),
      "utf8",
    );
    writeFileSync(
      join(workspace, "src/foo.ts"),
      [
        'import greet from "./bar";',
        "export function run(): string {",
        '  return greet("pi");',
        "}",
      ].join("\n"),
      "utf8",
    );

    const spec: TaskSpec = {
      schema: "brewva.task.v1",
      goal: "Ensure viewport shows default export definition",
      targets: { files: ["src/foo.ts"] },
    };
    runtime.task.setSpec(sessionId, spec);

    const injection = await runtime.context.buildInjection(sessionId, "check default import");
    expect(injection.text.includes("[Viewport]")).toBe(false);
    expect(injection.text.includes("[TaskLedger]")).toBe(true);
    expect(injection.text.includes("src/foo.ts")).toBe(true);

    const viewportEvents = runtime.events.query(sessionId, { type: "viewport_built" });
    expect(viewportEvents.length).toBe(0);
  });
});
