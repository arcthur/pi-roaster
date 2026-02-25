import { describe, expect, test } from "bun:test";
import { assertLoopbackHost, isLoopbackHost, normalizeGatewayHost } from "@brewva/brewva-gateway";

describe("gateway network policy", () => {
  test("given loopback host values, when validating host, then loopback hosts are accepted", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
  });

  test("given non-loopback host values, when validating host, then host is rejected", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow();
  });

  test("given empty host input, when normalizing gateway host, then default loopback host is returned", () => {
    expect(normalizeGatewayHost(undefined)).toBe("127.0.0.1");
    expect(normalizeGatewayHost("  ")).toBe("127.0.0.1");
    expect(normalizeGatewayHost("localhost")).toBe("localhost");
  });
});
