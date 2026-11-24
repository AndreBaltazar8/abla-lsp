#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodeActionKind,
  createConnection,
  CompletionItemKind,
  DiagnosticSeverity,
  DiagnosticTag,
  DocumentHighlightKind,
  DocumentSymbol,
  ErrorCodes,
  LSPErrorCodes,
  InitializeParams,
  InitializeResult,
  InlayHintKind,
  Location,
  ProposedFeatures,
  Range,
  ResponseError,
  SemanticTokensBuilder,
  SymbolInformation,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  WorkspaceSymbolParams,
  type DocumentSymbolParams,
  type CallHierarchyIncomingCall,
  type CallHierarchyItem,
  type TypeHierarchyItem,
  type CodeLens,
  type CallHierarchyOutgoingCall,
  type CodeAction,
  type Diagnostic,
  type CompletionItem,
  type Hover,
  type InlayHint,
  type TextEdit,
  type ReferenceParams,
  type RenameParams,
  type TextDocumentPositionParams,
  type CancellationToken,
  type WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { CompilerClient, CompilerProtocolError } from "./compiler-client.js";
import { CompilerWorkspace, SupersededAnalysis, ownedSource, compilerLocalUri } from "./compiler-workspace.js";
import { compilerUriKey } from "./encoding.js";
import type { CompilerWorkspaceSnapshot, CompilerPendingDiagnostic, CompilerQueryMethod, CompilerHover, CompilerLocation } from "./compiler-protocol.js";
import {
  ablaKeywords,
  callArgumentOffsets,
  callContext,
  foldingRanges,
  formatDocument,
  organizeImports,
  signatureMarkdown,
  symbolSignature,
  importRenameEdits,
  isTestProgram,
  inferredTypeHints,
  missingNamedArgument,
  namedArgumentIndex,
  type CallContext,
} from "./editor-features.js";
import type { AblaSymbol, DocumentAnalysis } from "./model.js";
import { implementationsOf, subtypesOf, supertypeIds } from "./hierarchy.js";
import { dataFixes, diagnosticData, diagnosticMessage } from "./diagnostics.js";
import { WorkspaceIndex, type EditResult, type RenameRequest } from "./index.js";
import { PositionMap } from "./positions.js";
import {
  AdvancedRefactors,
  type ChangeBindingKindRequest,
  type ChangeSignatureRequest,
  type ConvertFunctionToMethodRequest,
  type ConvertMethodToFunctionRequest,
  type ExtractFunctionRequest,
  type ExtractInterfaceRequest,
  type GenerateDeclarationRequest,
  type InlineSymbolRequest,
  type IntroduceBindingRequest,
  type OwnershipRepairRequest,
  type PromoteLocalRequest,
  type RefactorOperation,
  type RemoveDeadCodeRequest,
  type ToggleCompileTimeRequest,
} from "./refactors.js";
import { SyntaxAnalyzer } from "./source.js";
import { removeUnusedDeclaration, removeUnusedLocal, withPreview, type TextRemoval } from "./unused-fixes.js";
import {
  applyStagedRecipe,
  type StagedRefactorOperation,
} from "./staged-refactors.js";
import { indexWorkspace } from "./workspace.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const index = new WorkspaceIndex(new SyntaxAnalyzer());
const advancedRefactors = new AdvancedRefactors(index);
let workspaceRoots: string[] = [];
let compilerConfiguration: {
  readonly enabled: boolean;
  readonly path: string;
  readonly arguments?: readonly string[];
  readonly unusedImports: boolean;
  readonly unusedLocals: boolean;
  readonly unusedParameters: boolean;
  readonly unusedDeclarations: boolean;
  readonly jsonConstruction: boolean;
  readonly regexConstruction: boolean;
  readonly entryPoints?: readonly string[];
} = { enabled: true, path: process.env.ABLA_COMPILER ?? "ablac", unusedImports: true, unusedLocals: false, unusedParameters: false, unusedDeclarations: false, jsonConstruction: false, regexConstruction: false };
let compiler: CompilerClient | undefined;
let compilerRevision: string | undefined;
let compilerSnapshot: CompilerWorkspaceSnapshot | undefined;
let compilerWorkspace: CompilerWorkspace | undefined;
let compilerUris = new Set<string>();
let compilerRestartTimer: ReturnType<typeof setTimeout> | undefined;
let compilerRestartAttempt = 0;
let shuttingDown = false;
/** The client shows edits with annotations that need confirmation for review (LSP 3.16 change annotations). */
let clientPreviewsEdits = false;
/** Show `: T` after a local, loop variable or lambda parameter whose type the compiler inferred (initializationOptions.inlayHints.types, default on). */
let typeInlayHints = true;

interface InitializationOptions {
  readonly inlayHints?: { readonly types?: boolean };
  readonly compiler?: {
    readonly enabled?: boolean;
    readonly path?: string;
    readonly arguments?: readonly string[];
    /** Grey out and warn about imports nothing uses (default on; needs a compiler that has it). */
    readonly unusedImports?: boolean;
    /** Grey out and warn about locals nothing uses (off by default while the compiler measures it). */
    readonly unusedLocals?: boolean;
    /** Grey out and warn about function parameters nothing uses (off by default while the compiler measures it). */
    readonly unusedParameters?: boolean;
    /** Grey out and warn about top-level functions and values nothing refers to (off by default while the compiler measures it). */
    readonly unusedDeclarations?: boolean;
    /** Suggest standard JSON literals for hand-built JSON (off by default). */
    readonly jsonConstruction?: boolean;
    /** Suggest $regex for regexCompile calls with a literal pattern (off by default; needs --warn-regex-construction in the compiler). */
    readonly regexConstruction?: boolean;
    /** Project entry files (absolute paths) for a workspace whose abla.toml names none (the headless refactor driver passes --entry). */
    readonly entryPoints?: readonly string[];
  };
}

function symbolKind(symbol: AblaSymbol): SymbolKind {
  switch (symbol.kind) {
    case "function":
      return SymbolKind.Function;
    case "class":
      return SymbolKind.Class;
    case "interface":
      return SymbolKind.Interface;
    case "enum":
      return SymbolKind.Enum;
    case "type":
      return SymbolKind.TypeParameter;
    case "parameter":
      return SymbolKind.Variable;
    case "property":
      return SymbolKind.Property;
    case "value":
      return SymbolKind.Constant;
    case "variable":
      return SymbolKind.Variable;
  }
}

function completionKind(symbol: AblaSymbol): CompletionItemKind {
  switch (symbol.kind) {
    case "function":
      return CompletionItemKind.Function;
    case "class":
      return CompletionItemKind.Class;
    case "interface":
      return CompletionItemKind.Interface;
    case "enum":
      return CompletionItemKind.Enum;
    case "type":
      return CompletionItemKind.TypeParameter;
    case "parameter":
      return CompletionItemKind.Variable;
    case "property":
      return CompletionItemKind.Property;
    case "value":
      return CompletionItemKind.Constant;
    case "variable":
      return CompletionItemKind.Variable;
  }
}

const sourceImports = /^\s*(?:export\s+)?import\s+(?:contract\s+)?"([^"\r\n]+)"(?:[\t ]+as[\t ]+([A-Za-z_][A-Za-z0-9_]*))?/gmu;

/** Resolve only documents the compiler has already loaded, including its stdlib module layout. */
function importedDocument(analysis: DocumentAnalysis, requested: string): DocumentAnalysis | undefined {
  try {
    if (requested.startsWith("abla/")) {
      const matches = index.documents().filter((document) =>
        new URL(document.uri).pathname.endsWith(`/stdlib/${requested}/entry.ab`));
      return matches.length === 1 ? matches[0] : undefined;
    }
    return index.document(new URL(requested, analysis.uri).href);
  } catch {
    return undefined;
  }
}

function completionSymbols(
  analysis: DocumentAnalysis,
  offset: number,
  identifierBegin: number,
): readonly AblaSymbol[] {
  if (identifierBegin > 0 && analysis.text[identifierBegin - 1] === ".") {
    let receiverBegin = identifierBegin - 1;
    while (
      receiverBegin > 0 &&
      /[A-Za-z0-9_]/u.test(analysis.text[receiverBegin - 1] ?? "")
    ) receiverBegin -= 1;
    const receiverName = analysis.text.slice(receiverBegin, identifierBegin - 1);
    for (const match of analysis.text.matchAll(sourceImports)) {
      if (match[2] === receiverName && match[1] !== undefined) {
        return importedDocument(analysis, match[1])?.symbols.filter((symbol) => symbol.topLevel) ?? [];
      }
    }
    const receiver = analysis.occurrences.find(
      (occurrence) =>
        occurrence.range.start === receiverBegin &&
        occurrence.range.end === identifierBegin - 1,
    );
    const typeNames: readonly string[] =
      receiver?.type?.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    const owners = index.symbols().filter(
      (symbol) =>
        (symbol.kind === "class" || symbol.kind === "interface") &&
        typeNames.includes(symbol.name),
    );
    if (owners.length === 1 && owners[0] !== undefined) {
      return index.symbols().filter((symbol) => symbol.containerId === owners[0]?.id);
    }
    return [];
  }

  const visible = new Map<string, AblaSymbol>();
  const add = (symbol: AblaSymbol): void => {
    visible.set(symbol.id, symbol);
  };
  for (const symbol of analysis.symbols) {
    if (symbol.topLevel) add(symbol);
  }
  const owner = index.containingSymbol(analysis.uri, { start: offset, end: offset });
  if (owner !== undefined) {
    add(owner.symbol);
    for (const symbol of analysis.symbols) {
      if (symbol.containerId === owner.symbol.id) add(symbol);
    }
  }
  if (analysis.uri.startsWith("file:")) {
    for (const match of analysis.text.matchAll(sourceImports)) {
      const requested = match[1];
      if (requested === undefined || match[2] !== undefined) continue;
      for (const symbol of importedDocument(analysis, requested)?.symbols ?? []) {
        if (symbol.topLevel) add(symbol);
      }
    }
  }
  if (analysis.authority === "syntax") {
    for (const symbol of index.symbols()) {
      if (symbol.topLevel &&
        index.symbols().filter((candidate) =>
          candidate.topLevel && candidate.name === symbol.name,
        ).length === 1) add(symbol);
    }
  }
  return [...visible.values()];
}

