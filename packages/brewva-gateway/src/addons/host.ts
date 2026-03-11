import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  AddonJobContext,
  AddonJobDefinition,
  AddonPanelDefinition,
  AddonPanelRenderResult,
  BrewvaAddonDefinition,
  PublishContextPacketInput,
} from "@brewva/brewva-addons";
import { getNextCronRunAt, parseCronExpression, type BrewvaRuntime } from "@brewva/brewva-runtime";
import { FileAddonArtifactStore } from "./artifact-store.js";
import { AddonConfigStore } from "./config-store.js";
import { discoverAddonEntrypoints, loadAddonModule } from "./loader.js";

interface PublishedContextPacketRecord extends PublishContextPacketInput {
  addonId: string;
  writtenAt: number;
}

interface LoadedAddon {
  definition: BrewvaAddonDefinition;
  configStore: AddonConfigStore;
  artifacts: FileAddonArtifactStore;
  controlDir: string;
}

export interface AddonHostOptions {
  cwd: string;
  addonsDir?: string;
}

export interface AddonPanelDescriptor {
  addonId: string;
  panel: AddonPanelDefinition;
}

type JobTimer = ReturnType<typeof setTimeout>;

function normalizeAddonId(value: string): string {
  return value.trim().replaceAll(/[^\w.-]+/g, "-");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function appendJsonLine(filePath: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

export class AddonHost {
  private readonly cwd: string;
  private readonly addonsDir: string;
  private readonly loaded = new Map<string, LoadedAddon>();
  private readonly jobTimers = new Map<string, JobTimer>();

  constructor(options: AddonHostOptions) {
    this.cwd = resolve(options.cwd);
    this.addonsDir = resolve(options.addonsDir ?? join(this.cwd, ".brewva", "addons"));
  }

  async loadAll(): Promise<void> {
    this.stopJobs();
    this.loaded.clear();

    const entrypoints = await discoverAddonEntrypoints(this.addonsDir);
    for (const entrypoint of entrypoints) {
      if (!(await pathExists(entrypoint))) continue;
      const definition = await loadAddonModule(entrypoint);
      const addonId = normalizeAddonId(definition.id);
      const controlDir = join(this.cwd, ".brewva", "addons", addonId);
      const configStore = new AddonConfigStore(
        join(controlDir, "config.json"),
        definition.config ?? {},
      );
      await configStore.validateRequired(addonId);
      const artifacts = new FileAddonArtifactStore(join(controlDir, "artifacts"));
      this.loaded.set(addonId, {
        definition: { ...definition, id: addonId },
        configStore,
        artifacts,
        controlDir,
      });
    }
  }

  listAddons(): BrewvaAddonDefinition[] {
    return Array.from(this.loaded.values()).map((entry) => entry.definition);
  }

  listPanels(): AddonPanelDescriptor[] {
    const panels: AddonPanelDescriptor[] = [];
    for (const [addonId, loaded] of this.loaded.entries()) {
      for (const panel of loaded.definition.panels ?? []) {
        panels.push({ addonId, panel });
      }
    }
    return panels;
  }

  async renderPanel(addonId: string, panelId: string): Promise<AddonPanelRenderResult> {
    const loaded = this.loaded.get(addonId);
    if (!loaded) {
      throw new Error(`unknown addon: ${addonId}`);
    }
    const panel = (loaded.definition.panels ?? []).find((entry) => entry.id === panelId);
    if (!panel) {
      throw new Error(`unknown panel: ${addonId}/${panelId}`);
    }
    return panel.render({
      addonId,
      cwd: this.cwd,
      config: await loaded.configStore.read(),
      artifacts: loaded.artifacts,
    });
  }

  startJobs(): void {
    for (const [addonId, loaded] of this.loaded.entries()) {
      for (const job of loaded.definition.jobs ?? []) {
        this.scheduleJob(addonId, loaded, job);
      }
    }
  }

  stopJobs(): void {
    for (const timer of this.jobTimers.values()) {
      clearTimeout(timer);
    }
    this.jobTimers.clear();
  }

  async applyContextPackets(
    runtime: BrewvaRuntime,
    sessionId: string,
    scopeId?: string,
  ): Promise<void> {
    for (const [addonId, loaded] of this.loaded.entries()) {
      const packets = await this.readLatestContextPackets(loaded);
      for (const packet of packets) {
        if (packet.scopeId && scopeId && packet.scopeId !== scopeId) {
          continue;
        }
        if (packet.scopeId && !scopeId) {
          continue;
        }
        runtime.proposals.submit(sessionId, {
          id: randomUUID(),
          kind: "context_packet",
          issuer: `addon:${addonId}`,
          subject: scopeId ?? sessionId,
          payload: {
            label: packet.label ?? `${addonId}:${packet.packetKey}`,
            content: packet.content,
            scopeId: packet.scopeId,
            packetKey: packet.packetKey,
            profile: packet.profile,
          },
          evidenceRefs: [],
          createdAt: packet.writtenAt,
        });
      }
    }
  }

  private scheduleJob(addonId: string, loaded: LoadedAddon, job: AddonJobDefinition): void {
    const timerKey = `${addonId}:${job.id}`;
    const enqueue = (delayMs: number) => {
      const timer = setTimeout(
        async () => {
          this.jobTimers.delete(timerKey);
          try {
            await this.runJob(addonId, loaded, job);
          } finally {
            this.scheduleJob(addonId, loaded, job);
          }
        },
        Math.max(1000, delayMs),
      );
      timer.unref?.();
      this.jobTimers.set(timerKey, timer);
    };

    if ("intervalMs" in job.schedule) {
      enqueue(job.schedule.intervalMs);
      return;
    }

    const parsed = parseCronExpression(job.schedule.cron);
    if (!parsed.ok) {
      throw new Error(`invalid addon cron schedule for ${addonId}/${job.id}`);
    }
    const nextRunAt = getNextCronRunAt(parsed.expression, Date.now());
    if (!nextRunAt) {
      throw new Error(`addon cron has no future match for ${addonId}/${job.id}`);
    }
    enqueue(nextRunAt - Date.now());
  }

  private async runJob(
    addonId: string,
    loaded: LoadedAddon,
    job: AddonJobDefinition,
  ): Promise<void> {
    const packetsFile = join(loaded.controlDir, "context-packets.jsonl");
    const publish = async (input: PublishContextPacketInput): Promise<void> => {
      await appendJsonLine(packetsFile, {
        addonId,
        writtenAt: Date.now(),
        profile: "status_summary",
        ...input,
      });
    };

    const ctx: AddonJobContext = {
      addonId,
      cwd: this.cwd,
      config: await loaded.configStore.read(),
      artifacts: loaded.artifacts,
      contextPackets: { publish },
    };
    await job.run(ctx);
  }

  private async readLatestContextPackets(
    loaded: LoadedAddon,
  ): Promise<PublishedContextPacketRecord[]> {
    const packets = await readJsonLines<PublishedContextPacketRecord>(
      join(loaded.controlDir, "context-packets.jsonl"),
    );
    const latestByKey = new Map<string, PublishedContextPacketRecord>();
    for (const packet of packets) {
      const dedupeKey = `${packet.addonId}:${packet.scopeId ?? "global"}:${packet.packetKey}`;
      const previous = latestByKey.get(dedupeKey);
      if (!previous || previous.writtenAt <= packet.writtenAt) {
        latestByKey.set(dedupeKey, packet);
      }
    }
    return Array.from(latestByKey.values()).toSorted(
      (left, right) => left.writtenAt - right.writtenAt,
    );
  }
}
