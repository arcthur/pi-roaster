import { normalizeAgentId } from "@brewva/brewva-runtime";

export type ChannelCommandMatch =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "agents" }
  | { kind: "new-agent"; agentId: string; model?: string }
  | { kind: "del-agent"; agentId: string }
  | { kind: "focus"; agentId: string }
  | { kind: "run"; agentIds: string[]; task: string }
  | { kind: "discuss"; agentIds: string[]; topic: string; maxRounds?: number }
  | { kind: "route-agent"; agentId: string; task: string; viaMention: boolean };

function normalizeToken(token: string): string {
  return token.trim();
}

function parseAgentRef(raw: string): string | undefined {
  const normalized = normalizeAgentId(raw.replace(/^@/, ""));
  return normalized.length > 0 ? normalized : undefined;
}

function parseAgentList(raw: string): string[] {
  const values = raw
    .split(",")
    .map((item) => parseAgentRef(item))
    .filter((item): item is string => Boolean(item));
  return Array.from(new Set(values));
}

function parsePositiveInteger(raw: string): number | undefined {
  if (!/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function parseKeyValueArgs(input: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const token of input.split(/\s+/u)) {
    if (!token.includes("=")) continue;
    const [rawKey, ...rest] = token.split("=");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (!key || !value) continue;
    args[key] = value;
  }
  return args;
}

export class CommandRouter {
  match(rawText: string): ChannelCommandMatch {
    const text = rawText.trim();
    if (!text) return { kind: "none" };

    const mention = /^@([a-zA-Z0-9._-]+)[,:]?\s+([\s\S]+)$/u.exec(text);
    if (mention) {
      const agentId = parseAgentRef(mention[1] ?? "");
      const task = mention[2]?.trim() ?? "";
      if (!agentId || !task) {
        return { kind: "error", message: "Invalid @agent command." };
      }
      return {
        kind: "route-agent",
        agentId,
        task,
        viaMention: true,
      };
    }

    if (!text.startsWith("/")) {
      return { kind: "none" };
    }

    const [rawCommand = "", ...restTokens] = text.split(/\s+/u);
    const command = rawCommand.toLowerCase();
    const body = restTokens.join(" ").trim();

    if (command === "/agents") {
      return { kind: "agents" };
    }

    if (command === "/new-agent") {
      if (!body)
        return { kind: "error", message: "Usage: /new-agent <name> [model=<provider/id>]" };

      const nameIs = /^name\s+is\s+(\S+)(?:\s+|$)/iu.exec(body);
      let agentId = nameIs?.[1] ? parseAgentRef(nameIs[1]) : undefined;
      const kvArgs = parseKeyValueArgs(body);
      if (!agentId && kvArgs.name) {
        agentId = parseAgentRef(kvArgs.name);
      }
      if (!agentId) {
        const firstToken = normalizeToken(body.split(/\s+/u)[0] ?? "");
        if (
          firstToken &&
          !firstToken.includes("=") &&
          firstToken.toLowerCase() !== "name" &&
          firstToken.toLowerCase() !== "is"
        ) {
          agentId = parseAgentRef(firstToken);
        }
      }
      if (!agentId) {
        return { kind: "error", message: "Missing agent name for /new-agent." };
      }
      const model = kvArgs.model?.trim();
      return {
        kind: "new-agent",
        agentId,
        model: model && model.length > 0 ? model : undefined,
      };
    }

    if (command === "/del-agent") {
      if (!body) return { kind: "error", message: "Usage: /del-agent <name>" };
      const agentId = parseAgentRef(body.split(/\s+/u)[0] ?? "");
      if (!agentId) return { kind: "error", message: "Missing agent name for /del-agent." };
      return { kind: "del-agent", agentId };
    }

    if (command === "/focus") {
      if (!body) return { kind: "error", message: "Usage: /focus @agent" };
      const agentId = parseAgentRef(body.split(/\s+/u)[0] ?? "");
      if (!agentId) return { kind: "error", message: "Missing agent name for /focus." };
      return { kind: "focus", agentId };
    }

    if (command === "/run") {
      if (!body) return { kind: "error", message: "Usage: /run @a,@b <task>" };
      const [targetsToken, ...taskTokens] = body.split(/\s+/u);
      const agentIds = parseAgentList(targetsToken ?? "");
      const task = taskTokens.join(" ").trim();
      if (agentIds.length === 0 || !task) {
        return { kind: "error", message: "Usage: /run @a,@b <task>" };
      }
      return {
        kind: "run",
        agentIds,
        task,
      };
    }

    if (command === "/discuss") {
      if (!body) return { kind: "error", message: "Usage: /discuss @a,@b [maxRounds=N] <topic>" };
      const [targetsToken, ...rest] = body.split(/\s+/u);
      const agentIds = parseAgentList(targetsToken ?? "");
      if (agentIds.length === 0) {
        return { kind: "error", message: "Usage: /discuss @a,@b [maxRounds=N] <topic>" };
      }
      let maxRounds: number | undefined;
      const topicTokens: string[] = [];
      for (const token of rest) {
        const parsed = /^maxRounds=(\d+)$/iu.exec(token);
        if (parsed?.[1]) {
          maxRounds = parsePositiveInteger(parsed[1]);
          continue;
        }
        topicTokens.push(token);
      }
      const topic = topicTokens.join(" ").trim();
      if (!topic) {
        return { kind: "error", message: "Usage: /discuss @a,@b [maxRounds=N] <topic>" };
      }
      return {
        kind: "discuss",
        agentIds,
        topic,
        maxRounds,
      };
    }

    return { kind: "none" };
  }
}
