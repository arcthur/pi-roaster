export type AddonJsonPrimitive = string | number | boolean | null;
export type AddonJsonValue =
  | AddonJsonPrimitive
  | AddonJsonValue[]
  | { [key: string]: AddonJsonValue };

export type AddonConfigValueType = "string" | "number" | "boolean";

interface AddonConfigDefinitionBase {
  description: string;
  required?: boolean;
}

export interface AddonStringConfigDefinition extends AddonConfigDefinitionBase {
  type: "string";
  default?: string;
}

export interface AddonNumberConfigDefinition extends AddonConfigDefinitionBase {
  type: "number";
  default?: number;
}

export interface AddonBooleanConfigDefinition extends AddonConfigDefinitionBase {
  type: "boolean";
  default?: boolean;
}

export type AddonConfigDefinition =
  | AddonStringConfigDefinition
  | AddonNumberConfigDefinition
  | AddonBooleanConfigDefinition;

export interface AddonScheduleCron {
  cron: string;
}

export interface AddonScheduleInterval {
  intervalMs: number;
}

export type AddonJobSchedule = AddonScheduleCron | AddonScheduleInterval;

export interface PublishContextPacketInput {
  content: string;
  packetKey: string;
  label?: string;
  scopeId?: string;
  profile?: "status_summary";
  ttlMs?: number;
  meta?: Record<string, AddonJsonValue>;
}

export interface AddonArtifactStore {
  resolve(path: string): string;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readJson<T = AddonJsonValue>(path: string): Promise<T>;
  writeText(path: string, content: string): Promise<void>;
  writeJson(path: string, value: AddonJsonValue): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface AddonContextPacketPublisher {
  publish(input: PublishContextPacketInput): Promise<void>;
}

export interface AddonJobContext {
  addonId: string;
  cwd: string;
  config: Record<string, string | number | boolean | undefined>;
  artifacts: AddonArtifactStore;
  contextPackets: AddonContextPacketPublisher;
}

export interface AddonJobDefinition {
  id: string;
  schedule: AddonJobSchedule;
  run(ctx: AddonJobContext): Promise<void>;
}

export interface AddonPanelStatItem {
  label: string;
  value: string | number | boolean | null;
}

export interface AddonPanelStatsResult {
  kind: "stats";
  items: AddonPanelStatItem[];
}

export interface AddonPanelMarkdownResult {
  kind: "markdown";
  markdown: string;
}

export interface AddonPanelTableResult {
  kind: "table";
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
}

export type AddonPanelRenderResult =
  | AddonPanelStatsResult
  | AddonPanelMarkdownResult
  | AddonPanelTableResult;

export interface AddonPanelContext {
  addonId: string;
  cwd: string;
  config: Record<string, string | number | boolean | undefined>;
  artifacts: AddonArtifactStore;
}

export interface AddonPanelDefinition {
  id: string;
  title: string;
  render(ctx: AddonPanelContext): Promise<AddonPanelRenderResult>;
}

export interface BrewvaAddonDefinition {
  id: string;
  config?: Record<string, AddonConfigDefinition>;
  jobs?: AddonJobDefinition[];
  panels?: AddonPanelDefinition[];
}

export function defineAddon<T extends BrewvaAddonDefinition>(addon: T): T {
  return addon;
}
