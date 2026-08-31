import type { AblaDiagnostic, AblaOccurrence, AblaSymbol } from "./model.js";

export const compilerProtocolVersion = 1 as const;

export interface CompilerDocumentSnapshot {
  readonly uri: string;
  readonly version: number;
  readonly text: string;
  readonly symbols: readonly AblaSymbol[];
  readonly occurrences: readonly AblaOccurrence[];
  readonly diagnostics: readonly AblaDiagnostic[];
}

export interface CompilerWorkspaceSnapshot {
  readonly revision: string;
  readonly documents: readonly CompilerDocumentSnapshot[];
}

export interface CompilerInitializeParams {
  readonly workspaceRoots: readonly string[];
  readonly clientName: string;
  readonly clientVersion: string;
}

export interface CompilerInitializeResult {
  readonly compilerVersion: string;
  readonly protocolVersion: number;
  readonly capabilities: readonly string[];
}

export interface CompilerDocumentParams {
  readonly uri: string;
  readonly version: number;
  readonly text: string;
}

export interface CompilerCloseDocumentParams {
  readonly uri: string;
}

export interface CompilerAnalyzeParams {
  readonly roots?: readonly string[];
}

export interface CompilerTextEdit {
  readonly uri: string;
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

export interface CompilerValidateEditParams {
  readonly baseRevision: string;
  readonly edits: readonly CompilerTextEdit[];
  readonly invariants: readonly string[];
}

export interface CompilerValidateEditResult {
  readonly valid: boolean;
  readonly snapshot?: CompilerWorkspaceSnapshot;
  readonly reason?: string;
}

export type CompilerMethod =
  | "initialize"
  | "document/open"
  | "document/change"
  | "document/close"
  | "analyze"
  | "refactor/validate"
  | "shutdown";

export interface CompilerRequest {
  readonly schema: typeof compilerProtocolVersion;
  readonly id: number;
  readonly method: CompilerMethod;
  readonly params: unknown;
}

export interface CompilerNotification {
  readonly schema: typeof compilerProtocolVersion;
  readonly method: "cancel";
  readonly params: { readonly id: number };
}

export interface CompilerError {
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface CompilerResponse {
  readonly schema: typeof compilerProtocolVersion;
  readonly id: number;
  readonly result?: unknown;
  readonly error?: CompilerError;
}

export function isCompilerResponse(value: unknown): value is CompilerResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === compilerProtocolVersion &&
    typeof candidate.id === "number" &&
    (Object.hasOwn(candidate, "result") || Object.hasOwn(candidate, "error"))
  );
}
