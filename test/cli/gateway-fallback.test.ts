import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  resolveBackendWorkingCwd,
  resolveGatewayFailureStage,
  shouldFallbackAfterGatewayFailure,
} from "@brewva/brewva-cli";

describe("gateway fallback boundary", () => {
  test("given auto backend and pre-ack failure, when evaluating fallback, then fallback is allowed", () => {
    expect(shouldFallbackAfterGatewayFailure("auto", "pre-ack")).toBe(true);
  });

  test("given auto backend and post-ack failure, when evaluating fallback, then fallback is denied", () => {
    expect(shouldFallbackAfterGatewayFailure("auto", "post-ack")).toBe(false);
  });

  test("given send requested before failure, when resolving failure stage, then stage is post-ack", () => {
    expect(
      resolveGatewayFailureStage({
        sendRequested: true,
        ackReceived: false,
      }),
    ).toBe("post-ack");
  });

  test("given no send requested before failure, when resolving failure stage, then stage is pre-ack", () => {
    expect(
      resolveGatewayFailureStage({
        sendRequested: false,
        ackReceived: false,
      }),
    ).toBe("pre-ack");
  });

  test("given explicit backend cwd, when resolving backend cwd, then path is normalized to absolute", () => {
    expect(resolveBackendWorkingCwd("./test")).toBe(resolve("./test"));
  });

  test("given backend cwd unset, when resolving backend cwd, then process cwd is used", () => {
    expect(resolveBackendWorkingCwd()).toBe(process.cwd());
  });
});
