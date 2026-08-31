#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CodeActionKind,
  createConnection,
  CompletionItemKind,
  DiagnosticSeverity,
  DocumentHighlightKind,
  DocumentSymbol,
  ErrorCodes,
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
  type CallHierarchyOutgoingCall,
  type CodeAction,
  type CompletionItem,
  type Hover,
  type InlayHint,
  type ReferenceParams,
  type RenameParams,
  type TextDocumentPositionParams,
  type WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { CompilerClient } from "./compiler-client.js";
import type { CompilerWorkspaceSnapshot } from "./compiler-protocol.js";
import {
  ablaKeywords,
  callArgumentOffsets,
  callContext,
  foldingRanges,
  formatDocument,
  organizeImports,
  symbolSignature,
} from "./editor-features.js";
import type { AblaSymbol, DocumentAnalysis } from "./model.js";
import { WorkspaceIndex, type EditResult, type RenameRequest } from "./index.js";
import { PositionMap } from "./positions.js";
import { SyntaxAnalyzer } from "./source.js";
import { indexWorkspace } from "./workspace.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const index = new WorkspaceIndex(new SyntaxAnalyzer());
let workspaceRoots: string[] = [];
let compilerConfiguration: {
  readonly enabled: boolean;
  readonly path: string;
  readonly arguments?: readonly string[];
} = { enabled: true, path: process.env.ABLA_COMPILER ?? "ablac" };
let compiler: CompilerClient | undefined;
let compilerRevision: string | undefined;
let compilerAnalysis: AbortController | undefined;
let compilerAnalysisTimer: ReturnType<typeof setTimeout> | undefined;
let compilerRestartTimer: ReturnType<typeof setTimeout> | undefined;
let compilerRestartAttempt = 0;
let shuttingDown = false;

interface InitializationOptions {
  readonly compiler?: {
    readonly enabled?: boolean;
    readonly path?: string;
    readonly arguments?: readonly string[];
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
    const imports = /^\s*import\s+(?:contract\s+)?"([^"\r\n]+)"/gmu;
    for (const match of analysis.text.matchAll(imports)) {
      const requested = match[1];
      if (requested === undefined || requested.startsWith("abla/")) continue;
      try {
        const importedUri = new URL(requested, analysis.uri).href;
        for (const symbol of index.document(importedUri)?.symbols ?? []) {
          if (symbol.topLevel) add(symbol);
        }
      } catch {
        // Non-filesystem imports are supplied by the compiler in later schemas.
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

function publishDiagnostics(analysis: DocumentAnalysis): void {
  const positions = new PositionMap(analysis.text);
  connection.sendDiagnostics({
    uri: analysis.uri,
    version: analysis.version,
    diagnostics: analysis.diagnostics.map((diagnostic) => ({
      severity: DiagnosticSeverity.Error,
      source: analysis.authority === "compiler" ? "ablac" : "abla-syntax",
      code: diagnostic.code,
      message: diagnostic.message,
      range: positions.range(diagnostic.range),
    })),
  });
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const initialization = params.initializationOptions as InitializationOptions | undefined;
  const configured = initialization?.compiler;
  compilerConfiguration = {
    enabled: configured?.enabled ?? true,
    path: configured?.path ?? process.env.ABLA_COMPILER ?? "ablac",
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
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
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
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceOrganizeImports],
      },
      documentLinkProvider: { resolveProvider: false },
      callHierarchyProvider: true,
      renameProvider: { prepareProvider: true },
      executeCommandProvider: {
        commands: ["abla.renameSymbols", "abla.moveDeclarations"],
      },
      experimental: {
        abla: {
          analysisAuthority: "syntax",
          compilerAnalysisProtocol: 1,
          semanticState: compilerConfiguration.enabled ? "starting" : "disabled",
          transactionalRefactors: ["renameSymbols", "moveDeclarations"],
        },
      },
    },
    serverInfo: { name: "abla-lsp", version: "0.1.1" },
  };
});

