import type { Position, Range } from "vscode-languageserver/node";
import type { OffsetRange } from "./model.js";

export class PositionMap {
  readonly #text: string;
  readonly #lineOffsets: readonly number[];

  constructor(text: string) {
    this.#text = text;
    const offsets = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") offsets.push(index + 1);
    }
    this.#lineOffsets = offsets;
  }

  position(offset: number): Position {
    const bounded = Math.max(0, Math.min(offset, this.#text.length));
    let low = 0;
    let high = this.#lineOffsets.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      const lineOffset = this.#lineOffsets[middle];
      if (lineOffset !== undefined && lineOffset <= bounded) low = middle;
      else high = middle;
    }
    const lineOffset = this.#lineOffsets[low] ?? 0;
    return { line: low, character: bounded - lineOffset };
  }

  offset(position: Position): number {
    const line = Math.max(0, Math.min(position.line, this.#lineOffsets.length - 1));
    const begin = this.#lineOffsets[line] ?? 0;
    const end = this.#lineOffsets[line + 1] ?? this.#text.length;
    return Math.max(begin, Math.min(begin + position.character, end));
  }

  range(range: OffsetRange): Range {
    return { start: this.position(range.start), end: this.position(range.end) };
  }
}
