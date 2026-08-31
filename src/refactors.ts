import type { Position, Range, TextEdit, WorkspaceEdit } from "vscode-languageserver/node";
import { WorkspaceIndex, type EditResult, type MoveDeclarationsRequest, type RenameRequest } from "./index.js";
import type { AblaOccurrence, AblaSymbol, DocumentAnalysis, OffsetRange } from "./model.js";
import { PositionMap } from "./positions.js";
import { symbolSignature } from "./editor-features.js";

interface OffsetEdit {
  readonly uri: string;
  readonly range: OffsetRange;
  readonly newText: string;
}

interface ParsedParameter {
  readonly name: string;
  readonly text: string;
  readonly type: string;
}

interface ParsedFunction {
  readonly symbol: AblaSymbol;
  readonly analysis: DocumentAnalysis;
  readonly parameters: readonly ParsedParameter[];
  readonly parametersRange: OffsetRange;
  readonly headerRange: OffsetRange;
  readonly receiverType?: string;
  readonly body?: string;
  readonly bodyRange?: OffsetRange;
}

export interface SignatureParameter {
  readonly name: string;
  readonly declaration?: string;
  readonly source?: string | number;
  readonly argument?: string;
}

export interface ChangeSignatureRequest {
  readonly symbolId: string;
  readonly parameters: readonly SignatureParameter[];
  readonly returnType?: string;
}

export interface ExtractFunctionRequest {
  readonly uri: string;
  readonly range: Range;
  readonly name: string;
  readonly targetUri?: string;
  readonly returnType?: string;
  readonly receiverSymbolId?: string;
}

export interface ConvertFunctionToMethodRequest {
  readonly symbolId: string;
  readonly receiver: string | number;
}

export interface ConvertMethodToFunctionRequest {
  readonly symbolId: string;
  readonly receiverName?: string;
}

export interface InlineSymbolRequest {
  readonly symbolId: string;
  readonly removeDeclaration?: boolean;
}

export interface PromoteLocalRequest {
  readonly symbolId: string;
  readonly destination: "parameter" | "topLevel";
}

export interface ExtractInterfaceRequest {
  readonly classSymbolId: string;
  readonly methodSymbolIds: readonly string[];
  readonly name: string;
  readonly targetUri?: string;
}

export interface GenerateDeclarationRequest {
  readonly uri: string;
  readonly position: Position;
  readonly targetUri?: string;
  readonly kind?: "function" | "class" | "value";
  readonly resultType?: string;
}

export interface OwnershipRepairRequest {
  readonly uri: string;
  readonly range: Range;
  readonly strategy: "move" | "borrow" | "own" | "mutable" | "shared" | "weak";
}

export interface ToggleCompileTimeRequest {
  readonly symbolId: string;
  readonly compileTime: boolean;
}

export interface RemoveDeadCodeRequest {
  readonly symbolIds?: readonly string[];
  readonly aggressive?: boolean;
}

export type RefactorOperation =
  | { readonly kind: "rename"; readonly request: RenameRequest }
  | { readonly kind: "bulkRename"; readonly requests: readonly RenameRequest[] }
  | { readonly kind: "move"; readonly request: MoveDeclarationsRequest }
  | { readonly kind: "changeSignature"; readonly request: ChangeSignatureRequest }
  | { readonly kind: "extractFunction"; readonly request: ExtractFunctionRequest }
  | { readonly kind: "functionToMethod"; readonly request: ConvertFunctionToMethodRequest }
  | { readonly kind: "methodToFunction"; readonly request: ConvertMethodToFunctionRequest }
  | { readonly kind: "inline"; readonly request: InlineSymbolRequest }
  | { readonly kind: "promoteLocal"; readonly request: PromoteLocalRequest }
  | { readonly kind: "extractInterface"; readonly request: ExtractInterfaceRequest }
  | { readonly kind: "generateDeclaration"; readonly request: GenerateDeclarationRequest }
  | { readonly kind: "repairOwnership"; readonly request: OwnershipRepairRequest }
  | { readonly kind: "toggleCompileTime"; readonly request: ToggleCompileTimeRequest }
  | { readonly kind: "removeDeadCode"; readonly request: RemoveDeadCodeRequest };

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function failure(reason: string): EditResult {
  return { ok: false, reason };
}

