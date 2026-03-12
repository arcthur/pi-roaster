import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runCommand } from "./utils/exec.js";
import { failTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

function buildAstGrepUnavailableResult(
  action: "search" | "replace",
  error: unknown,
): ReturnType<typeof textResult> {
  const reason = error instanceof Error ? error.message : String(error);
  return failTextResult(
    [
      `ast_grep_${action} unavailable: ast-grep (sg) is required for semantic ${action}.`,
      `reason=${reason}`,
      "next_step=Install ast-grep (sg) and retry the command.",
    ].join("\n"),
    {
      status: "unavailable",
      reason: "ast_grep_unavailable",
      nextStep: "Install ast-grep (sg) and retry the command.",
      action,
      error: reason,
    },
  );
}

export function createAstGrepTools(): ToolDefinition[] {
  const astGrepSearch = defineBrewvaTool({
    name: "ast_grep_search",
    label: "AST Grep Search",
    description: "Search code patterns via ast-grep semantic matching.",
    parameters: Type.Object({
      pattern: Type.String(),
      lang: Type.String(),
      paths: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const sg = await runCommand(
          "sg",
          ["scan", "-p", params.pattern, "--lang", params.lang, ...(params.paths ?? ["."])],
          {
            cwd: ctx.cwd,
            timeoutMs: 120000,
          },
        );

        const combined = `${sg.stdout}\n${sg.stderr}`.trim();
        return textResult(combined.length > 0 ? combined : "No matches found");
      } catch (error) {
        return buildAstGrepUnavailableResult("search", error);
      }
    },
  });

  const astGrepReplace = defineBrewvaTool({
    name: "ast_grep_replace",
    label: "AST Grep Replace",
    description: "Replace code patterns via ast-grep semantic matching.",
    parameters: Type.Object({
      pattern: Type.String(),
      rewrite: Type.String(),
      lang: Type.String(),
      paths: Type.Optional(Type.Array(Type.String())),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const dryRun = params.dryRun !== false;
      try {
        const args = [
          "scan",
          "-p",
          params.pattern,
          "--rewrite",
          params.rewrite,
          "--lang",
          params.lang,
          ...(dryRun ? [] : ["--update-all"]),
          ...(params.paths ?? ["."]),
        ];
        const sg = await runCommand("sg", args, {
          cwd: ctx.cwd,
          timeoutMs: 120000,
        });
        const combined = `${sg.stdout}\n${sg.stderr}`.trim();
        return textResult(combined.length > 0 ? combined : "No matches found");
      } catch (error) {
        return buildAstGrepUnavailableResult("replace", error);
      }
    },
  });

  return [astGrepSearch, astGrepReplace];
}
