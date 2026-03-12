import { existsSync, statSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import ts from "typescript";
import { escapeRegexLiteral, tokenizeSearchTerms } from "./shared/query.js";
import { DEFAULT_SKIPPED_WORKSPACE_DIRS, walkWorkspaceFiles } from "./shared/workspace-walk.js";
import {
  readSourceTextWithCache,
  registerTocSourceCacheRuntime,
  resolveTocSessionKey,
} from "./toc-cache.js";
import type { BrewvaToolRuntime } from "./types.js";
import { getToolSessionId } from "./utils/parallel-read.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

const TOC_EVENT_TYPE = "tool_toc_query";
const JS_TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_CACHE_SESSIONS = 64;
const MAX_CACHE_ENTRIES_PER_SESSION = 512;
const DEFAULT_TOC_SEARCH_LIMIT = 8;
const MAX_TOC_SEARCH_LIMIT = 50;
const MAX_TOC_FILE_BYTES = 1_000_000;
const MAX_TOC_SEARCH_CANDIDATE_FILES = 2_000;
const MAX_TOC_SEARCH_INDEXED_BYTES = 8_000_000;
const BROAD_QUERY_MIN_FILE_COUNT = 3;
const BROAD_QUERY_SINGLE_TOKEN_RATIO = 0.35;
const BROAD_QUERY_MULTI_TOKEN_RATIO = 0.6;
const BROAD_QUERY_FACTOR = 4;
const BROAD_QUERY_ABSOLUTE_CANDIDATES = 12;
const UNAVAILABLE_STATUS = "unavailable";

type TocDeclarationKind = "interface" | "type_alias" | "enum";
type TocSymbolKind =
  | "function"
  | "const_function"
  | "class"
  | TocDeclarationKind
  | "method"
  | "getter"
  | "setter";
type TocSearchMatchKind = TocSymbolKind | "module" | "import";

interface TocImportEntry {
  source: string;
  clause: string | null;
  lineStart: number;
  lineEnd: number;
}

interface TocMethodEntry {
  kind: "method" | "getter" | "setter";
  name: string;
  static: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
}

interface TocFunctionEntry {
  kind: "function" | "const_function";
  name: string;
  exported: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
}

interface TocClassEntry {
  kind: "class";
  name: string;
  exported: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
  methods: TocMethodEntry[];
}

interface TocDeclarationEntry {
  kind: TocDeclarationKind;
  name: string;
  exported: boolean;
  lineStart: number;
  lineEnd: number;
  signature: string;
  summary: string | null;
}

interface TocDocument {
  filePath: string;
  language: string;
  moduleSummary: string | null;
  imports: TocImportEntry[];
  functions: TocFunctionEntry[];
  classes: TocClassEntry[];
  declarations: TocDeclarationEntry[];
}

interface TocSearchMatch {
  filePath: string;
  kind: TocSearchMatchKind;
  name: string;
  score: number;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  summary: string | null;
  parentName: string | null;
}

interface TocCacheEntry {
  signature: string;
  toc: TocDocument;
}

interface TocLookupResult {
  toc: TocDocument;
  cacheHit: boolean;
}

interface TocSearchSummary {
  indexedFiles: number;
  candidateFiles: number;
  cacheHits: number;
  cacheMisses: number;
  skippedFiles: number;
  oversizedFiles: number;
  indexedBytes: number;
}

type TocSessionCacheStore = Map<string, Map<string, TocCacheEntry>>;

function trimToSingleLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? firstLine.replace(/\s+/gu, " ") : null;
}

function normalizeRelativePath(baseDir: string, filePath: string): string {
  const relativePath = relative(baseDir, filePath).replaceAll("\\", "/");
  return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : filePath;
}

