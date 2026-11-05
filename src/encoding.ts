import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CompilerWorkspaceSnapshot, CompilerWireSnapshot, CompilerPendingDiagnostic } from "./compiler-protocol.js";
import type { OffsetRange } from "./model.js";

/** Converts compiler-owned UTF-8 byte offsets into JavaScript/LSP UTF-16 offsets. */
export class Utf8OffsetMap {
  readonly #offsets: readonly number[];
  readonly #bytes: readonly number[];

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
    const reverse = new Array<number>(text.length + 1).fill(0);
    for (let byte = 0; byte < offsets.length; byte += 1) {
      const utf16 = offsets[byte];
      if (utf16 !== undefined && (byte === 0 || offsets[byte - 1] !== utf16)) reverse[utf16] = byte;
    }
    // Interior UTF-16 surrogate positions map to the scalar's first byte.
    for (let pos = 1; pos < text.length; pos += 1) {
      if (text.charCodeAt(pos - 1) >= 0xd800 && text.charCodeAt(pos - 1) <= 0xdbff &&
          text.charCodeAt(pos) >= 0xdc00 && text.charCodeAt(pos) <= 0xdfff) reverse[pos] = reverse[pos - 1] ?? 0;
    }
    this.#bytes = reverse;
  }

  offset(byteOffset: number): number {
    if (!Number.isInteger(byteOffset) || byteOffset <= 0) return 0;
    return this.#offsets[Math.min(byteOffset, this.#offsets.length - 1)] ?? 0;
  }

  byteOffset(utf16Offset: number): number {
    if (!Number.isInteger(utf16Offset) || utf16Offset <= 0) return 0;
    return this.#bytes[Math.min(utf16Offset, this.#bytes.length - 1)] ?? 0;
  }

  range(range: OffsetRange): OffsetRange {
    return { start: this.offset(range.start), end: this.offset(range.end) };
  }
}

export function normalizeCompilerSnapshot(
  snapshot: CompilerWireSnapshot,
  sourceMaps?: ReadonlyMap<string, Utf8OffsetMap>,
): CompilerWorkspaceSnapshot {
  const maps = sourceMaps ?? new Map(snapshot.documents.map((document) => [compilerUriKey(document.uri), new Utf8OffsetMap(document.text)]));
  return {
    ...snapshot,
    ...(snapshot.pending === undefined ? {} : { pending: normalizePending(snapshot.pending, maps) }),
    revision: snapshot.revision,
    documents: snapshot.documents.map((document) => {
      const offsets = maps.get(compilerUriKey(document.uri)) ?? new Utf8OffsetMap(document.text);
      return {
        ...document,
        ...(document.occurrences === undefined ? { occurrencesAvailable: false } : {}),
        ...(document.symbols === undefined ? { symbolsAvailable: false } : {}),
        ...(document.diagnostics === undefined ? { diagnosticsAvailable: false } : {}),
        symbols: (document.symbols ?? []).map((symbol) => ({
          ...symbol,
          range: offsets.range(symbol.range),
          selectionRange: offsets.range(symbol.selectionRange),
        })),
        occurrences: (document.occurrences ?? []).map((occurrence) => ({
          ...occurrence,
          range: offsets.range(occurrence.range),
        })),
        diagnostics: (document.diagnostics ?? []).map((diagnostic) => ({
          ...diagnostic,
          range: offsets.range(diagnostic.range),
        })),
      };
    }),
  };
}

export function normalizePending(
  pending: readonly CompilerPendingDiagnostic[], maps: ReadonlyMap<string, Utf8OffsetMap>,
): readonly CompilerPendingDiagnostic[] {
  return pending.map((site) => {
    const map = maps.get(compilerUriKey(site.uri));
    if (map === undefined) throw new Error(`compiler pending span has no source: ${site.uri}`);
    return { ...site, range: map.range(site.range) };
  });
}

/** Lexical file identity only; never follow filesystem symlinks. */
export function compilerUriKey(uri: string): string {
  try { return uri.startsWith("file:") ? path.resolve(fileURLToPath(uri)) : uri; }
  catch { return uri; }
}
