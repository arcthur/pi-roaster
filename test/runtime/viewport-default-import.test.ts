import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { RoasterRuntime } from "@pi-roaster/roaster-runtime";
import type { TaskSpec } from "@pi-roaster/roaster-runtime";

function createWorkspace(name: string): string {
  return mkdtempSync(join(tmpdir(), `roaster-${name}-`));
}

describe("Viewport neighborhood probe", () => {
  test("includes export default line for default imports", () => {
    const workspace = createWorkspace("viewport-default-import");
    const runtime = new RoasterRuntime({ cwd: workspace });
    const sessionId = "viewport-default-1";

    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      join(workspace, "src/bar.ts"),
      ["export default function greet(name: string): string {", "  return `hi ${name}`;", "}"].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(workspace, "src/foo.ts"),
      ['import greet from "./bar";', "export function run(): string {", '  return greet("pi");', "}"].join("\n"),
      "utf8",
    );

    const spec: TaskSpec = {
      schema: "roaster.task.v1",
      goal: "Ensure viewport shows default export definition",
      targets: { files: ["src/foo.ts"] },
    };
    runtime.setTaskSpec(sessionId, spec);

    const injection = runtime.buildContextInjection(sessionId, "check default import");
    expect(injection.text.includes("[Viewport]")).toBe(true);
    expect(injection.text.includes("File: src/foo.ts")).toBe(true);
    expect(injection.text.includes("./bar default:")).toBe(true);
    expect(injection.text.includes("export default")).toBe(true);
  });
});

