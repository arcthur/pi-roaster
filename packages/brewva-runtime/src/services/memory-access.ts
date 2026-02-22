import type { MemoryEngine } from "../memory/engine.js";
import type { MemorySearchResult, WorkingMemorySnapshot } from "../memory/types.js";

export interface MemoryAccessServiceOptions {
  memory: MemoryEngine;
}

export class MemoryAccessService {
  private readonly memory: MemoryEngine;

  constructor(options: MemoryAccessServiceOptions) {
    this.memory = options.memory;
  }

  getWorkingMemory(sessionId: string): WorkingMemorySnapshot | undefined {
    return this.memory.getWorkingMemory(sessionId);
  }

  searchMemory(sessionId: string, input: { query: string; limit?: number }): MemorySearchResult {
    return this.memory.search(sessionId, input);
  }

  dismissMemoryInsight(
    sessionId: string,
    insightId: string,
  ): { ok: boolean; error?: "missing_id" | "not_found" } {
    const id = insightId.trim();
    if (!id) {
      return { ok: false, error: "missing_id" };
    }
    const dismissed = this.memory.dismissInsight(sessionId, id);
    if (!dismissed) {
      return { ok: false, error: "not_found" };
    }
    return { ok: true };
  }

  reviewMemoryEvolvesEdge(
    sessionId: string,
    input: { edgeId: string; decision: "accept" | "reject" },
  ): { ok: boolean; error?: "missing_id" | "not_found" | "already_set" } {
    const edgeId = input.edgeId.trim();
    if (!edgeId) {
      return { ok: false, error: "missing_id" };
    }
    return this.memory.reviewEvolvesEdge(sessionId, {
      edgeId,
      decision: input.decision,
    });
  }
}