function semanticTokenType(symbol: AblaSymbol): number {
  switch (symbol.kind) {
    case "function":
      return 0;
    case "class":
      return 1;
    case "interface":
      return 1;
    case "enum":
      return 2;
    case "type":
      return 1;
    case "parameter":
      return 5;
    case "property":
      return 4;
    case "value":
    case "variable":
      return 3;
  }
}

function location(symbol: AblaSymbol): Location | undefined {
  const analysis = index.document(symbol.uri);
  if (analysis === undefined) return undefined;
  return Location.create(
    symbol.uri,
    new PositionMap(analysis.text).range(symbol.selectionRange),
  );
}

function callHierarchyItem(symbol: AblaSymbol): CallHierarchyItem | undefined {
  const analysis = index.document(symbol.uri);
  if (analysis === undefined) return undefined;
  const positions = new PositionMap(analysis.text);
  return {
    name: symbol.name,
    kind: symbolKind(symbol),
    detail: symbol.detail,
    uri: symbol.uri,
    range: positions.range(symbol.range),
    selectionRange: positions.range(symbol.selectionRange),
    data: { id: symbol.id },
  };
}

function publishDiagnostics(analysis: DocumentAnalysis, pending: readonly CompilerPendingDiagnostic[] = []): void {
  const positions = new PositionMap(analysis.text);
  connection.sendDiagnostics({
    uri: analysis.uri,
    version: analysis.version,
    diagnostics: [...analysis.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
      ...(diagnostic.tags?.includes("unnecessary") ? { tags: [DiagnosticTag.Unnecessary] } : {}),
      source: analysis.authority === "compiler" ? "ablac" : "abla-syntax",
      code: diagnostic.code,
      message: diagnosticMessage(diagnostic),
      range: positions.range(diagnostic.range),
      ...(diagnosticData(diagnostic, positions) === undefined ? {} : { data: diagnosticData(diagnostic, positions) }),
    })), ...pending.map((site) => ({
      severity: DiagnosticSeverity.Information, source: "ablac", code: site.code,
      message: site.message, range: positions.range(site.range),
    }))],
  });
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const initialization = params.initializationOptions as InitializationOptions | undefined;
  const workspaceEdits = params.capabilities.workspace?.workspaceEdit;
  clientPreviewsEdits = workspaceEdits?.documentChanges === true && workspaceEdits.changeAnnotationSupport !== undefined;
  typeInlayHints = initialization?.inlayHints?.types ?? true;
  const configured = initialization?.compiler;
  compilerConfiguration = {
    enabled: configured?.enabled ?? true,
    path: configured?.path ?? process.env.ABLA_COMPILER ?? "ablac",
    unusedImports: configured?.unusedImports ?? true,
    unusedLocals: configured?.unusedLocals ?? false,
    unusedParameters: configured?.unusedParameters ?? false,
    unusedDeclarations: configured?.unusedDeclarations ?? false,
    jsonConstruction: configured?.jsonConstruction ?? false,
    regexConstruction: configured?.regexConstruction ?? false,
    ...(configured?.entryPoints === undefined ? {} : { entryPoints: configured.entryPoints }),
    ...(configured?.arguments === undefined ? {} : { arguments: configured.arguments }),
  };
  const roots = params.workspaceFolders?.map((folder) => folder.uri) ??
    (params.rootUri === null || params.rootUri === undefined ? [] : [params.rootUri]);
  workspaceRoots = roots.flatMap((uri) => {
    try {
      return uri.startsWith("file:") ? [fileURLToPath(uri)] : [];
    } catch {
      return [];
    }
  });
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      definitionProvider: true,
      declarationProvider: true,
      typeDefinitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      hoverProvider: true,
      completionProvider: { triggerCharacters: ["."] },
      signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [")", ":", "="] },
      semanticTokensProvider: {
        legend: {
          tokenTypes: ["function", "class", "enum", "variable", "property", "parameter"],
          tokenModifiers: ["declaration", "readonly"],
        },
        full: true,
      },
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      inlayHintProvider: true,
      documentFormattingProvider: true,
      codeActionProvider: {
        codeActionKinds: [
          CodeActionKind.QuickFix, CodeActionKind.SourceOrganizeImports, CodeActionKind.SourceFixAll, CodeActionKind.RefactorExtract,
          CodeActionKind.RefactorInline, CodeActionKind.RefactorRewrite,
        ],
        resolveProvider: true,
      },
      documentLinkProvider: { resolveProvider: false },
      workspace: {
        fileOperations: {
          willRename: { filters: [{ pattern: { glob: "**/*.ab" } }, { pattern: { glob: "**", matches: "folder" } }] },
        },
      },
      callHierarchyProvider: true,
      typeHierarchyProvider: true,
      codeLensProvider: { resolveProvider: false },
      implementationProvider: true,
      renameProvider: { prepareProvider: true },
      executeCommandProvider: {
        commands: [
          "abla.renameSymbols",
          "abla.moveDeclarations",
          "abla.moveTypes",
          "abla.splitDeclarations",
          "abla.mergeDeclarations",
          "abla.changeSignature",
          "abla.extractFunction",
          "abla.functionToMethod",
          "abla.methodToFunction",
          "abla.inlineSymbol",
          "abla.introduceBinding",
          "abla.changeBindingKind",
          "abla.promoteLocal",
          "abla.extractInterface",
          "abla.generateDeclaration",
          "abla.repairOwnership",
          "abla.toggleCompileTime",
          "abla.removeDeadCode",
          "abla.applyRefactorRecipe",
          "abla.applyStagedRefactorRecipe",
        ],
      },
      experimental: {
        abla: {
          analysisAuthority: "syntax",
          compilerAnalysisProtocol: 1,
          semanticState: compilerConfiguration.enabled ? "starting" : "disabled",
          transactionalRefactors: [
            "renameSymbols", "moveDeclarations", "changeSignature",
            "extractFunction", "functionToMethod", "methodToFunction",
            "inlineSymbol", "introduceBinding", "changeBindingKind",
            "promoteLocal", "extractInterface",
            "generateDeclaration", "repairOwnership", "toggleCompileTime",
            "removeDeadCode", "applyRefactorRecipe",
            "applyStagedRefactorRecipe",
          ],
        },
      },
    },
    serverInfo: { name: "abla-lsp", version: "0.4.0" },
  };
});

connection.onInitialized(() => {
  void indexWorkspace(connection, index, workspaceRoots).catch((error: unknown) => {
    connection.console.error(`workspace indexing failed: ${String(error)}`);
  });
  if (compilerConfiguration.enabled) void startCompiler();
});

async function startCompiler(): Promise<void> {
  const createClient = (): CompilerClient => {
    const child = new CompilerClient({
      executable: compilerConfiguration.path,
      ...(compilerConfiguration.arguments === undefined ? {} : { arguments: compilerConfiguration.arguments }),
      log: (message) => connection.console.info(`ablac analyze: ${message}`),
      onExit: (error) => {
        if (compiler !== child) return;
        compilerWorkspace?.dispose(); compilerWorkspace = undefined;
        compiler = undefined; compilerRevision = undefined; compilerSnapshot = undefined;
        clearCompilerFacts(new Set());
        void indexWorkspace(connection, index, workspaceRoots);
        for (const document of documents.all()) publishDiagnostics(index.upsert(document.uri, document.version, document.getText()));
        scheduleCompilerRestart(error);
      },
    });
    return child;
  };
  let candidate = createClient();
  try {
    const initialize = { workspaceRoots, clientName: "abla-lsp", clientVersion: "0.4.0", unusedImports: compilerConfiguration.unusedImports, unusedLocals: compilerConfiguration.unusedLocals, unusedParameters: compilerConfiguration.unusedParameters, unusedDeclarations: compilerConfiguration.unusedDeclarations, jsonConstruction: compilerConfiguration.jsonConstruction, regexConstruction: compilerConfiguration.regexConstruction, ...(compilerConfiguration.entryPoints === undefined ? {} : { entryPoints: compilerConfiguration.entryPoints }) };
    let initialized;
    // The newest analysis mode the compiler has: graph-v2 (stable declaration ids, analyze with since), else graph-v1. The compiler's
    // non-graph analysis (schema 1) is gone from current compilers (#832), so a compiler that refuses graph-v1 is not usable.
    for (const mode of ["graph-v2", "graph-v1"] as const) {
      try { initialized = await candidate.start({ ...initialize, analysisMode: mode }); break; }
      catch (error) {
        if (!(error instanceof CompilerProtocolError) || error.code !== "unsupported_analysis_mode" || mode === "graph-v1") throw error;
        connection.console.info(`compiler rejects ${mode}; reconnecting with graph-v1`);
        await candidate.stop().catch(() => undefined); candidate = createClient();
      }
    }
    if (initialized === undefined) throw new Error("compiler analysis did not start");
    if (initialized.protocolVersion !== 1) throw new Error(`compiler analysis protocol ${initialized.protocolVersion} is unsupported`);
    const workspace = new CompilerWorkspace(candidate, {
      roots: workspaceRoots, capabilities: initialized.capabilities,
      accept: acceptCompilerSnapshot,
      log: (message) => connection.console.warn(`compiler analysis failed: ${message}`),
      ...(compilerConfiguration.entryPoints?.[0] === undefined ? {} : { entry: compilerConfiguration.entryPoints[0] }),
    });
    compiler = candidate; compilerWorkspace = workspace; compilerRestartAttempt = 0;
    connection.console.info(`connected to ablac ${initialized.compilerVersion} analysis protocol 1 (${workspace.stableIds ? "graph-v2" : "graph-v1"})`);
    for (const document of documents.all()) await workspace.update("open", { uri: document.uri, version: document.version, text: document.getText() });
    workspace.schedule(0);
  } catch (error) {
    connection.console.warn(`compiler analysis unavailable; continuing in syntax mode: ${String(error)}`);
    if (compiler === candidate) {
      compilerWorkspace?.dispose(); compilerWorkspace = undefined; compiler = undefined;
      compilerRevision = undefined; compilerSnapshot = undefined; clearCompilerFacts(new Set());
    }
    await candidate.stop().catch(() => undefined);
    scheduleCompilerRestart(error instanceof Error ? error : new Error(String(error)));
  }
}

