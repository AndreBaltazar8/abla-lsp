export type AnalysisAuthority = "compiler" | "syntax";

export interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

export type AblaSymbolKind =
  | "function"
  | "class"
  | "interface"
  | "enum"
  | "type"
  | "parameter"
  | "property"
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
  /** What the comment above the declaration says of it (graph-v1 and graph-v2 compilers): shown with the declaration on hover. */
  readonly documentation?: string;
}

export interface AblaOccurrence {
  readonly name: string;
  readonly range: OffsetRange;
  readonly declarationId?: string;
  readonly type?: string;
}

export interface AblaDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: OffsetRange;
}

export interface DocumentAnalysis {
  readonly authority: AnalysisAuthority;
  readonly occurrencesAvailable?: boolean;
  readonly analysisComplete?: boolean;
  readonly writable?: boolean;
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
