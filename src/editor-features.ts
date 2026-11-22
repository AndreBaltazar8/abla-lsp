import type { FoldingRange, TextEdit } from "vscode-languageserver/node";
import type { AblaSymbol, DocumentAnalysis } from "./model.js";
import { PositionMap } from "./positions.js";

export const ablaKeywords = [
  "abstract", "await", "break", "class", "compile", "constructor",
  "continue", "defer", "do", "else", "enum", "extern", "false", "for",
  "fun", "generator", "if", "import", "in", "interface", "noescape",
  "null", "own", "region", "resource", "return", "task", "thread", "true",
  "trusted", "until", "val", "var", "when", "while", "yield",
] as const;

export interface CallContext {
  readonly name: string;
  readonly nameOffset: number;
  readonly activeParameter: number;
}

export function callArgumentOffsets(text: string, nameEnd: number): readonly number[] {
  let cursor = nameEnd;
  while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
  if (text[cursor] !== "(") return [];
  cursor += 1;
  while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
  if (text[cursor] === ")") return [];
  const offsets: number[] = [cursor];
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let quoted = false;
  let lineComment = false;
  let blockComment = 0;
  while (cursor < text.length) {
    const character = text[cursor] ?? "";
    const next = text[cursor + 1] ?? "";
    if (lineComment) {
      if (character === "\n") lineComment = false;
      cursor += 1;
      continue;
    }
    if (blockComment > 0) {
      if (character === "/" && next === "*") {
        blockComment += 1;
        cursor += 2;
      } else if (character === "*" && next === "/") {
        blockComment -= 1;
        cursor += 2;
      } else cursor += 1;
      continue;
    }
    if (!quoted && character === "/" && next === "/") {
      lineComment = true;
      cursor += 2;
      continue;
    }
    if (!quoted && character === "/" && next === "*") {
      blockComment = 1;
      cursor += 2;
      continue;
    }
    if (character === '"' && text[cursor - 1] !== "\\") {
      quoted = !quoted;
      cursor += 1;
      continue;
    }
    if (quoted) {
      cursor += 1;
      continue;
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") {
      if (parentheses === 0 && brackets === 0 && braces === 0) return offsets;
      parentheses = Math.max(0, parentheses - 1);
    } else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "," && parentheses === 0 && brackets === 0 && braces === 0) {
      cursor += 1;
      while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
      if (text[cursor] !== ")") offsets.push(cursor);
      continue;
    }
    cursor += 1;
  }
  return [];
}

export function callContext(text: string, offset: number): CallContext | undefined {
  const stack: Array<{ opening: string; call?: { name: string; nameOffset: number; activeParameter: number } }> = [];
  let cursor = 0;
  let quoted = false;
  let lineComment = false;
  let blockComment = 0;
  while (cursor < Math.min(offset, text.length)) {
    const character = text[cursor];
    const next = text[cursor + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
    } else if (blockComment > 0) {
      if (character === "/" && next === "*") { blockComment += 1; cursor += 1; }
      else if (character === "*" && next === "/") { blockComment -= 1; cursor += 1; }
    } else if (quoted) {
      if (character === "\\") cursor += 1;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "/" && next === "/") { lineComment = true; cursor += 1; }
    else if (character === "/" && next === "*") { blockComment = 1; cursor += 1; }
    else if (character === "(" || character === "[" || character === "{") {
      const group: (typeof stack)[number] = { opening: character };
      if (character === "(") {
        let nameEnd = cursor;
        while (nameEnd > 0 && /\s/.test(text[nameEnd - 1] ?? "")) nameEnd -= 1;
        let nameBegin = nameEnd;
        while (nameBegin > 0 && /[A-Za-z0-9_.]/.test(text[nameBegin - 1] ?? "")) {
          nameBegin -= 1;
        }
        const qualified = text.slice(nameBegin, nameEnd);
        const name = qualified.slice(qualified.lastIndexOf(".") + 1);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !["if", "while", "for", "when"].includes(name)) {
          group.call = { name, nameOffset: nameEnd - name.length, activeParameter: 0 };
        }
      }
      stack.push(group);
    } else if (character === ")" || character === "]" || character === "}") {
      stack.pop();
    } else if (character === ",") {
      const call = stack.at(-1)?.call;
      if (call !== undefined) call.activeParameter += 1;
    }
    cursor += 1;
  }
  return stack.findLast((group) => group.call !== undefined)?.call;
}

/** `text` without its comments (each becomes one blank), leaving string literals alone: a signature shows a declaration, not what is written inside it. */
function withoutComments(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (character === '"') {
      output += character;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && index + 1 < text.length) {
          output += text[index];
          index += 1;
        }
        output += text[index] ?? "";
        index += 1;
      }
      if (index < text.length) output += '"';
      index += 1;
    } else if (character === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close < 0 ? text.length : close + 2;
      output += " ";
    } else if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else {
      output += character;
      index += 1;
    }
  }
  return output;
}

