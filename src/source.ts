import type {
  AblaDiagnostic,
  AblaOccurrence,
  AblaSymbol,
  AblaSymbolKind,
  Analyzer,
  DocumentAnalysis,
  OffsetRange,
} from "./model.js";

interface Token {
  readonly kind: "identifier" | "string" | "punctuation";
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly depth: number;
  readonly groupDepth: number;
}

interface ScanResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly AblaDiagnostic[];
  readonly matchingBraces: ReadonlyMap<number, number>;
}

const declarationKinds = new Map<string, AblaSymbolKind>([
  ["fun", "function"],
  ["class", "class"],
  ["enum", "enum"],
  ["val", "value"],
  ["var", "variable"],
]);

const identifierStart = /[A-Za-z_]/;
const identifierPart = /[A-Za-z0-9_]/;

function scan(text: string): ScanResult {
  const tokens: Token[] = [];
  const diagnostics: AblaDiagnostic[] = [];
  const matchingBraces = new Map<number, number>();
  const braces: Array<{ token: number; offset: number }> = [];
  let depth = 0;
  let groupDepth = 0;
  let offset = 0;

  while (offset < text.length) {
    const character = text[offset] ?? "";
    const next = text[offset + 1] ?? "";
    if (/\s/.test(character)) {
      offset += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      offset += 2;
      while (offset < text.length && text[offset] !== "\n") offset += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const begin = offset;
      offset += 2;
      while (
        offset + 1 < text.length &&
        !(text[offset] === "*" && text[offset + 1] === "/")
      ) {
        offset += 1;
      }
      if (offset + 1 >= text.length) {
        diagnostics.push({
          code: "E_UNTERMINATED_BLOCK_COMMENT",
          message: "unterminated block comment",
          range: { start: begin, end: text.length },
        });
        break;
      }
      offset += 2;
      continue;
    }
    if (character === '"') {
      const begin = offset;
      offset += 1;
      let escaped = false;
      let terminated = false;
      while (offset < text.length) {
        const current = text[offset] ?? "";
        if (!escaped && current === '"') {
          offset += 1;
          terminated = true;
          break;
        }
        if (!escaped && current === "\n") break;
        if (!escaped && current === "\\") escaped = true;
        else escaped = false;
        offset += 1;
      }
      tokens.push({
        kind: "string",
        text: text.slice(begin, offset),
        start: begin,
        end: offset,
        depth,
        groupDepth,
      });
      if (!terminated) {
        diagnostics.push({
          code: "E_UNTERMINATED_STRING",
          message: "unterminated string literal",
          range: { start: begin, end: offset },
        });
      }
      continue;
    }
    if (identifierStart.test(character)) {
      const begin = offset;
      offset += 1;
      while (offset < text.length && identifierPart.test(text[offset] ?? "")) {
        offset += 1;
      }
      tokens.push({
        kind: "identifier",
        text: text.slice(begin, offset),
        start: begin,
        end: offset,
        depth,
        groupDepth,
      });
      continue;
    }

    const tokenIndex = tokens.length;
    if ((character === ")" || character === "]") && groupDepth > 0) {
      groupDepth -= 1;
    }
    if (character === "}") {
      if (braces.length === 0) {
        diagnostics.push({
          code: "E_UNEXPECTED_CLOSING_BRACE",
          message: "unexpected closing brace",
          range: { start: offset, end: offset + 1 },
        });
      } else {
        depth -= 1;
        const opening = braces.pop();
        if (opening !== undefined) {
          matchingBraces.set(opening.token, tokenIndex);
          matchingBraces.set(tokenIndex, opening.token);
        }
      }
    }
    tokens.push({
      kind: "punctuation",
      text: character,
      start: offset,
      end: offset + 1,
      depth,
      groupDepth,
    });
    if (character === "{") {
      braces.push({ token: tokenIndex, offset });
      depth += 1;
    }
    if (character === "(" || character === "[") groupDepth += 1;
    offset += 1;
  }

  for (const opening of braces) {
    diagnostics.push({
      code: "E_UNCLOSED_BRACE",
      message: "unclosed brace",
      range: { start: opening.offset, end: opening.offset + 1 },
    });
  }
  return { tokens, diagnostics, matchingBraces };
}

function lineEnd(text: string, offset: number): number {
  const found = text.indexOf("\n", offset);
  return found < 0 ? text.length : found;
}

