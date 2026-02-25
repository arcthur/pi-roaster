import { describe, expect, test } from "bun:test";
import {
  buildWorkingMemorySnapshot,
  type MemoryCrystal,
  type MemoryInsight,
} from "@brewva/brewva-runtime";
import { createMemoryCrystal, createMemoryUnitFactory } from "../fixtures/memory.js";

const unit = createMemoryUnitFactory({
  sessionId: "mem-working-session",
  status: "active",
  confidence: 0.8,
  updatedAt: 1_700_000_000_000,
  sourceRefsFactory: (input, timestamp) => [
    {
      eventId: `evt-${input.id}`,
      eventType: "task_event",
      sessionId: input.sessionId ?? "mem-working-session",
      timestamp,
    },
  ],
});

function crystal(id: string, topic: string, summary: string): MemoryCrystal {
  return createMemoryCrystal({
    id,
    topic,
    summary,
    sessionId: "mem-working-session",
    confidence: 0.85,
    unitIds: ["u1", "u2"],
    updatedAt: 1_700_000_000_001,
  });
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