function scheduleCompilerRestart(error: Error): void {
  if (shuttingDown || !compilerConfiguration.enabled) return;
  if (compilerRestartTimer !== undefined) clearTimeout(compilerRestartTimer);
  const delay = Math.min(30_000, 500 * (2 ** Math.min(compilerRestartAttempt, 6)));
  compilerRestartAttempt += 1;
  connection.console.warn(
    `compiler analysis will restart in ${delay}ms: ${error.message}`,
  );
  compilerRestartTimer = setTimeout(() => {
    compilerRestartTimer = undefined;
    if (compiler === undefined && !shuttingDown) void startCompiler();
  }, delay);
}

function clearCompilerFacts(keep: ReadonlySet<string>): void {
  for (const uri of compilerUris) {
    if (keep.has(uri)) continue;
    const previous = index.document(uri);
    if (previous?.authority !== "compiler") continue;
    const open = documents.get(uri);
    if (open !== undefined) index.upsert(uri, open.version, open.getText());
    else if (ownedSource(uri, workspaceRoots)) index.upsert(uri, 0, previous.text);
    else index.remove(uri);
  }
  compilerUris = new Set(keep);
}

function acceptCompilerSnapshot(snapshot: CompilerWorkspaceSnapshot): void {
  const previousRevision = compilerRevision;
  clearCompilerFacts(new Set(snapshot.documents.map((document) => document.uri)));
  compilerRevision = snapshot.revision; compilerSnapshot = snapshot;
  for (const document of snapshot.documents) {
    const previous = index.document(document.uri);
    const retained = document.occurrencesAvailable === false && previousRevision === snapshot.revision &&
      previous?.authority === "compiler" && previous.occurrencesAvailable !== false && previous.text === document.text;
    const analysis: DocumentAnalysis = {
      authority: "compiler", uri: document.uri, version: document.version, text: document.text,
      symbols: document.symbols, occurrences: retained ? previous.occurrences : document.occurrences,
      diagnostics: document.diagnostics,
      ...(document.occurrencesAvailable === false && !retained ? { occurrencesAvailable: false } : {}),
      ...(snapshot.complete === undefined ? {} : { analysisComplete: snapshot.complete }),
      ...(snapshot.analysisMode === "graph-v1" || snapshot.analysisMode === "graph-v2" ? { writable: ownedSource(document.uri, workspaceRoots) } : {}),
    };
    index.upsertAnalysis(analysis);
    if (documents.get(document.uri) !== undefined && document.diagnosticsAvailable !== false) {
      publishDiagnostics(analysis, snapshot.pending?.filter((site) => compilerUriKey(site.uri) === compilerUriKey(document.uri)));
    }
  }
  if (snapshot.complete === false) connection.console.info(`compiler graph is pre-CT/incomplete (${snapshot.pending?.length ?? 0} pending site(s))`);
  for (const issue of snapshot.issues ?? []) connection.console.warn(`${issue.code}: ${issue.message}`);
}

async function ensureCompilerFacts(uri?: string, editing = false, occurrences = true): Promise<boolean> {
  const workspace = compilerWorkspace;
  if (workspace === undefined || (workspace.graph && uri !== undefined && !compilerLocalUri(uri))) return true;
  const generation = workspace.generation;
  const summary = await workspace.ensure(uri, occurrences && !editing);
  if (uri !== undefined && workspace.graph && !summary.documents.some((document) => compilerUriKey(document.uri) === compilerUriKey(uri))) {
    if (editing) throw new ResponseError(ErrorCodes.InvalidRequest, "source is outside the selected program graph");
    return false;
  }
  if (editing && workspace.graph && summary.complete !== true) throw new ResponseError(ErrorCodes.InvalidRequest, "compiler graph is incomplete; compile-time evaluation was not performed");
  if (occurrences && summary.documents.some((document) => document.occurrencesAvailable === false)) await workspace.ensure(uri, true);
  if (workspace !== compilerWorkspace || generation !== workspace.generation) throw new ResponseError(LSPErrorCodes.ContentModified, "document changed during compiler analysis");
  return true;
}

async function compilerPosition(method: CompilerQueryMethod, params: TextDocumentPositionParams, token?: CancellationToken) {
  const workspace = compilerWorkspace;
  if (workspace?.queries !== true || !compilerLocalUri(params.textDocument.uri)) return undefined;
  const source = documents.get(params.textDocument.uri)?.getText() ?? index.document(params.textDocument.uri)?.text;
  if (source === undefined) return undefined;
  const controller = new AbortController();
  const cancelled = token?.onCancellationRequested(() => controller.abort(new SupersededAnalysis()));
  if (token?.isCancellationRequested === true) controller.abort(new SupersededAnalysis());
  try {
    const result = await workspace.position(method, params.textDocument.uri, new PositionMap(source).offset(params.position), controller.signal);
    const current = result.snapshot.documents.find((document) => compilerUriKey(document.uri) === compilerUriKey(params.textDocument.uri));
    if (current !== undefined && current.text !== source) throw new SupersededAnalysis();
    return result;
  } catch (error) {
    if (error instanceof CompilerProtocolError && error.code === "document_not_analyzed") {
      connection.console.info("source is outside the selected program graph");
      return { revision: compilerRevision ?? "", complete: false, value: method === "query/references" ? [] : null, snapshot: workspace.snapshot };
    }
    if (controller.signal.aborted) throw new ResponseError(LSPErrorCodes.RequestCancelled, "compiler positional query was cancelled");
    if (error instanceof SupersededAnalysis) throw new ResponseError(LSPErrorCodes.ContentModified, error.message);
    connection.console.warn(`compiler positional query failed: ${String(error)}`);
    throw new ResponseError(ErrorCodes.InternalError, String(error));
  } finally { cancelled?.dispose(); }
}

function queryLocation(symbol: AblaSymbol, snapshot: CompilerWorkspaceSnapshot | undefined): Location | undefined {
  const source = snapshot?.documents.find((document) => compilerUriKey(document.uri) === compilerUriKey(symbol.uri));
  return source === undefined ? undefined : Location.create(source.uri, new PositionMap(source.text).range(symbol.selectionRange));
}

async function assertOwnedEdit(uri: string, created: boolean): Promise<void> {
  const localOpen = workspaceRoots.length === 0 && documents.get(uri) !== undefined;
  if (!ownedSource(uri, workspaceRoots) && !localOpen) throw new ResponseError(ErrorCodes.InvalidRequest, "semantic edits cannot modify stdlib, dependency copies or sources outside the workspace");
  const file = fileURLToPath(uri);
  let actual: string;
  if (created) {
    let existing = path.dirname(file);
    const tail: string[] = [path.basename(file)];
    while (true) {
      try { actual = path.resolve(await fs.realpath(existing), ...tail); break; }
      catch {
        const parent = path.dirname(existing);
        if (parent === existing) throw new ResponseError(ErrorCodes.InvalidRequest, "new edit target has no owned parent");
        tail.unshift(path.basename(existing)); existing = parent;
      }
    }
  } else actual = await fs.realpath(file);
  if (localOpen) return;
  for (const root of workspaceRoots) {
    const relative = path.relative(await fs.realpath(root), actual);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return;
  }
  throw new ResponseError(ErrorCodes.InvalidRequest, "semantic edit follows a symlink outside the workspace");
}

