import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GATEWAY_OPTION_BLOCKS = [
  "START_PARSE_OPTIONS",
  "STATUS_PARSE_OPTIONS",
  "STOP_PARSE_OPTIONS",
  "HEARTBEAT_PARSE_OPTIONS",
  "ROTATE_TOKEN_PARSE_OPTIONS",
  "LOGS_PARSE_OPTIONS",
] as const;

function extractOptionKeys(source: string, constName: string): string[] {
  const start = source.indexOf(`const ${constName} = {`);
  if (start < 0) return [];
  const end = source.indexOf("} as const;", start);
  if (end < 0) return [];
  const block = source.slice(start, end);
  const keys: string[] = [];

  for (const line of block.split("\n")) {
    const match = /^\s*(?:"([^"]+)"|([a-z][a-z-]*)):\s*\{/.exec(line);
    const key = match?.[1] ?? match?.[2];
    if (!key) continue;
    keys.push(key);
  }

  return keys;
}

describe("docs/reference gateway CLI coverage", () => {
  it("documents gateway subcommands and flags", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const cliSource = readFileSync(
      resolve(repoRoot, "packages/brewva-gateway/src/cli.ts"),
      "utf-8",
    );
    const docs = readFileSync(resolve(repoRoot, "docs/reference/commands.md"), "utf-8");

    const expectedCommands = [
      "start",
      "run",
      "status",
      "stop",
      "heartbeat-reload",
      "rotate-token",
      "logs",
    ];

    const missingCommands = expectedCommands.filter((name) => !docs.includes(`\`${name}\``));

    const flags = new Set<string>();
    for (const block of GATEWAY_OPTION_BLOCKS) {
      for (const key of extractOptionKeys(cliSource, block)) {
        flags.add(`--${key}`);
      }
    }
    const missingFlags = [...flags.values()].filter((flag) => !docs.includes(`\`${flag}\``));

    expect(
      missingCommands,
      `Missing gateway subcommands in docs/reference/commands.md: ${missingCommands.join(", ")}`,
    ).toEqual([]);
    expect(
      missingFlags,
      `Missing gateway flags in docs/reference/commands.md: ${missingFlags.join(", ")}`,
    ).toEqual([]);
  });
});
