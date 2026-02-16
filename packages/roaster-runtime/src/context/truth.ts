import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function findSectionLines(lines: string[], headerPattern: RegExp): { start: number; end: number } | null {
  const startIndex = lines.findIndex((line) => headerPattern.test(line.trim()));
  if (startIndex < 0) return null;

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (/^##\s+\S+/.test(line)) {
      return { start: startIndex + 1, end: i };
    }
  }

  return { start: startIndex + 1, end: lines.length };
}

function trimToCharBudget(lines: string[], maxChars: number): string[] {
  const budget = Math.max(0, Math.floor(maxChars));
  if (budget <= 0) return [];

  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (out.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  return out;
}

export function buildTruthLedgerBlock(input: {
  cwd: string;
  maxChars?: number;
}): string {
  const agentsPath = resolve(input.cwd, "AGENTS.md");
  if (!existsSync(agentsPath)) return "";

  let text = "";
  try {
    text = readFileSync(agentsPath, "utf8");
  } catch {
    return "";
  }

  const lines = text.split(/\r?\n/);
  const critical = findSectionLines(lines, /^##\s+CRITICAL RULES\s*$/i);
  if (!critical) return "";

  const sectionText = lines.slice(critical.start, critical.end).join("\n");
  const cliNameMatch = /User-facing command name is\s+`([^`]+)`/i.exec(sectionText);
  const cliName = cliNameMatch?.[1]?.trim();

  const scopeMatches = [...sectionText.matchAll(/`(@[^`/]+)\/[^`]+`/g)].map((match) => match[1]).filter(Boolean);
  const scope = scopeMatches.length > 0 ? scopeMatches[0] : undefined;

  const bunVersionMatch = /Bun\s+`([^`]+)`/i.exec(sectionText);
  const bunVersion = bunVersionMatch?.[1]?.trim();

  const out: string[] = ["[TruthLedger]"];
  if (cliName) {
    out.push(`- CLI: ${cliName}.`);
  }

  const hasImportHints =
    Boolean(scope) ||
    sectionText.includes("workspace package imports") ||
    sectionText.includes("alias schemes") ||
    sectionText.includes("`@/...`") ||
    (sectionText.includes("src") && sectionText.includes("dist"));
  if (hasImportHints) {
    const importsBase = scope ? `${scope}/* only` : "workspace package imports";
    const hasNoAlias = sectionText.includes("`@/...`") || sectionText.includes("alias schemes");
    const hasNoSrcDistMix = sectionText.includes("src") && sectionText.includes("dist");
    const suffixParts = [hasNoAlias ? "no @/..." : null, hasNoSrcDistMix ? "no src/dist mix" : null].filter(Boolean);
    const suffix = suffixParts.length > 0 ? `; ${suffixParts.join("; ")}.` : ".";
    out.push(`- Imports: ${importsBase}${suffix}`);
  }

  if (sectionText.includes("bun run test:dist")) {
    out.push("- Release gate: bun run test:dist for exports/CLI/dist changes.");
  }

  const hasBunHints = Boolean(bunVersion) || sectionText.includes("Use Bun") || sectionText.includes("bun run") || sectionText.includes("bun test");
  if (hasBunHints) {
    const bunLine = bunVersion ? `- Bun: bun run/test; CI bun@${bunVersion}.` : "- Bun: bun run/test.";
    out.push(bunLine);
  }

  if (out.length <= 1) {
    return "";
  }

  const trimmed = trimToCharBudget(out, input.maxChars ?? 210);
  return trimmed.join("\n").trim();
}
