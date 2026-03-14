import {
  getExactToolGovernanceDescriptor,
  type ToolGovernanceDescriptor,
  normalizeToolName,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { getBrewvaToolSurface } from "../surface.js";
import type { BrewvaManagedToolDefinition, BrewvaToolMetadata } from "../types.js";

export function defineTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

function cloneGovernanceDescriptor(input: ToolGovernanceDescriptor): ToolGovernanceDescriptor {
  return {
    effects: [...new Set(input.effects)],
    defaultRisk: input.defaultRisk,
    posture: input.posture,
  };
}

function resolveCanonicalBrewvaToolMetadata(
  toolName: string,
  metadata: Partial<BrewvaToolMetadata> = {},
): BrewvaToolMetadata | undefined {
  const normalizedName = normalizeToolName(toolName);
  if (!normalizedName) {
    return undefined;
  }
  const surface = metadata.surface ?? getBrewvaToolSurface(normalizedName);
  if (!surface) {
    return undefined;
  }
  const governance = metadata.governance ?? getExactToolGovernanceDescriptor(normalizedName);
  if (!governance) {
    return undefined;
  }
  return {
    surface,
    governance: cloneGovernanceDescriptor(governance),
  };
}

export function defineBrewvaTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
  metadata: Partial<BrewvaToolMetadata> = {},
): BrewvaManagedToolDefinition {
  const normalizedName = normalizeToolName(tool.name);
  const canonicalMetadata = resolveCanonicalBrewvaToolMetadata(normalizedName, metadata);
  if (!canonicalMetadata?.surface) {
    throw new Error(`managed Brewva tool '${normalizedName}' is missing surface metadata`);
  }
  if (!canonicalMetadata.governance) {
    throw new Error(`managed Brewva tool '${normalizedName}' is missing governance metadata`);
  }

  const managed = {
    ...(tool as unknown as Record<string, unknown>),
  } as unknown as BrewvaManagedToolDefinition;
  Object.defineProperty(managed, "brewva", {
    enumerable: true,
    configurable: false,
    get() {
      return resolveCanonicalBrewvaToolMetadata(normalizedName, metadata) ?? canonicalMetadata;
    },
  });
  return managed;
}

export function getBrewvaToolMetadata(
  tool: ToolDefinition | BrewvaManagedToolDefinition | undefined,
): BrewvaToolMetadata | undefined {
  const metadata = (tool as BrewvaManagedToolDefinition | undefined)?.brewva;
  if (metadata) {
    return {
      surface: metadata.surface,
      governance: cloneGovernanceDescriptor(metadata.governance),
    };
  }
  return resolveCanonicalBrewvaToolMetadata(tool?.name ?? "");
}
