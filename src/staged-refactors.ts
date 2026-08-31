import type { TextEdit, WorkspaceEdit } from "vscode-languageserver/node";
import type {
  CompilerValidateEditParams,
  CompilerValidateEditResult,
  CompilerWorkspaceSnapshot,
} from "./compiler-protocol.js";
import {
  WorkspaceIndex,
  type EditResult,
  type MoveDeclarationsRequest,
  type RenameRequest,
} from "./index.js";
import type { AblaSymbol } from "./model.js";
import { PositionMap } from "./positions.js";
import {
  AdvancedRefactors,
  type ChangeBindingKindRequest,
  type ChangeSignatureRequest,
  type ConvertFunctionToMethodRequest,
  type ConvertMethodToFunctionRequest,
  type ExtractInterfaceRequest,
  type InlineSymbolRequest,
  type PromoteLocalRequest,
  type RefactorOperation,
  type RemoveDeadCodeRequest,
  type ToggleCompileTimeRequest,
} from "./refactors.js";
import { SyntaxAnalyzer } from "./source.js";

export interface SymbolSelector {
  readonly id?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly kind?: AblaSymbol["kind"];
  readonly containerName?: string;
}

export interface StagedRefactorOperation {
  readonly kind: RefactorOperation["kind"];
  readonly request?: unknown;
  readonly requests?: unknown;
}

export interface CompilerRefactorValidator {
  validate(params: CompilerValidateEditParams): Promise<CompilerValidateEditResult>;
}

type NormalizedOperation =
  | { readonly ok: true; readonly operation: RefactorOperation }
  | { readonly ok: false; readonly reason: string };

