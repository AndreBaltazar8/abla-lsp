import type { AblaSymbol, DocumentAnalysis, OffsetRange } from "./model.js";

/**
 * Supertypes written in a class or interface header (`class Square(val side: int) : Shape, Printable {`): the
 * region after the header's colon, past the type parameters and the constructor's parentheses. The compiler's
 * occurrences inside it name the supertypes.
 */
export function supertypeRegion(text: string, symbol: AblaSymbol): OffsetRange | undefined {
  let at = symbol.selectionRange.end;
  const skip = (open: string, close: string): boolean => {
    if (text[at] !== open) return true;
    let depth = 0;
    while (at < text.length) {
      const character = text[at];
      if (character === open) depth += 1;
      else if (character === close) { depth -= 1; if (depth === 0) { at += 1; return true; } }
      at += 1;
    }
    return false;
  };
  const blanks = (): void => { while (at < text.length && /[ \t]/u.test(text[at] ?? "")) at += 1; };
  blanks();
  if (!skip("<", ">")) return undefined;
  blanks();
  if (!skip("(", ")")) return undefined;
  blanks();
  if (text[at] !== ":") return undefined;
  at += 1;
  const start = at;
  while (at < text.length && text[at] !== "{" && text[at] !== "\n") at += 1;
  return { start, end: at };
}

/** The declaration ids of a class or interface's supertypes. */
export function supertypeIds(analysis: DocumentAnalysis, symbol: AblaSymbol): string[] {
  const region = supertypeRegion(analysis.text, symbol);
  if (region === undefined) return [];
  const ids: string[] = [];
  for (const occurrence of analysis.occurrences) {
    if (occurrence.declarationId !== undefined && occurrence.range.start >= region.start && occurrence.range.end <= region.end && !ids.includes(occurrence.declarationId)) {
      ids.push(occurrence.declarationId);
    }
  }
  return ids;
}

/** Every class or interface whose header names `id` as a supertype. */
export function subtypesOf(analyses: readonly DocumentAnalysis[], id: string): AblaSymbol[] {
  const found: AblaSymbol[] = [];
  for (const analysis of analyses) {
    for (const symbol of analysis.symbols) {
      if ((symbol.kind === "class" || symbol.kind === "interface") && supertypeIds(analysis, symbol).includes(id)) found.push(symbol);
    }
  }
  return found;
}

/** The methods that implement `method` (a member of an interface or class) in the subtypes of its owner. */
export function implementationsOf(analyses: readonly DocumentAnalysis[], method: AblaSymbol): AblaSymbol[] {
  if (method.containerId === undefined) return [];
  const owners = subtypesOf(analyses, method.containerId);
  const found: AblaSymbol[] = [];
  for (const owner of owners) {
    for (const analysis of analyses) {
      for (const symbol of analysis.symbols) {
        if (symbol.containerId === owner.id && symbol.kind === "function" && symbol.name === method.name) found.push(symbol);
      }
    }
    // A subtype of a subtype overrides it too.
    found.push(...implementationsOf(analyses, { ...method, containerId: owner.id }));
  }
  return found;
}
