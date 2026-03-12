import {
  buildOperatorTeachingSemanticKey,
  buildEpisodeNoteContent,
  buildProcedureNoteContent,
  buildReferenceNoteContent,
  type CognitionArtifactLane,
  extractOperatorTeachingSemanticKey,
  listCognitionArtifacts,
  parseEpisodeNoteContent,
  parseProcedureNoteContent,
  parseReferenceNoteContent,
  readCognitionArtifact,
  writeCognitionArtifact,
} from "@brewva/brewva-deliberation";
import {
  COGNITION_NOTE_WRITE_FAILED_EVENT_TYPE,
  COGNITION_NOTE_WRITTEN_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatISO } from "date-fns";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

type CognitionNoteAction = "record" | "supersede" | "list";
type CognitionNoteKind = "reference" | "procedure" | "episode";

interface ListedArtifact {
  kind: CognitionNoteKind;
  lane: "reference" | "summaries";
  fileName: string;
  artifactRef: string;
  createdAt: number;
  title: string;
  semanticKey: string;
}

const ActionSchema = Type.Union([
  Type.Literal("record"),
  Type.Literal("supersede"),
  Type.Literal("list"),
]);
const KindSchema = Type.Union([
  Type.Literal("reference"),
  Type.Literal("procedure"),
  Type.Literal("episode"),
]);

function normalizeOperatorNoteString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOperatorNoteStringArray(value: unknown, maxItems = 6): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: string[] = [];
  for (const entry of value) {
    const normalized = normalizeOperatorNoteString(entry);
    if (!normalized || items.includes(normalized)) continue;
    items.push(normalized);
    if (items.length >= maxItems) {
      break;
    }
  }
  return items;
}

function resolveLane(kind: CognitionNoteKind): "reference" | "summaries" {
  return kind === "episode" ? "summaries" : "reference";
}

function buildCognitionNoteContent(input: {
  kind: CognitionNoteKind;
  name: string;
  title?: string;
  body?: string;
  sessionScope?: string;
  lessonKey?: string;
  pattern?: string;
  recommendation?: string;
  focus?: string;
  nextAction?: string;
  blockedOn: string[];
}): string | null {
  const title = input.title ?? input.name;
  if (input.kind === "reference") {
    return buildReferenceNoteContent({
      title,
      summary: input.title ?? null,
      body: input.body ?? null,
      fields: [
        { key: "reference_kind", value: "operator_teaching" },
        { key: "name", value: input.name },
      ],
    });
  }
  if (input.kind === "procedure") {
    const recommendation = normalizeOperatorNoteString(input.recommendation ?? input.body);
    if (!recommendation) {
      return null;
    }
    return buildProcedureNoteContent({
      noteKind: "operator_teaching",
      lessonKey: input.lessonKey ?? null,
      pattern: input.pattern ?? null,
      recommendation,
      fields: [
        { key: "title", value: title },
        { key: "name", value: input.name },
        { key: "operator_body", value: input.body ?? null },
      ],
    });
  }
  return buildEpisodeNoteContent({
    episodeKind: "operator_teaching",
    focus: input.focus ?? title,
    nextAction: input.nextAction ?? null,
    blockedOn: input.blockedOn,
    fields: [
      { key: "session_scope", value: input.sessionScope ?? null },
      { key: "title", value: title },
      { key: "name", value: input.name },
      { key: "operator_body", value: input.body ?? null },
    ],
  });
}

function formatListArtifacts(artifacts: ListedArtifact[]): string {
  if (artifacts.length === 0) {
    return "No matching operator cognition artifacts were found.";
  }
  return [
    "# Cognition Notes",
    ...artifacts.map(
      (artifact) =>
        `- ${artifact.kind} ${artifact.title} (${artifact.fileName}) lane=${artifact.lane} created_at=${formatISO(artifact.createdAt)}`,
    ),
  ].join("\n");
}

async function listArtifacts(
  workspaceRoot: string,
  kind?: CognitionNoteKind,
  limit = 10,
): Promise<ListedArtifact[]> {
  const lanes: CognitionArtifactLane[] =
    kind === "episode" ? ["summaries"] : kind ? [resolveLane(kind)] : ["reference", "summaries"];
  const listed: ListedArtifact[] = [];
  const seenSemanticKeys = new Set<string>();
  for (const lane of lanes) {
    const artifacts = await listCognitionArtifacts(workspaceRoot, lane);
    for (const artifact of artifacts.toReversed()) {
      const content = await readCognitionArtifact({
        workspaceRoot,
        lane,
        fileName: artifact.fileName,
      });
      const semanticKey = extractOperatorTeachingSemanticKey(content);
      if (!semanticKey || seenSemanticKeys.has(semanticKey)) {
        continue;
      }
      const reference = parseReferenceNoteContent(content);
      const procedure = parseProcedureNoteContent(content);
      const episode = parseEpisodeNoteContent(content);
      const classifiedKind: CognitionNoteKind | null = procedure
        ? "procedure"
        : episode
          ? "episode"
          : reference
            ? "reference"
            : null;
      if (!classifiedKind) {
        continue;
      }
      if (kind && classifiedKind !== kind) {
        continue;
      }
      seenSemanticKeys.add(semanticKey);
      listed.push({
        kind: classifiedKind,
        lane,
        fileName: artifact.fileName,
        artifactRef: artifact.artifactRef,
        createdAt: artifact.createdAt,
        semanticKey,
        title:
          reference?.title ??
          procedure?.lessonKey ??
          procedure?.pattern ??
          episode?.focus ??
          artifact.fileName,
      });
    }
  }
  return listed
    .toSorted((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return right.createdAt - left.createdAt;
      }
      return left.fileName.localeCompare(right.fileName);
    })
    .slice(0, limit);
}

