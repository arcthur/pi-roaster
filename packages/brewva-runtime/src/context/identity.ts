import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const IDENTITY_SCHEMA = "brewva.identity.v2";
const DEFAULT_AGENT_ID = "default";
const PERSONA_SECTION_TITLES = {
  "who i am": "WhoIAm",
  "how i work": "HowIWork",
  "what i care about": "WhatICareAbout",
} as const;

type PersonaSectionKey = keyof typeof PERSONA_SECTION_TITLES;

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

function normalizePersonaHeading(raw: string): PersonaSectionKey | null {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized in PERSONA_SECTION_TITLES) {
    return normalized as PersonaSectionKey;
  }
  return null;
}

function parsePersonaSections(text: string): Partial<Record<PersonaSectionKey, string>> {
  const sections: Partial<Record<PersonaSectionKey, string[]>> = {};
  let currentSection: PersonaSectionKey | null = null;
  let matchedHeading = false;

  for (const line of text.split("\n")) {
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (headingMatch) {
      const heading = normalizePersonaHeading(headingMatch[2] ?? "");
      if (heading) {
        matchedHeading = true;
        currentSection = heading;
        if (!sections[currentSection]) {
          sections[currentSection] = [];
        }
        continue;
      }
    }

    if (currentSection) {
      sections[currentSection]?.push(line);
    }
  }

  const normalizedSections: Partial<Record<PersonaSectionKey, string>> = {};
  if (!matchedHeading) {
    const fallback = text.trim();
    if (fallback) {
      normalizedSections["who i am"] = fallback;
    }
    return normalizedSections;
  }

  for (const key of Object.keys(PERSONA_SECTION_TITLES) as PersonaSectionKey[]) {
    const value = sections[key]?.join("\n").trim();
    if (value) {
      normalizedSections[key] = value;
    }
  }

  return normalizedSections;
}

function renderPersonaProfileContent(input: {
  agentId: string;
  relativePath: string;
  text: string;
}): string {
  const sections = parsePersonaSections(input.text);
  const lines = ["[PersonaProfile]", `agent_id: ${input.agentId}`, `source: ${input.relativePath}`];

  for (const key of Object.keys(PERSONA_SECTION_TITLES) as PersonaSectionKey[]) {
    const value = sections[key];
    if (!value) continue;
    lines.push("", `[${PERSONA_SECTION_TITLES[key]}]`, value);
  }

  return lines.join("\n");
}

export function readIdentityProfile(input: ReadIdentityProfileInput): IdentityProfile | null {
  const workspaceRoot = resolve(input.workspaceRoot);
  const agentId = normalizeAgentId(input.agentId);
  const path = resolveIdentityPath(workspaceRoot, agentId);
  if (!existsSync(path)) return null;

  const text = readFileSync(path, "utf8").trim();
  if (!text) return null;

  const relativePath = relative(workspaceRoot, path) || ".";
  const content = renderPersonaProfileContent({
    agentId,
    relativePath,
    text,
  });
  return {
    schema: IDENTITY_SCHEMA,
    agentId,
    path,
    relativePath,
    content,
  };
}
