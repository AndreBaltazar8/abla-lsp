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
  let cursor = Math.min(offset, text.length) - 1;
  let depth = 0;
  let activeParameter = 0;
  while (cursor >= 0) {
    const character = text[cursor];
    if (character === ")") depth += 1;
    else if (character === "(") {
      if (depth === 0) {
        let nameEnd = cursor;
        while (nameEnd > 0 && /\s/.test(text[nameEnd - 1] ?? "")) nameEnd -= 1;
        let nameBegin = nameEnd;
        while (nameBegin > 0 && /[A-Za-z0-9_.]/.test(text[nameBegin - 1] ?? "")) {
          nameBegin -= 1;
        }
        const qualified = text.slice(nameBegin, nameEnd);
        const name = qualified.slice(qualified.lastIndexOf(".") + 1);
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
          ? { name, activeParameter }
          : undefined;
      }
      depth -= 1;
    } else if (character === "," && depth === 0) activeParameter += 1;
    cursor -= 1;
  }
  return undefined;
}

export function symbolSignature(analysis: DocumentAnalysis, symbol: AblaSymbol): string {
  const raw = analysis.text.slice(symbol.range.start, symbol.range.end);
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
