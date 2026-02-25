import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime, type BrewvaConfig } from "@brewva/brewva-runtime";

export interface RuntimeFixtureOptions {
  config?: BrewvaConfig;
  context?: Partial<BrewvaRuntime["context"]>;
  events?: Partial<BrewvaRuntime["events"]>;
  tools?: Partial<BrewvaRuntime["tools"]>;
  session?: Partial<BrewvaRuntime["session"]>;
  memory?: Partial<BrewvaRuntime["memory"]>;
}

export function createRuntimeConfig(mutate?: (config: BrewvaConfig) => void): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  mutate?.(config);
  return config;
}

export function createRuntimeFixture(options: RuntimeFixtureOptions = {}): BrewvaRuntime {
  const runtime = new BrewvaRuntime({
    cwd: mkdtempSync(join(tmpdir(), "brewva-ext-runtime-fixture-")),
    config: options.config,
  });

  if (options.context) {
    Object.assign(runtime.context, options.context);
  }
  if (options.events) {
    Object.assign(runtime.events, options.events);
  }
  if (options.tools) {
    Object.assign(runtime.tools, options.tools);
  }
  if (options.session) {
    Object.assign(runtime.session, options.session);
  }
  if (options.memory) {
    Object.assign(runtime.memory, options.memory);
  }

  return runtime;
}
