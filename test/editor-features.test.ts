import assert from "node:assert/strict";
import test from "node:test";
import { callContext, foldingRanges, formatDocument } from "../src/editor-features.js";

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
