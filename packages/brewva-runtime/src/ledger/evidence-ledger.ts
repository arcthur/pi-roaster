import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvidenceLedgerRow, EvidenceRecord, EvidenceQuery } from "../types.js";
import { ensureDirForFile, writeFileAtomic } from "../utils/fs.js";
import { sha256 } from "../utils/hash.js";
import { redactSecrets, redactUnknown } from "../security/redact.js";

interface AppendInput extends Omit<EvidenceRecord, "id" | "timestamp" | "outputHash"> {
  sessionId: string;
  fullOutput?: string;
  metadata?: Record<string, unknown>;
}

export interface CompactSessionOptions {
  keepLast: number;
  reason?: string;
}

export interface CompactSessionResult {
  sessionId: string;
  compacted: number;
  kept: number;
  checkpointId: string;
}

function summarizeText(input: string, maxLen = 200): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

function parseRows(path: string): EvidenceLedgerRow[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const rows: EvidenceLedgerRow[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as EvidenceLedgerRow;
      if (row && typeof row.id === "string") {
        rows.push(row);
      }
    } catch {
      continue;
    }
  }
  return rows;
}

export class EvidenceLedger {
  private readonly filePath: string;
  private loadedIndex = false;
  private fileHasContent = false;
  private lastHashBySession = new Map<string, string>();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
    ensureDirForFile(this.filePath);
  }

  get path(): string {
    return this.filePath;
  }

  append(input: AppendInput): EvidenceLedgerRow {
    this.ensureIndexLoaded();
    const previousHash = this.lastHashBySession.get(input.sessionId) ?? "root";

    const timestamp = Date.now();
    const id = `ev_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
    const rawOutput = redactSecrets(input.fullOutput ?? input.outputSummary);
    const outputHash = sha256(rawOutput);

    const argsSummary = redactSecrets(input.argsSummary);
    const outputSummary = redactSecrets(input.outputSummary);
    const metadata = input.metadata ? (redactUnknown(input.metadata) as EvidenceLedgerRow["metadata"]) : undefined;

    const recordBody: Omit<EvidenceLedgerRow, "hash"> = {
      id,
      timestamp,
      turn: input.turn,
      skill: input.skill,
      tool: input.tool,
      argsSummary: summarizeText(argsSummary),
      outputSummary: summarizeText(outputSummary),
      outputHash,
      verdict: input.verdict,
      sessionId: input.sessionId,
      previousHash,
      metadata,
    };

    const hash = sha256(JSON.stringify(recordBody));
    const row: EvidenceLedgerRow = {
      ...recordBody,
      hash,
    };

    const prefix = this.fileHasContent ? "\n" : "";
    writeFileSync(this.filePath, `${prefix}${JSON.stringify(row)}`, { flag: "a" });
    this.fileHasContent = true;
    this.lastHashBySession.set(input.sessionId, row.hash);

    return row;
  }

  compactSession(sessionId: string, options: CompactSessionOptions): CompactSessionResult | undefined {
    const keepLast = Math.max(1, Math.trunc(options.keepLast));
    const allRows = parseRows(this.filePath);
    if (allRows.length === 0) return undefined;

    const sessionRows: EvidenceLedgerRow[] = [];
    const sessionPositions: number[] = [];
    for (const [i, row] of allRows.entries()) {
      if (row.sessionId === sessionId) {
        sessionRows.push(row);
        sessionPositions.push(i);
      }
    }

    if (sessionRows.length <= keepLast) return undefined;

    const compactedRows = sessionRows.slice(0, -keepLast);
    const keptRows = sessionRows.slice(-keepLast);
    if (compactedRows.length === 0) return undefined;

    const firstCompacted = compactedRows[0]!;
    const lastCompacted = compactedRows[compactedRows.length - 1]!;
    const checkpointSummary = [
      `Ledger checkpoint (${options.reason ?? "scheduled"})`,
      `compacted=${compactedRows.length}`,
      `kept=${keptRows.length}`,
      `turn=${firstCompacted.turn}..${lastCompacted.turn}`,
      `time=${firstCompacted.timestamp}..${lastCompacted.timestamp}`,
    ].join(" | ");

    const checkpointId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const checkpointBody: Omit<EvidenceLedgerRow, "hash" | "previousHash"> = {
      id: checkpointId,
      timestamp: Date.now(),
      turn: lastCompacted.turn,
      skill: undefined,
      tool: "ledger_checkpoint",
      argsSummary: summarizeText(`reason=${options.reason ?? "scheduled"} keepLast=${keepLast}`),
      outputSummary: summarizeText(checkpointSummary),
      outputHash: sha256(checkpointSummary),
      verdict: "inconclusive",
      sessionId,
      metadata: {
        compacted: compactedRows.length,
        kept: keptRows.length,
        fromTurn: firstCompacted.turn,
        toTurn: lastCompacted.turn,
      },
    };

    const keptBodies: Array<Omit<EvidenceLedgerRow, "hash" | "previousHash">> = keptRows.map((row) => {
      const { hash: _hash, previousHash: _previousHash, ...body } = row;
      return body;
    });

    const rebuiltSessionRows = this.rehashSessionRows([checkpointBody, ...keptBodies]);
    const checkpointInsertAt = sessionPositions[compactedRows.length - 1];
    if (checkpointInsertAt === undefined) return undefined;
    const keepPositions = sessionPositions.slice(compactedRows.length);
    const targetPositions = [checkpointInsertAt, ...keepPositions];

    const insertMap = new Map<number, EvidenceLedgerRow>();
    for (let i = 0; i < targetPositions.length; i += 1) {
      const target = targetPositions[i];
      const row = rebuiltSessionRows[i];
      if (target !== undefined && row) {
        insertMap.set(target, row);
      }
    }

    const rewrittenRows: EvidenceLedgerRow[] = [];
    for (const [i, row] of allRows.entries()) {
      const replacement = insertMap.get(i);
      if (replacement) {
        rewrittenRows.push(replacement);
        continue;
      }

      if (row.sessionId === sessionId) {
        continue;
      }
      rewrittenRows.push(row);
    }

    this.writeAllRows(rewrittenRows);
    this.resetIndex();
    return {
      sessionId,
      compacted: compactedRows.length,
      kept: keptRows.length,
      checkpointId,
    };
  }

  list(sessionId?: string): EvidenceLedgerRow[] {
    const rows = parseRows(this.filePath);
    if (!sessionId) return rows;
    return rows.filter((row) => row.sessionId === sessionId);
  }

  clearSessionCache(sessionId: string): void {
    this.lastHashBySession.delete(sessionId);
  }

  query(sessionId: string, query: EvidenceQuery): EvidenceLedgerRow[] {
    let rows = this.list(sessionId);

    if (query.file) {
      const file = query.file;
      rows = rows.filter((row) => row.argsSummary.includes(file) || row.outputSummary.includes(file));
    }
    if (query.skill) {
      rows = rows.filter((row) => row.skill === query.skill);
    }
    if (query.verdict) {
      rows = rows.filter((row) => row.verdict === query.verdict);
    }
    if (query.tool) {
      rows = rows.filter((row) => row.tool === query.tool);
    }
    if (query.last && query.last > 0) {
      rows = rows.slice(-query.last);
    }

    return rows;
  }

  verifyChain(sessionId: string): { valid: boolean; reason?: string } {
    const rows = this.list(sessionId);
    let previousHash = "root";
    for (const row of rows) {
      if (row.previousHash !== previousHash) {
        return { valid: false, reason: `invalid previous hash at ${row.id}` };
      }
      const { hash, ...body } = row;
      const expected = sha256(JSON.stringify(body));
      if (hash !== expected) {
        return { valid: false, reason: `invalid hash at ${row.id}` };
      }
      previousHash = row.hash;
    }
    return { valid: true };
  }

  private rehashSessionRows(rows: Array<Omit<EvidenceLedgerRow, "hash" | "previousHash">>): EvidenceLedgerRow[] {
    let previousHash = "root";
    const out: EvidenceLedgerRow[] = [];

    for (const body of rows) {
      const withPreviousHash: Omit<EvidenceLedgerRow, "hash"> = {
        ...body,
        previousHash,
      };
      const hash = sha256(JSON.stringify(withPreviousHash));
      const row: EvidenceLedgerRow = { ...withPreviousHash, hash };
      out.push(row);
      previousHash = row.hash;
    }

    return out;
  }

  private writeAllRows(rows: EvidenceLedgerRow[]): void {
    const content = rows.map((row) => JSON.stringify(row)).join("\n");
    writeFileAtomic(this.filePath, content);
  }

  private resetIndex(): void {
    this.loadedIndex = false;
    this.fileHasContent = false;
    this.lastHashBySession.clear();
  }

  private ensureIndexLoaded(): void {
    if (this.loadedIndex) return;
    this.loadedIndex = true;

    if (!existsSync(this.filePath)) {
      this.fileHasContent = false;
      return;
    }

    try {
      this.fileHasContent = statSync(this.filePath).size > 0;
    } catch {
      this.fileHasContent = false;
      return;
    }

    if (!this.fileHasContent) return;

    const lines = readFileSync(this.filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      try {
        const row = JSON.parse(line) as EvidenceLedgerRow;
        if (row && typeof row.sessionId === "string" && typeof row.hash === "string") {
          this.lastHashBySession.set(row.sessionId, row.hash);
        }
      } catch {
        continue;
      }
    }
  }
}
