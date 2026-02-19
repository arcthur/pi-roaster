import type { TruthFact, TruthState } from "../types.js";

function summarizeFact(fact: TruthFact): string {
  const severity = fact.severity.toUpperCase();
  return `[${fact.id}] (${severity}) ${fact.summary}`;
}

export function buildTruthFactsBlock(input: {
  state: TruthState;
  maxFacts?: number;
  maxEvidenceIdsPerFact?: number;
}): string {
  const maxFacts = Math.max(1, Math.floor(input.maxFacts ?? 8));
  const maxEvidenceIdsPerFact = Math.max(0, Math.floor(input.maxEvidenceIdsPerFact ?? 2));

  const active = input.state.facts
    .filter((fact) => fact.status === "active")
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, maxFacts);

  const lines: string[] = ["[TruthFacts]"];
  if (active.length === 0) {
    lines.push("- (none)");
    return lines.join("\n");
  }

  for (const fact of active) {
    lines.push(`- ${summarizeFact(fact)}`);
    if (maxEvidenceIdsPerFact > 0 && fact.evidenceIds.length > 0) {
      const ids = fact.evidenceIds.slice(0, maxEvidenceIdsPerFact);
      lines.push(`  evidenceIds: ${ids.join(", ")}`);
    }
  }

  return lines.join("\n");
}

