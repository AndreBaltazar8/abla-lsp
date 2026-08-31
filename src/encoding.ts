import type { CompilerWorkspaceSnapshot } from "./compiler-protocol.js";
import type { OffsetRange } from "./model.js";

/** Converts compiler-owned UTF-8 byte offsets into JavaScript/LSP UTF-16 offsets. */
export class Utf8OffsetMap {
  readonly #offsets: readonly number[];

  constructor(text: string) {
    const byteLength = Buffer.byteLength(text, "utf8");
    const offsets = new Array<number>(byteLength + 1).fill(0);
    let byteOffset = 0;
    let utf16Offset = 0;
    offsets[0] = 0;
    for (const scalar of text) {
      const bytes = Buffer.byteLength(scalar, "utf8");
      for (let byte = 1; byte < bytes; byte += 1) {
        offsets[byteOffset + byte] = utf16Offset;
      }
      byteOffset += bytes;
      utf16Offset += scalar.length;
      offsets[byteOffset] = utf16Offset;
    }
    this.#offsets = offsets;
  }

  offset(byteOffset: number): number {
    if (!Number.isInteger(byteOffset) || byteOffset <= 0) return 0;
    return this.#offsets[Math.min(byteOffset, this.#offsets.length - 1)] ?? 0;
  }

  range(range: OffsetRange): OffsetRange {
    return { start: this.offset(range.start), end: this.offset(range.end) };
  }
}

export function normalizeCompilerSnapshot(
  snapshot: CompilerWorkspaceSnapshot,
): CompilerWorkspaceSnapshot {
  return {
    revision: snapshot.revision,
    documents: snapshot.documents.map((document) => {
      const offsets = new Utf8OffsetMap(document.text);
      return {
        ...document,
        symbols: document.symbols.map((symbol) => ({
          ...symbol,
          range: offsets.range(symbol.range),
          selectionRange: offsets.range(symbol.selectionRange),
        })),
        occurrences: document.occurrences.map((occurrence) => ({
          ...occurrence,
          range: offsets.range(occurrence.range),
        })),
        diagnostics: document.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          range: offsets.range(diagnostic.range),
        })),
      };
    }),
  };
}