function supportsToc(filePath: string): boolean {
  return JS_TS_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function resolveScriptKind(filePath: string): ts.ScriptKind {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".ts") return ts.ScriptKind.TS;
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js") return ts.ScriptKind.JS;
  if (extension === ".mjs") return ts.ScriptKind.JS;
  if (extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.Unknown;
}

function lineSpan(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { lineStart: number; lineEnd: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const endPosition = Math.max(node.getStart(sourceFile), node.getEnd() - 1);
  const end = sourceFile.getLineAndCharacterOfPosition(endPosition);
  return {
    lineStart: start.line + 1,
    lineEnd: end.line + 1,
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return Boolean(modifiers?.some((modifier) => modifier.kind === kind));
}

function isExportedDeclaration(node: ts.Node): boolean {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(node, ts.SyntaxKind.DefaultKeyword)
  );
}

function buildFunctionSignature(
  name: string,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  prefix = "function",
): string {
  const params = parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
  const returnType = type ? `: ${type.getText(sourceFile)}` : "";
  return `${prefix} ${name}(${params})${returnType}`;
}

function buildAnonymousDefaultFunctionSignature(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): string {
  const params = parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
  const returnType = type ? `: ${type.getText(sourceFile)}` : "";
  return `export default function(${params})${returnType}`;
}

function formatTypeParameters(
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  sourceFile: ts.SourceFile,
): string {
  if (!typeParameters || typeParameters.length === 0) return "";
  return `<${typeParameters.map((parameter) => parameter.getText(sourceFile)).join(", ")}>`;
}

function compactInlineText(value: string, maxChars = 180): string {
  const compact = trimToSingleLine(value) ?? "";
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function buildMethodSignature(
  name: string,
  node:
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.MethodSignature,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isGetAccessorDeclaration(node)) {
    const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : "";
    return `get ${name}()${returnType}`;
  }
  if (ts.isSetAccessorDeclaration(node)) {
    const params = node.parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
    return `set ${name}(${params})`;
  }
  const params = node.parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
  const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : "";
  return `${name}(${params})${returnType}`;
}

function buildImportClauseText(node: ts.ImportDeclaration): string | null {
  const clause = node.importClause;
  if (!clause) return null;

  const parts: string[] = [];
  if (clause.name) {
    parts.push(clause.name.text);
  }
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      parts.push(`* as ${clause.namedBindings.name.text}`);
    } else {
      const names = clause.namedBindings.elements.map((element) => {
        const propertyName = element.propertyName?.text;
        const localName = element.name.text;
        return propertyName && propertyName !== localName
          ? `${propertyName} as ${localName}`
          : localName;
      });
      parts.push(`{ ${names.join(", ")} }`);
    }
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

function extractTopOfFileSummary(sourceText: string): string | null {
  const text = sourceText.replace(/^\uFEFF/u, "");
  const lines = text.split(/\r?\n/u);
  let index = 0;

  while (index < lines.length) {
    const line = (lines[index] ?? "").trim();
    if (!line || line === "#!/usr/bin/env node") {
      index += 1;
      continue;
    }

    if (line.startsWith("//")) {
      return trimToSingleLine(line.replace(/^\/\/+\s*/u, ""));
    }

    if (line.startsWith("/*")) {
      const block: string[] = [];
      for (; index < lines.length; index += 1) {
        const current = lines[index] ?? "";
        block.push(
          current
            .replace(/^\s*\/\*\*?/u, "")
            .replace(/\*\/\s*$/u, "")
            .replace(/^\s*\*\s?/u, "")
            .trim(),
        );
        if (current.includes("*/")) break;
      }
      return trimToSingleLine(block.join("\n"));
    }

    return null;
  }

  return null;
}

function extractNodeSummary(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const jsDocNodes = (node as ts.Node & { jsDoc?: Array<{ comment?: unknown }> }).jsDoc;
  if (Array.isArray(jsDocNodes) && jsDocNodes.length > 0) {
    const jsDocComment = jsDocNodes[0]?.comment;
    if (typeof jsDocComment === "string") {
      return trimToSingleLine(jsDocComment);
    }
    if (Array.isArray(jsDocComment)) {
      const text = jsDocComment
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const value = (part as { text?: unknown }).text;
          return typeof value === "string" ? value : "";
        })
        .join("");
      return trimToSingleLine(text);
    }
  }

  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
  const lastRange = ranges.at(-1);
  if (!lastRange) return null;
  const commentText = sourceFile.text.slice(lastRange.pos, lastRange.end);
  const normalized = commentText
    .replace(/^\/\*\*?/u, "")
    .replace(/\*\/$/u, "")
    .replace(/^\/\/+/u, "")
    .replace(/^\s*\*\s?/gmu, "")
    .trim();
  return trimToSingleLine(normalized);
}

function buildMethodEntry(
  node: ts.ClassElement,
  sourceFile: ts.SourceFile,
): TocMethodEntry | undefined {
  if (
    !ts.isMethodDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)
  ) {
    return undefined;
  }
  const nameNode = node.name;
  if (!nameNode || !ts.isIdentifier(nameNode)) return undefined;
  if (
    hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
  ) {
    return undefined;
  }

  const span = lineSpan(sourceFile, node);
  const kind: TocMethodEntry["kind"] = ts.isGetAccessorDeclaration(node)
    ? "getter"
    : ts.isSetAccessorDeclaration(node)
      ? "setter"
      : "method";
  return {
    kind,
    name: nameNode.text,
    static: hasModifier(node, ts.SyntaxKind.StaticKeyword),
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    signature: buildMethodSignature(nameNode.text, node, sourceFile),
    summary: extractNodeSummary(node, sourceFile),
  };
}

function buildFunctionEntry(
  node: ts.FunctionDeclaration | ts.VariableStatement,
  sourceFile: ts.SourceFile,
): TocFunctionEntry[] {
  if (ts.isFunctionDeclaration(node)) {
    const isAnonymousDefaultExport = !node.name && hasModifier(node, ts.SyntaxKind.DefaultKeyword);
    if (!node.name && !isAnonymousDefaultExport) return [];
    const name = node.name?.text ?? "default";
    const span = lineSpan(sourceFile, node);
    return [
      {
        kind: "function",
        name,
        exported: isExportedDeclaration(node),
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        signature: isAnonymousDefaultExport
          ? buildAnonymousDefaultFunctionSignature(node.parameters, node.type, sourceFile)
          : buildFunctionSignature(name, node.parameters, node.type, sourceFile, "function"),
        summary: extractNodeSummary(node, sourceFile),
      },
    ];
  }

  const entries: TocFunctionEntry[] = [];
  for (const declaration of node.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const initializer = declaration.initializer;
    if (
      !initializer ||
      (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))
    ) {
      continue;
    }
    const span = lineSpan(sourceFile, declaration);
    entries.push({
      kind: "const_function",
      name: declaration.name.text,
      exported: isExportedDeclaration(node),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      signature: buildFunctionSignature(
        declaration.name.text,
        initializer.parameters,
        initializer.type,
        sourceFile,
        "const",
      ),
      summary: extractNodeSummary(node, sourceFile),
    });
  }
  return entries;
}