async function validateCompilerEdit(edit: WorkspaceEdit): Promise<void> {
  const active = compiler;
  const workspace = compilerWorkspace;
  const generation = workspace?.generation;
  const baseRevision = compilerRevision;
  const snapshot = compilerSnapshot;
  const createdUris = new Set<string>();
  const changes = new Map<string, Array<{ readonly range: Range; readonly newText: string }>>();
  const addChanges = (
    uri: string,
    edits: readonly ({ readonly range: Range } & Record<string, unknown>)[],
  ): void => {
    changes.set(uri, [
      ...(changes.get(uri) ?? []),
      ...edits.flatMap((edit) =>
        typeof edit.newText === "string"
          ? [{ range: edit.range, newText: edit.newText }]
          : [],
      ),
    ]);
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) addChanges(uri, edits);
  for (const change of edit.documentChanges ?? []) {
    if ("textDocument" in change) addChanges(change.textDocument.uri, change.edits);
    else if (change.kind === "create") createdUris.add(change.uri);
  }
  if (workspace?.graph === true) {
    if (snapshot?.complete !== true) throw new ResponseError(ErrorCodes.InvalidRequest, "compiler graph is incomplete; semantic edits require complete validation");
    for (const uri of new Set([...changes.keys(), ...createdUris])) {
      if (!createdUris.has(uri) && !snapshot.documents.some((document) => compilerUriKey(document.uri) === compilerUriKey(uri))) {
        throw new ResponseError(ErrorCodes.InvalidRequest, "semantic edit targets a source outside the selected program graph");
      }
      await assertOwnedEdit(uri, createdUris.has(uri));
    }
  }
  const compilerOwned = workspace?.graph === true || [...changes.keys()].some(
    (uri) => index.document(uri)?.authority === "compiler" || createdUris.has(uri),
  );
  if (!compilerOwned) return;
  if (active === undefined || baseRevision === undefined) {
    throw new ResponseError(
      ErrorCodes.ServerNotInitialized,
      "compiler validation is unavailable for this semantic refactor",
    );
  }
  const edits = [...changes].flatMap(([uri, documentEdits]) => {
    const analysis = index.document(uri);
    const text = analysis?.text ?? (createdUris.has(uri) ? "" : undefined);
    if (text === undefined) return [];
    const positions = new PositionMap(text);
    return documentEdits.map((documentEdit) => {
      const start = positions.offset(documentEdit.range.start);
      const end = positions.offset(documentEdit.range.end);
      return {
        uri,
        start: Buffer.byteLength(text.slice(0, start), "utf8"),
        end: Buffer.byteLength(text.slice(0, end), "utf8"),
        newText: documentEdit.newText,
      };
    });
  });
  const validated = await active.validate({
    baseRevision,
    edits,
    ...(createdUris.size === 0 ? {} : {
      createdDocuments: [...createdUris].map((uri) => ({ uri, text: "" })),
    }),
    invariants: ["no-new-errors", "preserve-unedited-symbols"],
  });
  if (workspace !== compilerWorkspace || generation !== workspace?.generation) throw new ResponseError(LSPErrorCodes.ContentModified, "document changed while validating the edit");
  if (!validated.valid) {
    throw new ResponseError(
      ErrorCodes.InvalidRequest,
      validated.reason ?? "the compiler rejected the prospective refactor",
    );
  }
}

function updateCompilerDocument(method: "open" | "change", document: TextDocument): void {
  if (compilerWorkspace === undefined) return;
  void compilerWorkspace.update(method, { uri: document.uri, version: document.version, text: document.getText() })
    .catch((error: unknown) => connection.console.warn(`compiler overlay update failed: ${String(error)}`));
}

documents.onDidOpen((event) => {
  publishDiagnostics(index.upsert(event.document.uri, event.document.version, event.document.getText()));
  updateCompilerDocument("open", event.document);
});

documents.onDidChangeContent((event) => {
  publishDiagnostics(index.upsert(event.document.uri, event.document.version, event.document.getText()));
  updateCompilerDocument("change", event.document);
});

documents.onDidClose((event) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  void compilerWorkspace
    ?.close(event.document.uri)
    .catch((error: unknown) => {
      connection.console.warn(`compiler overlay close failed: ${String(error)}`);
    });
  if (!event.document.uri.startsWith("file:")) {
    index.remove(event.document.uri);
    return;
  }
  void fs
    .readFile(fileURLToPath(event.document.uri), "utf8")
    .then((text) => {
      if (index.document(event.document.uri)?.authority !== "compiler") index.upsert(event.document.uri, 0, text);
    })
    .catch(() => index.remove(event.document.uri));
});

connection.onDidChangeWatchedFiles(() => { compilerWorkspace?.invalidate(); });

connection.onDocumentSymbol(async (params: DocumentSymbolParams): Promise<DocumentSymbol[]> => {
  await ensureCompilerFacts(params.textDocument.uri, false, false);
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return [];
  const positions = new PositionMap(analysis.text);
  return analysis.symbols.map((symbol) => ({
    name: symbol.name,
    detail: `${symbol.detail} · ${analysis.authority}${analysis.analysisComplete === false ? " (pre-CT; incomplete)" : ""}`,
    kind: symbolKind(symbol),
    range: positions.range(symbol.range),
    selectionRange: positions.range(symbol.selectionRange),
  }));
});

connection.onWorkspaceSymbol(
  (params: WorkspaceSymbolParams): SymbolInformation[] =>
    index.symbols(params.query).flatMap((symbol) => {
      const resolvedLocation = location(symbol);
      if (resolvedLocation === undefined) return [];
      return [
        SymbolInformation.create(
          symbol.name,
          symbolKind(symbol),
          resolvedLocation.range,
          resolvedLocation.uri,
          symbol.detail,
        ),
      ];
    }),
);

function navigationIndex(uri: string): WorkspaceIndex {
  if (compilerWorkspace?.graph !== true || compilerLocalUri(uri)) return index;
  const local = new WorkspaceIndex(new SyntaxAnalyzer());
  const source = index.document(uri);
  if (source !== undefined) local.upsert(uri, source.version, source.text);
  return local;
}

async function definitionLocations(params: TextDocumentPositionParams, token?: CancellationToken): Promise<Location[]> {
  const query = await compilerPosition("query/definition", params, token);
  if (query !== undefined) {
    const target = query.value as AblaSymbol | null;
    const result = target === null ? undefined : queryLocation(target, query.snapshot);
    return result === undefined ? [] : [result];
  }
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return [];
  const navigation = navigationIndex(params.textDocument.uri);
  const resolved = navigation.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return [];
  const result = location(resolved.symbol);
  return result === undefined ? [] : [result];
}
connection.onDefinition(definitionLocations);
connection.onDeclaration(definitionLocations);

connection.onTypeDefinition(async (params: TextDocumentPositionParams): Promise<Location[]> => {
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return [];
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return [];
  const offset = new PositionMap(analysis.text).offset(params.position);
  const occurrence = analysis.occurrences.find(
    (candidate) => candidate.range.start <= offset && offset < candidate.range.end,
  );
  if (occurrence?.type === undefined) return [];
  const typeNames: readonly string[] =
    occurrence.type.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const candidates = index.symbols().filter(
    (symbol) =>
      (symbol.kind === "class" || symbol.kind === "interface" ||
        symbol.kind === "enum" || symbol.kind === "type") &&
      typeNames.includes(symbol.name),
  );
  if (candidates.length !== 1 || candidates[0] === undefined) return [];
  const target = location(candidates[0]);
  return target === undefined ? [] : [target];
});

connection.onReferences(async (params: ReferenceParams, token): Promise<Location[]> => {
  const query = await compilerPosition("query/references", params, token);
  if (query !== undefined) {
    let declaration: AblaSymbol | null = null;
    if (!params.context.includeDeclaration) {
      const target = await compilerPosition("query/definition", params, token);
      if (target !== undefined && target.revision !== query.revision) throw new ResponseError(LSPErrorCodes.ContentModified, "references changed during the query");
      declaration = (target?.value as AblaSymbol | null | undefined) ?? null;
    }
    const locations: Location[] = [];
    for (const reference of query.value as readonly CompilerLocation[]) {
      if (declaration !== null && compilerUriKey(reference.uri) === compilerUriKey(declaration.uri) &&
          reference.range.start === declaration.selectionRange.start && reference.range.end === declaration.selectionRange.end) continue;
      const source = query.snapshot?.documents.find((document) => compilerUriKey(document.uri) === compilerUriKey(reference.uri));
      if (source !== undefined) locations.push(Location.create(source.uri, new PositionMap(source.text).range(reference.range)));
    }
    return locations;
  }
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return [];
  const navigation = navigationIndex(params.textDocument.uri);
  const resolved = navigation.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return [];
  const result: Location[] = [];
  for (const [uri, occurrences] of navigation.references(resolved)) {
    const analysis = index.document(uri);
    if (analysis === undefined) continue;
    const positions = new PositionMap(analysis.text);
    for (const occurrence of occurrences) {
      if (
        !params.context.includeDeclaration &&
        uri === resolved.symbol.uri &&
        occurrence.range.start === resolved.symbol.selectionRange.start &&
        occurrence.range.end === resolved.symbol.selectionRange.end
      ) {
        continue;
      }
      result.push(Location.create(uri, positions.range(occurrence.range)));
    }
  }
  return result;
});

connection.onDocumentHighlight((params: TextDocumentPositionParams) => {
  const navigation = navigationIndex(params.textDocument.uri);
  const resolved = navigation.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return [];
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return [];
  const occurrences = navigation.references(resolved).get(analysis.uri) ?? [];
  const positions = new PositionMap(analysis.text);
  return occurrences.map((occurrence) => ({
    range: positions.range(occurrence.range),
    kind: DocumentHighlightKind.Text,
  }));
});

