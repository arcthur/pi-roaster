import type {
  BrewvaConfig,
  TurnWALRecord,
  TurnWALRecoveryResult,
  TurnWALSource,
} from "../types.js";
import { TurnWALStore } from "./turn-wal.js";

export interface TurnWALRecoverHandlerInput {
  record: TurnWALRecord;
  store: TurnWALStore;
}

export type TurnWALRecoverHandler = (input: TurnWALRecoverHandlerInput) => Promise<void> | void;

export interface TurnWALRecoveryOptions {
  workspaceRoot: string;
  config: BrewvaConfig["infrastructure"]["turnWal"];
  now?: () => number;
  handlers?: Partial<Record<TurnWALSource, TurnWALRecoverHandler>>;
  scopeFilter?: (scope: string) => boolean;
  recordEvent?: (input: {
    sessionId: string;
    type: string;
    payload?: Record<string, unknown>;
  }) => void;
}

function buildEmptySummary(): TurnWALRecoveryResult {
  return {
    recoveredAt: 0,
    scanned: 0,
    retried: 0,
    expired: 0,
    failed: 0,
    skipped: 0,
    compacted: 0,
    bySource: {
      channel: {
        scanned: 0,
        retried: 0,
        expired: 0,
        failed: 0,
        skipped: 0,
      },
      schedule: {
        scanned: 0,
        retried: 0,
        expired: 0,
        failed: 0,
        skipped: 0,
      },
      gateway: {
        scanned: 0,
        retried: 0,
        expired: 0,
        failed: 0,
        skipped: 0,
      },
      heartbeat: {
        scanned: 0,
        retried: 0,
        expired: 0,
        failed: 0,
        skipped: 0,
      },
    },
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown_recovery_error";
}

export class TurnWALRecovery {
  private readonly now: () => number;
  private readonly handlers: Partial<Record<TurnWALSource, TurnWALRecoverHandler>>;
  private readonly scopeFilter: (scope: string) => boolean;
  private readonly maxRetries: number;
  private readonly defaultTtlMs: number;
  private readonly scheduleTurnTtlMs: number;
  private readonly recordEvent?:
    | ((input: { sessionId: string; type: string; payload?: Record<string, unknown> }) => void)
    | undefined;

  constructor(private readonly options: TurnWALRecoveryOptions) {
    this.now = options.now ?? (() => Date.now());
    this.handlers = options.handlers ?? {};
    this.scopeFilter = options.scopeFilter ?? (() => true);
    this.maxRetries = Math.max(0, Math.floor(options.config.maxRetries));
    this.defaultTtlMs = Math.max(1, Math.floor(options.config.defaultTtlMs));
    this.scheduleTurnTtlMs = Math.max(1, Math.floor(options.config.scheduleTurnTtlMs));
    this.recordEvent = options.recordEvent;
  }

  async recover(): Promise<TurnWALRecoveryResult> {
    const result = buildEmptySummary();
    const recoveredAt = this.now();
    result.recoveredAt = recoveredAt;
    if (!this.options.config.enabled) {
      return result;
    }

    const scopes = TurnWALStore.listScopeIds({
      workspaceRoot: this.options.workspaceRoot,
      dir: this.options.config.dir,
    }).filter((scope) => this.scopeFilter(scope));

    for (const scope of scopes) {
      const store = new TurnWALStore({
        workspaceRoot: this.options.workspaceRoot,
        config: this.options.config,
        scope,
        now: this.now,
        recordEvent: this.recordEvent,
      });
      const rows = store.listPending();
      for (const row of rows) {
        result.scanned += 1;
        result.bySource[row.source].scanned += 1;

        if (this.isExpired(row, recoveredAt)) {
          store.markExpired(row.walId);
          result.expired += 1;
          result.bySource[row.source].expired += 1;
          continue;
        }

        if (row.attempts >= this.maxRetries) {
          store.markFailed(row.walId, "max_retries_exhausted");
          result.failed += 1;
          result.bySource[row.source].failed += 1;
          continue;
        }

        const handler = this.handlers[row.source];
        if (!handler) {
          result.skipped += 1;
          result.bySource[row.source].skipped += 1;
          continue;
        }

        try {
          await handler({ record: row, store });
          result.retried += 1;
          result.bySource[row.source].retried += 1;
        } catch (error) {
          store.markFailed(row.walId, `recovery_retry_failed:${toErrorMessage(error)}`);
          result.failed += 1;
          result.bySource[row.source].failed += 1;
        }
      }

      const compacted = store.compact();
      result.compacted += compacted.dropped;
    }

    this.emitRecoveryCompleted(result);
    return result;
  }

  private isExpired(record: TurnWALRecord, nowMs: number): boolean {
    const ttlMs =
      typeof record.ttlMs === "number" && Number.isFinite(record.ttlMs) && record.ttlMs > 0
        ? Math.floor(record.ttlMs)
        : record.source === "schedule"
          ? this.scheduleTurnTtlMs
          : this.defaultTtlMs;
    const lastActivity = Math.max(record.createdAt, record.updatedAt);
    return lastActivity + ttlMs < nowMs;
  }

  private emitRecoveryCompleted(result: TurnWALRecoveryResult): void {
    this.recordEvent?.({
      sessionId: "turn_wal:recovery",
      type: "turn_wal_recovery_completed",
      payload: {
        recoveredAt: result.recoveredAt,
        scanned: result.scanned,
        retried: result.retried,
        expired: result.expired,
        failed: result.failed,
        skipped: result.skipped,
        compacted: result.compacted,
        bySource: result.bySource,
      },
    });
  }
}
