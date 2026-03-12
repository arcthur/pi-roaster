import { describe, expect, test } from "bun:test";
import {
  markContextCompacted,
  type ContextCompactionDeps,
} from "../../packages/brewva-runtime/src/services/context-compaction.js";
import { RuntimeSessionStateStore } from "../../packages/brewva-runtime/src/services/session-state.js";
import type { SkillDocument } from "../../packages/brewva-runtime/src/types.js";

async function flushAsyncEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("context-compaction module", () => {
  test("marks compaction, clears scope caches, emits event, and appends ledger evidence", () => {
    const sessionState = new RuntimeSessionStateStore();
    sessionState.setLastInjectedFingerprint("session-a::root", "fp-a");
    sessionState.setLastInjectedFingerprint("session-b::root", "fp-b");
    sessionState.setReservedInjectionTokens("session-a::root", 42);
    sessionState.setReservedInjectionTokens("session-b::root", 7);

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
      recordInfrastructureRow: (row) => {
        ledgerRows.push(row as Record<string, unknown>);
        return "ev_test";
      },
      markPressureCompacted: (sessionId) => {
        pressureMarks.push(sessionId);
      },
      markInjectionCompacted: (sessionId) => {
        injectionMarks.push(sessionId);
      },
      getCurrentTurn: () => 17,
      getActiveSkill: () =>
        ({
          name: "implementation",
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
    expect(sessionState.getLastInjectedFingerprint("session-a::root")).toBeUndefined();
    expect(sessionState.getLastInjectedFingerprint("session-b::root")).toBe("fp-b");
    expect(sessionState.getReservedInjectionTokens("session-a::root")).toBeUndefined();
    expect(sessionState.getReservedInjectionTokens("session-b::root")).toBe(7);
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
        skill: "implementation",
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
      recordInfrastructureRow: () => "ev_test",
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

  test("emits governance_compaction_integrity_checked when governance port accepts summary", async () => {
    const sessionState = new RuntimeSessionStateStore();
    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: Record<string, unknown>;
    }> = [];

    const deps: ContextCompactionDeps = {
      sessionState,
      recordInfrastructureRow: () => "ev_test",
      governancePort: {
        checkCompactionIntegrity: () => ({ ok: true }),
      },
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
      fromTokens: 400,
      toTokens: 120,
      summary: "compact summary",
      entryId: "cmp-ok",
    });
    await flushAsyncEvents();

    expect(events.some((event) => event.type === "governance_compaction_integrity_checked")).toBe(
      true,
    );
  });

  test("emits governance_compaction_integrity_failed when governance port rejects summary", async () => {
    const sessionState = new RuntimeSessionStateStore();
    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: Record<string, unknown>;
    }> = [];

    const deps: ContextCompactionDeps = {
      sessionState,
      recordInfrastructureRow: () => "ev_test",
      governancePort: {
        checkCompactionIntegrity: () => ({ ok: false, reason: "missing-required-fact" }),
      },
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
      fromTokens: 400,
      toTokens: 120,
      summary: "compact summary",
      entryId: "cmp-failed",
    });
    await flushAsyncEvents();

    const failed = events.find((event) => event.type === "governance_compaction_integrity_failed");
    expect(failed).toBeDefined();
    const payload = failed?.payload as { reason?: string } | undefined;
    expect(payload?.reason).toBe("missing-required-fact");
  });

  test("emits governance_compaction_integrity_error when governance port throws", async () => {
    const sessionState = new RuntimeSessionStateStore();
    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: Record<string, unknown>;
    }> = [];

    const deps: ContextCompactionDeps = {
      sessionState,
      recordInfrastructureRow: () => "ev_test",
      governancePort: {
        checkCompactionIntegrity: () => {
          throw new Error("compaction-integrity-port-error");
        },
      },
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
      fromTokens: 400,
      toTokens: 120,
      summary: "compact summary",
      entryId: "cmp-error",
    });
    await flushAsyncEvents();

    const errored = events.find((event) => event.type === "governance_compaction_integrity_error");
    expect(errored).toBeDefined();
    const payload = errored?.payload as { error?: string } | undefined;
    expect(payload?.error).toContain("compaction-integrity-port-error");
  });
});
