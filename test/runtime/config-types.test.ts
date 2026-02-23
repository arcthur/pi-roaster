import { describe, expect, test } from "bun:test";
import type { BrewvaConfigFile } from "@brewva/brewva-runtime";

describe("BrewvaConfigFile typing", () => {
  test("supports deep-partial memory overlays", () => {
    const config: BrewvaConfigFile = {
      memory: {
        cognitive: {
          mode: "active",
        },
        retrievalWeights: {
          lexical: 0.7,
        },
        global: {
          enabled: true,
        },
      },
      infrastructure: {
        toolFailureInjection: {
          enabled: false,
          maxEntries: 5,
        },
      },
    };

    expect(config.memory?.cognitive?.mode).toBe("active");
    expect(config.memory?.global?.enabled).toBe(true);
    expect(config.infrastructure?.toolFailureInjection?.enabled).toBe(false);
  });
});
