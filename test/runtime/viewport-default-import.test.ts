import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { TaskSpec } from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  return mkdtempSync(join(tmpdir(), `brewva-${name}-`));
}

describe("Viewport neighborhood probe", () => {
  test("includes export default line for default imports", () => {
    const workspace = createWorkspace("viewport-default-import");
    const runtime = new BrewvaRuntime({ cwd: workspace });
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
      schema: "brewva.task.v1",
      goal: "Ensure viewport shows default export definition",
      targets: { files: ["src/foo.ts"] },
    };
    runtime.setTaskSpec(sessionId, spec);

    const injection = runtime.buildContextInjection(sessionId, "check default import");
    expect(injection.text.includes("[Viewport]")).toBe(true);
    expect(injection.text.includes("File: src/foo.ts")).toBe(true);
    expect(injection.text.includes("./bar default:")).toBe(true);
    expect(injection.text.includes("export default")).toBe(true);

    const viewportEvents = runtime.queryEvents(sessionId, { type: "viewport_built" });
    expect(viewportEvents.length).toBe(1);
    const payload = viewportEvents[0]?.payload ?? {};
    expect(payload.totalChars).not.toBeNull();
    expect(payload.snr).not.toBeNull();
    expect(payload.truncated).toBe(false);
  });
});