connection.onInitialized(() => {
  void indexWorkspace(connection, index, workspaceRoots).catch((error: unknown) => {
    connection.console.error(`workspace indexing failed: ${String(error)}`);
  });
  if (compilerConfiguration.enabled) void startCompiler();
});

async function startCompiler(): Promise<void> {
  let candidate: CompilerClient;
  candidate = new CompilerClient({
    executable: compilerConfiguration.path,
    ...(compilerConfiguration.arguments === undefined
      ? {}
      : { arguments: compilerConfiguration.arguments }),
    log: (message) => connection.console.info(`ablac analyze: ${message}`),
    onExit: (error) => {
      if (compiler === candidate) compiler = undefined;
      void indexWorkspace(connection, index, workspaceRoots);
      for (const document of documents.all()) {
        publishDiagnostics(index.upsert(
          document.uri,
          document.version,
          document.getText(),
        ));
      }
      scheduleCompilerRestart(error);
    },
  });
  try {
    const initialized = await candidate.start({
      workspaceRoots,
      clientName: "abla-lsp",
      clientVersion: "0.1.1",
    });
    if (initialized.protocolVersion !== 1) {
      throw new Error(
        `compiler analysis protocol ${initialized.protocolVersion} is unsupported`,
      );
    }
    compiler = candidate;
    compilerRestartAttempt = 0;
    connection.console.info(
      `connected to ablac ${initialized.compilerVersion} analysis protocol 1`,
    );
    for (const document of documents.all()) {
      await candidate.open({
        uri: document.uri,
        version: document.version,
        text: document.getText(),
      });
    }
    scheduleCompilerAnalysis(0);
  } catch (error) {
    connection.console.warn(
      `compiler analysis unavailable; continuing in syntax mode: ${String(error)}`,
    );
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

function acceptCompilerSnapshot(snapshot: CompilerWorkspaceSnapshot): void {
  compilerRevision = snapshot.revision;
  for (const document of snapshot.documents) {
    const analysis: DocumentAnalysis = {
      authority: "compiler",
      uri: document.uri,
      version: document.version,
      text: document.text,
      symbols: document.symbols,
      occurrences: document.occurrences,
      diagnostics: document.diagnostics,
    };
    index.upsertAnalysis(analysis);
    if (documents.get(document.uri) !== undefined) publishDiagnostics(analysis);
  }
}

async function validateCompilerEdit(edit: WorkspaceEdit): Promise<void> {
  const active = compiler;
  const baseRevision = compilerRevision;
  const changes = edit.changes ?? {};
  const compilerOwned = Object.keys(changes).some(
    (uri) => index.document(uri)?.authority === "compiler",
  );
  if (!compilerOwned) return;
  if (active === undefined || baseRevision === undefined) {
    throw new ResponseError(
      ErrorCodes.ServerNotInitialized,
      "compiler validation is unavailable for this semantic refactor",
    );
  }
  const edits = Object.entries(changes).flatMap(([uri, documentEdits]) => {
    const analysis = index.document(uri);
    if (analysis === undefined) return [];
    const positions = new PositionMap(analysis.text);
    return documentEdits.map((documentEdit) => {
      const start = positions.offset(documentEdit.range.start);
      const end = positions.offset(documentEdit.range.end);
      return {
        uri,
        start: Buffer.byteLength(analysis.text.slice(0, start), "utf8"),
        end: Buffer.byteLength(analysis.text.slice(0, end), "utf8"),
        newText: documentEdit.newText,
      };
    });
  });
  const validated = await active.validate({
    baseRevision,
    edits,
    invariants: ["no-new-errors", "preserve-unedited-symbols"],
  });
  if (!validated.valid) {
    throw new ResponseError(
      ErrorCodes.InvalidRequest,
      validated.reason ?? "the compiler rejected the prospective refactor",
    );
  }
}

function scheduleCompilerAnalysis(delay = 50): void {
  if (compiler === undefined) return;
  if (compilerAnalysisTimer !== undefined) clearTimeout(compilerAnalysisTimer);
  compilerAnalysis?.abort(new Error("superseded by a newer document version"));
  compilerAnalysisTimer = setTimeout(() => {
    compilerAnalysisTimer = undefined;
    const controller = new AbortController();
    compilerAnalysis = controller;
    void compiler
      ?.analyze({}, controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) acceptCompilerSnapshot(snapshot);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          connection.console.warn(`compiler analysis failed: ${String(error)}`);
        }
      })
      .finally(() => {
        if (compilerAnalysis === controller) compilerAnalysis = undefined;
      });
  }, delay);
}

