import type { BrewvaToolSurface } from "./types.js";

export type { BrewvaToolSurface } from "./types.js";

export const BREWVA_TOOL_SURFACE_BY_NAME = {
  agent_broadcast: "operator",
  agent_list: "operator",
  agent_send: "operator",
  grep: "base",
  read_spans: "base",
  look_at: "base",
  toc_search: "base",
  session_compact: "base",
  resource_lease: "base",
  exec: "base",
  toc_document: "skill",
  skill_load: "skill",
  tape_handoff: "skill",
  tape_info: "skill",
  tape_search: "skill",
  task_view_state: "skill",
  ast_grep_search: "skill",
  ast_grep_replace: "skill",
  ledger_query: "skill",
  lsp_diagnostics: "skill",
  lsp_find_references: "skill",
  lsp_goto_definition: "skill",
  lsp_prepare_rename: "skill",
  lsp_rename: "skill",
  lsp_symbols: "skill",
  output_search: "skill",
  process: "skill",
  schedule_intent: "skill",
  skill_chain_control: "skill",
  skill_complete: "skill",
  task_add_item: "skill",
  task_record_blocker: "skill",
  task_resolve_blocker: "skill",
  task_set_spec: "skill",
  task_update_item: "skill",
  cost_view: "operator",
  cognition_note: "operator",
  obs_query: "operator",
  obs_slo_assert: "operator",
  obs_snapshot: "operator",
  rollback_last_patch: "operator",
} as const satisfies Record<string, BrewvaToolSurface>;

function toolNamesBySurface<S extends BrewvaToolSurface>(surface: S) {
  return (Object.entries(BREWVA_TOOL_SURFACE_BY_NAME) as [string, BrewvaToolSurface][])
    .filter((entry): entry is [string, S] => entry[1] === surface)
    .map(([name]) => name)
    .toSorted();
}

export const BASE_BREWVA_TOOL_NAMES = toolNamesBySurface("base");
export const SKILL_BREWVA_TOOL_NAMES = toolNamesBySurface("skill");
export const OPERATOR_BREWVA_TOOL_NAMES = toolNamesBySurface("operator");
export const MANAGED_BREWVA_TOOL_NAMES = Object.keys(BREWVA_TOOL_SURFACE_BY_NAME).toSorted();

export function getBrewvaToolSurface(name: string): BrewvaToolSurface | undefined {
  return BREWVA_TOOL_SURFACE_BY_NAME[name as keyof typeof BREWVA_TOOL_SURFACE_BY_NAME];
}

export function isManagedBrewvaToolName(name: string): boolean {
  return Object.hasOwn(BREWVA_TOOL_SURFACE_BY_NAME, name);
}
