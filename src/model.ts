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

/** One fix the compiler gives a diagnostic: edits to apply as they are (analyze `fixes`). */
export interface AblaFix {
  readonly title: string;
  readonly kind: string;
  readonly edits: readonly { readonly range: OffsetRange; readonly newText: string }[];
}

export interface AblaDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: OffsetRange;
  /** Help lines the compiler gives this diagnostic (analyze `help`), without the `help:` prefix. */
  readonly help?: readonly string[];
  /** "warning" for a compiler warning (W_UNUSED_IMPORT); absent is an error. */
  readonly severity?: "warning";
  /** "unnecessary": the range is shown greyed out. */
  readonly tags?: readonly string[];
  /** The edits that fix it, when the compiler has them (a did-you-mean, a missing import). */
  readonly fixes?: readonly AblaFix[];
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
