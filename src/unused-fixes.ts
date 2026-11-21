import type { WorkspaceEdit } from "vscode-languageserver/node";

/** A removal as offsets into the document text. */
export interface TextRemoval {
  readonly title: string;
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(text: string, offset: number): number {
  const index = text.indexOf("\n", offset);
  return index < 0 ? text.length : index;
}

function balanced(source: string): boolean {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== "") {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && quote === "";
}

/**
 * The unused local `name` removed: its whole line when the initializer calls nothing, otherwise the
 * statement replaced by the initializer, which keeps what the call does. Only a one-line `val`/`var`
 * statement is handled; anything else gets no removal (the compiler's rename to `_name` stays).
 */
export function removeUnusedLocal(text: string, offset: number, name: string): TextRemoval | undefined {
  const start = lineStart(text, offset);
  const end = lineEnd(text, offset);
  const line = text.slice(start, end);
  const match = new RegExp(`^(\\s*)(?:val|var)\\s+${name}\\b\\s*(?::[^=]+)?=\\s*(.+?)\\s*$`, "u").exec(line);
  if (match === null) return undefined;
  const initializer = match[2] ?? "";
  if (initializer === "" || !balanced(initializer) || initializer.endsWith("{")) return undefined;
  if (!/[(\[{]|\$\{/u.test(initializer)) {
    const next = end < text.length ? end + 1 : end;
    return { title: `Remove unused \`${name}\``, start, end: next, newText: "" };
  }
  return { title: `Remove unused \`${name}\`, keep its initializer`, start, end, newText: `${match[1] ?? ""}${initializer}` };
}

/**
 * An unused function or method removed with its whole lines and the comment block directly above, plus
 * one blank line so no double gap is left. `start`/`end` is the declaration the compiler marked.
 */
export function removeUnusedDeclaration(text: string, start: number, end: number, name: string): TextRemoval | undefined {
  if (!balanced(text.slice(start, end))) return undefined;
  let from = lineStart(text, start);
  if (text.slice(from, start).trim() !== "") return undefined;
  let to = lineEnd(text, end);
  if (text.slice(end, to).trim() !== "") return undefined;
  to = to < text.length ? to + 1 : to;
  // The comment lines directly above (`//` lines or one `/** ... */` block).
  for (;;) {
    if (from === 0) break;
    const previousStart = lineStart(text, from - 1);
    const previous = text.slice(previousStart, from - 1).trim();
    if (previous.startsWith("//")) { from = previousStart; continue; }
    if (previous.endsWith("*/")) {
      let blockStart = previousStart;
      while (blockStart > 0 && !text.slice(blockStart, lineEnd(text, blockStart)).trim().startsWith("/*")) blockStart = lineStart(text, blockStart - 1);
      if (text.slice(blockStart, lineEnd(text, blockStart)).trim().startsWith("/*")) { from = blockStart; continue; }
    }
    break;
  }
  // A blank line after the declaration goes when one stands before it too, or at the file's start.
  const after = text.slice(to, lineEnd(text, to));
  const before = from === 0 ? "" : text.slice(lineStart(text, from - 1), from - 1);
  if (to < text.length && after.trim() === "" && (from === 0 || before.trim() === "")) to = lineEnd(text, to) < text.length ? lineEnd(text, to) + 1 : lineEnd(text, to);
  return { title: `Delete unused \`${name}\``, start: from, end: to, newText: "" };
}

/**
 * The same edit as documentChanges whose every text edit names one annotation that needs confirmation,
 * so a client with change-annotation support shows the edit for review before applying it.
 */
export function withPreview(edit: WorkspaceEdit, label: string): WorkspaceEdit {
  const id = "abla-unused-removal";
  return {
    changeAnnotations: { [id]: { label, needsConfirmation: true } },
    documentChanges: Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({
      textDocument: { uri, version: null },
      edits: edits.map((item) => ({ range: item.range, newText: item.newText, annotationId: id })),
    })),
  };
}
