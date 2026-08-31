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
    this.#documents.set(uri, analysis);
    return analysis;
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
    for (const analysis of this.#documents.values()) {
      const matches = analysis.occurrences.filter(
        (occurrence) => occurrence.name === resolved.symbol.name,
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
          symbol.topLevel === resolved.symbol.topLevel,
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
    const combined = new Map<string, TextEdit[]>();
    for (const request of requests) {
      const result = this.rename(request);
      if (!result.ok) return result;
      for (const [uri, edits] of Object.entries(result.edit.changes ?? {})) {
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
      const declaration = analysis.symbols.find(
        (symbol) => symbol.id === occurrence.declarationId,
      );
      if (declaration !== undefined) return { symbol: declaration, analysis };
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
}
