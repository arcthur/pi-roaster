import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function ensureDirForFile(filePath: string): void {
  const parent = dirname(resolve(filePath));
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

export function ensureDir(path: string): void {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    mkdirSync(resolved, { recursive: true });
  }
}

export function writeFileAtomic(filePath: string, content: string | NodeJS.ArrayBufferView): void {
  ensureDirForFile(filePath);
  const parent = dirname(resolve(filePath));
  const tempPath = join(
    parent,
    `.${Math.random().toString(36).slice(2, 10)}.${Date.now().toString(36)}.tmp`,
  );

  if (typeof content === "string") {
    writeFileSync(tempPath, content, "utf8");
  } else {
    writeFileSync(tempPath, content);
  }
  renameSync(tempPath, resolve(filePath));
}
