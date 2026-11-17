import assert from "node:assert/strict";
import test from "node:test";
import {
  callContext,
  callArgumentOffsets,
  foldingRanges,
  formatDocument,
  organizeImports,
  symbolSignature,
} from "../src/editor-features.js";
import type { AblaSymbol, DocumentAnalysis } from "../src/model.js";

test("signature context tracks nested calls and active arguments", () => {
  const text = "render(title, format(value, 2), ";
  assert.deepEqual(callContext(text, text.length), {
    name: "render",
    activeParameter: 2,
  });
  assert.deepEqual(callContext(text, text.indexOf("value") + 2), {
    name: "format",
    activeParameter: 0,
  });
});

test("call arguments retain top-level offsets through nested syntax", () => {
  const text = 'render(title, format(value, 2), { "comma, text" }, final)';
  assert.deepEqual(
    callArgumentOffsets(text, "render".length),
    [
      text.indexOf("title"),
      text.indexOf("format"),
      text.indexOf("{"),
      text.indexOf("final"),
    ],
  );
  assert.deepEqual(callArgumentOffsets("empty()", 5), []);
});

test("folding follows code braces without treating strings as blocks", () => {
  const text = [
    "fun main: int {",
    "    val display = \"{not a block}\"",
    "    if (true) {",
    "        1",
    "    }",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(foldingRanges(text), [
    { startLine: 0, endLine: 5 },
    { startLine: 2, endLine: 4 },
  ]);
});

test("safe formatting trims line endings and supplies one final newline", () => {
  const edits = formatDocument("fun main: int = 0   \n\n");
  assert.equal(edits.length, 1);
  assert.equal(edits[0]?.newText, "fun main: int = 0\n");
  assert.deepEqual(formatDocument("fun main: int = 0\n"), []);
});

test("import organization sorts and deduplicates the leading import block", () => {
  const text = 'import "z.ab"\nimport "a.ab"\nimport "z.ab"\n\nfun main: int = 0\n';
  const edit = organizeImports(text);
  assert.equal(edit?.newText, 'import "a.ab"\nimport "z.ab"');
});

test("a signature leaves out the comments inside the declaration, and not a string that looks like one", () => {
  const text = [
    "class Map<K, V>(",
    "    /** The number of entries. */",
    "    val size: int, // how many",
    "    val label: string = \"a // b /* c */\"",
    ") {",
    "    fun get(key: K): V?",
    "}",
  ].join("\n");
  const analysis = { uri: "file:///x.ab", text, version: 1, authority: "compiler", symbols: [], occurrences: [], diagnostics: [] } as unknown as DocumentAnalysis;
  const symbol = { id: "m", name: "Map", kind: "class", uri: "file:///x.ab", range: { start: 0, end: text.length }, selectionRange: { start: 6, end: 9 }, detail: "class", topLevel: true } as AblaSymbol;
  assert.equal(symbolSignature(analysis, symbol), 'class Map<K, V>( val size: int, val label: string = "a // b /* c */" )');
});