function skipSpace(text: string, offset: number): number {
  let cursor = offset;
  while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function matchingDelimiter(text: string, opening: number): number | undefined {
  const open = text[opening];
  const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : undefined;
  if (close === undefined) return undefined;
  let depth = 0;
  let quoted = false;
  let lineComment = false;
  let blockComment = 0;
  for (let cursor = opening; cursor < text.length; cursor += 1) {
    const current = text[cursor] ?? "";
    const next = text[cursor + 1] ?? "";
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment > 0) {
      if (current === "/" && next === "*") { blockComment += 1; cursor += 1; }
      else if (current === "*" && next === "/") { blockComment -= 1; cursor += 1; }
      continue;
    }
    if (!quoted && current === "/" && next === "/") { lineComment = true; cursor += 1; continue; }
    if (!quoted && current === "/" && next === "*") { blockComment = 1; cursor += 1; continue; }
    if (current === '"' && text[cursor - 1] !== "\\") { quoted = !quoted; continue; }
    if (quoted) continue;
    if (current === open) depth += 1;
    if (current === close) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return undefined;
}

function splitDelimited(text: string, begin: number, end: number): string[] {
  const result: string[] = [];
  let start = begin;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let quoted = false;
  for (let cursor = begin; cursor < end; cursor += 1) {
    const current = text[cursor] ?? "";
    if (current === '"' && text[cursor - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (current === "(") parentheses += 1;
    else if (current === ")") parentheses -= 1;
    else if (current === "[") brackets += 1;
    else if (current === "]") brackets -= 1;
    else if (current === "{") braces += 1;
    else if (current === "}") braces -= 1;
    else if (current === "," && parentheses === 0 && brackets === 0 && braces === 0) {
      result.push(text.slice(start, cursor).trim());
      start = cursor + 1;
    }
  }
  const final = text.slice(start, end).trim();
  if (final !== "" || result.length > 0) result.push(final);
  return result;
}

function parseParameter(text: string): ParsedParameter | undefined {
  const match = /^(?:(?:own|var|val)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+?))?(?:\s*=.*)?$/su.exec(text.trim());
  const name = match?.[1];
  if (name === undefined) return undefined;
  return { name, text: text.trim(), type: match?.[2]?.trim() ?? "" };
}

function pureExpression(text: string): boolean {
  const value = text.trim();
  return /^(?:-?\d+(?:\.\d+)?|true|false|null|"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_.]*)$/u.test(value);
}

function defaultValue(type: string): string {
  const normalized = type.trim();
  if (normalized === "void") return "return";
  if (normalized === "bool") return "false";
  if (normalized === "string" || normalized === "cstring") return '""';
  if (normalized.endsWith("?")) return "null";
  return "0";
}

function replaceWords(expression: string, replacements: ReadonlyMap<string, string>): string {
  return expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/gu, (name) => {
    const replacement = replacements.get(name);
    return replacement === undefined ? name : `(${replacement})`;
  });
}

function expressionFromBlock(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const lines = trimmed.slice(1, -1).trim().split(/\r?\n/u)
    .map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length !== 1 || lines[0] === undefined) return undefined;
  const returned = /^return\s+(.+)$/su.exec(lines[0]);
  if (returned?.[1] !== undefined) return returned[1].trim();
  if (/^(?:val|var|own|fun|class|interface|enum|type|if|while|for|return|break|continue|defer)\b/u.test(lines[0])) {
    return undefined;
  }
  return lines[0];
}

function indentedBlock(body: string, indentation: string): string {
  return body.trim().split(/\r?\n/u)
    .map((line, index) => index === 0 ? line : `${indentation}${line}`)
    .join("\n");
}

function receiverBeforeMember(text: string, memberStart: number): OffsetRange | undefined {
  let end = memberStart;
  while (end > 0 && /\s/u.test(text[end - 1] ?? "")) end -= 1;
  if (text[end - 1] !== ".") return undefined;
  end -= 1;
  while (end > 0 && /\s/u.test(text[end - 1] ?? "")) end -= 1;
  let start = end;
  if (text[start - 1] === ")") {
    let depth = 0;
    let cursor = start - 1;
    while (cursor >= 0) {
      const character = text[cursor] ?? "";
      if (character === ")") depth += 1;
      else if (character === "(") {
        depth -= 1;
        if (depth === 0) {
          start = cursor;
          while (start > 0 && /[A-Za-z0-9_.]/u.test(text[start - 1] ?? "")) start -= 1;
          break;
        }
      }
      cursor -= 1;
    }
  } else {
    while (start > 0 && /[A-Za-z0-9_.]/u.test(text[start - 1] ?? "")) start -= 1;
  }
  return start < end ? { start, end } : undefined;
}

function editResult(edits: readonly OffsetEdit[], documents: readonly DocumentAnalysis[]): EditResult {
  const analyses = new Map(documents.map((document) => [document.uri, document]));
  const grouped = new Map<string, OffsetEdit[]>();
  for (const edit of edits) {
    const analysis = analyses.get(edit.uri);
    if (analysis === undefined) return failure(`refactor targets an unanalyzed document: ${edit.uri}`);
    if (edit.range.start < 0 || edit.range.end < edit.range.start || edit.range.end > analysis.text.length) {
      return failure(`refactor produced an invalid range in ${edit.uri}`);
    }
    const values = grouped.get(edit.uri) ?? [];
    const duplicate = values.find((candidate) =>
      candidate.range.start === edit.range.start && candidate.range.end === edit.range.end);
    if (duplicate !== undefined) {
      if (duplicate.newText !== edit.newText) return failure(`refactor produced conflicting edits in ${edit.uri}`);
      continue;
    }
    values.push(edit);
    grouped.set(edit.uri, values);
  }
  const changes: Record<string, TextEdit[]> = {};
  for (const [uri, values] of grouped) {
    values.sort((left, right) => right.range.start - left.range.start || right.range.end - left.range.end);
    for (let index = 1; index < values.length; index += 1) {
      const later = values[index - 1];
      const earlier = values[index];
      if (later !== undefined && earlier !== undefined && earlier.range.end > later.range.start) {
        return failure(`refactor produced overlapping edits in ${uri}`);
      }
    }
    const analysis = analyses.get(uri);
    if (analysis === undefined) continue;
    const positions = new PositionMap(analysis.text);
    changes[uri] = values.map((edit) => ({ range: positions.range(edit.range), newText: edit.newText }));
  }
  return { ok: true, edit: { changes } };
}

function workspaceEdits(edit: WorkspaceEdit, documents: readonly DocumentAnalysis[]): OffsetEdit[] | undefined {
  const analyses = new Map(documents.map((document) => [document.uri, document]));
  const values: OffsetEdit[] = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    const analysis = analyses.get(uri);
    if (analysis === undefined) return undefined;
    const positions = new PositionMap(analysis.text);
    for (const candidate of edits) {
      values.push({
        uri,
        range: { start: positions.offset(candidate.range.start), end: positions.offset(candidate.range.end) },
        newText: candidate.newText,
      });
    }
  }
  return values;
}

