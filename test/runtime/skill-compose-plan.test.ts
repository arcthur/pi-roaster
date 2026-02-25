import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

describe("compose plan validation", () => {
  test("given valid skill dependency chain, when validating compose plan, then result is valid", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const validPlan = {
      steps: [
        { skill: "exploration", produces: ["tree_summary"] },
        { skill: "planning", consumes: ["tree_summary"], produces: ["execution_steps"] },
        {
          skill: "patching",
          consumes: ["execution_steps"],
          produces: ["fix_description", "verification"],
        },
      ],
    };

    const result = runtime.skills.validateComposePlan(validPlan);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("given unknown skill name, when validating compose plan, then result reports error", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const invalidPlan = {
      steps: [{ skill: "nonexistent_skill", produces: ["foo"] }],
    };

    const result = runtime.skills.validateComposePlan(invalidPlan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent_skill"))).toBe(true);
  });

  test("given consumed output without producer step, when validating compose plan, then warning is emitted", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const plan = {
      steps: [{ skill: "patching", consumes: ["execution_steps"], produces: ["fix_description"] }],
    };

    const result = runtime.skills.validateComposePlan(plan);
    expect(result.warnings.some((w) => w.includes("execution_steps"))).toBe(true);
  });

  test("given produced outputs are consumed in order, when validating compose plan, then warnings are empty", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });

    const plan = {
      steps: [
        { skill: "exploration", produces: ["execution_steps"] },
        { skill: "patching", consumes: ["execution_steps"], produces: ["fix_description"] },
      ],
    };

    const result = runtime.skills.validateComposePlan(plan);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