connection.onHover(async (params: TextDocumentPositionParams, token): Promise<Hover | null> => {
  const query = await compilerPosition("query/hover", params, token);
  if (query !== undefined) {
    const value = query.value as CompilerHover | null;
    if (value === null || (value.type === "" && value.symbol === null)) return null;
    const source = query.snapshot?.documents.find((document) => compilerUriKey(document.uri) === compilerUriKey(params.textDocument.uri));
    if (source === undefined) return null;
    const owner = value.symbol === null ? undefined : query.snapshot?.documents.find((document) => compilerUriKey(document.uri) === compilerUriKey(value.symbol?.uri ?? ""));
    const signature = value.symbol === null ? value.type : value.symbol.signature ?? (owner === undefined ? value.symbol.detail
      : symbolSignature({ ...owner, authority: "compiler" }, value.symbol));
    return { contents: { kind: "markdown", value: `${signatureMarkdown(signature)}${value.symbol?.documentation === undefined || value.symbol.documentation === "" ? "" : `\n\n${value.symbol.documentation}`}${value.type === "" ? "" : `\n\nType: \`${value.type}\``}\n\nAnalysis: **compiler${query.complete === false ? " (pre-CT; incomplete)" : ""}**` },
      range: new PositionMap(source.text).range(value.range) };
  }
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return null;
  const navigation = navigationIndex(params.textDocument.uri);
  const resolved = navigation.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return null;
  const source = index.document(params.textDocument.uri);
  if (source === undefined) return null;
  const positions = new PositionMap(source.text);
  const offset = positions.offset(params.position);
  const occurrence = source.occurrences.find(
    (candidate) => candidate.range.start <= offset && offset < candidate.range.end,
  );
  const signature = symbolSignature(resolved.analysis, resolved.symbol);
  const type = occurrence?.type === undefined ? "" : `\n\nType: \`${occurrence.type}\``;
  return {
    contents: {
      kind: "markdown",
      value: `${signatureMarkdown(signature)}${resolved.symbol.documentation ? `\n\n${resolved.symbol.documentation}` : ""}${type}\n\nAnalysis: **${resolved.analysis.authority}**`,
    },
    ...(occurrence === undefined ? {} : { range: positions.range(occurrence.range) }),
  };
});

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  if (!(await ensureCompilerFacts(params.textDocument.uri, false, false))) return [];
  let analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return [];
  const offset = new PositionMap(analysis.text).offset(params.position);
  let begin = offset;
  while (begin > 0 && /[A-Za-z0-9_]/.test(analysis.text[begin - 1] ?? "")) begin -= 1;
  if (begin > 0 && analysis.text[begin - 1] === ".") {
    if (!(await ensureCompilerFacts(params.textDocument.uri))) return [];
    analysis = index.document(params.textDocument.uri);
    if (analysis === undefined) return [];
  }
  const prefix = analysis.text.slice(begin, offset).toLocaleLowerCase();
  const items = new Map<string, CompletionItem>();
  for (const symbol of completionSymbols(analysis, offset, begin)) {
    if (prefix !== "" && !symbol.name.toLocaleLowerCase().startsWith(prefix)) continue;
    const resolved = index.symbolById(symbol.id);
    items.set(symbol.id, {
      label: symbol.name,
      kind: completionKind(symbol),
      detail: resolved === undefined ? symbol.detail : symbolSignature(resolved.analysis, symbol),
      ...(symbol.documentation ? { documentation: { kind: "markdown" as const, value: symbol.documentation } } : {}),
      sortText: `0-${symbol.name}`,
    });
  }
  if (!(begin > 0 && analysis.text[begin - 1] === ".")) {
    for (const keyword of ablaKeywords) {
      if (prefix !== "" && !keyword.startsWith(prefix)) continue;
      if (![...items.values()].some((item) => item.label === keyword)) {
        items.set(`keyword:${keyword}`, {
          label: keyword,
          kind: CompletionItemKind.Keyword,
          sortText: `1-${keyword}`,
        });
      }
    }
  }
  return [...items.values()].slice(0, 250);
});

connection.onSignatureHelp(async (params) => {
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return null;
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return null;
  const offset = new PositionMap(analysis.text).offset(params.position);
  const found = callContext(analysis.text, offset);
  if (found === undefined) return null;
  let context: CallContext = found;
  const resolvedCall = navigationIndex(analysis.uri).resolve(analysis.uri, new PositionMap(analysis.text).position(context.nameOffset));
  if (resolvedCall === undefined && analysis.authority === "compiler") return null;
  if (resolvedCall !== undefined && resolvedCall.symbol.kind !== "function" && resolvedCall.symbol.kind !== "class") return null;
  const candidates = resolvedCall === undefined ? index.symbols().filter(
    (symbol) => symbol.kind === "function" && symbol.name === context.name,
  ) : [resolvedCall.symbol];
  if (candidates.length === 0) return null;
  const labels = candidates[0]?.parameters?.map((parameter) => parameter.label) ?? [];
  const named = namedArgumentIndex(analysis.text, context.nameOffset + context.name.length, offset, labels);
  if (named !== undefined) context = { ...context, activeParameter: named };
  return {
    activeSignature: 0,
    activeParameter: context.activeParameter,
    signatures: candidates.map((symbol) => {
      const resolved = index.symbolById(symbol.id);
      return {
        label: resolved === undefined
          ? `${symbol.detail} ${symbol.name}`
          : symbolSignature(resolved.analysis, symbol),
        ...(symbol.documentation ? { documentation: { kind: "markdown" as const, value: symbol.documentation } } : {}),
        ...(symbol.parameters === undefined ? {} : {
          parameters: symbol.parameters.map((parameter) => ({
            label: parameter.label,
            ...(parameter.documentation ? { documentation: { kind: "markdown" as const, value: parameter.documentation } } : {}),
          })),
          activeParameter: Math.min(context.activeParameter, Math.max(0, symbol.parameters.length - 1)),
        }),
      };
    }),
  };
});

connection.languages.semanticTokens.on(async (params) => {
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return new SemanticTokensBuilder().build();
  const analysis = index.document(params.textDocument.uri);
  const builder = new SemanticTokensBuilder();
  if (analysis === undefined) return builder.build();
  const positions = new PositionMap(analysis.text);
  const sorted = [...analysis.occurrences].sort(
    (left, right) => left.range.start - right.range.start,
  );
  for (const occurrence of sorted) {
    const start = positions.position(occurrence.range.start);
    const declared = occurrence.declarationId === undefined
      ? analysis.authority === "syntax"
        ? index.resolve(analysis.uri, start)
        : undefined
      : index.symbolById(occurrence.declarationId);
    if (declared === undefined) continue;
    const end = positions.position(occurrence.range.end);
    if (start.line !== end.line || end.character <= start.character) continue;
    const declaration = declared.symbol.selectionRange.start === occurrence.range.start &&
      declared.symbol.uri === analysis.uri;
    const readonly = declared.symbol.kind === "value";
    builder.push(
      start.line,
      start.character,
      end.character - start.character,
      semanticTokenType(declared.symbol),
      (declaration ? 1 : 0) | (readonly ? 2 : 0),
    );
  }
  return builder.build();
});

connection.onFoldingRanges((params) => {
  const analysis = index.document(params.textDocument.uri);
  return analysis === undefined ? [] : foldingRanges(analysis.text);
});

connection.onSelectionRanges(async (params) => {
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return [];
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return [];
  const positions = new PositionMap(analysis.text);
  return params.positions.map((position) => {
    const offset = positions.offset(position);
    const occurrence = analysis.occurrences.find(
      (candidate) => candidate.range.start <= offset && offset < candidate.range.end,
    );
    const selected = occurrence === undefined
      ? undefined
      : index.containingSymbol(analysis.uri, occurrence.range);
    const documentRange = positions.range({ start: 0, end: analysis.text.length });
    if (occurrence === undefined) return { range: documentRange };
    const occurrenceRange = positions.range(occurrence.range);
    if (selected === undefined) {
      return { range: occurrenceRange, parent: { range: documentRange } };
    }
    return {
      range: occurrenceRange,
      parent: {
        range: positions.range(selected.symbol.range),
        parent: { range: documentRange },
      },
    };
  });
});

connection.languages.inlayHint.on(async (params) => {
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return [];
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined || analysis.authority !== "compiler") return [];
  const positions = new PositionMap(analysis.text);
  const requestedStart = positions.offset(params.range.start);
  const requestedEnd = positions.offset(params.range.end);
  const hints: InlayHint[] = [];
  for (const occurrence of analysis.occurrences) {
    if (
      occurrence.declarationId === undefined ||
      occurrence.range.end < requestedStart ||
      occurrence.range.start > requestedEnd
    ) continue;
    const target = index.symbolById(occurrence.declarationId);
    if (
      target === undefined ||
      (target.symbol.kind !== "function" && target.symbol.kind !== "class")
    ) continue;
    if (
      target.symbol.uri === analysis.uri &&
      target.symbol.selectionRange.start === occurrence.range.start &&
      target.symbol.selectionRange.end === occurrence.range.end
    ) continue;
    const parameters = target.analysis.symbols
      .filter((symbol) =>
        symbol.containerId === target.symbol.id &&
        (symbol.kind === "parameter" || symbol.kind === "property"),
      )
      .sort((left, right) => left.selectionRange.start - right.selectionRange.start);
    if (parameters.length === 0) continue;
    const arguments_ = callArgumentOffsets(analysis.text, occurrence.range.end);
    for (
      let argument = 0;
      argument < arguments_.length && argument < parameters.length;
      argument += 1
    ) {
      const offset = arguments_[argument];
      const parameter = parameters[argument];
      if (offset === undefined || parameter === undefined) continue;
      const following = analysis.text.slice(offset, offset + parameter.name.length + 2);
      if (
        following.startsWith(`${parameter.name}:`) ||
        following.startsWith(`${parameter.name} =`)
      ) continue;
      hints.push({
        position: positions.position(offset),
        label: `${parameter.name}:`,
        kind: InlayHintKind.Parameter,
        paddingRight: true,
      });
    }
  }
  if (typeInlayHints) {
    for (const hint of inferredTypeHints(analysis, requestedStart, requestedEnd)) {
      hints.push({ position: positions.position(hint.offset), label: hint.label, kind: InlayHintKind.Type });
    }
  }
  return hints;
});