function buildDeclarationEntry(
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
  sourceFile: ts.SourceFile,
): TocDeclarationEntry {
  const span = lineSpan(sourceFile, node);

  if (ts.isInterfaceDeclaration(node)) {
    const typeParams = formatTypeParameters(node.typeParameters, sourceFile);
    const heritage = node.heritageClauses
      ?.map((clause) => {
        const clauseName = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
        const types = clause.types.map((entry) => entry.getText(sourceFile)).join(", ");
        return `${clauseName} ${types}`;
      })
      .join(" ");

    return {
      kind: "interface",
      name: node.name.text,
      exported: isExportedDeclaration(node),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      signature: `interface ${node.name.text}${typeParams}${heritage ? ` ${heritage}` : ""}`,
      summary: extractNodeSummary(node, sourceFile),
    };
  }

  if (ts.isTypeAliasDeclaration(node)) {
    const typeParams = formatTypeParameters(node.typeParameters, sourceFile);
    return {
      kind: "type_alias",
      name: node.name.text,
      exported: isExportedDeclaration(node),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      signature: `type ${node.name.text}${typeParams} = ${compactInlineText(node.type.getText(sourceFile))}`,
      summary: extractNodeSummary(node, sourceFile),
    };
  }

  return {
    kind: "enum",
    name: node.name.text,
    exported: isExportedDeclaration(node),
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    signature: `${hasModifier(node, ts.SyntaxKind.ConstKeyword) ? "const " : ""}enum ${node.name.text}`,
    summary: extractNodeSummary(node, sourceFile),
  };
}

function parseTocDocument(filePath: string, sourceText: string): TocDocument {
  const language = extname(filePath).replace(/^\./u, "").toLowerCase() || "unknown";
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    resolveScriptKind(filePath),
  );

  const imports: TocImportEntry[] = [];
  const functions: TocFunctionEntry[] = [];
  const classes: TocClassEntry[] = [];
  const declarations: TocDeclarationEntry[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const span = lineSpan(sourceFile, statement);
      const moduleSpecifier = statement.moduleSpecifier
        .getText(sourceFile)
        .replace(/^['"]|['"]$/gu, "");
      imports.push({
        source: moduleSpecifier,
        clause: buildImportClauseText(statement),
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
      });
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)) {
      functions.push(...buildFunctionEntry(statement, sourceFile));
      continue;
    }

    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      declarations.push(buildDeclarationEntry(statement, sourceFile));
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      const isAnonymousDefaultExport =
        !statement.name && hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      if (!statement.name && !isAnonymousDefaultExport) {
        continue;
      }
      const className = statement.name?.text ?? "default";
      const span = lineSpan(sourceFile, statement);
      const methods = statement.members
        .map((member) => buildMethodEntry(member, sourceFile))
        .filter((entry): entry is TocMethodEntry => Boolean(entry));
      classes.push({
        kind: "class",
        name: className,
        exported: isExportedDeclaration(statement),
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        signature: isAnonymousDefaultExport ? "export default class" : `class ${className}`,
        summary: extractNodeSummary(statement, sourceFile),
        methods,
      });
    }
  }

  return {
    filePath,
    language,
    moduleSummary: extractTopOfFileSummary(sourceText),
    imports,
    functions,
    classes,
    declarations,
  };
}

function getSessionCache(
  cacheStore: TocSessionCacheStore,
  sessionKey: string,
): Map<string, TocCacheEntry> {
  const existing = cacheStore.get(sessionKey);
  if (existing) {
    cacheStore.delete(sessionKey);
    cacheStore.set(sessionKey, existing);
    return existing;
  }

  const created = new Map<string, TocCacheEntry>();
  cacheStore.set(sessionKey, created);
  while (cacheStore.size > MAX_CACHE_SESSIONS) {
    const oldest = cacheStore.keys().next().value;
    if (!oldest) break;
    cacheStore.delete(oldest);
  }
  return created;
}

function cacheLookup(input: {
  cacheStore: TocSessionCacheStore;
  sessionKey: string;
  absolutePath: string;
  signature: string;
  sourceText: string;
}): TocLookupResult {
  const cache = getSessionCache(input.cacheStore, input.sessionKey);
  const cached = cache.get(input.absolutePath);
  if (cached && cached.signature === input.signature) {
    cache.delete(input.absolutePath);
    cache.set(input.absolutePath, cached);
    return {
      toc: cached.toc,
      cacheHit: true,
    };
  }

  const toc = parseTocDocument(input.absolutePath, input.sourceText);
  cache.set(input.absolutePath, {
    signature: input.signature,
    toc,
  });
  while (cache.size > MAX_CACHE_ENTRIES_PER_SESSION) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return {
    toc,
    cacheHit: false,
  };
}

