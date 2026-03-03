import { describe, expect, test } from "bun:test";
import type { EvidenceLedger } from "../../packages/brewva-runtime/src/ledger/evidence-ledger.js";
import {
  markContextCompacted,
  type ContextCompactionDeps,
} from "../../packages/brewva-runtime/src/services/context-compaction.js";
import { RuntimeSessionStateStore } from "../../packages/brewva-runtime/src/services/session-state.js";
import type { SkillDocument } from "../../packages/brewva-runtime/src/types.js";

describe("context-compaction module", () => {
  test("marks compaction, clears scope caches, emits event, and appends ledger evidence", () => {
    const sessionState = new RuntimeSessionStateStore();
    sessionState.lastInjectedContextFingerprintBySession.set("session-a::root", "fp-a");
    sessionState.lastInjectedContextFingerprintBySession.set("session-b::root", "fp-b");
    sessionState.reservedContextInjectionTokensByScope.set("session-a::root", 42);
    sessionState.reservedContextInjectionTokensByScope.set("session-b::root", 7);

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: Record<string, unknown>;
    }> = [];
    const ledgerRows: Array<Record<string, unknown>> = [];
    const pressureMarks: string[] = [];
    const injectionMarks: string[] = [];

    const deps: ContextCompactionDeps = {
      sessionState,
      ledger: {
        append: (row: unknown) => {
          ledgerRows.push(row as Record<string, unknown>);
          return row;
        },
      } as unknown as EvidenceLedger,
      markPressureCompacted: (sessionId) => {
        pressureMarks.push(sessionId);
      },
      markInjectionCompacted: (sessionId) => {
        injectionMarks.push(sessionId);
      },
      getCurrentTurn: () => 17,
      getActiveSkill: () =>
        ({
          name: "patching",
        }) as SkillDocument,
      recordEvent: (input) => {
        events.push(input);
        return undefined;
      },
    };

    markContextCompacted(deps, "session-a", {
      fromTokens: 900,
      toTokens: 320,
      summary: "  keep latest failures only  ",
      entryId: "  cmp-42 ",
    });

    expect(pressureMarks).toEqual(["session-a"]);
    expect(injectionMarks).toEqual(["session-a"]);
    expect(sessionState.lastInjectedContextFingerprintBySession.has("session-a::root")).toBe(false);
    expect(sessionState.lastInjectedContextFingerprintBySession.has("session-b::root")).toBe(true);
    expect(sessionState.reservedContextInjectionTokensByScope.has("session-a::root")).toBe(false);
    expect(sessionState.reservedContextInjectionTokensByScope.has("session-b::root")).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        sessionId: "session-a",
        type: "context_compacted",
        turn: 17,
        payload: expect.objectContaining({
          fromTokens: 900,
          toTokens: 320,
          entryId: "cmp-42",
          summaryChars: "keep latest failures only".length,
        }),
      }),
    );

    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toEqual(
      expect.objectContaining({
        sessionId: "session-a",
        turn: 17,
        tool: "brewva_context_compaction",
        skill: "patching",
      }),
    );
    expect(ledgerRows[0]?.metadata).toEqual(
      expect.objectContaining({
        source: "context_budget",
        fromTokens: 900,
        toTokens: 320,
        entryId: "cmp-42",
      }),
    );
  });

  test("keeps compaction payload normalization when summary text is empty after trim", () => {
    const sessionState = new RuntimeSessionStateStore();

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: Record<string, unknown>;
    }> = [];

    const deps: ContextCompactionDeps = {
      sessionState,
      ledger: {
        append: () => undefined,
      } as unknown as EvidenceLedger,
      markPressureCompacted: () => undefined,
      markInjectionCompacted: () => undefined,
      getCurrentTurn: () => 3,
      getActiveSkill: () => undefined,
      recordEvent: (input) => {
        events.push(input);
        return undefined;
      },
    };

    markContextCompacted(deps, "session-a", {
      fromTokens: null,
      toTokens: null,
      summary: "   ",
      entryId: "  ",
    });

    expect(events[0]?.payload).toEqual(
      expect.objectContaining({
        entryId: "",
        summaryChars: 0,
      }),
    );
  });
});
