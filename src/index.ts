import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Position, TextEdit, WorkspaceEdit } from "vscode-languageserver/node";
import type { AblaOccurrence, AblaSymbol, Analyzer, DocumentAnalysis } from "./model.js";
import { PositionMap } from "./positions.js";
import { identifierAt } from "./source.js";

export interface ResolvedSymbol {
  readonly symbol: AblaSymbol;
  readonly analysis: DocumentAnalysis;
}

export type EditResult =
  | { readonly ok: true; readonly edit: WorkspaceEdit }
  | { readonly ok: false; readonly reason: string };

export interface RenameRequest {
  readonly uri: string;
  readonly position: Position;
  readonly newName: string;
}

export interface MoveDeclarationsRequest {
  readonly symbolIds: readonly string[];
  readonly targetUri: string;
}

const validIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class WorkspaceIndex {
  readonly #analyzer: Analyzer;
  readonly #documents = new Map<string, DocumentAnalysis>();

  constructor(analyzer: Analyzer) {
    this.#analyzer = analyzer;
  }

  upsert(uri: string, version: number, text: string): DocumentAnalysis {
    const analysis = this.#analyzer.analyze(uri, version, text);
    this.upsertAnalysis(analysis);
    return analysis;
  }

  upsertAnalysis(analysis: DocumentAnalysis): void {
    this.#documents.set(analysis.uri, analysis);
  }

  remove(uri: string): void {
    this.#documents.delete(uri);
  }

  document(uri: string): DocumentAnalysis | undefined {
    return this.#documents.get(uri);
  }

  documents(): readonly DocumentAnalysis[] {
    return [...this.#documents.values()].sort((left, right) =>
      left.uri.localeCompare(right.uri),
    );
  }

  symbols(query = ""): readonly AblaSymbol[] {
    const normalized = query.toLocaleLowerCase();
    return this.documents()
      .flatMap((document) => document.symbols)
      .filter((symbol) => symbol.name.toLocaleLowerCase().includes(normalized));
  }

  symbolById(id: string): ResolvedSymbol | undefined {
    for (const analysis of this.#documents.values()) {
      const symbol = analysis.symbols.find((candidate) => candidate.id === id);
      if (symbol !== undefined) return { symbol, analysis };
    }
    return undefined;
  }

  containingSymbol(uri: string, range: { readonly start: number; readonly end: number }): ResolvedSymbol | undefined {
    const analysis = this.#documents.get(uri);
    if (analysis === undefined) return undefined;
    let found: AblaSymbol | undefined;
    for (const symbol of analysis.symbols) {
      if (symbol.range.start <= range.start && range.end <= symbol.range.end) {
        if (found === undefined || symbol.range.start >= found.range.start) found = symbol;
      }
    }
    return found === undefined ? undefined : { symbol: found, analysis };
  }

  resolve(uri: string, position: Position): ResolvedSymbol | undefined {
    const analysis = this.#documents.get(uri);
    if (analysis === undefined) return undefined;
    const offset = new PositionMap(analysis.text).offset(position);
    const occurrence = identifierAt(analysis, offset);
    if (occurrence === undefined) return undefined;
    return this.#resolveOccurrence(analysis, occurrence);
  }

  references(resolved: ResolvedSymbol): ReadonlyMap<string, readonly AblaOccurrence[]> {
    const result = new Map<string, AblaOccurrence[]>();
    if (!this.#uniquelyResolvable(resolved.symbol)) return result;
    const canonical = resolved.analysis.authority === "compiler";
    for (const analysis of this.#documents.values()) {
      const matches = analysis.occurrences.filter(
        (occurrence) =>
          canonical
            ? occurrence.declarationId === resolved.symbol.id
            : occurrence.name === resolved.symbol.name,
      );
      if (matches.length > 0) result.set(analysis.uri, matches);
    }
    return result;
  }

  prepareRename(uri: string, position: Position): ResolvedSymbol | undefined {
    const resolved = this.resolve(uri, position);
    if (resolved === undefined || !this.#uniquelyResolvable(resolved.symbol)) {
      return undefined;
    }
    const semanticComponent = this.#componentUris(resolved.symbol.uri);
    if (
      resolved.analysis.authority === "compiler" &&
      this.documents().some((analysis) =>
        semanticComponent.has(analysis.uri) &&
        analysis.occurrences.some(
          (occurrence) =>
            occurrence.name === resolved.symbol.name &&
            occurrence.declarationId === undefined,
        ),
      )
    ) {
      return undefined;
    }
    return resolved;
  }

  rename(request: RenameRequest): EditResult {
    if (!validIdentifier.test(request.newName)) {
      return { ok: false, reason: "the new name is not a valid Abla identifier" };
    }
    const resolved = this.prepareRename(request.uri, request.position);
    if (resolved === undefined) {
      return {
        ok: false,
        reason: "syntax-only analysis cannot prove that this symbol is unambiguous",
      };
    }
    if (
      this.symbols().some(
        (symbol) =>
          symbol.id !== resolved.symbol.id &&
          symbol.name === request.newName &&
          this.#sameNamespace(symbol, resolved.symbol),
      )
    ) {
      return { ok: false, reason: `renaming would collide with '${request.newName}'` };
    }
    const changes: Record<string, TextEdit[]> = {};
    for (const [uri, occurrences] of this.references(resolved)) {
      const analysis = this.#documents.get(uri);
      if (analysis === undefined) continue;
      const positions = new PositionMap(analysis.text);
      changes[uri] = occurrences.map((occurrence) => ({
        range: positions.range(occurrence.range),
        newText: request.newName,
      }));
    }
    return { ok: true, edit: { changes } };
  }

  bulkRename(requests: readonly RenameRequest[]): EditResult {
    if (requests.length === 0) {
      return { ok: false, reason: "bulk rename requires at least one symbol" };
    }
    const planned = new Map<string, { readonly resolved: ResolvedSymbol; readonly newName: string }>();
    for (const request of requests) {
      if (!validIdentifier.test(request.newName)) {
        return { ok: false, reason: "the new name is not a valid Abla identifier" };
      }
      const resolved = this.prepareRename(request.uri, request.position);
      if (resolved === undefined) {
        return { ok: false, reason: "one bulk rename target is ambiguous or incompletely analyzed" };
      }
      const previous = planned.get(resolved.symbol.id);
      if (previous !== undefined && previous.newName !== request.newName) {
        return { ok: false, reason: "one symbol has conflicting bulk rename targets" };
      }
      planned.set(resolved.symbol.id, { resolved, newName: request.newName });
    }

    const finalNames = this.symbols().map((symbol) => ({
      symbol,
      name: planned.get(symbol.id)?.newName ?? symbol.name,
    }));
    for (let left = 0; left < finalNames.length; left += 1) {
      const first = finalNames[left];
      if (first === undefined) continue;
      for (let right = left + 1; right < finalNames.length; right += 1) {
        const second = finalNames[right];
        if (
          second !== undefined &&
          first.name === second.name &&
          this.#sameNamespace(first.symbol, second.symbol) &&
          (planned.has(first.symbol.id) || planned.has(second.symbol.id))
        ) {
          return { ok: false, reason: `bulk rename would collide with '${first.name}'` };
        }
      }
    }

    const combined = new Map<string, TextEdit[]>();
    for (const { resolved, newName } of planned.values()) {
      for (const [uri, occurrences] of this.references(resolved)) {
        const analysis = this.#documents.get(uri);
        if (analysis === undefined) continue;
        const positions = new PositionMap(analysis.text);
        const edits = occurrences.map((occurrence) => ({
          range: positions.range(occurrence.range),
          newText: newName,
        }));
        const existing = combined.get(uri) ?? [];
        for (const edit of edits) {
          const duplicate = existing.find(
            (candidate) =>
              candidate.range.start.line === edit.range.start.line &&
              candidate.range.start.character === edit.range.start.character &&
              candidate.range.end.line === edit.range.end.line &&
              candidate.range.end.character === edit.range.end.character,
          );
          if (duplicate !== undefined && duplicate.newText !== edit.newText) {
            return { ok: false, reason: "bulk rename requests overlap" };
          }
          if (duplicate === undefined) existing.push(edit);
        }
        combined.set(uri, existing);
      }
    }
    const changes: Record<string, TextEdit[]> = {};
    for (const [uri, edits] of combined) {
      changes[uri] = edits.sort((left, right) => {
        if (left.range.start.line !== right.range.start.line) {
          return right.range.start.line - left.range.start.line;
        }
        return right.range.start.character - left.range.start.character;
      });
    }
    return { ok: true, edit: { changes } };
  }

  moveDeclarations(request: MoveDeclarationsRequest): EditResult {
    if (request.symbolIds.length === 0) {
      return { ok: false, reason: "move requires at least one declaration" };
    }
    const target = this.#documents.get(request.targetUri);
    if (target === undefined || target.authority !== "compiler") {
      return { ok: false, reason: "the target must be an analyzed Abla document" };
    }
    const selected: ResolvedSymbol[] = [];
    const seen = new Set<string>();
    for (const id of request.symbolIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const resolved = this.symbolById(id);
      if (
        resolved === undefined ||
        resolved.analysis.authority !== "compiler" ||
        !resolved.symbol.topLevel
      ) {
        return { ok: false, reason: "only compiler-resolved top-level declarations can move" };
      }
      if (resolved.symbol.uri === request.targetUri) {
        return { ok: false, reason: "a selected declaration is already in the target file" };
      }
      selected.push(resolved);
    }

    const snippets: string[] = [];
    const changes: Record<string, TextEdit[]> = {};
    const movedIds = new Set(selected.map((resolved) => resolved.symbol.id));
    const movedRanges = new Map<string, Array<{ start: number; end: number }>>();
    for (const resolved of selected) {
      const attachedStart = this.#attachedCommentStart(
        resolved.analysis.text,
        resolved.symbol.range.start,
      );
      const range = { start: attachedStart, end: resolved.symbol.range.end };
      snippets.push(resolved.analysis.text.slice(range.start, range.end).trimEnd());
      const ranges = movedRanges.get(resolved.symbol.uri) ?? [];
      ranges.push(range);
      movedRanges.set(resolved.symbol.uri, ranges);
      const positions = new PositionMap(resolved.analysis.text);
      const edits = changes[resolved.symbol.uri] ?? [];
      edits.push({ range: positions.range(range), newText: "" });
      changes[resolved.symbol.uri] = edits;
    }

    for (const [uri, edits] of Object.entries(changes)) {
      const sorted = edits.sort((left, right) => {
        if (left.range.start.line !== right.range.start.line) {
          return right.range.start.line - left.range.start.line;
        }
        return right.range.start.character - left.range.start.character;
      });
      for (let index = 1; index < sorted.length; index += 1) {
        const later = sorted[index - 1];
        const earlier = sorted[index];
        if (
          later !== undefined &&
          earlier !== undefined &&
          (earlier.range.end.line > later.range.start.line ||
            (earlier.range.end.line === later.range.start.line &&
              earlier.range.end.character > later.range.start.character))
        ) {
          return { ok: false, reason: `move ranges overlap in ${uri}` };
        }
      }
    }

    const targetPositions = new PositionMap(target.text);
    const prefix = target.text.length === 0 || target.text.endsWith("\n\n")
      ? ""
      : target.text.endsWith("\n") ? "\n" : "\n\n";
    const suffix = target.text.length === 0 ? "\n" : "\n";
    const targetEdits = changes[request.targetUri] ?? [];
    targetEdits.push({
      range: targetPositions.range({ start: target.text.length, end: target.text.length }),
      newText: `${prefix}${snippets.join("\n\n")}${suffix}`,
    });
    changes[request.targetUri] = targetEdits;

    const imports = new Map<string, Set<string>>();
    const requireImport = (fromUri: string, importedUri: string): void => {
      if (fromUri === importedUri) return;
      const targets = imports.get(fromUri) ?? new Set<string>();
      targets.add(importedUri);
      imports.set(fromUri, targets);
    };
    for (const resolved of selected) {
      for (const occurrence of resolved.analysis.occurrences) {
        if (
          occurrence.declarationId === undefined ||
          movedIds.has(occurrence.declarationId) ||
          occurrence.range.start < resolved.symbol.range.start ||
          occurrence.range.end > resolved.symbol.range.end
        ) continue;
        const dependency = this.symbolById(occurrence.declarationId);
        if (dependency !== undefined) requireImport(request.targetUri, dependency.symbol.uri);
      }
    }
    for (const analysis of this.#documents.values()) {
      for (const occurrence of analysis.occurrences) {
        if (occurrence.declarationId === undefined || !movedIds.has(occurrence.declarationId)) {
          continue;
        }
        const removed = (movedRanges.get(analysis.uri) ?? []).some(
          (range) => range.start <= occurrence.range.start && occurrence.range.end <= range.end,
        );
        if (!removed) requireImport(analysis.uri, request.targetUri);
      }
    }
    if (this.#importGraphHasCycle(imports)) {
      return { ok: false, reason: "move would introduce an import cycle" };
    }
    for (const [uri, importedUris] of imports) {
      const analysis = this.#documents.get(uri);
      if (analysis === undefined) continue;
      const requested = [...importedUris]
        .map((importedUri) => this.#relativeImport(uri, importedUri))
        .filter((value): value is string => value !== undefined)
        .filter((value) => !analysis.text.includes(`import "${value}"`))
        .sort((left, right) => left.localeCompare(right));
      if (requested.length === 0) continue;
      const importEdit = this.#mergeImportEdit(analysis, requested);
      const existingEdits = changes[uri] ?? [];
      const positions = new PositionMap(analysis.text);
      const importStart = positions.offset(importEdit.range.start);
      const importEnd = positions.offset(importEdit.range.end);
      let absorbed = false;
      changes[uri] = existingEdits.map((edit) => {
        const editStart = positions.offset(edit.range.start);
        const editEnd = positions.offset(edit.range.end);
        if (!absorbed && edit.newText === "" &&
          editStart <= importStart && importEnd <= editEnd) {
          absorbed = true;
          return { ...edit, newText: importEdit.newText };
        }
        return edit;
      });
      if (!absorbed) changes[uri]?.push(importEdit);
    }
    return { ok: true, edit: { changes } };
  }

  #resolveOccurrence(
    analysis: DocumentAnalysis,
    occurrence: AblaOccurrence,
  ): ResolvedSymbol | undefined {
    if (occurrence.declarationId !== undefined) {
      for (const candidate of this.#documents.values()) {
        const declaration = candidate.symbols.find(
          (symbol) => symbol.id === occurrence.declarationId,
        );
        if (declaration !== undefined) {
          return { symbol: declaration, analysis: candidate };
        }
      }
    }
    const local = analysis.symbols.filter((symbol) => symbol.name === occurrence.name);
    if (local.length === 1 && local[0] !== undefined) {
      return { symbol: local[0], analysis };
    }
    const workspace = this.symbols().filter(
      (symbol) => symbol.name === occurrence.name && symbol.topLevel,
    );
    if (workspace.length !== 1 || workspace[0] === undefined) return undefined;
    const declarationAnalysis = this.#documents.get(workspace[0].uri);
    if (declarationAnalysis === undefined) return undefined;
    return { symbol: workspace[0], analysis: declarationAnalysis };
  }

  #uniquelyResolvable(symbol: AblaSymbol): boolean {
    const declaration = this.#documents.get(symbol.uri);
    if (declaration?.authority === "compiler") return true;
    if (!symbol.topLevel) {
      const owner = symbol.containerId;
      return (
        owner !== undefined &&
        this.symbols().filter(
          (candidate) =>
            candidate.containerId === owner && candidate.name === symbol.name,
        ).length === 1
      );
    }
    return this.symbols().filter(
      (candidate) => candidate.topLevel && candidate.name === symbol.name,
    ).length === 1;
  }

  #sameNamespace(left: AblaSymbol, right: AblaSymbol): boolean {
    if (left.topLevel || right.topLevel) {
      if (!left.topLevel || !right.topLevel) return false;
      const leftAnalysis = this.#documents.get(left.uri);
      const rightAnalysis = this.#documents.get(right.uri);
      if (leftAnalysis?.authority === "compiler" &&
        rightAnalysis?.authority === "compiler") {
        return this.#componentUris(left.uri).has(right.uri);
      }
      return true;
    }
    return left.containerId !== undefined && left.containerId === right.containerId;
  }

  #componentUris(startUri: string): ReadonlySet<string> {
    const graph = new Map<string, Set<string>>();
    for (const analysis of this.#documents.values()) graph.set(analysis.uri, new Set());
    for (const analysis of this.#documents.values()) {
      if (!analysis.uri.startsWith("file:")) continue;
      const imports = /^\s*import\s+(?:contract\s+)?"([^"\r\n]+)"/gmu;
      for (const match of analysis.text.matchAll(imports)) {
        const requested = match[1];
        if (requested === undefined || requested.startsWith("abla/")) continue;
        try {
          const importer = fileURLToPath(analysis.uri);
          const importedUri = pathToFileURL(
            path.resolve(path.dirname(importer), requested),
          ).href;
          if (!graph.has(importedUri)) continue;
          graph.get(analysis.uri)?.add(importedUri);
          graph.get(importedUri)?.add(analysis.uri);
        } catch {
          // Non-file documents form their own analysis component.
        }
      }
    }
    const visited = new Set<string>();
    const pending = [startUri];
    while (pending.length > 0) {
      const uri = pending.pop();
      if (uri === undefined || visited.has(uri)) continue;
      visited.add(uri);
      for (const linked of graph.get(uri) ?? []) pending.push(linked);
    }
    return visited;
  }

  #attachedCommentStart(text: string, declarationStart: number): number {
    let start = text.lastIndexOf("\n", Math.max(0, declarationStart - 1)) + 1;
    let cursor = start;
    while (cursor > 0) {
      const previousEnd = cursor - 1;
      const previousStart = text.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
      const line = text.slice(previousStart, previousEnd).trim();
      if (!line.startsWith("//")) break;
      start = previousStart;
      cursor = previousStart;
    }
    return start;
  }

  #relativeImport(fromUri: string, importedUri: string): string | undefined {
    try {
      const from = fileURLToPath(fromUri);
      const imported = fileURLToPath(importedUri);
      return path.relative(path.dirname(from), imported).replaceAll(path.sep, "/");
    } catch {
      return undefined;
    }
  }

  #mergeImportEdit(analysis: DocumentAnalysis, requested: readonly string[]): TextEdit {
    const lines = analysis.text.match(/[^\n]*(?:\n|$)/gu) ?? [];
    let offset = 0;
    let headerEnd = 0;
    let blockComment = false;
    let line = 0;
    while (line < lines.length) {
      const raw = lines[line] ?? "";
      const trimmed = raw.trim();
      const header = trimmed === "" || trimmed.startsWith("//") ||
        blockComment || trimmed.startsWith("/*");
      if (!header) break;
      if (trimmed.startsWith("/*") && !trimmed.includes("*/")) blockComment = true;
      if (blockComment && trimmed.includes("*/")) blockComment = false;
      offset += raw.length;
      headerEnd = offset;
      line += 1;
    }
    const importStart = headerEnd;
    const existing: string[] = [];
    while (line < lines.length) {
      const raw = lines[line] ?? "";
      const trimmed = raw.trim();
      if (!trimmed.startsWith("import ")) break;
      existing.push(trimmed);
      offset += raw.length;
      line += 1;
    }
    const importEnd = offset;
    const combined = [...new Set([
      ...existing,
      ...requested.map((value) => `import "${value}"`),
    ])].sort((left, right) => left.localeCompare(right));
    return {
      range: new PositionMap(analysis.text).range({
        start: importStart,
        end: importEnd,
      }),
      newText: `${combined.join("\n")}\n`,
    };
  }

  #importGraphHasCycle(additions: ReadonlyMap<string, ReadonlySet<string>>): boolean {
    const graph = new Map<string, Set<string>>();
    for (const analysis of this.#documents.values()) {
      const edges = graph.get(analysis.uri) ?? new Set<string>();
      const imports = /^\s*import\s+(?:contract\s+)?"([^"\r\n]+)"/gmu;
      for (const match of analysis.text.matchAll(imports)) {
        const requested = match[1];
        if (requested === undefined || requested.startsWith("abla/")) continue;
        try {
          const importer = fileURLToPath(analysis.uri);
          const imported = path.resolve(path.dirname(importer), requested);
          edges.add(pathToFileURL(imported).href);
        } catch {
          // Non-file documents do not participate in the filesystem import graph.
        }
      }
      graph.set(analysis.uri, edges);
    }
    for (const [uri, targets] of additions) {
      const edges = graph.get(uri) ?? new Set<string>();
      for (const target of targets) edges.add(target);
      graph.set(uri, edges);
    }
    const state = new Map<string, 0 | 1 | 2>();
    const visits = (uri: string): boolean => {
      const current = state.get(uri) ?? 0;
      if (current === 1) return true;
      if (current === 2) return false;
      state.set(uri, 1);
      for (const target of graph.get(uri) ?? []) {
        if (graph.has(target) && visits(target)) return true;
      }
      state.set(uri, 2);
      return false;
    };
    return [...graph.keys()].some((uri) => visits(uri));
  }
}