connection.onDocumentFormatting((params) => {
  const analysis = index.document(params.textDocument.uri);
  return analysis === undefined ? [] : formatDocument(analysis.text);
});

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    for (let index = 0; index < current.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

/** The removals offered for an unused local, parameter or declaration: an edit the client previews, when it can. */
async function unusedRemovals(
  analysis: NonNullable<ReturnType<typeof index.document>>,
  positions: PositionMap,
  diagnostic: Diagnostic,
): Promise<Array<{ readonly title: string; readonly edit: WorkspaceEdit }>> {
  const code = diagnostic.code;
  if (code !== "W_UNUSED_LOCAL" && code !== "W_UNUSED_PARAMETER" && code !== "W_UNUSED_DECLARATION") return [];
  const message = typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value;
  const name = /`([^`]+)`/u.exec(message)?.[1]?.split(".").pop();
  if (name === undefined) return [];
  const start = positions.offset(diagnostic.range.start);
  const end = positions.offset(diagnostic.range.end);
  const preview = (edit: WorkspaceEdit, title: string): WorkspaceEdit => clientPreviewsEdits ? withPreview(edit, title) : edit;
  const fromText = (removal: TextRemoval | undefined): Array<{ readonly title: string; readonly edit: WorkspaceEdit }> => {
    if (removal === undefined) return [];
    const edit: WorkspaceEdit = { changes: { [analysis.uri]: [{ range: positions.range({ start: removal.start, end: removal.end }), newText: removal.newText }] } };
    return [{ title: removal.title, edit: preview(edit, removal.title) }];
  };
  if (code === "W_UNUSED_LOCAL") return fromText(removeUnusedLocal(analysis.text, start, name));
  if (code === "W_UNUSED_DECLARATION") {
    if (/: (?:field|parameter) `/u.test(message)) return [];
    return fromText(removeUnusedDeclaration(analysis.text, start, end, name));
  }
  // A parameter goes with the argument at every call: the signature refactoring, over the compiler's graph.
  const parameter = index.symbols().find((symbol) =>
    symbol.kind === "parameter" && symbol.uri === analysis.uri && symbol.selectionRange.start <= start && end <= symbol.selectionRange.end);
  if (parameter?.containerId === undefined) return [];
  const siblings = index.symbols()
    .filter((symbol) => symbol.kind === "parameter" && symbol.containerId === parameter.containerId)
    .sort((left, right) => left.range.start - right.range.start);
  const result = advancedRefactors.changeSignature({
    symbolId: parameter.containerId,
    parameters: siblings.filter((symbol) => symbol.id !== parameter.id).map((symbol) => ({ name: symbol.name, source: symbol.name })),
  });
  if (!result.ok) return [];
  const title = `Remove unused parameter \`${name}\` and its arguments`;
  return [{ title, edit: preview(result.edit, title) }];
}

connection.onCodeAction(async (params) => {
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return [];
  const semanticActions = compilerWorkspace?.graph !== true || compilerSnapshot?.complete === true;
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return [];
  const actions: CodeAction[] = [];
  if (
    analysis.authority === "compiler" &&
    (params.context.only === undefined ||
      params.context.only.some((kind) => CodeActionKind.QuickFix.startsWith(kind)))
  ) {
    const positions = new PositionMap(analysis.text);
    // This repairs a parser error, for which the compiler graph is incomplete.
    // The diagnostic anchors the insertion at the missing value's delimiter.
    const missingExpressions = analysis.diagnostics.filter((diagnostic) => diagnostic.code === "E_PARSE_EXPRESSION");
    if (missingExpressions.length > 0 && documents.get(analysis.uri)?.getText() === analysis.text &&
        (workspaceRoots.length === 0 || ownedSource(analysis.uri, workspaceRoots))) {
      const missing = missingNamedArgument(analysis.text, positions.offset(params.range.start), positions.offset(params.range.end));
      if (missing !== undefined && missingExpressions.some((diagnostic) => diagnostic.range.start === missing.delimiter)) {
        const at = positions.position(missing.offset);
        actions.push({
          title: `Fill named argument with '${missing.name}'`,
          kind: CodeActionKind.QuickFix,
          edit: { changes: { [analysis.uri]: [{ range: { start: at, end: at }, newText: ` ${missing.name}` }] } },
        });
      }
    }
    for (const diagnostic of semanticActions ? params.context.diagnostics : []) {
      if (diagnostic.source !== "ablac") continue;
      // The compiler's own fixes (a did-you-mean, a missing import) come as edits in the diagnostic's data.
      const given = dataFixes(diagnostic.data);
      for (const fix of given) {
        // Several diagnostics can ask for the same import: one action for it.
        if (actions.some((action) => action.title === fix.title && JSON.stringify(action.edit) === JSON.stringify({ changes: { [analysis.uri]: fix.edits.map((edit) => ({ range: edit.range, newText: edit.newText })) } }))) continue;
        actions.push({
          title: fix.title,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          isPreferred: given.length === 1,
          edit: { changes: { [analysis.uri]: fix.edits.map((edit) => ({ range: edit.range, newText: edit.newText })) } },
        });
      }
      // The unused-code warnings also get a removal (the compiler's own fix is the import's, or the rename to `_x`).
      for (const removal of await unusedRemovals(analysis, positions, diagnostic)) {
        try {
          await validateCompilerEdit(removal.edit);
          actions.push({ title: removal.title, kind: CodeActionKind.QuickFix, diagnostics: [diagnostic], edit: removal.edit });
        } catch {
          // A removal is shown only after compiler validation.
        }
      }
      // Only a diagnostic without fixes of the compiler's gets the editor's own spelling guess (an older compiler).
      if (given.length > 0 || diagnostic.code !== "E_SEMANTIC") continue;
      const start = positions.offset(diagnostic.range.start);
      const end = positions.offset(diagnostic.range.end);
      const misspelled = analysis.text.slice(start, end);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(misspelled)) continue;
      const ranked = completionSymbols(analysis, start, start)
        .filter((symbol) => symbol.name !== misspelled)
        .map((symbol) => ({ symbol, distance: editDistance(misspelled, symbol.name) }))
        .sort((left, right) =>
          left.distance === right.distance
            ? left.symbol.name.localeCompare(right.symbol.name)
            : left.distance - right.distance,
        );
      const best = ranked[0];
      const next = ranked[1];
      const limit = Math.max(2, Math.min(3, Math.floor(misspelled.length / 3)));
      if (best === undefined || best.distance > limit || best.distance === next?.distance) continue;
      const edit: WorkspaceEdit = {
        changes: {
          [analysis.uri]: [{ range: diagnostic.range, newText: best.symbol.name }],
        },
      };
      try {
        await validateCompilerEdit(edit);
        actions.push({
          title: `Change '${misspelled}' to '${best.symbol.name}'`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          isPreferred: true,
          edit,
        });
      } catch {
        // A spelling suggestion is shown only after compiler validation.
      }
    }
  }
  if (
    params.context.only === undefined ||
    params.context.only.some((kind) => CodeActionKind.SourceOrganizeImports.startsWith(kind))
  ) {
    const edit = organizeImports(analysis.text);
    if (edit !== undefined) {
      actions.push({
        title: "Organize Abla imports",
        kind: CodeActionKind.SourceOrganizeImports,
        edit: { changes: { [analysis.uri]: [edit] } },
      });
    }
  }
  // Fix all: only when asked for by kind (a save action), since the combined edit is validated by the compiler.
  if (
    semanticActions && analysis.authority === "compiler" && params.context.only !== undefined &&
    params.context.only.some((kind) => CodeActionKind.SourceFixAll.startsWith(kind) || kind.startsWith(CodeActionKind.SourceFixAll))
  ) {
    const edit = fixAllEdit(analysis);
    if (edit !== undefined) {
      try {
        await validateCompilerEdit(edit);
        actions.push({ title: "Fix all auto-fixable Abla problems", kind: CodeActionKind.SourceFixAll, edit });
      } catch {
        // A combined fix is offered only after compiler validation.
      }
    }
  }
  if (semanticActions && analysis.authority === "compiler") actions.push(...refactorActions(analysis, params.range, params.context.only));
  return actions;
});

/**
 * Every unambiguous compiler fix of the file in one edit: a diagnostic with exactly one fix of kind `import` (add the
 * missing import) or `remove` (an unused import). A did-you-mean (`replace`) and the rename/removal of unused locals
 * stay explicit choices.
 */
function fixAllEdit(analysis: DocumentAnalysis): WorkspaceEdit | undefined {
  const positions = new PositionMap(analysis.text);
  const edits: TextEdit[] = [];
  const taken: { start: number; end: number }[] = [];
  for (const diagnostic of analysis.diagnostics) {
    const fixes = diagnostic.fixes ?? [];
    const fix = fixes[0];
    if (fixes.length !== 1 || fix === undefined || (fix.kind !== "import" && fix.kind !== "remove")) continue;
    for (const edit of fix.edits) {
      // The same import wanted by several diagnostics is added once; an edit inside an earlier one is dropped.
      if (taken.some((range) => (edit.range.start === range.start && edit.range.end === range.end) || (edit.range.start < range.end && range.start < edit.range.end))) continue;
      taken.push(edit.range);
      edits.push({ range: positions.range(edit.range), newText: edit.newText });
    }
  }
  return edits.length === 0 ? undefined : { changes: { [analysis.uri]: edits } };
}

interface RefactorActionData { readonly refactor: { readonly command: string; readonly argument: Record<string, unknown> } }

/**
 * Refactorings offered at the cursor or selection. The edit is not computed here (a request comes at every cursor
 * move and each edit is compiler-validated): the action carries its command and is resolved when it is chosen.
 */
