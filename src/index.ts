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
    if (
      resolved.analysis.authority === "compiler" &&
      this.documents().some((analysis) =>
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
    if (left.topLevel || right.topLevel) return left.topLevel && right.topLevel;
    return left.containerId !== undefined && left.containerId === right.containerId;
  }
}
