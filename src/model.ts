export type AnalysisAuthority = "compiler" | "syntax";

export interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

export type AblaSymbolKind =
  | "function"
  | "class"
  | "enum"
  | "value"
  | "variable";

export interface AblaSymbol {
  readonly id: string;
  readonly name: string;
  readonly kind: AblaSymbolKind;
  readonly uri: string;
  readonly range: OffsetRange;
  readonly selectionRange: OffsetRange;
  readonly detail: string;
  readonly topLevel: boolean;
  readonly containerId?: string;
}

export interface AblaOccurrence {
  readonly name: string;
  readonly range: OffsetRange;
  readonly declarationId?: string;
}

export interface AblaDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: OffsetRange;
}

export interface DocumentAnalysis {
  readonly authority: AnalysisAuthority;
  readonly uri: string;
  readonly version: number;
  readonly text: string;
  readonly symbols: readonly AblaSymbol[];
  readonly occurrences: readonly AblaOccurrence[];
  readonly diagnostics: readonly AblaDiagnostic[];
}

export interface Analyzer {
  analyze(uri: string, version: number, text: string): DocumentAnalysis;
}
