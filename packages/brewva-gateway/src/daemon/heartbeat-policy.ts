import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StructuredLogger } from "./logger.js";

export interface HeartbeatRule {
  id: string;
  intervalMinutes: number;
  prompt: string;
  sessionId?: string;
  objective?: string;
  contextHints?: string[];
  wakeMode?: "always" | "if_signal" | "if_open_loop";
  staleAfterMinutes?: number;
}

export interface HeartbeatPolicy {
  sourcePath: string;
  loadedAt: number;
  rules: HeartbeatRule[];
}

const POLICY_BLOCK_REGEX = /```(?:json\s+)?heartbeat\s*\n([\s\S]*?)```/iu;

function normalizeRule(
  input: Partial<HeartbeatRule>,
  fallbackId: string,
): HeartbeatRule | undefined {
  const id = (input.id ?? fallbackId).trim();
  const prompt = (input.prompt ?? "").trim();
  const intervalMinutes = Number(input.intervalMinutes ?? 0);
  if (!id || !prompt || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return undefined;
  }
  const sessionId =
    typeof input.sessionId === "string" && input.sessionId.trim()
      ? input.sessionId.trim()
      : undefined;
  const objective =
    typeof input.objective === "string" && input.objective.trim()
      ? input.objective.trim()
      : undefined;
  const contextHints = Array.isArray(input.contextHints)
    ? [
        ...new Set(
          input.contextHints
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      ]
    : undefined;
  const wakeMode =
    input.wakeMode === "always" ||
    input.wakeMode === "if_signal" ||
    input.wakeMode === "if_open_loop"
      ? input.wakeMode
      : undefined;
  const staleAfterMinutes =
    typeof input.staleAfterMinutes === "number" && Number.isFinite(input.staleAfterMinutes)
      ? Math.max(1, Math.floor(input.staleAfterMinutes))
      : undefined;
  return {
    id,
    prompt,
    intervalMinutes: Math.floor(intervalMinutes),
    sessionId,
    objective,
    contextHints: contextHints && contextHints.length > 0 ? contextHints : undefined,
    wakeMode,
    staleAfterMinutes,
  };
}

function parseJsonPolicy(markdown: string): HeartbeatRule[] {
  const match = POLICY_BLOCK_REGEX.exec(markdown);
  if (!match) {
    return [];
  }
  const block = match[1];
  if (!block) {
    return [];
  }

  try {
    const parsed = JSON.parse(block) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return [];
    }
    const rulesRaw = (parsed as { rules?: unknown }).rules;
    if (!Array.isArray(rulesRaw)) {
      return [];
    }
    const out: HeartbeatRule[] = [];
    let index = 0;
    for (const item of rulesRaw) {
      index += 1;
      if (!item || typeof item !== "object") continue;
      const normalized = normalizeRule(item as Partial<HeartbeatRule>, `rule-${index}`);
      if (normalized) out.push(normalized);
    }
    return out;
  } catch {
    return [];
  }
}

export function loadHeartbeatPolicy(sourcePath: string): HeartbeatPolicy {
  const resolved = resolve(sourcePath);
  const loadedAt = Date.now();

  if (!existsSync(resolved)) {
    return {
      sourcePath: resolved,
      loadedAt,
      rules: [],
    };
  }

  const markdown = readFileSync(resolved, "utf8");
  const rules = parseJsonPolicy(markdown);

  return {
    sourcePath: resolved,
    loadedAt,
    rules,
  };
}

export interface HeartbeatSchedulerStatus {
  sourcePath: string;
  loadedAt: number;
  rules: Array<HeartbeatRule & { nextRunAt: number }>;
}

export class HeartbeatScheduler {
  private policy: HeartbeatPolicy;
  private readonly nextRunByRule = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: {
      sourcePath: string;
      logger: StructuredLogger;
      tickIntervalMs?: number;
      onFire: (rule: HeartbeatRule) => Promise<void>;
    },
  ) {
    this.policy = loadHeartbeatPolicy(options.sourcePath);
    this.initializeNextRuns();
  }

  start(): void {
    if (this.timer) return;
    const tickIntervalMs = Math.max(1000, this.options.tickIntervalMs ?? 15_000);
    this.timer = setInterval(() => {
      void this.tick();
    }, tickIntervalMs);
    this.timer.unref?.();
    this.options.logger.info("heartbeat scheduler started", {
      sourcePath: this.policy.sourcePath,
      rules: this.policy.rules.length,
      tickIntervalMs,
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  reload(): HeartbeatPolicy {
    this.policy = loadHeartbeatPolicy(this.options.sourcePath);
    this.initializeNextRuns();
    this.options.logger.info("heartbeat policy reloaded", {
      sourcePath: this.policy.sourcePath,
      rules: this.policy.rules.length,
    });
    return this.policy;
  }

  getStatus(): HeartbeatSchedulerStatus {
    return {
      sourcePath: this.policy.sourcePath,
      loadedAt: this.policy.loadedAt,
      rules: this.policy.rules.map((rule) => ({
        ...rule,
        nextRunAt: this.nextRunByRule.get(rule.id) ?? Date.now(),
      })),
    };
  }

  private initializeNextRuns(): void {
    this.nextRunByRule.clear();
    const now = Date.now();
    for (const rule of this.policy.rules) {
      this.nextRunByRule.set(rule.id, now + rule.intervalMinutes * 60_000);
    }
  }

  private async tick(): Promise<void> {
    if (this.policy.rules.length === 0) {
      return;
    }
    const now = Date.now();
    for (const rule of this.policy.rules) {
      const nextRunAt = this.nextRunByRule.get(rule.id) ?? now;
      if (now < nextRunAt) {
        continue;
      }

      try {
        await this.options.onFire(rule);
        this.options.logger.info("heartbeat fired", {
          ruleId: rule.id,
          sessionId: rule.sessionId ?? null,
        });
      } catch (error) {
        this.options.logger.warn("heartbeat execution failed", {
          ruleId: rule.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.nextRunByRule.set(rule.id, Date.now() + rule.intervalMinutes * 60_000);
      }
    }
  }
}