function updateCompilerDocument(
  method: "open" | "change",
  document: TextDocument,
): void {
  const active = compiler;
  if (active === undefined) return;
  const update = {
    uri: document.uri,
    version: document.version,
    text: document.getText(),
  };
  const operation = method === "open" ? active.open(update) : active.change(update);
  void operation
    .then(() => scheduleCompilerAnalysis())
    .catch((error: unknown) => {
      connection.console.warn(`compiler overlay update failed: ${String(error)}`);
    });
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
  void compiler
    ?.close({ uri: event.document.uri })
    .then(() => scheduleCompilerAnalysis())
    .catch((error: unknown) => {
      connection.console.warn(`compiler overlay close failed: ${String(error)}`);
    });
  if (!event.document.uri.startsWith("file:")) {
    index.remove(event.document.uri);
    return;
  }
  void fs
    .readFile(fileURLToPath(event.document.uri), "utf8")
    .then((text) => index.upsert(event.document.uri, 0, text))
    .catch(() => index.remove(event.document.uri));
});

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return [];
  const positions = new PositionMap(analysis.text);
  return analysis.symbols.map((symbol) => ({
    name: symbol.name,
    detail: `${symbol.detail} · ${analysis.authority}`,
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

connection.onDefinition((params: TextDocumentPositionParams): Location[] => {
  const resolved = index.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return [];
  const resolvedLocation = location(resolved.symbol);
  return resolvedLocation === undefined ? [] : [resolvedLocation];
});

connection.onDeclaration((params: TextDocumentPositionParams): Location[] => {
  const resolved = index.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return [];
  const resolvedLocation = location(resolved.symbol);
  return resolvedLocation === undefined ? [] : [resolvedLocation];
});

connection.onTypeDefinition((params: TextDocumentPositionParams): Location[] => {
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

connection.onReferences((params: ReferenceParams): Location[] => {
  const resolved = index.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return [];
  const result: Location[] = [];
  for (const [uri, occurrences] of index.references(resolved)) {
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
  const resolved = index.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return [];
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return [];
  const occurrences = index.references(resolved).get(analysis.uri) ?? [];
  const positions = new PositionMap(analysis.text);
  return occurrences.map((occurrence) => ({
    range: positions.range(occurrence.range),
    kind: DocumentHighlightKind.Text,
  }));
});

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const resolved = index.resolve(params.textDocument.uri, params.position);
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
      value: `\`${signature}\`${type}\n\nAnalysis: **${resolved.analysis.authority}**`,
    },
    ...(occurrence === undefined ? {} : { range: positions.range(occurrence.range) }),
  };
});

connection.onCompletion((params): CompletionItem[] => {
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return [];
  const offset = new PositionMap(analysis.text).offset(params.position);
  let begin = offset;
  while (begin > 0 && /[A-Za-z0-9_]/.test(analysis.text[begin - 1] ?? "")) begin -= 1;
  const prefix = analysis.text.slice(begin, offset).toLocaleLowerCase();
  const items = new Map<string, CompletionItem>();
  for (const symbol of completionSymbols(analysis, offset, begin)) {
    if (prefix !== "" && !symbol.name.toLocaleLowerCase().startsWith(prefix)) continue;
    const resolved = index.symbolById(symbol.id);
    items.set(symbol.name, {
      label: symbol.name,
      kind: completionKind(symbol),
      detail: resolved === undefined ? symbol.detail : symbolSignature(resolved.analysis, symbol),
      sortText: `0-${symbol.name}`,
    });
  }
  if (!(begin > 0 && analysis.text[begin - 1] === ".")) {
    for (const keyword of ablaKeywords) {
      if (prefix !== "" && !keyword.startsWith(prefix)) continue;
      if (!items.has(keyword)) {
        items.set(keyword, {
          label: keyword,
          kind: CompletionItemKind.Keyword,
          sortText: `1-${keyword}`,
        });
      }
    }
  }
  return [...items.values()].slice(0, 250);
});

connection.onSignatureHelp((params) => {
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return null;
  const offset = new PositionMap(analysis.text).offset(params.position);
  const context = callContext(analysis.text, offset);
  if (context === undefined) return null;
  const candidates = index.symbols().filter(
    (symbol) => symbol.kind === "function" && symbol.name === context.name,
  );
  if (candidates.length === 0) return null;
  return {
    activeSignature: 0,
    activeParameter: context.activeParameter,
    signatures: candidates.map((symbol) => {
      const resolved = index.symbolById(symbol.id);
      return {
        label: resolved === undefined
          ? `${symbol.detail} ${symbol.name}`
          : symbolSignature(resolved.analysis, symbol),
      };
    }),
  };
});

connection.languages.semanticTokens.on((params) => {
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

connection.onSelectionRanges((params) => {
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

connection.languages.inlayHint.on((params) => {
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

connection.onCodeAction(async (params) => {
  const analysis = index.document(params.textDocument.uri);
  if (analysis === undefined) return [];
  const actions: CodeAction[] = [];
  if (
    analysis.authority === "compiler" &&
    (params.context.only === undefined ||
      params.context.only.some((kind) => CodeActionKind.QuickFix.startsWith(kind)))
  ) {
    const positions = new PositionMap(analysis.text);
    for (const diagnostic of params.context.diagnostics) {
      if (diagnostic.source !== "ablac" || diagnostic.code !== "E_SEMANTIC") continue;
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
  return actions;
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

connection.languages.callHierarchy.onPrepare((params) => {
  const resolved = index.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined || resolved.symbol.kind !== "function") return null;
  const item = callHierarchyItem(resolved.symbol);
  return item === undefined ? null : [item];
});

connection.languages.callHierarchy.onIncomingCalls((params) => {
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

connection.languages.callHierarchy.onOutgoingCalls((params) => {
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

connection.onPrepareRename((params: TextDocumentPositionParams): Range | null => {
  const resolved = index.prepareRename(params.textDocument.uri, params.position);
  if (resolved === undefined) return null;
  return new PositionMap(resolved.analysis.text).range(resolved.symbol.selectionRange);
});

connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit> => {
  const result = index.rename({
    uri: params.textDocument.uri,
    position: params.position,
    newName: params.newName,
  });
  if (!result.ok) throw new ResponseError(ErrorCodes.InvalidRequest, result.reason);
  await validateCompilerEdit(result.edit);
  return result.edit;
});

connection.onExecuteCommand(async (params): Promise<WorkspaceEdit | null> => {
  let apply = false;
  let result: EditResult;
  if (params.command === "abla.renameSymbols") {
    const argument = params.arguments?.[0] as
      | { readonly renames?: readonly RenameRequest[]; readonly apply?: boolean }
      | undefined;
    apply = argument?.apply === true;
    result = index.bulkRename(argument?.renames ?? []);
  } else if (params.command === "abla.moveDeclarations") {
    const argument = params.arguments?.[0] as
      | {
          readonly symbolIds?: readonly string[];
          readonly selections?: readonly {
            readonly uri: string;
            readonly position: { readonly line: number; readonly character: number };
          }[];
          readonly targetUri?: string;
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
    });
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
});

connection.onShutdown(async () => {
  shuttingDown = true;
  if (compilerAnalysisTimer !== undefined) clearTimeout(compilerAnalysisTimer);
  if (compilerRestartTimer !== undefined) clearTimeout(compilerRestartTimer);
  compilerAnalysis?.abort(new Error("language server is shutting down"));
  await compiler?.stop();
  compiler = undefined;
  compilerRevision = undefined;
});

documents.listen(connection);
connection.listen();
