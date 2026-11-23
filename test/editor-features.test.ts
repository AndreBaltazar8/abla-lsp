import assert from "node:assert/strict";
import test from "node:test";
import {
  callContext,
  callArgumentOffsets,
  foldingRanges,
  formatDocument,
  importRenameEdits,
  inferredTypeHints,
  namedArgumentIndex,
  organizeImports,
  signatureMarkdown,
  symbolSignature,
} from "../src/editor-features.js";
import type { AblaSymbol, DocumentAnalysis } from "../src/model.js";

test("signature context tracks nested calls and active arguments", () => {
  const text = "render(title, format(value, 2), ";
  assert.deepEqual(callContext(text, text.length), {
    name: "render",
    nameOffset: 0,
    activeParameter: 2,
  });
  assert.deepEqual(callContext(text, text.indexOf("value") + 2), {
    name: "format",
    nameOffset: text.indexOf("format"),
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

test("signature context ignores commas and parentheses in strings, comments and nested collections", () => {
  for (const [text, activeParameter] of [
    ['render("comma, (", [1, 2], ', 2],
    ['render("escaped \\\" ,", /* outer /* , */ ( */ value, ', 2],
    ['render(value, // ignored (,\n ', 1],
    ['render({ val pair = [1, 2] }, ', 1],
  ] as const) {
    assert.deepEqual(callContext(text, text.length), {
      name: "render", nameOffset: 0, activeParameter,
    }, text);
  }
  assert.equal(callContext('render("done")', 14), undefined);
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
  const exact = 'fun render(\n    label: string = "```"\n): string';
  assert.equal(symbolSignature(analysis, { ...symbol, signature: exact }), exact);
  assert.equal(signatureMarkdown(exact), '````abla\n'+exact+'\n````');
});

test("type hints: an unannotated local, loop variable or lambda parameter gets the type of its first typed use", () => {
  const text = "fun main {\n val n = 3\n val s: string = \"x\"\n for (i in 0 until n) { n + i }\n val f = { a -> a }\n}";
  const at = (needle: string, skip = 0): { start: number; end: number } => {
    const start = text.indexOf(needle) + skip;
    return { start, end: start + 1 };
  };
  const symbol = (id: string, name: string, detail: string, range: { start: number; end: number }): AblaSymbol => ({
    id, name, detail, kind: detail === "lambda.parameter" ? "parameter" : "value", uri: "file:///t.ab", range, selectionRange: range, topLevel: false,
  });
  const analysis: DocumentAnalysis = {
    authority: "compiler", uri: "file:///t.ab", version: 1, text, diagnostics: [],
    symbols: [
      symbol("n", "n", "local.val", at("val n", 4)),
      symbol("s", "s", "local.val", at("val s", 4)),
      symbol("i", "i", "for", at("(i in", 1)),
      symbol("a", "a", "lambda.parameter", at("{ a ->", 2)),
      symbol("f", "f", "local.val", at("val f", 4)),
    ],
    occurrences: [
      { name: "n", range: at("until n", 6), declarationId: "n" },
      { name: "n", range: at("n + i", 0), declarationId: "n", type: "i64" },
      { name: "i", range: at("+ i", 2), declarationId: "i", type: "i64" },
      { name: "a", range: at("a }", 0), declarationId: "a", type: "string" },
      { name: "s", range: at("s:", 0), declarationId: "s", type: "string" },
    ],
  };
  const hints = inferredTypeHints(analysis, 0, text.length);
  assert.deepEqual(hints.map((hint) => [text.slice(0, hint.offset).split("\n").pop(), hint.label]), [
    [" val n", ": i64"],
    [" for (i", ": i64"],
    [" val f = { a", ": string"],
  ]);
  assert.deepEqual(inferredTypeHints(analysis, 0, 5), []);
});

test("signature help follows a named argument to its parameter", () => {
  const labels = ["name: string", "count: int", "verbose: bool"];
  const text = 'render("a", verbose = true, count: 2)';
  const end = text.indexOf("(");
  assert.equal(namedArgumentIndex(text, end, text.indexOf("true"), labels), 2);
  assert.equal(namedArgumentIndex(text, end, text.indexOf("2"), labels), 1);
  assert.equal(namedArgumentIndex(text, end, text.indexOf('"a"') + 2, labels), undefined);
  assert.equal(namedArgumentIndex('render(x == 1', 6, 13, labels), undefined);
  assert.equal(namedArgumentIndex("render(other = 1", 6, 16, labels), undefined);
});

test("renaming a file rewrites the imports of its importers and its own relative imports", () => {
  const importer = { uri: "file:///p/main.ab", text: 'import "lib.ab"\nimport "util/helper.ab" as h\nimport "abla/json"\nfun main {}\n' };
  const lib = { uri: "file:///p/lib.ab", text: 'import "util/helper.ab"\n' };
  const edits = importRenameEdits([importer, lib], [{ oldUri: "file:///p/lib.ab", newUri: "file:///p/core/lib2.ab" }]);
  assert.deepEqual(edits.get(importer.uri)?.map((edit) => edit.newText), ["core/lib2.ab"]);
  assert.deepEqual(edits.get(lib.uri)?.map((edit) => edit.newText), ["../util/helper.ab"], "a moved file's own relative imports keep their targets");
  // A folder rename moves everything under it.
  const folder = importRenameEdits([importer], [{ oldUri: "file:///p/util", newUri: "file:///p/tools" }]);
  assert.deepEqual(folder.get(importer.uri)?.map((edit) => edit.newText), ["tools/helper.ab"]);
  // Nothing to change: no edits.
  assert.equal(importRenameEdits([importer], [{ oldUri: "file:///p/other.ab", newUri: "file:///p/other2.ab" }]).size, 0);
});
