import type { AblaDiagnostic } from "./model.js";
import type { PositionMap } from "./positions.js";

/** A fix as it travels in a diagnostic's `data` (LSP ranges), so the code action needs nothing from the message. */
export interface DiagnosticFix {
  readonly title: string;
  readonly kind: string;
  readonly edits: readonly { readonly range: { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } }; readonly newText: string }[];
}

export function diagnosticData(diagnostic: AblaDiagnostic, positions: PositionMap): { readonly fixes: readonly DiagnosticFix[] } | undefined {
  const fixes = diagnostic.fixes ?? [];
  if (fixes.length === 0) return undefined;
  return {
    fixes: fixes.map((fix) => ({
      title: fix.title, kind: fix.kind,
      edits: fix.edits.map((edit) => ({ range: positions.range(edit.range), newText: edit.newText })),
    })),
  };
}

/** The fixes a client sent back in a diagnostic's `data`, or none (a diagnostic of another source, an older server). */
export function dataFixes(data: unknown): readonly DiagnosticFix[] {
  const fixes = (data as { fixes?: unknown } | null | undefined)?.fixes;
  return Array.isArray(fixes) ? (fixes as DiagnosticFix[]).filter((fix) => typeof fix?.title === "string" && Array.isArray(fix.edits)) : [];
}

/** The message with the compiler's help lines under it: VS Code shows the lines on hover and in the Problems view alike. */
export function diagnosticMessage(diagnostic: AblaDiagnostic): string {
  const help = diagnostic.help ?? [];
  return help.length === 0 ? diagnostic.message : `${diagnostic.message}\n${help.map((line) => `help: ${line}`).join("\n")}`;
}