export class AdvancedRefactors {
  readonly #index: WorkspaceIndex;

  constructor(index: WorkspaceIndex) {
    this.#index = index;
  }

  #function(id: string): ParsedFunction | undefined {
    const resolved = this.#index.symbolById(id);
    if (resolved === undefined || resolved.symbol.kind !== "function") return undefined;
    const { symbol, analysis } = resolved;
    const text = analysis.text;
    const headerEnd = (() => {
      const raw = text.slice(symbol.range.start, symbol.range.end);
      const marker = raw.search(/[={\n]/u);
      return marker < 0 ? symbol.range.end : symbol.range.start + marker;
    })();
    const open = skipSpace(text, symbol.selectionRange.end);
    const actualOpen = text[open] === "(" ? open : -1;
    const close = actualOpen < 0 ? undefined : matchingDelimiter(text, actualOpen);
    const parametersRange = actualOpen < 0 || close === undefined
      ? { start: symbol.selectionRange.end, end: symbol.selectionRange.end }
      : { start: actualOpen + 1, end: close };
    const parameters = splitDelimited(text, parametersRange.start, parametersRange.end)
      .flatMap((parameter) => {
        const parsed = parseParameter(parameter);
        return parsed === undefined ? [] : [parsed];
      });
    const prefix = text.slice(symbol.range.start, symbol.selectionRange.start);
    const receiver = /\bfun\s+([A-Za-z_][A-Za-z0-9_<>?]*)\s*\.\s*$/u.exec(prefix)?.[1];
    const equals = skipSpace(text, close === undefined ? symbol.selectionRange.end : close + 1);
    const bodyMarker = (() => {
      let cursor = equals;
      while (cursor < symbol.range.end && text[cursor] !== "=" && text[cursor] !== "{") cursor += 1;
      return cursor < symbol.range.end ? cursor : -1;
    })();
    const bodyRange = bodyMarker < 0 ? undefined : text[bodyMarker] === "="
      ? { start: skipSpace(text, bodyMarker + 1), end: symbol.range.end }
      : { start: bodyMarker, end: symbol.range.end };
    return {
      symbol,
      analysis,
      parameters,
      parametersRange,
      headerRange: { start: symbol.range.start, end: headerEnd },
      ...(receiver === undefined ? {} : { receiverType: receiver }),
      ...(bodyRange === undefined ? {} : { bodyRange, body: text.slice(bodyRange.start, bodyRange.end) }),
    };
  }

