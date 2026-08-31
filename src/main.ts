#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createConnection,
  DiagnosticSeverity,
  DocumentSymbol,
  ErrorCodes,
  InitializeParams,
  InitializeResult,
  Location,
  ProposedFeatures,
  Range,
  ResponseError,
  SymbolInformation,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  WorkspaceSymbolParams,
  type DocumentSymbolParams,
  type Hover,
  type ReferenceParams,
  type RenameParams,
  type TextDocumentPositionParams,
  type WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { AblaSymbol, DocumentAnalysis } from "./model.js";
import { WorkspaceIndex, type RenameRequest } from "./index.js";
import { PositionMap } from "./positions.js";
import { SyntaxAnalyzer } from "./source.js";
import { indexWorkspace } from "./workspace.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const index = new WorkspaceIndex(new SyntaxAnalyzer());
let workspaceRoots: string[] = [];

function symbolKind(symbol: AblaSymbol): SymbolKind {
  switch (symbol.kind) {
    case "function":
      return SymbolKind.Function;
    case "class":
      return SymbolKind.Class;
    case "enum":
      return SymbolKind.Enum;
    case "value":
      return SymbolKind.Constant;
    case "variable":
      return SymbolKind.Variable;
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

function publishDiagnostics(analysis: DocumentAnalysis): void {
  const positions = new PositionMap(analysis.text);
  connection.sendDiagnostics({
    uri: analysis.uri,
    version: analysis.version,
    diagnostics: analysis.diagnostics.map((diagnostic) => ({
      severity: DiagnosticSeverity.Error,
      source: "abla-syntax",
      code: diagnostic.code,
      message: diagnostic.message,
      range: positions.range(diagnostic.range),
    })),
  });
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
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
      referencesProvider: true,
      hoverProvider: true,
      renameProvider: { prepareProvider: true },
      executeCommandProvider: {
        commands: ["abla.renameSymbols"],
      },
      experimental: {
        abla: {
          analysisAuthority: "syntax",
          compilerAnalysisProtocol: 1,
          transactionalRefactors: ["renameSymbols"],
        },
      },
    },
    serverInfo: { name: "abla-lsp", version: "0.1.0-dev" },
  };
});

connection.onInitialized(() => {
  void indexWorkspace(connection, index, workspaceRoots).catch((error: unknown) => {
    connection.console.error(`workspace indexing failed: ${String(error)}`);
  });
});

documents.onDidOpen((event) => {
  publishDiagnostics(index.upsert(event.document.uri, event.document.version, event.document.getText()));
});

documents.onDidChangeContent((event) => {
  publishDiagnostics(index.upsert(event.document.uri, event.document.version, event.document.getText()));
});

documents.onDidClose((event) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
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

connection.onReferences((params: ReferenceParams): Location[] => {
  const resolved = index.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return [];
  const result: Location[] = [];
  for (const [uri, occurrences] of index.references(resolved)) {
    const analysis = index.document(uri);
    if (analysis === undefined) continue;
    const positions = new PositionMap(analysis.text);
    for (const occurrence of occurrences) {
      if (!params.context.includeDeclaration && occurrence.declarationId !== undefined) {
        continue;
      }
      result.push(Location.create(uri, positions.range(occurrence.range)));
    }
  }
  return result;
});

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const resolved = index.resolve(params.textDocument.uri, params.position);
  if (resolved === undefined) return null;
  const positions = new PositionMap(resolved.analysis.text);
  return {
    contents: {
      kind: "markdown",
      value: `\`${resolved.symbol.detail} ${resolved.symbol.name}\`\n\nAnalysis: **${resolved.analysis.authority}**`,
    },
    range: positions.range(resolved.symbol.selectionRange),
  };
});

connection.onPrepareRename((params: TextDocumentPositionParams): Range | null => {
  const resolved = index.prepareRename(params.textDocument.uri, params.position);
  if (resolved === undefined) return null;
  return new PositionMap(resolved.analysis.text).range(resolved.symbol.selectionRange);
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit => {
  const result = index.rename({
    uri: params.textDocument.uri,
    position: params.position,
    newName: params.newName,
  });
  if (!result.ok) throw new ResponseError(ErrorCodes.InvalidRequest, result.reason);
  return result.edit;
});

connection.onExecuteCommand(async (params): Promise<WorkspaceEdit | null> => {
  if (params.command !== "abla.renameSymbols") return null;
  const argument = params.arguments?.[0] as
    | { readonly renames?: readonly RenameRequest[]; readonly apply?: boolean }
    | undefined;
  const result = index.bulkRename(argument?.renames ?? []);
  if (!result.ok) throw new ResponseError(ErrorCodes.InvalidRequest, result.reason);
  if (argument?.apply === true) {
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

documents.listen(connection);
connection.listen();
