import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AddonArtifactStore, AddonJsonValue } from "@brewva/brewva-addons";

function assertRelativePath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../")) {
    throw new Error(`invalid addon artifact path: ${path}`);
  }
  return normalized;
}

export class FileAddonArtifactStore implements AddonArtifactStore {
  constructor(private readonly rootDir: string) {}

  resolve(path: string): string {
    return resolve(this.rootDir, assertRelativePath(path));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.resolve(path));
      return true;
    } catch {
      return false;
    }
  }

  async readText(path: string): Promise<string> {
    return readFile(this.resolve(path), "utf8");
  }

  async readJson<T = AddonJsonValue>(path: string): Promise<T> {
    return JSON.parse(await this.readText(path)) as T;
  }

  async writeText(path: string, content: string): Promise<void> {
    const target = this.resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async writeJson(path: string, value: AddonJsonValue): Promise<void> {
    await this.writeText(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async remove(path: string): Promise<void> {
    await rm(this.resolve(path), { force: true });
  }
}
