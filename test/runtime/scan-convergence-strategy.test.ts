import { describe, expect, test } from "bun:test";
import { SCAN_CONVERGENCE_TOOL_RULES_BY_NAME } from "@brewva/brewva-runtime";
import { MANAGED_BREWVA_TOOL_NAMES } from "@brewva/brewva-tools";

describe("scan convergence strategy registry", () => {
  test("every managed brewva tool has an explicit scan convergence rule", () => {
    const missing = MANAGED_BREWVA_TOOL_NAMES.filter(
      (toolName) => !Object.hasOwn(SCAN_CONVERGENCE_TOOL_RULES_BY_NAME, toolName),
    );

    expect(missing).toEqual([]);
  });
});
