import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLoggerOptions {
  logFilePath: string;
  maxBytes?: number;
  maxFiles?: number;
  jsonStdout?: boolean;
}

export class StructuredLogger {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly jsonStdout: boolean;

  constructor(options: StructuredLoggerOptions) {
    this.filePath = resolve(options.logFilePath);
    this.maxBytes = Math.max(256 * 1024, Math.floor(options.maxBytes ?? 10 * 1024 * 1024));
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 5));
    this.jsonStdout = options.jsonStdout === true;
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.log("error", message, fields);
  }

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const baseRecord = {
      ts: new Date().toISOString(),
      level,
      message,
    };
    const line = JSON.stringify(fields ? { ...baseRecord, ...fields } : baseRecord);

    if (this.jsonStdout) {
      process.stdout.write(`${line}\n`);
    }

    this.rotateIfNeeded(line.length + 1);
    appendFileSync(this.filePath, `${line}\n`, "utf8");
  }

  private rotateIfNeeded(nextBytes: number): void {
    let current = 0;
    if (existsSync(this.filePath)) {
      try {
        current = statSync(this.filePath).size;
      } catch {
        current = 0;
      }
    }

    if (current + nextBytes <= this.maxBytes) {
      return;
    }

    for (let index = this.maxFiles; index >= 1; index -= 1) {
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const target = `${this.filePath}.${index}`;
      if (!existsSync(source)) {
        continue;
      }
      try {
        if (existsSync(target)) {
          rmSync(target, { force: true });
        }
        renameSync(source, target);
      } catch {
        // best effort
      }
    }
  }
}
