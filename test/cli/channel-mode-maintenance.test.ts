import { describe, expect, test } from "bun:test";
import { createSerializedAsyncTaskRunner } from "../../packages/brewva-gateway/src/channels/host.js";

describe("channel mode maintenance runner", () => {
  test("skips overlapping ticks and allows the next tick after completion", async () => {
    let starts = 0;
    let completions = 0;
    let releaseFirstRun: () => void = () => {};
    let firstRunBlocked = false;

    const runner = createSerializedAsyncTaskRunner(async () => {
      starts += 1;
      if (starts === 1) {
        await new Promise<void>((resolve) => {
          firstRunBlocked = true;
          releaseFirstRun = resolve;
        });
      }
      completions += 1;
    });

    const firstRun = runner.run();
    const secondRun = runner.run();

    expect(starts).toBe(1);
    expect(await secondRun).toBe(false);

    expect(firstRunBlocked).toBe(true);
    releaseFirstRun();
    expect(await firstRun).toBe(true);
    expect(completions).toBe(1);

    expect(await runner.run()).toBe(true);
    expect(starts).toBe(2);
    expect(completions).toBe(2);
    await runner.whenIdle();
  });

  test("releases the latch after a failure", async () => {
    let attempts = 0;
    const runner = createSerializedAsyncTaskRunner(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("maintenance failed");
      }
    });

    try {
      await runner.run();
      expect.unreachable("expected the first maintenance run to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("maintenance failed");
    }
    expect(await runner.run()).toBe(true);
    expect(attempts).toBe(2);
  });
});
