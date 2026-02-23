import { describe, expect, test } from "bun:test";
import {
  buildWorkingMemorySnapshot,
  type MemoryCrystal,
  type MemoryInsight,
  type MemoryUnit,
} from "@brewva/brewva-runtime";

function unit(input: {
  id: string;
  type: MemoryUnit["type"];
  topic: string;
  statement: string;
  sessionId?: string;
  status?: MemoryUnit["status"];
  confidence?: number;
  updatedAt?: number;
  metadata?: MemoryUnit["metadata"];
}): MemoryUnit {
  const timestamp = input.updatedAt ?? 1_700_000_000_000;
  return {
    id: input.id,
    sessionId: input.sessionId ?? "mem-working-session",
    type: input.type,
    status: input.status ?? "active",
    topic: input.topic,
    statement: input.statement,
    confidence: input.confidence ?? 0.8,
    fingerprint: `fp-${input.id}`,
    sourceRefs: [
      {
        eventId: `evt-${input.id}`,
        eventType: "task_event",
        sessionId: input.sessionId ?? "mem-working-session",
        timestamp,
      },
    ],
    metadata: input.metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
  };
}

function crystal(id: string, topic: string, summary: string): MemoryCrystal {
  return {
    id,
    sessionId: "mem-working-session",
    topic,
    summary,
    unitIds: ["u1", "u2"],
    confidence: 0.85,
    sourceRefs: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
  };
}

function insight(id: string, message: string): MemoryInsight {
  return {
    id,
    sessionId: "mem-working-session",
    kind: "conflict",
    status: "open",
    message,
    relatedUnitIds: ["u1", "u2"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

describe("working memory builder", () => {
  test("builds fixed sections with working memory header", () => {
    const snapshot = buildWorkingMemorySnapshot({
      sessionId: "mem-working-session",
      maxChars: 2400,
      units: [
        unit({
          id: "u1",
          type: "decision",
          topic: "architecture",
          statement: "Keep event tape as trace source.",
        }),
        unit({
          id: "u2",
          type: "constraint",
          topic: "runtime",
          statement: "Do not introduce graph database.",
        }),
        unit({
          id: "u3",
          type: "risk",
          topic: "quality",
          statement: "Noisy recalls may hurt context.",
        }),
        unit({
          id: "u4",
          type: "learning",
          topic: "skill",
          statement: "Skill completion should emit semantic event.",
        }),
        unit({
          id: "u5",
          type: "learning",
          topic: "lessons learned",
          statement: "When verification fails, tighten strategy before retrying.",
          metadata: {
            memorySignal: "lesson",
            source: "cognitive_outcome_reflection",
          },
        }),
      ],
      crystals: [
        crystal("c1", "architecture", "[Crystal]\n- Keep event tape.\n- Build memory projections."),
      ],
      insights: [insight("i1", "Potential conflict in topic 'quality' with 2 active statements.")],
    });

    expect(snapshot.content.includes("[WorkingMemory]")).toBe(true);
    expect(snapshot.content.includes("Now")).toBe(true);
    expect(snapshot.content.includes("Decisions")).toBe(true);
    expect(snapshot.content.includes("Constraints")).toBe(true);
    expect(snapshot.content.includes("Risks")).toBe(true);
    expect(snapshot.content.includes("Lessons Learned")).toBe(true);
    expect(snapshot.content.includes("Open Threads")).toBe(true);
    expect(snapshot.content.includes("tighten strategy before retrying")).toBe(true);
  });

  test("respects max chars by trimming output", () => {
    const snapshot = buildWorkingMemorySnapshot({
      sessionId: "mem-working-session",
      maxChars: 260,
      units: [
        unit({
          id: "u1",
          type: "fact",
          topic: "long",
          statement:
            "This is a very long statement that should be trimmed to stay within configured working memory limits.",
        }),
        unit({
          id: "u2",
          type: "risk",
          topic: "long",
          statement:
            "Another long statement that increases total output length and should force trimming behavior.",
        }),
      ],
      crystals: [],
      insights: [],
    });

    expect(snapshot.content.length).toBeLessThanOrEqual(260);
  });
});
