import type { AblaDiagnostic } from "./model.js";

/** The message with the compiler's help lines under it: VS Code shows the lines on hover and in the Problems view alike. */
export function diagnosticMessage(diagnostic: AblaDiagnostic): string {
  const help = diagnostic.help ?? [];
  return help.length === 0 ? diagnostic.message : `${diagnostic.message}\n${help.map((line) => `help: ${line}`).join("\n")}`;
}
