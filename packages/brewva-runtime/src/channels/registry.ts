import type { ChannelAdapter } from "./adapter.js";
import { normalizeChannelId } from "./channel-id.js";

export interface AdapterRegistration {
  id: string;
  aliases?: string[];
  create: () => ChannelAdapter;
}

interface RegistryEntry {
  id: string;
  aliases: string[];
  create: () => ChannelAdapter;
}

function normalizeToken(value: string): string {
  return normalizeChannelId(value);
}

function normalizeAliases(aliases: string[] | undefined, id: string): string[] {
  if (!aliases || aliases.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  for (const alias of aliases) {
    const normalized = normalizeToken(alias);
    if (!normalized || normalized === id) {
      continue;
    }
    seen.add(normalized);
  }
  return Array.from(seen);
}

export class ChannelAdapterRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly aliasToId = new Map<string, string>();

  register(input: AdapterRegistration): string {
    const id = normalizeToken(input.id);
    if (!id) {
      throw new Error("adapter id is required");
    }
    if (this.entries.has(id)) {
      throw new Error(`adapter already registered: ${id}`);
    }

    const aliases = normalizeAliases(input.aliases, id);
    for (const alias of [id, ...aliases]) {
      const owner = this.aliasToId.get(alias);
      if (owner && owner !== id) {
        throw new Error(`adapter alias already registered: ${alias} -> ${owner}`);
      }
    }

    this.entries.set(id, { id, aliases, create: input.create });
    this.aliasToId.set(id, id);
    for (const alias of aliases) {
      this.aliasToId.set(alias, id);
    }
    return id;
  }

  unregister(idOrAlias: string): boolean {
    const id = this.resolveId(idOrAlias);
    if (!id) {
      return false;
    }
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    this.entries.delete(id);
    this.aliasToId.delete(id);
    for (const alias of entry.aliases) {
      this.aliasToId.delete(alias);
    }
    return true;
  }

  resolveId(idOrAlias: string): string | undefined {
    const normalized = normalizeToken(idOrAlias);
    if (!normalized) {
      return undefined;
    }
    return this.aliasToId.get(normalized);
  }

  createAdapter(idOrAlias: string): ChannelAdapter | undefined {
    const id = this.resolveId(idOrAlias);
    if (!id) {
      return undefined;
    }
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    const adapter = entry.create();
    const adapterId = normalizeToken(adapter.id);
    if (adapterId !== id) {
      throw new Error(`adapter id mismatch: expected ${id}, got ${adapter.id}`);
    }
    return adapter;
  }

  list(): Array<{ id: string; aliases: string[] }> {
    return Array.from(this.entries.values())
      .map((entry) => ({ id: entry.id, aliases: [...entry.aliases] }))
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }
}