function refactorActions(analysis: DocumentAnalysis, selection: Range, only: readonly string[] | undefined): CodeAction[] {
  const wants = (kind: string): boolean => only === undefined || only.some((wanted) => kind.startsWith(wanted));
  const actions: CodeAction[] = [];
  const add = (title: string, kind: string, command: string, argument: Record<string, unknown>): void => {
    if (!wants(kind)) return;
    const data: RefactorActionData = { refactor: { command, argument } };
    actions.push({ title, kind, data });
  };
  const positions = new PositionMap(analysis.text);
  const start = positions.offset(selection.start);
  const end = positions.offset(selection.end);
  if (end > start && analysis.text.slice(start, end).trim() !== "") {
    const name = (base: string): string => {
      let candidate = base;
      for (let attempt = 2; new RegExp(`\\b${candidate}\\b`, "u").test(analysis.text); attempt += 1) candidate = `${base}${attempt}`;
      return candidate;
    };
    add("Extract to function", `${CodeActionKind.RefactorExtract}.function`, "abla.extractFunction", { uri: analysis.uri, range: selection, name: name("extracted") });
    if (!analysis.text.slice(start, end).includes("\n")) {
      add("Extract to local variable", `${CodeActionKind.RefactorExtract}.variable`, "abla.introduceBinding", { uri: analysis.uri, range: selection, name: name("extracted"), destination: "local" });
    }
  }
  const target = index.resolve(analysis.uri, selection.start);
  const symbol = target?.symbol;
  if (symbol !== undefined) {
    const local = symbol.detail === "local.val" || symbol.detail === "local.var";
    if (local || (symbol.kind === "function" && symbol.topLevel)) add(`Inline '${symbol.name}'`, CodeActionKind.RefactorInline, "abla.inlineSymbol", { symbolId: symbol.id });
    if (local) {
      const to = symbol.detail === "local.val" ? "var" : "val";
      add(`Convert '${symbol.name}' to ${to}`, `${CodeActionKind.RefactorRewrite}.binding`, "abla.changeBindingKind", { symbolId: symbol.id, kind: to });
    }
  }
  return actions;
}

connection.onCodeActionResolve(async (action) => {
  const data = (action.data as RefactorActionData | undefined)?.refactor;
  if (data === undefined) return action;
  const edit = await executeRefactorCommand({ command: data.command, arguments: [{ ...data.argument, apply: false }] });
  if (edit !== null) action.edit = edit;
  return action;
});

connection.onDocumentLinks((params) => {
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined || !analysis.uri.startsWith("file:")) return [];
  const positions = new PositionMap(analysis.text);
  const links = [];
  const imports = /^\s*import\s+(?:contract\s+)?"([^"\r\n]+)"/gmu;
  for (const match of analysis.text.matchAll(imports)) {
    const requested = match[1];
    const full = match[0];
    const matchOffset = match.index;
    if (requested === undefined || matchOffset === undefined || requested.startsWith("abla/")) {
      continue;
    }
    const relative = full.indexOf(requested);
    const start = matchOffset + relative;
    links.push({
      range: positions.range({ start, end: start + requested.length }),
      target: new URL(requested, analysis.uri).href,
      tooltip: `Open ${requested}`,
    });
  }
  return links;
});

// Run / debug lenses on the `main` of a test program (the client registers abla.runTest and abla.debugTest).
connection.onCodeLens((params): CodeLens[] => {
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined || !isTestProgram(analysis.uri, analysis.text)) return [];
  const main = analysis.symbols.find((symbol) => symbol.kind === "function" && symbol.name === "main" && symbol.topLevel);
  if (main === undefined) return [];
  const range = new PositionMap(analysis.text).range(main.selectionRange);
  return [
    { range, command: { title: "$(play) Run test", command: "abla.runTest", arguments: [analysis.uri] } },
    { range, command: { title: "$(debug) Debug test", command: "abla.debugTest", arguments: [analysis.uri] } },
  ];
});

function typeHierarchyItem(symbol: AblaSymbol): TypeHierarchyItem | undefined {
  const item = callHierarchyItem(symbol);
  return item === undefined ? undefined : { ...item, kind: symbolKind(symbol) };
}

connection.onImplementation(async (params: TextDocumentPositionParams): Promise<Location[]> => {
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return [];
  const resolved = index.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return [];
  const symbol = resolved.symbol;
  const targets = symbol.kind === "class" || symbol.kind === "interface"
    ? subtypesOf(index.documents(), symbol.id)
    : symbol.kind === "function" ? implementationsOf(index.documents(), symbol) : [];
  return targets.flatMap((target) => {
    const document = index.document(target.uri);
    return document === undefined ? [] : [Location.create(target.uri, new PositionMap(document.text).range(target.selectionRange))];
  });
});

connection.languages.typeHierarchy.onPrepare(async (params) => {
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return null;
  const resolved = index.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined || (resolved.symbol.kind !== "class" && resolved.symbol.kind !== "interface")) return null;
  const item = typeHierarchyItem(resolved.symbol);
  return item === undefined ? null : [item];
});

connection.languages.typeHierarchy.onSupertypes(async (params) => {
  const id = (params.item.data as { readonly id?: string } | undefined)?.id;
  const owner = id === undefined ? undefined : index.symbolById(id);
  if (owner === undefined) return [];
  return supertypeIds(owner.analysis, owner.symbol).flatMap((superId) => {
    const target = index.symbolById(superId);
    const item = target === undefined ? undefined : typeHierarchyItem(target.symbol);
    return item === undefined ? [] : [item];
  });
});

connection.languages.typeHierarchy.onSubtypes(async (params) => {
  const id = (params.item.data as { readonly id?: string } | undefined)?.id;
  if (id === undefined) return [];
  return subtypesOf(index.documents(), id).flatMap((symbol) => {
    const item = typeHierarchyItem(symbol);
    return item === undefined ? [] : [item];
  });
});

// Renaming or moving a file (or folder) in the editor rewrites the imports that name it.
connection.workspace.onWillRenameFiles((params): WorkspaceEdit | null => {
  const files = index.documents().filter((document) => document.uri.startsWith("file:")).map((document) => ({ uri: document.uri, text: document.text }));
  const edits = importRenameEdits(files, params.files.map((file) => ({ oldUri: file.oldUri, newUri: file.newUri })));
  if (edits.size === 0) return null;
  return { changes: Object.fromEntries(edits) };
});

connection.languages.callHierarchy.onPrepare(async (params) => {
  if (!(await ensureCompilerFacts(params.textDocument.uri))) return [];
  const resolved = index.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined || resolved.symbol.kind !== "function") return null;
  const item = callHierarchyItem(resolved.symbol);
  return item === undefined ? null : [item];
});

connection.languages.callHierarchy.onIncomingCalls(async (params) => {
  if (!(await ensureCompilerFacts(params.item.uri))) return [];
  const id = (params.item.data as { readonly id?: string } | undefined)?.id;
  if (id === undefined) return [];
  const groups = new Map<string, CallHierarchyIncomingCall>();
  for (const analysis of index.documents()) {
    const positions = new PositionMap(analysis.text);
    for (const occurrence of analysis.occurrences) {
      if (occurrence.declarationId !== id) continue;
      const owner = index.containingSymbol(analysis.uri, occurrence.range);
      if (owner === undefined || owner.symbol.id === id || owner.symbol.kind !== "function") {
        continue;
      }
      const item = callHierarchyItem(owner.symbol);
      if (item === undefined) continue;
      const existing = groups.get(owner.symbol.id);
      if (existing === undefined) {
        groups.set(owner.symbol.id, {
          from: item,
          fromRanges: [positions.range(occurrence.range)],
        });
      } else existing.fromRanges.push(positions.range(occurrence.range));
    }
  }
  return [...groups.values()];
});

connection.languages.callHierarchy.onOutgoingCalls(async (params) => {
  if (!(await ensureCompilerFacts(params.item.uri))) return [];
  const id = (params.item.data as { readonly id?: string } | undefined)?.id;
  if (id === undefined) return [];
  const source = index.symbolById(id);
  if (source === undefined) return [];
  const positions = new PositionMap(source.analysis.text);
  const groups = new Map<string, CallHierarchyOutgoingCall>();
  for (const occurrence of source.analysis.occurrences) {
    if (
      occurrence.declarationId === undefined ||
      occurrence.declarationId === id ||
      occurrence.range.start < source.symbol.range.start ||
      occurrence.range.end > source.symbol.range.end
    ) continue;
    const target = index.symbolById(occurrence.declarationId);
    if (target === undefined || target.symbol.kind !== "function") continue;
    const item = callHierarchyItem(target.symbol);
    if (item === undefined) continue;
    const existing = groups.get(target.symbol.id);
    if (existing === undefined) {
      groups.set(target.symbol.id, {
        to: item,
        fromRanges: [positions.range(occurrence.range)],
      });
    } else existing.fromRanges.push(positions.range(occurrence.range));
  }
  return [...groups.values()];
});

connection.onPrepareRename(async (params: TextDocumentPositionParams): Promise<Range | null> => {
  await ensureCompilerFacts(params.textDocument.uri, true);
  const resolved = index.prepareRename(params.textDocument.uri, params.position);
  if (resolved === undefined) return null;
  return new PositionMap(resolved.analysis.text).range(resolved.symbol.selectionRange);
});

connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit> => {
  await ensureCompilerFacts(params.textDocument.uri, true);
  const result = index.rename({
    uri: params.textDocument.uri,
    position: params.position,
    newName: params.newName,
  });
  if (!result.ok) throw new ResponseError(ErrorCodes.InvalidRequest, result.reason);
  await validateCompilerEdit(result.edit);
  return result.edit;
});

interface CommandSelection {
  readonly uri: string;
  readonly position: { readonly line: number; readonly character: number };
}

function commandSymbolId(
  symbolId: string | undefined,
  selection: CommandSelection | undefined,
): string {
  if (symbolId !== undefined) return symbolId;
  if (selection === undefined) return "";
  return index.resolve(selection.uri, selection.position)?.symbol.id ?? "";
}

