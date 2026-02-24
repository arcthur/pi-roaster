import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const IDENTITY_SCHEMA = "brewva.identity.v1";
const DEFAULT_AGENT_ID = "default";

export interface ReadIdentityProfileInput {
  workspaceRoot: string;
  agentId?: string;
}

export interface IdentityProfile {
  schema: typeof IDENTITY_SCHEMA;
  agentId: string;
  path: string;
  relativePath: string;
  content: string;
}

export function normalizeAgentId(raw: string | undefined): string {
  if (typeof raw !== "string") return DEFAULT_AGENT_ID;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : DEFAULT_AGENT_ID;
}

function resolveIdentityPath(workspaceRoot: string, agentId: string): string {
  return join(workspaceRoot, ".brewva", "agents", agentId, "identity.md");
}

export function readIdentityProfile(input: ReadIdentityProfileInput): IdentityProfile | null {
  const workspaceRoot = resolve(input.workspaceRoot);
  const agentId = normalizeAgentId(input.agentId);
  const path = resolveIdentityPath(workspaceRoot, agentId);
  if (!existsSync(path)) return null;

  const text = readFileSync(path, "utf8").trim();
  if (!text) return null;

  const relativePath = relative(workspaceRoot, path) || ".";
  const content = ["[Identity]", `agent_id: ${agentId}`, `source: ${relativePath}`, text].join(
    "\n",
  );
  return {
    schema: IDENTITY_SCHEMA,
    agentId,
    path,
    relativePath,
    content,
  };
}