type AppliedEdit =
  | { readonly ok: true; readonly texts: Map<string, string>; readonly created: Set<string> }
  | { readonly ok: false; readonly reason: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function resolveSymbol(index: WorkspaceIndex, value: unknown): AblaSymbol | undefined {
  if (typeof value === "string") {
    return index.symbolById(value)?.symbol ?? (() => {
      const matches = index.symbols().filter((symbol) => symbol.name === value);
      return matches.length === 1 ? matches[0] : undefined;
    })();
  }
  const selector = record(value);
  if (selector === undefined) return undefined;
  if (typeof selector.id === "string") {
    const byId = index.symbolById(selector.id)?.symbol;
    if (byId !== undefined) return byId;
  }
  const matches = index.symbols().filter((symbol) => {
    if (typeof selector.name === "string" && symbol.name !== selector.name) return false;
    if (typeof selector.uri === "string" && symbol.uri !== selector.uri) return false;
    if (typeof selector.kind === "string" && symbol.kind !== selector.kind) return false;
    if (typeof selector.containerName === "string") {
      if (symbol.containerId === undefined) return false;
      if (index.symbolById(symbol.containerId)?.symbol.name !== selector.containerName) return false;
    }
    return typeof selector.name === "string" || typeof selector.uri === "string";
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function symbolId(
  index: WorkspaceIndex,
  request: Record<string, unknown>,
  idField: string,
  selectorField: string,
): string | undefined {
  const currentId = request[idField];
  if (typeof currentId === "string" && index.symbolById(currentId) !== undefined) return currentId;
  return resolveSymbol(index, request[selectorField])?.id ??
    (typeof currentId === "string" ? currentId : undefined);
}

function renameRequest(index: WorkspaceIndex, value: unknown): RenameRequest | undefined {
  const request = record(value);
  if (request === undefined || typeof request.newName !== "string") return undefined;
  if (typeof request.uri === "string" && record(request.position) !== undefined) {
    return request as unknown as RenameRequest;
  }
  const symbol = resolveSymbol(index, request.symbol);
  const analysis = symbol === undefined ? undefined : index.document(symbol.uri);
  if (symbol === undefined || analysis === undefined) return undefined;
  return {
    uri: symbol.uri,
    position: new PositionMap(analysis.text).position(symbol.selectionRange.start),
    newName: request.newName,
  };
}

function normalizeOperation(
  index: WorkspaceIndex,
  staged: StagedRefactorOperation,
): NormalizedOperation {
  const request = record(staged.request) ?? {};
  const resolved = (idField = "symbolId", selectorField = "symbol"): string | undefined =>
    symbolId(index, request, idField, selectorField);
  switch (staged.kind) {
    case "rename": {
      const normalized = renameRequest(index, request);
      return normalized === undefined
        ? { ok: false, reason: "staged rename requires one uniquely resolved symbol" }
        : { ok: true, operation: { kind: "rename", request: normalized } };
    }
    case "bulkRename": {
      if (!Array.isArray(staged.requests)) {
        return { ok: false, reason: "staged bulk rename requires a requests array" };
      }
      const requests = staged.requests.map((value) => renameRequest(index, value));
      return requests.some((value) => value === undefined)
        ? { ok: false, reason: "every staged bulk rename needs one uniquely resolved symbol" }
        : {
            ok: true,
            operation: { kind: "bulkRename", requests: requests as RenameRequest[] },
          };
    }
    case "move": {
      const selectors = Array.isArray(request.symbols) ? request.symbols : [];
      const selected = selectors.map((value) => resolveSymbol(index, value)?.id);
      if (selected.some((value) => value === undefined)) {
        return { ok: false, reason: "every staged move selector must resolve uniquely" };
      }
      return {
        ok: true,
        operation: {
          kind: "move",
          request: {
            ...(request as object),
            symbolIds: [
              ...(Array.isArray(request.symbolIds)
                ? request.symbolIds.filter((value): value is string => typeof value === "string")
                : []),
              ...(selected as string[]),
            ],
          } as unknown as MoveDeclarationsRequest,
        },
      };
    }
    case "changeSignature": {
      const id = resolved();
      if (id === undefined) return { ok: false, reason: "staged change signature requires one uniquely resolved function" };
      return { ok: true, operation: { kind: "changeSignature", request: { ...request, symbolId: id } as unknown as ChangeSignatureRequest } };
    }
    case "functionToMethod": {
      const id = resolved();
      if (id === undefined) return { ok: false, reason: "staged function-to-method requires one uniquely resolved function" };
      return { ok: true, operation: { kind: "functionToMethod", request: { ...request, symbolId: id } as unknown as ConvertFunctionToMethodRequest } };
    }
    case "methodToFunction": {
      const id = resolved();
      if (id === undefined) return { ok: false, reason: "staged method-to-function requires one uniquely resolved method" };
      return { ok: true, operation: { kind: "methodToFunction", request: { ...request, symbolId: id } as unknown as ConvertMethodToFunctionRequest } };
    }
    case "inline": {
      const id = resolved();
      if (id === undefined) return { ok: false, reason: "staged inline requires one uniquely resolved symbol" };
      return { ok: true, operation: { kind: "inline", request: { ...request, symbolId: id } as unknown as InlineSymbolRequest } };
    }
    case "changeBindingKind": {
      const id = resolved();
      if (id === undefined) return { ok: false, reason: "staged binding conversion requires one uniquely resolved binding" };
      return { ok: true, operation: { kind: "changeBindingKind", request: { ...request, symbolId: id } as unknown as ChangeBindingKindRequest } };
    }
    case "promoteLocal": {
      const id = resolved();
      if (id === undefined) return { ok: false, reason: "staged promotion requires one uniquely resolved local" };
      return { ok: true, operation: { kind: "promoteLocal", request: { ...request, symbolId: id } as unknown as PromoteLocalRequest } };
    }
    case "extractInterface": {
      const classId = resolved("classSymbolId", "classSymbol");
      const methodSelectors = Array.isArray(request.methodSymbols) ? request.methodSymbols : [];
      const methodIds = methodSelectors.map((value) => resolveSymbol(index, value)?.id);
      if (classId === undefined || methodIds.some((value) => value === undefined)) {
        return { ok: false, reason: "staged interface extraction selectors must resolve uniquely" };
      }
      return {
        ok: true,
        operation: {
          kind: "extractInterface",
          request: {
            ...request,
            classSymbolId: classId,
            methodSymbolIds: [
              ...(Array.isArray(request.methodSymbolIds)
                ? request.methodSymbolIds.filter((value): value is string => typeof value === "string")
                : []),
              ...(methodIds as string[]),
            ],
          } as unknown as ExtractInterfaceRequest,
        },
      };
    }
    case "toggleCompileTime": {
      const id = resolved();
      if (id === undefined) return { ok: false, reason: "staged compile-time migration requires one uniquely resolved function" };
      return { ok: true, operation: { kind: "toggleCompileTime", request: { ...request, symbolId: id } as unknown as ToggleCompileTimeRequest } };
    }
    case "removeDeadCode": {
      const selectors = Array.isArray(request.symbols) ? request.symbols : [];
      const ids = selectors.map((value) => resolveSymbol(index, value)?.id);
      if (ids.some((value) => value === undefined)) {
        return { ok: false, reason: "every staged dead-code selector must resolve uniquely" };
      }
      return {
        ok: true,
        operation: {
          kind: "removeDeadCode",
          request: {
            ...request,
            ...(selectors.length === 0 ? {} : { symbolIds: ids as string[] }),
          } as unknown as RemoveDeadCodeRequest,
        },
      };
    }
    case "extractFunction":
    case "introduceBinding":
    case "generateDeclaration":
    case "repairOwnership":
      return {
        ok: true,
        operation: { kind: staged.kind, request } as unknown as RefactorOperation,
      };
  }
}

function applyTextEdits(text: string, edits: readonly TextEdit[]): string | undefined {
  const positions = new PositionMap(text);
  const offsets = edits.map((edit) => ({
    start: positions.offset(edit.range.start),
    end: positions.offset(edit.range.end),
    newText: edit.newText,
  })).sort((left, right) => right.start - left.start || right.end - left.end);
  for (let index = 1; index < offsets.length; index += 1) {
    const later = offsets[index - 1];
    const earlier = offsets[index];
    if (later !== undefined && earlier !== undefined && earlier.end > later.start) return undefined;
  }
  return offsets.reduce((current, edit) =>
    `${current.slice(0, edit.start)}${edit.newText}${current.slice(edit.end)}`, text);
}

function applyWorkspaceEdit(
  current: ReadonlyMap<string, string>,
  currentCreated: ReadonlySet<string>,
  edit: WorkspaceEdit,
): AppliedEdit {
  const texts = new Map(current);
  const created = new Set(currentCreated);
  const apply = (uri: string, edits: readonly unknown[]): string | undefined => {
    const text = texts.get(uri);
    if (text === undefined) return `refactor edits an unavailable document: ${uri}`;
    const plain = edits.flatMap((value) => {
      const candidate = record(value);
      return candidate !== undefined && record(candidate.range) !== undefined &&
        typeof candidate.newText === "string"
        ? [candidate as unknown as TextEdit]
        : [];
    });
    if (plain.length !== edits.length) return "staged recipes do not accept snippet or annotated edits";
    const next = applyTextEdits(text, plain);
    if (next === undefined) return `refactor produces overlapping edits in ${uri}`;
    texts.set(uri, next);
    return undefined;
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    const reason = apply(uri, edits);
    if (reason !== undefined) return { ok: false, reason };
  }
  for (const change of edit.documentChanges ?? []) {
    if ("textDocument" in change) {
      const reason = apply(change.textDocument.uri, change.edits);
      if (reason !== undefined) return { ok: false, reason };
    } else if (change.kind === "create") {
      if (texts.has(change.uri)) return { ok: false, reason: `refactor would overwrite ${change.uri}` };
      texts.set(change.uri, "");
      created.add(change.uri);
    } else return { ok: false, reason: "staged recipes only support file creation" };
  }
  return { ok: true, texts, created };
}

function snapshotIndex(snapshot: CompilerWorkspaceSnapshot): WorkspaceIndex {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  for (const document of snapshot.documents) {
    index.upsertAnalysis({ ...document, authority: "compiler" });
  }
  return index;
}

function prospectiveParams(
  baseline: CompilerWorkspaceSnapshot,
  texts: ReadonlyMap<string, string>,
  created: ReadonlySet<string>,
): CompilerValidateEditParams {
  const baselineTexts = new Map(baseline.documents.map((document) => [document.uri, document.text]));
  const edits = [...texts].flatMap(([uri, text]) => {
    const before = baselineTexts.get(uri);
    if (before === text) return [];
    return [{
      uri,
      start: 0,
      end: before === undefined ? 0 : Buffer.byteLength(before, "utf8"),
      newText: text,
    }];
  });
  return {
    baseRevision: baseline.revision,
    edits,
    ...(created.size === 0 ? {} : {
      createdDocuments: [...created].map((uri) => ({ uri, text: "" })),
    }),
    invariants: ["no-new-errors", "preserve-unedited-symbols"],
  };
}

function finalWorkspaceEdit(
  baseline: CompilerWorkspaceSnapshot,
  texts: ReadonlyMap<string, string>,
  created: ReadonlySet<string>,
): WorkspaceEdit {
  const baselineTexts = new Map(baseline.documents.map((document) => [document.uri, document.text]));
  const changed = [...texts].filter(([uri, text]) => baselineTexts.get(uri) !== text);
  if (created.size === 0) {
    return {
      changes: Object.fromEntries(changed.map(([uri, text]) => {
        const before = baselineTexts.get(uri) ?? "";
        return [uri, [{
          range: new PositionMap(before).range({ start: 0, end: before.length }),
          newText: text,
        }]];
      })),
    };
  }
  return {
    documentChanges: [
      ...[...created].map((uri) => ({ kind: "create" as const, uri })),
      ...changed.map(([uri, text]) => {
        const before = baselineTexts.get(uri) ?? "";
        return {
          textDocument: { uri, version: null },
          edits: [{
            range: new PositionMap(before).range({ start: 0, end: before.length }),
            newText: text,
          }],
        };
      }),
    ],
  };
}

export async function applyStagedRecipe(
  baseline: CompilerWorkspaceSnapshot,
  operations: readonly StagedRefactorOperation[],
  validator: CompilerRefactorValidator,
): Promise<EditResult> {
  if (operations.length === 0) {
    return { ok: false, reason: "a staged refactor recipe requires at least one operation" };
  }
  let snapshot = baseline;
  let texts = new Map(baseline.documents.map((document) => [document.uri, document.text]));
  let created = new Set<string>();
  for (const staged of operations) {
    const index = snapshotIndex(snapshot);
    const normalized = normalizeOperation(index, staged);
    if (!normalized.ok) return normalized;
    const planned = new AdvancedRefactors(index).operation(normalized.operation);
    if (!planned.ok) return planned;
    const applied = applyWorkspaceEdit(texts, created, planned.edit);
    if (!applied.ok) return applied;
    const validated = await validator.validate(
      prospectiveParams(baseline, applied.texts, applied.created),
    );
    if (!validated.valid || validated.snapshot === undefined) {
      return {
        ok: false,
        reason: validated.reason ?? "the compiler rejected a staged refactor operation",
      };
    }
    texts = applied.texts;
    created = applied.created;
    snapshot = validated.snapshot;
  }
  return { ok: true, edit: finalWorkspaceEdit(baseline, texts, created) };
}