async function hasExistingOperatorTeachingArtifact(input: {
  workspaceRoot: string;
  kind: CognitionNoteKind;
  semanticKey: string;
}): Promise<boolean> {
  const lane = resolveLane(input.kind);
  const artifacts = await listCognitionArtifacts(input.workspaceRoot, lane);
  for (const artifact of artifacts.toReversed()) {
    const content = await readCognitionArtifact({
      workspaceRoot: input.workspaceRoot,
      lane,
      fileName: artifact.fileName,
    });
    if (extractOperatorTeachingSemanticKey(content) === input.semanticKey) {
      return true;
    }
  }
  return false;
}

export function createCognitionNoteTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "cognition_note",
    label: "Cognition Note",
    description:
      "Record, supersede, or list operator-authored cognition artifacts without mutating kernel state.",
    parameters: Type.Object({
      action: ActionSchema,
      kind: Type.Optional(KindSchema),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      body: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      sessionScope: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      lessonKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
      recommendation: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      focus: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      nextAction: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      blockedOn: Type.Optional(
        Type.Union([
          Type.String({ minLength: 1, maxLength: 300 }),
          Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 6 }),
        ]),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const workspaceRoot = options.runtime.workspaceRoot;
      if (!workspaceRoot) {
        return failTextResult("Cognition note rejected (missing_workspace_root).", {
          ok: false,
          error: "missing_workspace_root",
        });
      }

      const action = params.action as CognitionNoteAction;
      const kind = params.kind as CognitionNoteKind | undefined;
      if (action === "list") {
        const artifacts = await listArtifacts(
          workspaceRoot,
          kind,
          typeof params.limit === "number" ? Math.max(1, Math.trunc(params.limit)) : 10,
        );
        return textResult(formatListArtifacts(artifacts), {
          kind: kind ?? null,
          count: artifacts.length,
          artifacts,
        });
      }

      const name = normalizeOperatorNoteString(params.name);
      if (!kind || !name) {
        return failTextResult("Cognition note rejected (missing_kind_or_name).", {
          ok: false,
          error: "missing_kind_or_name",
        });
      }
      const semanticKey = buildOperatorTeachingSemanticKey(kind, name);
      if (
        action === "record" &&
        (await hasExistingOperatorTeachingArtifact({
          workspaceRoot,
          kind,
          semanticKey,
        }))
      ) {
        return failTextResult("Cognition note rejected (duplicate_operator_teaching_name).", {
          ok: false,
          error: "duplicate_operator_teaching_name",
          kind,
          name,
        });
      }
      const content = buildCognitionNoteContent({
        kind,
        name,
        title: normalizeOperatorNoteString(params.title),
        body: normalizeOperatorNoteString(params.body),
        sessionScope: normalizeOperatorNoteString(params.sessionScope),
        lessonKey: normalizeOperatorNoteString(params.lessonKey),
        pattern: normalizeOperatorNoteString(params.pattern),
        recommendation: normalizeOperatorNoteString(params.recommendation),
        focus: normalizeOperatorNoteString(params.focus),
        nextAction: normalizeOperatorNoteString(params.nextAction),
        blockedOn:
          typeof params.blockedOn === "string"
            ? [params.blockedOn]
            : normalizeOperatorNoteStringArray(params.blockedOn),
      });
      if (!content) {
        return failTextResult("Cognition note rejected (invalid_payload_for_kind).", {
          ok: false,
          error: "invalid_payload_for_kind",
        });
      }

      try {
        const artifact = await writeCognitionArtifact({
          workspaceRoot,
          lane: resolveLane(kind),
          name,
          content,
        });
        options.runtime.events.record?.({
          sessionId,
          type: COGNITION_NOTE_WRITTEN_EVENT_TYPE,
          payload: {
            action,
            kind,
            lane: artifact.lane,
            name,
            semanticKey,
            artifactRef: artifact.artifactRef,
            fileName: artifact.fileName,
            createdAt: artifact.createdAt,
          },
        });
        return textResult(
          `${action === "supersede" ? "Superseded" : "Recorded"} ${kind} cognition note: ${artifact.fileName}`,
          {
            ok: true,
            action,
            kind,
            lane: artifact.lane,
            semanticKey,
            artifactRef: artifact.artifactRef,
            fileName: artifact.fileName,
            createdAt: artifact.createdAt,
          },
        );
      } catch (error) {
        options.runtime.events.record?.({
          sessionId,
          type: COGNITION_NOTE_WRITE_FAILED_EVENT_TYPE,
          payload: {
            action,
            kind,
            name,
            semanticKey,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
        return failTextResult("Cognition note write failed.", {
          ok: false,
          action,
          kind,
          name,
          semanticKey,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}
