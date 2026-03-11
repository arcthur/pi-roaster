import { describe, expect, test } from "bun:test";
import {
  resolveToolDisplayStatus,
  resolveToolDisplayText,
  resolveToolDisplayVerdict,
} from "@brewva/brewva-gateway/runtime-plugins";

describe("tool output display", () => {
  test("prefers explicit fail verdict over channel success", () => {
    const result = {
      content: [
        {
          type: "text",
          text: Array.from({ length: 140 }, (_value, index) =>
            index % 20 === 0 ? `error: failure ${index}` : `trace ${index}`,
          ).join("\n"),
        },
      ],
      details: {
        verdict: "fail",
      },
    };

    expect(resolveToolDisplayVerdict({ isError: false, result })).toBe("fail");
    expect(resolveToolDisplayStatus({ isError: false, result })).toBe("failed");
    expect(
      resolveToolDisplayText({
        toolName: "exec",
        isError: false,
        result,
      }).includes("status: failed"),
    ).toBe(true);
  });
});