function resolveBaseDir(ctx: unknown, runtime?: BrewvaToolRuntime): string {
  const cwd =
    ctx && typeof ctx === "object" && typeof (ctx as { cwd?: unknown }).cwd === "string"
      ? (ctx as { cwd: string }).cwd
      : runtime?.cwd;
  return resolve(cwd ?? process.cwd());
}

function resolveAbsolutePath(baseDir: string, target: string): string {
  return resolve(baseDir, target);
}

function walkTocFiles(paths: string[]): { files: string[]; scopeOverflow: boolean } {
  const { files, overflow } = walkWorkspaceFiles({
    roots: paths,
    maxFiles: MAX_TOC_SEARCH_CANDIDATE_FILES,
    isMatch: (filePath) => supportsToc(filePath),
    skippedDirs: DEFAULT_SKIPPED_WORKSPACE_DIRS,
  });
  return { files: files.toSorted(), scopeOverflow: overflow };
}

function splitSearchTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ];
}

function hasWordBoundaryMatch(value: string, token: string): boolean {
  if (!value || !token) return false;
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_-])${escapeRegexLiteral(token)}($|[^\\p{L}\\p{N}_-])`,
    "iu",
  ).test(value);
}

function scoreField(query: string, tokens: string[], field: string | null | undefined): number {
  if (!field) return 0;
  const lower = field.toLowerCase();
  const fieldTerms = new Set(splitSearchTerms(field));
  let score = 0;
  if (lower === query) score += 30;
  if (fieldTerms.has(query)) score += 20;
  if (hasWordBoundaryMatch(lower, query)) score += 10;
  if (lower.includes(query)) score += 12;
  for (const token of tokens) {
    if (lower === token) {
      score += 12;
      continue;
    }
    if (fieldTerms.has(token)) {
      score += Math.max(4, token.length + 2);
      continue;
    }
    if (hasWordBoundaryMatch(lower, token)) {
      score += Math.max(3, token.length + 1);
      continue;
    }
    if (lower.includes(token)) {
      score += Math.max(2, token.length);
    }
  }
  return score;
}

function formatLineSpan(lineStart: number, lineEnd: number): string {
  return lineStart === lineEnd ? `L${lineStart}` : `L${lineStart}-L${lineEnd}`;
}

function buildDocumentText(toc: TocDocument, baseDir: string): string {
  const lines: string[] = [
    "[TOCDocument]",
    `file: ${normalizeRelativePath(baseDir, toc.filePath)}`,
    `language: ${toc.language}`,
    `module_summary: ${toc.moduleSummary ?? "n/a"}`,
    `imports_count: ${toc.imports.length}`,
    `functions_count: ${toc.functions.length}`,
    `classes_count: ${toc.classes.length}`,
    `declarations_count: ${toc.declarations.length}`,
    "",
    "[Imports]",
  ];

  if (toc.imports.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of toc.imports) {
      lines.push(
        `- lines=${formatLineSpan(entry.lineStart, entry.lineEnd)} source=${entry.source} clause=${entry.clause ?? "n/a"}`,
      );
    }
  }

  lines.push("", "[Functions]");
  if (toc.functions.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of toc.functions) {
      lines.push(
        `- lines=${formatLineSpan(entry.lineStart, entry.lineEnd)} kind=${entry.kind} name=${entry.name} exported=${entry.exported ? "true" : "false"} signature=${JSON.stringify(entry.signature)} summary=${JSON.stringify(entry.summary ?? "n/a")}`,
      );
    }
  }

  lines.push("", "[Declarations]");
  if (toc.declarations.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of toc.declarations) {
      lines.push(
        `- lines=${formatLineSpan(entry.lineStart, entry.lineEnd)} kind=${entry.kind} name=${entry.name} exported=${entry.exported ? "true" : "false"} signature=${JSON.stringify(entry.signature)} summary=${JSON.stringify(entry.summary ?? "n/a")}`,
      );
    }
  }

  lines.push("", "[Classes]");
  if (toc.classes.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of toc.classes) {
      lines.push(
        `- lines=${formatLineSpan(entry.lineStart, entry.lineEnd)} kind=class name=${entry.name} exported=${entry.exported ? "true" : "false"} signature=${JSON.stringify(entry.signature)} summary=${JSON.stringify(entry.summary ?? "n/a")}`,
      );
      if (entry.methods.length === 0) {
        lines.push(`- parent=${entry.name} methods=none`);
        continue;
      }
      for (const method of entry.methods) {
        lines.push(
          `- parent=${entry.name} lines=${formatLineSpan(method.lineStart, method.lineEnd)} kind=${method.kind} name=${method.name} static=${method.static ? "true" : "false"} signature=${JSON.stringify(method.signature)} summary=${JSON.stringify(method.summary ?? "n/a")}`,
        );
      }
    }
  }

  return lines.join("\n");
}

function searchDocument(
  toc: TocDocument,
  baseDir: string,
  query: string,
  tokens: string[],
): TocSearchMatch[] {
  const relativePath = normalizeRelativePath(baseDir, toc.filePath);
  const matches: TocSearchMatch[] = [];

  const moduleScore =
    scoreField(query, tokens, relativePath) + scoreField(query, tokens, toc.moduleSummary);
  if (moduleScore > 0) {
    matches.push({
      filePath: toc.filePath,
      kind: "module",
      name: basename(toc.filePath),
      score: moduleScore,
      lineStart: 1,
      lineEnd: 1,
      signature: null,
      summary: toc.moduleSummary,
      parentName: null,
    });
  }

  for (const entry of toc.imports) {
    const score =
      scoreField(query, tokens, entry.source) +
      scoreField(query, tokens, entry.clause) +
      scoreField(query, tokens, relativePath);
    if (score <= 0) continue;
    matches.push({
      filePath: toc.filePath,
      kind: "import",
      name: entry.source,
      score,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      signature: entry.clause
        ? `import ${entry.clause} from "${entry.source}"`
        : `import "${entry.source}"`,
      summary: null,
      parentName: null,
    });
  }

  for (const entry of toc.functions) {
    const score =
      scoreField(query, tokens, entry.name) +
      scoreField(query, tokens, entry.signature) +
      scoreField(query, tokens, entry.summary) +
      scoreField(query, tokens, entry.exported ? "export" : undefined);
    if (score <= 0) continue;
    matches.push({
      filePath: toc.filePath,
      kind: entry.kind,
      name: entry.name,
      score,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      signature: entry.signature,
      summary: entry.summary,
      parentName: null,
    });
  }

  for (const entry of toc.declarations) {
    const score =
      scoreField(query, tokens, entry.name) +
      scoreField(query, tokens, entry.signature) +
      scoreField(query, tokens, entry.summary) +
      scoreField(query, tokens, entry.exported ? "export" : undefined);
    if (score <= 0) continue;
    matches.push({
      filePath: toc.filePath,
      kind: entry.kind,
      name: entry.name,
      score,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      signature: entry.signature,
      summary: entry.summary,
      parentName: null,
    });
  }

  for (const entry of toc.classes) {
    const classScore =
      scoreField(query, tokens, entry.name) +
      scoreField(query, tokens, entry.signature) +
      scoreField(query, tokens, entry.summary) +
      scoreField(query, tokens, entry.exported ? "export" : undefined);
    if (classScore > 0) {
      matches.push({
        filePath: toc.filePath,
        kind: "class",
        name: entry.name,
        score: classScore,
        lineStart: entry.lineStart,
        lineEnd: entry.lineEnd,
        signature: entry.signature,
        summary: entry.summary,
        parentName: null,
      });
    }

    for (const method of entry.methods) {
      const methodScore =
        scoreField(query, tokens, method.name) +
        scoreField(query, tokens, method.signature) +
        scoreField(query, tokens, method.summary) +
        scoreField(query, tokens, entry.name);
      if (methodScore <= 0) continue;
      matches.push({
        filePath: toc.filePath,
        kind: method.kind,
        name: method.name,
        score: methodScore,
        lineStart: method.lineStart,
        lineEnd: method.lineEnd,
        signature: method.signature,
        summary: method.summary,
        parentName: entry.name,
      });
    }
  }

  return matches;
}

function summarizeSearch(
  query: string,
  matches: TocSearchMatch[],
  summary: TocSearchSummary,
  baseDir: string,
): string {
  const lines: string[] = [
    "[TOCSearch]",
    `query: ${query}`,
    "status: ok",
    `indexed_files: ${summary.indexedFiles}`,
    `candidate_files: ${summary.candidateFiles}`,
    `matches_shown: ${matches.length}`,
    `cache_hits: ${summary.cacheHits}`,
    `cache_misses: ${summary.cacheMisses}`,
    `skipped_files: ${summary.skippedFiles}`,
    `oversized_files: ${summary.oversizedFiles}`,
    `indexed_bytes: ${summary.indexedBytes}`,
    "follow_up_hint: Prefer read_spans for exact line ranges; use grep for broad text search.",
    "",
  ];

  for (const match of matches) {
    lines.push(
      `- score=${match.score} file=${normalizeRelativePath(baseDir, match.filePath)} kind=${match.kind} name=${match.name} lines=${formatLineSpan(match.lineStart, match.lineEnd)} parent=${match.parentName ?? "n/a"} signature=${JSON.stringify(match.signature ?? "n/a")} summary=${JSON.stringify(match.summary ?? "n/a")}`,
    );
  }

  return lines.join("\n");
}

function summarizeBroadQuery(input: {
  query: string;
  preview: TocSearchMatch[];
  summary: TocSearchSummary;
  baseDir: string;
}): string {
  const lines: string[] = [
    "[TOCSearch]",
    `query: ${input.query}`,
    `status: ${UNAVAILABLE_STATUS}`,
    "reason: broad_query",
    `indexed_files: ${input.summary.indexedFiles}`,
    `candidate_files: ${input.summary.candidateFiles}`,
    `matches_shown: ${input.preview.length}`,
    `cache_hits: ${input.summary.cacheHits}`,
    `cache_misses: ${input.summary.cacheMisses}`,
    `skipped_files: ${input.summary.skippedFiles}`,
    `oversized_files: ${input.summary.oversizedFiles}`,
    `indexed_bytes: ${input.summary.indexedBytes}`,
    "next_step: Narrow the query to a symbol/import name or switch to grep for broad text search.",
  ];

  if (input.preview.length > 0) {
    lines.push("", "[TopCandidates]");
    for (const match of input.preview) {
      lines.push(
        `- file=${normalizeRelativePath(input.baseDir, match.filePath)} kind=${match.kind} name=${match.name} lines=${formatLineSpan(match.lineStart, match.lineEnd)} score=${match.score}`,
      );
    }
  }

  return lines.join("\n");
}

function summarizeScopeOverflow(input: {
  query: string;
  candidateFiles: number;
  baseDir: string;
}): string {
  return [
    "[TOCSearch]",
    `query: ${input.query}`,
    `status: ${UNAVAILABLE_STATUS}`,
    "reason: search_scope_too_large",
    `candidate_files_scanned: ${input.candidateFiles}`,
    `walk_limit: ${MAX_TOC_SEARCH_CANDIDATE_FILES}`,
    `workspace_root: ${input.baseDir}`,
    "next_step: Narrow paths to a package/folder first, then retry toc_search.",
  ].join("\n");
}

function summarizeIndexBudgetExceeded(input: {
  query: string;
  preview: TocSearchMatch[];
  summary: TocSearchSummary;
  baseDir: string;
}): string {
  const lines: string[] = [
    "[TOCSearch]",
    `query: ${input.query}`,
    `status: ${UNAVAILABLE_STATUS}`,
    "reason: indexing_budget_exceeded",
    `indexed_files: ${input.summary.indexedFiles}`,
    `candidate_files: ${input.summary.candidateFiles}`,
    `cache_hits: ${input.summary.cacheHits}`,
    `cache_misses: ${input.summary.cacheMisses}`,
    `skipped_files: ${input.summary.skippedFiles}`,
    `oversized_files: ${input.summary.oversizedFiles}`,
    `indexed_bytes: ${input.summary.indexedBytes}`,
    `indexed_bytes_limit: ${MAX_TOC_SEARCH_INDEXED_BYTES}`,
    "next_step: Narrow paths or query terms before retrying toc_search.",
  ];

  if (input.preview.length > 0) {
    lines.push("", "[IndexedPreview]");
    for (const match of input.preview) {
      lines.push(
        `- file=${normalizeRelativePath(input.baseDir, match.filePath)} kind=${match.kind} name=${match.name} lines=${formatLineSpan(match.lineStart, match.lineEnd)} score=${match.score}`,
      );
    }
  }

  return lines.join("\n");
}

function recordTocEvent(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string | undefined,
  payload: Record<string, unknown>,
): void {
  if (!runtime?.events.record || !sessionId) return;
  runtime.events.record({
    sessionId,
    type: TOC_EVENT_TYPE,
    payload,
  });
}

function resolveBroadQuery(input: {
  candidateFiles: number;
  indexedFiles: number;
  limit: number;
  tokens: string[];
}): boolean {
  if (input.indexedFiles <= 0 || input.candidateFiles <= 0) return false;
  const ratio = input.candidateFiles / input.indexedFiles;
  const ratioThreshold =
    input.tokens.length <= 1 ? BROAD_QUERY_SINGLE_TOKEN_RATIO : BROAD_QUERY_MULTI_TOKEN_RATIO;
  const absoluteThreshold = Math.max(
    input.limit * BROAD_QUERY_FACTOR,
    BROAD_QUERY_ABSOLUTE_CANDIDATES,
  );
  if (input.candidateFiles > absoluteThreshold) return true;
  return input.candidateFiles >= BROAD_QUERY_MIN_FILE_COUNT && ratio >= ratioThreshold;
}

export function createTocTools(options?: { runtime?: BrewvaToolRuntime }): ToolDefinition[] {
  const sessionCache = new Map<string, Map<string, TocCacheEntry>>();
  registerTocSourceCacheRuntime(options?.runtime);
  options?.runtime?.session?.onClearState?.((sessionId) => {
    sessionCache.delete(resolveTocSessionKey(sessionId));
  });

  const tocDocument = defineBrewvaTool({
    name: "toc_document",
    label: "TOC Document",
    description:
      "Return a structural table of contents for one TS/JS file: imports, top-level symbols, public methods, summaries, and line spans.",
    parameters: Type.Object({
      file_path: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const baseDir = resolveBaseDir(ctx, options?.runtime);
      const absolutePath = resolveAbsolutePath(baseDir, params.file_path);
      if (!existsSync(absolutePath)) {
        return failTextResult(`Error: File not found: ${absolutePath}`);
      }
      let stats: import("node:fs").Stats;
      try {
        stats = statSync(absolutePath);
      } catch (error) {
        return failTextResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!stats.isFile()) {
        return failTextResult(`Error: Path is not a file: ${absolutePath}`);
      }
      if (!supportsToc(absolutePath)) {
        return inconclusiveTextResult(
          [
            "toc_document unavailable: unsupported language for structural TOC extraction.",
            `file: ${absolutePath}`,
            "reason=unsupported_language",
            "next_step=Use grep or look_at for non-TS/JS files.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "unsupported_language",
            nextStep: "Use grep or look_at for non-TS/JS files.",
            filePath: absolutePath,
          },
        );
      }
      if (stats.size > MAX_TOC_FILE_BYTES) {
        return inconclusiveTextResult(
          [
            "toc_document unavailable: file exceeds structural parse budget.",
            `file: ${absolutePath}`,
            "reason=file_too_large",
            `file_bytes: ${stats.size}`,
            `max_file_bytes: ${MAX_TOC_FILE_BYTES}`,
            "next_step=Use read_spans on a focused line range or grep for targeted text search.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "file_too_large",
            filePath: absolutePath,
            fileBytes: stats.size,
            maxFileBytes: MAX_TOC_FILE_BYTES,
            nextStep: "Use read_spans on a focused line range or grep for targeted text search.",
          },
        );
      }

      const signature = `${stats.mtimeMs}:${stats.size}`;
      const sessionId = getToolSessionId(ctx);
      const source = readSourceTextWithCache({
        sessionId,
        absolutePath,
        signature,
      });
      const startedAt = Date.now();
      const lookup = cacheLookup({
        cacheStore: sessionCache,
        sessionKey: resolveTocSessionKey(sessionId),
        absolutePath,
        signature,
        sourceText: source.sourceText,
      });
      recordTocEvent(options?.runtime, sessionId, {
        toolName: "toc_document",
        operation: "document",
        filePath: absolutePath,
        cacheHit: lookup.cacheHit,
        sourceCacheHit: source.cacheHit,
        durationMs: Date.now() - startedAt,
      });

      return textResult(buildDocumentText(lookup.toc, baseDir), {
        status: "ok",
        filePath: absolutePath,
        cacheHit: lookup.cacheHit,
        sourceCacheHit: source.cacheHit,
        language: lookup.toc.language,
        importsCount: lookup.toc.imports.length,
        functionsCount: lookup.toc.functions.length,
        classesCount: lookup.toc.classes.length,
        declarationsCount: lookup.toc.declarations.length,
      });
    },
  });

  const tocSearch = defineBrewvaTool({
    name: "toc_search",
    label: "TOC Search",
    description:
      "Search TS/JS file structure before full reads. Returns ranked symbols, imports, summaries, and line spans; broad queries fall back with guidance.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TOC_SEARCH_LIMIT,
          default: DEFAULT_TOC_SEARCH_LIMIT,
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const baseDir = resolveBaseDir(ctx, options?.runtime);
      const roots = (params.paths ?? ["."]).map((entry) => resolveAbsolutePath(baseDir, entry));
      const sessionId = getToolSessionId(ctx);
      const sessionKey = resolveTocSessionKey(sessionId);
      const query = params.query.trim().toLowerCase();
      const tokens = tokenizeSearchTerms(query);
      const limit = params.limit ?? DEFAULT_TOC_SEARCH_LIMIT;

      if (tokens.length === 0) {
        return inconclusiveTextResult(
          [
            "toc_search unavailable: query is too broad or empty after tokenization.",
            "reason=query_tokens_insufficient",
            "next_step=Provide a symbol, import path, or API phrase with at least one concrete token.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "query_tokens_insufficient",
            nextStep:
              "Provide a symbol, import path, or API phrase with at least one concrete token.",
          },
        );
      }

      const walk = walkTocFiles(roots);
      if (walk.scopeOverflow) {
        recordTocEvent(options?.runtime, sessionId, {
          toolName: "toc_search",
          operation: "search",
          broadQuery: false,
          scopeOverflow: true,
          candidateFilesScanned: walk.files.length,
          durationMs: 0,
        });
        return inconclusiveTextResult(
          summarizeScopeOverflow({
            query: params.query.trim(),
            candidateFiles: walk.files.length,
            baseDir,
          }),
          {
            status: UNAVAILABLE_STATUS,
            reason: "search_scope_too_large",
            candidateFiles: walk.files.length,
            walkLimit: MAX_TOC_SEARCH_CANDIDATE_FILES,
            nextStep: "Narrow paths to a package/folder first, then retry toc_search.",
          },
        );
      }

      const files = walk.files;

      if (files.length === 0) {
        return inconclusiveTextResult(
          [
            "toc_search unavailable: no supported TS/JS files found in the requested paths.",
            "reason=no_supported_files",
            "next_step=Point paths at a TS/JS workspace or use grep/look_at for other languages.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "no_supported_files",
            nextStep: "Point paths at a TS/JS workspace or use grep/look_at for other languages.",
          },
        );
      }

      const startedAt = Date.now();
      const allMatches: TocSearchMatch[] = [];
      let indexedFiles = 0;
      let cacheHits = 0;
      let cacheMisses = 0;
      let skippedFiles = 0;
      let oversizedFiles = 0;
      let indexedBytes = 0;
      let budgetExceeded = false;
      for (const filePath of files) {
        try {
          const stats = statSync(filePath);
          if (stats.size > MAX_TOC_FILE_BYTES) {
            oversizedFiles += 1;
            continue;
          }
          if (indexedBytes + stats.size > MAX_TOC_SEARCH_INDEXED_BYTES) {
            budgetExceeded = true;
            break;
          }
          const source = readSourceTextWithCache({
            sessionId,
            absolutePath: filePath,
            signature: `${stats.mtimeMs}:${stats.size}`,
          });
          const lookup = cacheLookup({
            cacheStore: sessionCache,
            sessionKey,
            absolutePath: filePath,
            signature: `${stats.mtimeMs}:${stats.size}`,
            sourceText: source.sourceText,
          });
          indexedFiles += 1;
          indexedBytes += stats.size;
          if (lookup.cacheHit) {
            cacheHits += 1;
          } else {
            cacheMisses += 1;
          }
          allMatches.push(...searchDocument(lookup.toc, baseDir, query, tokens));
        } catch {
          skippedFiles += 1;
          continue;
        }
      }

      if (indexedFiles === 0) {
        return inconclusiveTextResult(
          [
            "toc_search unavailable: no accessible TS/JS files could be indexed.",
            `reason=${oversizedFiles > 0 ? "no_indexable_files" : "no_accessible_files"}`,
            `candidate_files: ${files.length}`,
            `skipped_files: ${skippedFiles}`,
            `oversized_files: ${oversizedFiles}`,
            "next_step=Check file permissions, narrow paths, or use read_spans on a specific file.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: oversizedFiles > 0 ? "no_indexable_files" : "no_accessible_files",
            candidateFiles: files.length,
            skippedFiles,
            oversizedFiles,
            nextStep: "Check file permissions, narrow paths, or use read_spans on a specific file.",
          },
        );
      }

      allMatches.sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        if (left.filePath !== right.filePath) return left.filePath.localeCompare(right.filePath);
        if (left.lineStart !== right.lineStart) return left.lineStart - right.lineStart;
        return left.name.localeCompare(right.name);
      });

      const candidateFiles = new Set(allMatches.map((match) => match.filePath)).size;
      const searchSummary: TocSearchSummary = {
        indexedFiles,
        candidateFiles,
        cacheHits,
        cacheMisses,
        skippedFiles,
        oversizedFiles,
        indexedBytes,
      };

      const broadQuery = resolveBroadQuery({
        candidateFiles,
        indexedFiles,
        limit,
        tokens,
      });
      const durationMs = Date.now() - startedAt;
      recordTocEvent(options?.runtime, sessionId, {
        toolName: "toc_search",
        operation: "search",
        indexedFiles,
        candidateFiles,
        returnedMatches: Math.min(limit, allMatches.length),
        cacheHits,
        cacheMisses,
        skippedFiles,
        oversizedFiles,
        indexedBytes,
        broadQuery,
        budgetExceeded,
        durationMs,
      });

      if (budgetExceeded) {
        const preview = allMatches.slice(0, Math.min(5, limit));
        return inconclusiveTextResult(
          summarizeIndexBudgetExceeded({
            query: params.query.trim(),
            preview,
            summary: searchSummary,
            baseDir,
          }),
          {
            status: UNAVAILABLE_STATUS,
            reason: "indexing_budget_exceeded",
            indexedFiles,
            candidateFiles,
            cacheHits,
            cacheMisses,
            skippedFiles,
            oversizedFiles,
            indexedBytes,
            indexedBytesLimit: MAX_TOC_SEARCH_INDEXED_BYTES,
            nextStep: "Narrow paths or query terms before retrying toc_search.",
          },
        );
      }

      if (allMatches.length === 0) {
        return inconclusiveTextResult(
          [
            "[TOCSearch]",
            `query: ${params.query.trim()}`,
            `status: ${UNAVAILABLE_STATUS}`,
            "reason: no_match",
            `indexed_files: ${indexedFiles}`,
            `cache_hits: ${cacheHits}`,
            `cache_misses: ${cacheMisses}`,
            `skipped_files: ${skippedFiles}`,
            `oversized_files: ${oversizedFiles}`,
            `indexed_bytes: ${indexedBytes}`,
            "next_step: Try a symbol name, import path, or use grep for raw text search.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "no_match",
            indexedFiles,
            cacheHits,
            cacheMisses,
            skippedFiles,
            oversizedFiles,
            indexedBytes,
            nextStep: "Try a symbol name, import path, or use grep for raw text search.",
          },
        );
      }

      if (broadQuery) {
        const preview = allMatches.slice(0, Math.min(5, limit));
        return inconclusiveTextResult(
          summarizeBroadQuery({
            query: params.query.trim(),
            preview,
            summary: searchSummary,
            baseDir,
          }),
          {
            status: UNAVAILABLE_STATUS,
            reason: "broad_query",
            indexedFiles,
            candidateFiles,
            cacheHits,
            cacheMisses,
            skippedFiles,
            oversizedFiles,
            indexedBytes,
            nextStep:
              "Narrow the query to a symbol/import name or switch to grep for broad text search.",
          },
        );
      }

      const matches = allMatches.slice(0, limit);
      return textResult(summarizeSearch(params.query.trim(), matches, searchSummary, baseDir), {
        status: "ok",
        indexedFiles,
        candidateFiles,
        cacheHits,
        cacheMisses,
        skippedFiles,
        oversizedFiles,
        indexedBytes,
        matchesReturned: matches.length,
      });
    },
  });

  return [tocDocument, tocSearch];
}