  #calls(symbol: AblaSymbol): Array<{ analysis: DocumentAnalysis; occurrence: AblaOccurrence; arguments: string[]; range: OffsetRange }> {
    const calls: Array<{ analysis: DocumentAnalysis; occurrence: AblaOccurrence; arguments: string[]; range: OffsetRange }> = [];
    const resolved = this.#index.symbolById(symbol.id);
    if (resolved === undefined) return calls;
    for (const [uri, occurrences] of this.#index.references(resolved)) {
      const analysis = this.#index.document(uri);
      if (analysis === undefined) continue;
      for (const occurrence of occurrences) {
        if (uri === symbol.uri && occurrence.range.start === symbol.selectionRange.start) continue;
        const open = skipSpace(analysis.text, occurrence.range.end);
        if (analysis.text[open] !== "(") continue;
        const close = matchingDelimiter(analysis.text, open);
        if (close === undefined) continue;
        calls.push({
          analysis,
          occurrence,
          arguments: splitDelimited(analysis.text, open + 1, close),
          range: { start: occurrence.range.start, end: close + 1 },
        });
      }
    }
    return calls;
  }

  changeSignature(request: ChangeSignatureRequest): EditResult {
    const target = this.#function(request.symbolId);
    if (target === undefined) return failure("change signature requires a resolved function");
    if (request.parameters.some((parameter) => !identifier.test(parameter.name))) {
      return failure("every parameter name must be a valid Abla identifier");
    }
    const sourceIndices = request.parameters.map((parameter) =>
      typeof parameter.source === "number"
        ? parameter.source
        : target.parameters.findIndex((candidate) => candidate.name === (parameter.source ?? parameter.name)));
    if (sourceIndices.some((index) => index >= target.parameters.length)) {
      return failure("a signature parameter refers to an unknown source parameter");
    }
    const declarations = request.parameters.map((parameter, index) => {
      if (parameter.declaration !== undefined) return parameter.declaration;
      const source = target.parameters[sourceIndices[index] ?? -1];
      if (source === undefined) return parameter.name;
      return source.name === parameter.name
        ? source.text
        : source.text.replace(new RegExp(`\\b${source.name}\\b`, "u"), parameter.name);
    });
    const edits: OffsetEdit[] = [{
      uri: target.analysis.uri,
      range: target.parametersRange,
      newText: declarations.join(", "),
    }];
    for (const call of this.#calls(target.symbol)) {
      const next = request.parameters.map((parameter, index) => {
        const source = sourceIndices[index] ?? -1;
        if (source >= 0) return call.arguments[source] ?? parameter.argument ?? "";
        return parameter.argument ?? parameter.declaration?.match(/=\s*(.+)$/su)?.[1]?.trim() ?? "";
      });
      if (next.some((argument) => argument === "")) {
        return failure("new parameters need an argument or default value");
      }
      edits.push({ uri: call.analysis.uri, range: call.range, newText: `${target.symbol.name}(${next.join(", ")})` });
    }
    for (let index = 0; index < request.parameters.length; index += 1) {
      const source = target.parameters[sourceIndices[index] ?? -1];
      const next = request.parameters[index];
      if (source === undefined || next === undefined || source.name === next.name) continue;
      const parameterSymbol = target.analysis.symbols.find((symbol) =>
        symbol.containerId === target.symbol.id && symbol.kind === "parameter" && symbol.name === source.name);
      if (parameterSymbol === undefined) continue;
      const resolved = this.#index.symbolById(parameterSymbol.id);
      if (resolved === undefined) continue;
      for (const [uri, occurrences] of this.#index.references(resolved)) {
        for (const occurrence of occurrences) {
          if (uri === target.analysis.uri &&
            target.parametersRange.start <= occurrence.range.start &&
            occurrence.range.end <= target.parametersRange.end) continue;
          edits.push({ uri, range: occurrence.range, newText: next.name });
        }
      }
    }
    if (request.returnType !== undefined) {
      const text = target.analysis.text;
      const after = target.parametersRange.end + (text[target.parametersRange.end] === ")" ? 1 : 0);
      let marker = after;
      while (marker < target.symbol.range.end && text[marker] !== "=" && text[marker] !== "{") marker += 1;
      const existing = text.slice(after, marker);
      const type = /:\s*[^={]+/u.exec(existing);
      edits.push({
        uri: target.analysis.uri,
        range: type === null
          ? { start: after, end: after }
          : { start: after + (type.index ?? 0), end: after + (type.index ?? 0) + type[0].length },
        newText: `: ${request.returnType}`,
      });
    }
    return editResult(edits, this.#index.documents());
  }

  extractFunction(request: ExtractFunctionRequest): EditResult {
    if (!identifier.test(request.name)) return failure("the extracted function name is invalid");
    const analysis = this.#index.document(request.uri);
    const target = this.#index.document(request.targetUri ?? request.uri);
    if (analysis === undefined || target === undefined) return failure("extract function requires analyzed source and target documents");
    const positions = new PositionMap(analysis.text);
    const range = { start: positions.offset(request.range.start), end: positions.offset(request.range.end) };
    if (range.start >= range.end) return failure("extract function requires a non-empty selection");
    const selected = analysis.text.slice(range.start, range.end);
    const free = new Map<string, { symbol: AblaSymbol; type: string }>();
    for (const occurrence of analysis.occurrences) {
      if (occurrence.range.start < range.start || occurrence.range.end > range.end || occurrence.declarationId === undefined) continue;
      const resolved = this.#index.symbolById(occurrence.declarationId);
      if (resolved === undefined || resolved.symbol.topLevel ||
        (range.start <= resolved.symbol.range.start && resolved.symbol.range.end <= range.end)) continue;
      const type = occurrence.type ?? resolved.symbol.detail;
      free.set(resolved.symbol.id, { symbol: resolved.symbol, type });
    }
    let receiver = request.receiverSymbolId === undefined ? undefined : free.get(request.receiverSymbolId);
    if (request.receiverSymbolId !== undefined && receiver === undefined) return failure("the requested receiver is not captured by the selection");
    const parameters = [...free.values()].filter((value) => value !== receiver);
    if (parameters.some((value) => value.type === "" || value.type === "unknown")) {
      return failure("the compiler did not provide every captured value type");
    }
    const parameterText = parameters.map((value) => `${value.symbol.name}: ${value.type}`).join(", ");
    const argumentsText = parameters.map((value) => value.symbol.name).join(", ");
    const expression = !selected.includes("\n") && !/^\s*(?:val|var|return|if|for|while|when)\b/u.test(selected);
    const receiverType = receiver?.type;
    const qualified = receiver === undefined ? request.name : `${receiverType}.${request.name}`;
    const declaration = expression
      ? `fun ${qualified}(${parameterText})${request.returnType === undefined ? "" : `: ${request.returnType}`} = ${selected.trim()}\n`
      : `fun ${qualified}(${parameterText})${request.returnType === undefined ? ": void" : `: ${request.returnType}`} {\n${selected.trimEnd()}\n}\n`;
    const call = receiver === undefined
      ? `${request.name}(${argumentsText})`
      : `${receiver.symbol.name}.${request.name}(${argumentsText})`;
    const prefix = target.text.length === 0 || target.text.endsWith("\n\n") ? "" : target.text.endsWith("\n") ? "\n" : "\n\n";
    return editResult([
      { uri: analysis.uri, range, newText: call },
      { uri: target.uri, range: { start: target.text.length, end: target.text.length }, newText: `${prefix}${declaration}` },
    ], this.#index.documents());
  }

  functionToMethod(request: ConvertFunctionToMethodRequest): EditResult {
    const target = this.#function(request.symbolId);
    if (target === undefined || target.receiverType !== undefined) return failure("function-to-method requires a top-level non-extension function");
    const receiverIndex = typeof request.receiver === "number"
      ? request.receiver
      : target.parameters.findIndex((parameter) => parameter.name === request.receiver);
    const receiver = target.parameters[receiverIndex];
    if (receiver === undefined || receiver.type === "") return failure("the receiver parameter needs an explicit type");
    const retained = target.parameters.filter((_parameter, index) => index !== receiverIndex);
    const edits: OffsetEdit[] = [{
      uri: target.analysis.uri,
      range: { start: target.symbol.selectionRange.start, end: target.parametersRange.end },
      newText: `${receiver.type}.${target.symbol.name}(${retained.map((parameter) => parameter.text).join(", ")}`,
    }];
    const receiverSymbol = target.analysis.symbols.find((symbol) =>
      symbol.containerId === target.symbol.id && symbol.kind === "parameter" &&
      symbol.name === receiver.name);
    const resolvedReceiver = receiverSymbol === undefined
      ? undefined
      : this.#index.symbolById(receiverSymbol.id);
    if (resolvedReceiver !== undefined) {
      for (const [uri, occurrences] of this.#index.references(resolvedReceiver)) {
        for (const occurrence of occurrences) {
          if (uri === target.analysis.uri && target.parametersRange.start <= occurrence.range.start &&
            occurrence.range.end <= target.parametersRange.end) continue;
          edits.push({ uri, range: occurrence.range, newText: "this" });
        }
      }
    }
    for (const call of this.#calls(target.symbol)) {
      const receiverArgument = call.arguments[receiverIndex];
      if (receiverArgument === undefined) return failure("one call does not supply the receiver parameter");
      const argumentsText = call.arguments.filter((_argument, index) => index !== receiverIndex).join(", ");
      edits.push({ uri: call.analysis.uri, range: call.range, newText: `${receiverArgument}.${target.symbol.name}(${argumentsText})` });
    }
    return editResult(edits, this.#index.documents());
  }

  methodToFunction(request: ConvertMethodToFunctionRequest): EditResult {
    const target = this.#function(request.symbolId);
    if (target === undefined) return failure("method-to-function requires a resolved method");
    const owner = target.symbol.containerId === undefined
      ? undefined
      : this.#index.symbolById(target.symbol.containerId)?.symbol;
    const receiverType = target.receiverType ?? (owner?.kind === "class" ? owner.name : undefined);
    if (receiverType === undefined) return failure("the selected function has no receiver type");
    const receiverName = request.receiverName ?? "receiver";
    if (!identifier.test(receiverName)) return failure("the receiver parameter name is invalid");
    const parameters = [`${receiverName}: ${receiverType}`, ...target.parameters.map((parameter) => parameter.text)];
    const edits: OffsetEdit[] = [];
    if (target.receiverType !== undefined) {
      edits.push({
        uri: target.analysis.uri,
        range: { start: target.symbol.range.start, end: target.parametersRange.end },
        newText: `${target.analysis.text.slice(target.symbol.range.start, target.symbol.selectionRange.start).replace(new RegExp(`${target.receiverType}\\s*\\.\\s*$`, "u"), "")}${target.symbol.name}(${parameters.join(", ")}`,
      });
    } else {
      let snippet = target.analysis.text.slice(target.symbol.range.start, target.symbol.range.end);
      const localEdits: Array<{ start: number; end: number; newText: string }> = [{
        start: target.symbol.selectionRange.start - target.symbol.range.start,
        end: target.parametersRange.end - target.symbol.range.start,
        newText: `${target.symbol.name}(${parameters.join(", ")}`,
      }];
      for (const occurrence of target.analysis.occurrences) {
        if (occurrence.range.start < (target.bodyRange?.start ?? target.symbol.range.end) ||
          occurrence.range.end > target.symbol.range.end) continue;
        if (occurrence.name === "this") {
          localEdits.push({
            start: occurrence.range.start - target.symbol.range.start,
            end: occurrence.range.end - target.symbol.range.start,
            newText: receiverName,
          });
          continue;
        }
        const declaration = occurrence.declarationId === undefined
          ? undefined
          : this.#index.symbolById(occurrence.declarationId)?.symbol;
        if (declaration !== undefined && declaration.containerId === owner?.id &&
          declaration.id !== target.symbol.id) {
          localEdits.push({
            start: occurrence.range.start - target.symbol.range.start,
            end: occurrence.range.end - target.symbol.range.start,
            newText: `${receiverName}.${occurrence.name}`,
          });
        }
      }
      for (const edit of localEdits.sort((left, right) => right.start - left.start)) {
        snippet = `${snippet.slice(0, edit.start)}${edit.newText}${snippet.slice(edit.end)}`;
      }
      const prefix = target.analysis.text.endsWith("\n") ? "\n" : "\n\n";
      edits.push(
        { uri: target.analysis.uri, range: target.symbol.range, newText: "" },
        { uri: target.analysis.uri, range: { start: target.analysis.text.length, end: target.analysis.text.length }, newText: `${prefix}${snippet.trim()}\n` },
      );
    }
    for (const call of this.#calls(target.symbol)) {
      if (target.receiverType === undefined && call.analysis.uri === target.analysis.uri &&
        target.symbol.range.start <= call.range.start && call.range.end <= target.symbol.range.end) continue;
      const receiverRange = receiverBeforeMember(call.analysis.text, call.occurrence.range.start);
      if (receiverRange === undefined) return failure("one method call has a receiver expression that cannot be moved safely");
      const receiver = call.analysis.text.slice(receiverRange.start, receiverRange.end);
      edits.push({
        uri: call.analysis.uri,
        range: { start: receiverRange.start, end: call.range.end },
        newText: `${target.symbol.name}(${[receiver, ...call.arguments].join(", ")})`,
      });
    }
    if (target.receiverType !== undefined && target.bodyRange !== undefined) {
      for (const occurrence of target.analysis.occurrences) {
        if (occurrence.name === "this" && target.bodyRange.start <= occurrence.range.start && occurrence.range.end <= target.bodyRange.end) {
          edits.push({ uri: target.analysis.uri, range: occurrence.range, newText: receiverName });
        }
      }
    }
    return editResult(edits, this.#index.documents());
  }

  inlineSymbol(request: InlineSymbolRequest): EditResult {
    const resolved = this.#index.symbolById(request.symbolId);
    if (resolved === undefined) return failure("inline requires a resolved symbol");
    const edits: OffsetEdit[] = [];
    const remove = request.removeDeclaration ?? true;
    if (resolved.symbol.kind === "function") {
      const target = this.#function(resolved.symbol.id);
      if (target?.body === undefined || target.bodyRange === undefined) {
        return failure("the function has no body to inline");
      }
      const block = target.body.trimStart().startsWith("{");
      const blockExpression = block ? expressionFromBlock(target.body) : undefined;
      if (block && blockExpression === undefined &&
        /\b(?:return|break|continue|defer)\b/u.test(target.body)) {
        return failure("a block with escaping control flow cannot be inlined safely");
      }
      const substitutionBody = blockExpression ?? target.body.trim();
      const calls = this.#calls(resolved.symbol);
      for (const call of calls) {
        if (call.arguments.length !== target.parameters.length) return failure("one call does not match the function signature");
        const replacements = new Map<string, string>();
        for (let index = 0; index < target.parameters.length; index += 1) {
          const parameter = target.parameters[index];
          const argument = call.arguments[index];
          if (parameter === undefined || argument === undefined) continue;
          const uses = substitutionBody.match(new RegExp(`\\b${parameter.name}\\b`, "gu"))?.length ?? 0;
          if (uses > 1 && !pureExpression(argument)) return failure(`inlining would evaluate '${argument}' more than once`);
          replacements.set(parameter.name, argument);
        }
        if (!block || blockExpression !== undefined) {
          edits.push({
            uri: call.analysis.uri,
            range: call.range,
            newText: `(${replaceWords(substitutionBody, replacements)})`,
          });
          continue;
        }
        const lineStart = call.analysis.text.lastIndexOf("\n", Math.max(0, call.range.start - 1)) + 1;
        const candidateEnd = call.analysis.text.indexOf("\n", call.range.end);
        const lineEnd = candidateEnd < 0 ? call.analysis.text.length : candidateEnd;
        if (call.analysis.text.slice(lineStart, lineEnd).trim() !==
          call.analysis.text.slice(call.range.start, call.range.end)) {
          return failure("a multi-statement block can only inline at a standalone call");
        }
        const indentation = /^\s*/u.exec(
          call.analysis.text.slice(lineStart, call.range.start),
        )?.[0] ?? "";
        edits.push({
          uri: call.analysis.uri,
          range: call.range,
          newText: indentedBlock(replaceWords(substitutionBody, replacements), indentation),
        });
      }
    } else if (resolved.symbol.kind === "value" || resolved.symbol.kind === "variable") {
      const raw = resolved.analysis.text.slice(resolved.symbol.range.start, resolved.symbol.range.end);
      const marker = raw.indexOf("=");
      if (marker < 0) return failure("the binding has no initializer to inline");
      const expression = raw.slice(marker + 1).trim();
      for (const [uri, occurrences] of this.#index.references(resolved)) {
        for (const occurrence of occurrences) {
          if (uri === resolved.symbol.uri && resolved.symbol.range.start <= occurrence.range.start && occurrence.range.end <= resolved.symbol.range.end) continue;
          edits.push({ uri, range: occurrence.range, newText: `(${expression})` });
        }
      }
    } else return failure("only functions and bindings can be inlined");
    if (remove) edits.push({ uri: resolved.symbol.uri, range: resolved.symbol.range, newText: "" });
    return editResult(edits, this.#index.documents());
  }

  promoteLocal(request: PromoteLocalRequest): EditResult {
    const resolved = this.#index.symbolById(request.symbolId);
    if (resolved === undefined || resolved.symbol.topLevel || !["value", "variable"].includes(resolved.symbol.kind)) {
      return failure("promotion requires a compiler-resolved local binding");
    }
    const raw = resolved.analysis.text.slice(resolved.symbol.range.start, resolved.symbol.range.end);
    const match = /^\s*(val|var)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([^=]+))?\s*=\s*([\s\S]+?)\s*$/u.exec(raw);
    if (match === null) return failure("the local binding must have an initializer");
    if (request.destination === "topLevel") {
      const prefix = resolved.analysis.text.endsWith("\n") ? "\n" : "\n\n";
      return editResult([
        { uri: resolved.analysis.uri, range: resolved.symbol.range, newText: "" },
        { uri: resolved.analysis.uri, range: { start: resolved.analysis.text.length, end: resolved.analysis.text.length }, newText: `${prefix}${raw.trim()}\n` },
      ], this.#index.documents());
    }
    const ownerId = resolved.symbol.containerId;
    const owner = ownerId === undefined ? undefined : this.#function(ownerId);
    if (owner === undefined) return failure("the local binding is not contained by a function");
    const type = match[3]?.trim() ?? resolved.symbol.detail;
    if (type === "" || type === "unknown") return failure("the promoted parameter type is unknown");
    const declaration = `${match[2]}: ${type} = ${match[4]?.trim() ?? ""}`;
    const existing = owner.analysis.text.slice(owner.parametersRange.start, owner.parametersRange.end).trim();
    return editResult([
      { uri: resolved.analysis.uri, range: resolved.symbol.range, newText: "" },
      { uri: owner.analysis.uri, range: owner.parametersRange, newText: existing === "" ? declaration : `${existing}, ${declaration}` },
    ], this.#index.documents());
  }

  extractInterface(request: ExtractInterfaceRequest): EditResult {
    if (!identifier.test(request.name)) return failure("the interface name is invalid");
    const source = this.#index.symbolById(request.classSymbolId);
    const target = this.#index.document(request.targetUri ?? source?.symbol.uri ?? "");
    if (source === undefined || source.symbol.kind !== "class" || target === undefined) return failure("extract interface requires a resolved class and target document");
    const methods = request.methodSymbolIds.map((id) => this.#index.symbolById(id));
    if (methods.some((method) => method === undefined || method.symbol.kind !== "function" || method.symbol.containerId !== source.symbol.id)) {
      return failure("every extracted method must belong to the selected class");
    }
    const signatures = methods.map((method) => `    ${symbolSignature(method!.analysis, method!.symbol)}`).join("\n");
    const declaration = `interface ${request.name} {\n${signatures}\n}\n`;
    const prefix = target.text.length === 0 || target.text.endsWith("\n\n") ? "" : target.text.endsWith("\n") ? "\n" : "\n\n";
    return editResult([{ uri: target.uri, range: { start: target.text.length, end: target.text.length }, newText: `${prefix}${declaration}` }], this.#index.documents());
  }

  generateDeclaration(request: GenerateDeclarationRequest): EditResult {
    const analysis = this.#index.document(request.uri);
    const target = this.#index.document(request.targetUri ?? request.uri);
    if (analysis === undefined || target === undefined) return failure("declaration generation requires analyzed source and target documents");
    const offset = new PositionMap(analysis.text).offset(request.position);
    const occurrence = analysis.occurrences.find((value) => value.range.start <= offset && offset < value.range.end);
    if (occurrence === undefined || occurrence.declarationId !== undefined || !identifier.test(occurrence.name)) {
      return failure("place the cursor on an unresolved identifier");
    }
    const kind = request.kind ?? "function";
    let declaration: string;
    if (kind === "class") declaration = `class ${occurrence.name}()\n`;
    else if (kind === "value") declaration = `val ${occurrence.name}: ${request.resultType ?? "int"} = 0\n`;
    else {
      const open = skipSpace(analysis.text, occurrence.range.end);
      const close = analysis.text[open] === "(" ? matchingDelimiter(analysis.text, open) : undefined;
      const argumentsList = close === undefined ? [] : splitDelimited(analysis.text, open + 1, close);
      const parameters = argumentsList.map((argument, index) => {
        const begin = analysis.text.indexOf(argument, open + 1);
        const typed = analysis.occurrences.find((candidate) => candidate.range.start >= begin && candidate.range.end <= begin + argument.length)?.type;
        return `argument${index + 1}: ${typed ?? "int"}`;
      });
      const resultType = request.resultType ?? "int";
      declaration = `fun ${occurrence.name}(${parameters.join(", ")}): ${resultType} = ${defaultValue(resultType)}\n`;
    }
    const prefix = target.text.length === 0 || target.text.endsWith("\n\n") ? "" : target.text.endsWith("\n") ? "\n" : "\n\n";
    return editResult([{ uri: target.uri, range: { start: target.text.length, end: target.text.length }, newText: `${prefix}${declaration}` }], this.#index.documents());
  }

  repairOwnership(request: OwnershipRepairRequest): EditResult {
    const analysis = this.#index.document(request.uri);
    if (analysis === undefined) return failure("ownership repair requires an analyzed document");
    const positions = new PositionMap(analysis.text);
    const range = { start: positions.offset(request.range.start), end: positions.offset(request.range.end) };
    const selected = analysis.text.slice(range.start, range.end);
    let newText: string;
    if (request.strategy === "move") newText = `move(${selected})`;
    else if (request.strategy === "borrow") newText = `borrow(${selected})`;
    else if (request.strategy === "shared") newText = `Shared(${selected})`;
    else if (request.strategy === "weak") newText = `Weak(${selected})`;
    else if (request.strategy === "own" || request.strategy === "mutable") {
      const modifier = request.strategy === "own" ? "own" : "var";
      newText = /^(?:own|var|val)\s+/u.test(selected) ? selected.replace(/^(?:own|var|val)/u, modifier) : `${modifier} ${selected}`;
    } else return failure("unsupported ownership repair strategy");
    return editResult([{ uri: analysis.uri, range, newText }], this.#index.documents());
  }

  toggleCompileTime(request: ToggleCompileTimeRequest): EditResult {
    const target = this.#function(request.symbolId);
    if (target === undefined) return failure("compile-time migration requires a resolved function");
    const prefix = target.analysis.text.slice(target.symbol.range.start, target.symbol.selectionRange.start);
    const isCompile = /\bcompile\s+fun\s*$/u.test(prefix);
    if (isCompile === request.compileTime) return { ok: true, edit: { changes: {} } };
    const edits: OffsetEdit[] = [];
    if (request.compileTime) {
      const fun = prefix.lastIndexOf("fun");
      edits.push({ uri: target.analysis.uri, range: { start: target.symbol.range.start + fun, end: target.symbol.range.start + fun }, newText: "compile " });
    } else {
      const compile = prefix.lastIndexOf("compile");
      edits.push({ uri: target.analysis.uri, range: { start: target.symbol.range.start + compile, end: target.symbol.range.start + compile + "compile ".length }, newText: "" });
    }
    for (const call of this.#calls(target.symbol)) {
      const hash = call.analysis.text[call.occurrence.range.start - 1] === "#";
      if (request.compileTime && !hash) edits.push({ uri: call.analysis.uri, range: { start: call.occurrence.range.start, end: call.occurrence.range.start }, newText: "#" });
      if (!request.compileTime && hash) edits.push({ uri: call.analysis.uri, range: { start: call.occurrence.range.start - 1, end: call.occurrence.range.start }, newText: "" });
    }
    return editResult(edits, this.#index.documents());
  }

  removeDeadCode(request: RemoveDeadCodeRequest): EditResult {
    const selected = request.symbolIds === undefined
      ? this.#index.symbols().filter((symbol) => symbol.topLevel && symbol.name !== "main" && (request.aggressive === true || symbol.name.startsWith("_")))
      : request.symbolIds.flatMap((id) => {
        const value = this.#index.symbolById(id)?.symbol;
        return value === undefined ? [] : [value];
      });
    const edits: OffsetEdit[] = [];
    for (const symbol of selected) {
      if (!symbol.topLevel) return failure("dead-code removal only accepts top-level declarations");
      const resolved = this.#index.symbolById(symbol.id);
      if (resolved === undefined) continue;
      const live = [...this.#index.references(resolved).entries()].some(([uri, occurrences]) =>
        occurrences.some((occurrence) => !(uri === symbol.uri && symbol.range.start <= occurrence.range.start && occurrence.range.end <= symbol.range.end)));
      if (live) {
        if (request.symbolIds !== undefined) return failure(`'${symbol.name}' still has references`);
        continue;
      }
      edits.push({ uri: symbol.uri, range: symbol.range, newText: "" });
    }
    if (edits.length === 0) return failure("no removable dead declarations were proven");
    return editResult(edits, this.#index.documents());
  }

  operation(operation: RefactorOperation): EditResult {
    switch (operation.kind) {
      case "rename": return this.#index.rename(operation.request);
      case "bulkRename": return this.#index.bulkRename(operation.requests);
      case "move": return this.#index.moveDeclarations(operation.request);
      case "changeSignature": return this.changeSignature(operation.request);
      case "extractFunction": return this.extractFunction(operation.request);
      case "functionToMethod": return this.functionToMethod(operation.request);
      case "methodToFunction": return this.methodToFunction(operation.request);
      case "inline": return this.inlineSymbol(operation.request);
      case "promoteLocal": return this.promoteLocal(operation.request);
      case "extractInterface": return this.extractInterface(operation.request);
      case "generateDeclaration": return this.generateDeclaration(operation.request);
      case "repairOwnership": return this.repairOwnership(operation.request);
      case "toggleCompileTime": return this.toggleCompileTime(operation.request);
      case "removeDeadCode": return this.removeDeadCode(operation.request);
    }
  }

  recipe(operations: readonly RefactorOperation[]): EditResult {
    if (operations.length === 0) return failure("a refactor recipe requires at least one operation");
    const edits: OffsetEdit[] = [];
    for (const operation of operations) {
      const result = this.operation(operation);
      if (!result.ok) return result;
      const converted = workspaceEdits(result.edit, this.#index.documents());
      if (converted === undefined) return failure("a recipe operation targets an unavailable document");
      edits.push(...converted);
    }
    return editResult(edits, this.#index.documents());
  }
}