async function executeRefactorCommand(params: { readonly command: string; readonly arguments?: readonly unknown[] }): Promise<WorkspaceEdit | null> {
  const argument = params.arguments?.[0] as { readonly uri?: string; readonly selection?: CommandSelection; readonly selections?: readonly CommandSelection[]; readonly renames?: readonly RenameRequest[]; readonly symbolId?: string; readonly classSymbolId?: string; readonly symbolIds?: readonly string[] } | undefined;
  const selectedId = argument?.symbolId ?? argument?.classSymbolId ?? argument?.symbolIds?.[0];
  const requestedUri = argument?.selection?.uri ?? argument?.selections?.[0]?.uri ?? argument?.renames?.[0]?.uri ?? argument?.uri ?? (selectedId === undefined ? undefined : index.symbolById(selectedId)?.symbol.uri);
  await ensureCompilerFacts(requestedUri, true);
  let apply = false;
  let result: EditResult;
  if (params.command === "abla.renameSymbols") {
    const argument = params.arguments?.[0] as
      | { readonly renames?: readonly RenameRequest[]; readonly apply?: boolean }
      | undefined;
    apply = argument?.apply === true;
    result = index.bulkRename(argument?.renames ?? []);
  } else if ([
    "abla.moveDeclarations",
    "abla.moveTypes",
    "abla.splitDeclarations",
    "abla.mergeDeclarations",
  ].includes(params.command)) {
    const argument = params.arguments?.[0] as
      | {
          readonly symbolIds?: readonly string[];
          readonly selections?: readonly {
            readonly uri: string;
            readonly position: { readonly line: number; readonly character: number };
          }[];
          readonly targetUri?: string;
          readonly createTarget?: boolean;
          readonly apply?: boolean;
        }
      | undefined;
    apply = argument?.apply === true;
    const selectedIds = (argument?.selections ?? []).flatMap((selection) => {
      const resolved = index.resolve(selection.uri, selection.position);
      return resolved === undefined ? [] : [resolved.symbol.id];
    });
    result = index.moveDeclarations({
      symbolIds: [...(argument?.symbolIds ?? []), ...selectedIds],
      targetUri: argument?.targetUri ?? "",
      createTarget: argument?.createTarget === true,
    });
  } else if (params.command === "abla.changeSignature") {
    const argument = params.arguments?.[0] as
      | (Omit<ChangeSignatureRequest, "symbolId"> & {
          readonly symbolId?: string;
          readonly selection?: CommandSelection;
          readonly apply?: boolean;
        })
      | undefined;
    apply = argument?.apply === true;
    result = advancedRefactors.changeSignature({
      symbolId: commandSymbolId(argument?.symbolId, argument?.selection),
      parameters: argument?.parameters ?? [],
      ...(argument?.returnType === undefined ? {} : { returnType: argument.returnType }),
    });
  } else if (params.command === "abla.extractFunction") {
    const argument = params.arguments?.[0] as (ExtractFunctionRequest & { readonly apply?: boolean }) | undefined;
    apply = argument?.apply === true;
    result = argument === undefined
      ? { ok: false, reason: "extract function requires a request" }
      : advancedRefactors.extractFunction(argument);
  } else if (params.command === "abla.functionToMethod") {
    const argument = params.arguments?.[0] as
      | (Omit<ConvertFunctionToMethodRequest, "symbolId"> & {
          readonly symbolId?: string;
          readonly selection?: CommandSelection;
          readonly apply?: boolean;
        })
      | undefined;
    apply = argument?.apply === true;
    result = advancedRefactors.functionToMethod({
      symbolId: commandSymbolId(argument?.symbolId, argument?.selection),
      receiver: argument?.receiver ?? 0,
    });
  } else if (params.command === "abla.methodToFunction") {
    const argument = params.arguments?.[0] as
      | (Omit<ConvertMethodToFunctionRequest, "symbolId"> & {
          readonly symbolId?: string;
          readonly selection?: CommandSelection;
          readonly apply?: boolean;
        })
      | undefined;
    apply = argument?.apply === true;
    result = advancedRefactors.methodToFunction({
      symbolId: commandSymbolId(argument?.symbolId, argument?.selection),
      ...(argument?.receiverName === undefined ? {} : { receiverName: argument.receiverName }),
    });
  } else if (params.command === "abla.inlineSymbol") {
    const argument = params.arguments?.[0] as
      | (Omit<InlineSymbolRequest, "symbolId"> & {
          readonly symbolId?: string;
          readonly selection?: CommandSelection;
          readonly apply?: boolean;
        })
      | undefined;
    apply = argument?.apply === true;
    result = advancedRefactors.inlineSymbol({
      symbolId: commandSymbolId(argument?.symbolId, argument?.selection),
      ...(argument?.removeDeclaration === undefined ? {} : { removeDeclaration: argument.removeDeclaration }),
    });
  } else if (params.command === "abla.introduceBinding") {
    const argument = params.arguments?.[0] as
      | (IntroduceBindingRequest & { readonly apply?: boolean })
      | undefined;
    apply = argument?.apply === true;
    result = argument === undefined
      ? { ok: false, reason: "introduce binding requires a request" }
      : advancedRefactors.introduceBinding(argument);
  } else if (params.command === "abla.changeBindingKind") {
    const argument = params.arguments?.[0] as
      | (Omit<ChangeBindingKindRequest, "symbolId"> & {
          readonly symbolId?: string;
          readonly selection?: CommandSelection;
          readonly apply?: boolean;
        })
      | undefined;
    apply = argument?.apply === true;
    result = advancedRefactors.changeBindingKind({
      symbolId: commandSymbolId(argument?.symbolId, argument?.selection),
      kind: argument?.kind ?? "val",
    });
  } else if (params.command === "abla.promoteLocal") {
    const argument = params.arguments?.[0] as
      | (Omit<PromoteLocalRequest, "symbolId"> & {
          readonly symbolId?: string;
          readonly selection?: CommandSelection;
          readonly apply?: boolean;
        })
      | undefined;
    apply = argument?.apply === true;
    result = advancedRefactors.promoteLocal({
      symbolId: commandSymbolId(argument?.symbolId, argument?.selection),
      destination: argument?.destination ?? "parameter",
    });
  } else if (params.command === "abla.extractInterface") {
    const argument = params.arguments?.[0] as
      | (Partial<ExtractInterfaceRequest> & {
          readonly selections?: readonly CommandSelection[];
          readonly apply?: boolean;
        })
      | undefined;
    apply = argument?.apply === true;
    const selected = (argument?.selections ?? []).flatMap((selection) => {
      const resolved = index.resolve(selection.uri, selection.position);
      return resolved === undefined ? [] : [resolved.symbol];
    });
    const selectedMethods = selected.filter((symbol) => symbol.kind === "function");
    const inferredClass = selectedMethods[0]?.containerId ??
      selected.find((symbol) => symbol.kind === "class")?.id;
    result = advancedRefactors.extractInterface({
      classSymbolId: argument?.classSymbolId ?? inferredClass ?? "",
      methodSymbolIds: argument?.methodSymbolIds ?? selectedMethods.map((symbol) => symbol.id),
      name: argument?.name ?? "",
      ...(argument?.targetUri === undefined ? {} : { targetUri: argument.targetUri }),
    });
  } else if (params.command === "abla.generateDeclaration") {
    const argument = params.arguments?.[0] as (GenerateDeclarationRequest & { readonly apply?: boolean }) | undefined;
    apply = argument?.apply === true;
    result = argument === undefined
      ? { ok: false, reason: "generate declaration requires a request" }
      : advancedRefactors.generateDeclaration(argument);
  } else if (params.command === "abla.repairOwnership") {
    const argument = params.arguments?.[0] as (OwnershipRepairRequest & { readonly apply?: boolean }) | undefined;
    apply = argument?.apply === true;
    result = argument === undefined
      ? { ok: false, reason: "ownership repair requires a request" }
      : advancedRefactors.repairOwnership(argument);
  } else if (params.command === "abla.toggleCompileTime") {
    const argument = params.arguments?.[0] as
      | (Omit<ToggleCompileTimeRequest, "symbolId"> & {
          readonly symbolId?: string;
          readonly selection?: CommandSelection;
          readonly apply?: boolean;
        })
      | undefined;
    apply = argument?.apply === true;
    result = advancedRefactors.toggleCompileTime({
      symbolId: commandSymbolId(argument?.symbolId, argument?.selection),
      compileTime: argument?.compileTime ?? true,
    });
  } else if (params.command === "abla.removeDeadCode") {
    const argument = params.arguments?.[0] as (RemoveDeadCodeRequest & { readonly apply?: boolean }) | undefined;
    apply = argument?.apply === true;
    result = advancedRefactors.removeDeadCode(argument ?? {});
  } else if (params.command === "abla.applyRefactorRecipe") {
    const argument = params.arguments?.[0] as
      | { readonly operations?: readonly RefactorOperation[]; readonly apply?: boolean }
      | undefined;
    apply = argument?.apply === true;
    result = advancedRefactors.recipe(argument?.operations ?? []);
  } else if (params.command === "abla.applyStagedRefactorRecipe") {
    const argument = params.arguments?.[0] as
      | { readonly operations?: readonly StagedRefactorOperation[]; readonly apply?: boolean }
      | undefined;
    apply = argument?.apply === true;
    if (compiler === undefined || compilerSnapshot === undefined) {
      result = { ok: false, reason: "staged recipes require an active compiler snapshot" };
    } else {
      result = await applyStagedRecipe(
        compilerSnapshot,
        argument?.operations ?? [],
        compiler,
      );
    }
  } else return null;
  if (!result.ok) throw new ResponseError(ErrorCodes.InvalidRequest, result.reason);
  await validateCompilerEdit(result.edit);
  if (apply) {
    const applied = await connection.workspace.applyEdit(result.edit);
    if (!applied.applied) {
      throw new ResponseError(
        ErrorCodes.InternalError,
        applied.failureReason ?? "the client rejected the workspace edit",
      );
    }
  }
  return result.edit;
}
connection.onExecuteCommand(executeRefactorCommand);

connection.onShutdown(async () => {
  shuttingDown = true;
  if (compilerRestartTimer !== undefined) clearTimeout(compilerRestartTimer);
  compilerWorkspace?.dispose(); compilerWorkspace = undefined;
  await compiler?.stop();
  compiler = undefined;
  compilerRevision = undefined;
  compilerSnapshot = undefined;
});

documents.listen(connection);
connection.listen();