function declarationEnd(
  text: string,
  tokens: readonly Token[],
  matchingBraces: ReadonlyMap<number, number>,
  keywordIndex: number,
): number {
  const keyword = tokens[keywordIndex];
  if (keyword === undefined) return text.length;
  for (let index = keywordIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.depth < keyword.depth) break;
    if (token.groupDepth !== keyword.groupDepth) continue;
    if (token.depth === keyword.depth && token.text === "{") {
      const closingIndex = matchingBraces.get(index);
      const closing = closingIndex === undefined ? undefined : tokens[closingIndex];
      return closing?.end ?? text.length;
    }
    if (
      index > keywordIndex + 1 &&
      token.depth === keyword.depth &&
      declarationKinds.has(token.text)
    ) {
      return token.start;
    }
  }
  return lineEnd(text, keyword.end);
}

function declarationName(
  tokens: readonly Token[],
  keywordIndex: number,
): { token: Token; detail: string } | undefined {
  const keyword = tokens[keywordIndex];
  if (keyword === undefined) return undefined;
  let first: Token | undefined;
  for (let index = keywordIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.depth !== keyword.depth) break;
    if (token.groupDepth !== keyword.groupDepth) continue;
    if (token.kind === "identifier") {
      if (first === undefined) first = token;
      const dot = tokens[index + 1];
      const member = tokens[index + 2];
      if (
        dot?.text === "." &&
        member?.kind === "identifier" &&
        member.depth === keyword.depth &&
        member.groupDepth === keyword.groupDepth
      ) {
        return { token: member, detail: `${keyword.text} ${first.text}.` };
      }
      return { token, detail: keyword.text };
    }
  }
  return undefined;
}

function containingSymbol(
  symbols: readonly AblaSymbol[],
  range: OffsetRange,
): AblaSymbol | undefined {
  let result: AblaSymbol | undefined;
  for (const symbol of symbols) {
    if (
      symbol.range.start <= range.start &&
      range.end <= symbol.range.end &&
      symbol.range.start !== range.start
    ) {
      if (result === undefined || symbol.range.start >= result.range.start) {
        result = symbol;
      }
    }
  }
  return result;
}

export class SyntaxAnalyzer implements Analyzer {
  analyze(uri: string, version: number, text: string): DocumentAnalysis {
    const result = scan(text);
    const symbols: AblaSymbol[] = [];
    for (let index = 0; index < result.tokens.length; index += 1) {
      const keyword = result.tokens[index];
      if (
        keyword === undefined ||
        keyword.kind !== "identifier" ||
        !declarationKinds.has(keyword.text)
      ) {
        continue;
      }
      if (keyword.depth > 1 || keyword.groupDepth !== 0) continue;
      const named = declarationName(result.tokens, index);
      if (named === undefined) continue;
      const kind = declarationKinds.get(keyword.text);
      if (kind === undefined) continue;
      const range = {
        start: keyword.start,
        end: declarationEnd(text, result.tokens, result.matchingBraces, index),
      };
      const container = containingSymbol(symbols, range);
      const id = `syntax:${uri}:${named.token.start}:${named.token.text}`;
      symbols.push({
        id,
        name: named.token.text,
        kind,
        uri,
        range,
        selectionRange: { start: named.token.start, end: named.token.end },
        detail: named.detail,
        topLevel: keyword.depth === 0,
        ...(container === undefined ? {} : { containerId: container.id }),
      });
    }

    const declarations = new Map<number, string>();
    for (const symbol of symbols) {
      declarations.set(symbol.selectionRange.start, symbol.id);
    }
    const occurrences: AblaOccurrence[] = result.tokens
      .filter((token) => token.kind === "identifier")
      .map((token) => {
        const declarationId = declarations.get(token.start);
        return {
          name: token.text,
          range: { start: token.start, end: token.end },
          ...(declarationId === undefined ? {} : { declarationId }),
        };
      });

    return {
      authority: "syntax",
      uri,
      version,
      text,
      symbols,
      occurrences,
      diagnostics: result.diagnostics,
    };
  }
}

export function identifierAt(
  analysis: DocumentAnalysis,
  offset: number,
): AblaOccurrence | undefined {
  return analysis.occurrences.find(
    (occurrence) => occurrence.range.start <= offset && offset < occurrence.range.end,
  );
}