export function symbolSignature(analysis: DocumentAnalysis, symbol: AblaSymbol): string {
  if (symbol.signature !== undefined) return symbol.signature;
  const raw = withoutComments(analysis.text.slice(symbol.range.start, symbol.range.end));
  let end = raw.length;
  let groups = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "(" || character === "[") groups += 1;
    if (character === ")" || character === "]") groups = Math.max(0, groups - 1);
    if (groups === 0 && (character === "=" || character === "{" || character === "\n")) {
      end = index;
      break;
    }
  }
  return raw.slice(0, end).trim().replace(/\s+/g, " ");
}

/** Keep multiline source and literal backticks intact when presenting a signature. */
export function signatureMarkdown(signature: string): string {
  const fence = "`".repeat(Math.max(3, ...[...signature.matchAll(/`+/gu)].map((match) => match[0].length + 1)));
  return `${fence}abla\n${signature}\n${fence}`;
}

export function foldingRanges(text: string): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const stack: number[] = [];
  let line = 0;
  let offset = 0;
  let quoted = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let blockCommentLine = -1;
  while (offset < text.length) {
    const character = text[offset] ?? "";
    const next = text[offset + 1] ?? "";
    if (character === "\n") {
      line += 1;
      lineComment = false;
      offset += 1;
      continue;
    }
    if (!quoted && !lineComment && character === "/" && next === "*") {
      if (blockCommentDepth === 0) blockCommentLine = line;
      blockCommentDepth += 1;
      offset += 2;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (character === "*" && next === "/") {
        blockCommentDepth -= 1;
        offset += 2;
        if (blockCommentDepth === 0 && blockCommentLine < line) {
          ranges.push({ startLine: blockCommentLine, endLine: line, kind: "comment" });
        }
      } else offset += 1;
      continue;
    }
    if (!quoted && character === "/" && next === "/") {
      lineComment = true;
      offset += 2;
      continue;
    }
    if (!lineComment && character === '"' && text[offset - 1] !== "\\") {
      quoted = !quoted;
      offset += 1;
      continue;
    }
    if (!quoted && !lineComment && character === "{") stack.push(line);
    if (!quoted && !lineComment && character === "}") {
      const startLine = stack.pop();
      if (startLine !== undefined && startLine < line) ranges.push({ startLine, endLine: line });
    }
    offset += 1;
  }
  return ranges.sort((left, right) =>
    left.startLine === right.startLine
      ? left.endLine - right.endLine
      : left.startLine - right.startLine,
  );
}

export function formatDocument(text: string): TextEdit[] {
  const formatted = `${text
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+$/u, ""))
    .join("\n")
    .replace(/\n*$/u, "")}\n`;
  if (formatted === text) return [];
  const positions = new PositionMap(text);
  return [{
    range: {
      start: { line: 0, character: 0 },
      end: positions.position(text.length),
    },
    newText: formatted,
  }];
}

export function organizeImports(text: string): TextEdit | undefined {
  const lines = text.split("\n");
  let first = 0;
  while (first < lines.length && (lines[first]?.trim() === "" || lines[first]?.trimStart().startsWith("//"))) {
    first += 1;
  }
  let last = first;
  while (last < lines.length && /^\s*import\s+/.test(lines[last] ?? "")) last += 1;
  if (last - first < 2) return undefined;
  const sorted = [...new Set(lines.slice(first, last).map((line) => line.trim()))].sort(
    (left, right) => left.localeCompare(right),
  );
  const original = lines.slice(first, last);
  if (sorted.length === original.length && sorted.every((line, index) => line === original[index])) {
    return undefined;
  }
  const before = lines.slice(0, first).join("\n");
  const startOffset = before === "" ? 0 : before.length + 1;
  const oldText = original.join("\n");
  const positions = new PositionMap(text);
  return {
    range: positions.range({ start: startOffset, end: startOffset + oldText.length }),
    newText: sorted.join("\n"),
  };
}

/**
 * `: T` after a binding that has no written type: a local val/var, a loop variable, a lambda parameter. The compiler
 * puts a type on the uses of a binding, not on its declaration, so the type of the first use that has one is the
 * binding's (a binding nothing uses gets no hint).
 */
export function inferredTypeHints(
  analysis: DocumentAnalysis,
  start: number,
  end: number,
): readonly { readonly offset: number; readonly label: string }[] {
  const types = new Map<string, string>();
  for (const occurrence of analysis.occurrences) {
    if (occurrence.declarationId === undefined || occurrence.type === undefined || occurrence.type === "" || types.has(occurrence.declarationId)) continue;
    types.set(occurrence.declarationId, occurrence.type);
  }
  const hints: { offset: number; label: string }[] = [];
  for (const symbol of analysis.symbols) {
    const at = symbol.selectionRange.end;
    if (at < start || symbol.selectionRange.start > end) continue;
    if (!/^(?:local\.(?:val|var|own)|for|lambda\.parameter)/u.test(symbol.detail)) continue;
    const type = types.get(symbol.id);
    if (type === undefined) continue;
    if (/^\s*:/u.test(analysis.text.slice(at, at + 12))) continue;
    hints.push({ offset: at, label: `: ${type}` });
  }
  return hints;
}
