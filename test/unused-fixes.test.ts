import assert from "node:assert/strict";
import test from "node:test";
import { removeUnusedDeclaration, removeUnusedLocal, withPreview } from "../src/unused-fixes.js";

function apply(text: string, removal: { start: number; end: number; newText: string } | undefined): string {
  assert.ok(removal !== undefined);
  return text.slice(0, removal.start) + removal.newText + text.slice(removal.end);
}

test("an unused local with a plain initializer loses its whole line", () => {
  const text = "fun f(a: int): int {\n    val dead = a + 1\n    a\n}\n";
  const at = text.indexOf("dead");
  assert.equal(apply(text, removeUnusedLocal(text, at, "dead")), "fun f(a: int): int {\n    a\n}\n");
  const typed = "fun f(): int {\n    var n: int = 0\n    1\n}\n";
  assert.equal(apply(typed, removeUnusedLocal(typed, typed.indexOf("n:"), "n")), "fun f(): int {\n    1\n}\n");
});

test("an unused local whose initializer calls something keeps the call", () => {
  const text = "fun f(): int {\n    val side = compute(1, 2)\n    1\n}\n";
  const removal = removeUnusedLocal(text, text.indexOf("side"), "side");
  assert.equal(apply(text, removal), "fun f(): int {\n    compute(1, 2)\n    1\n}\n");
  assert.match(removal?.title ?? "", /keep its initializer/u);
});

test("a local that is not a one-line val or var statement gets no removal", () => {
  const text = "fun f(): int {\n    val parts = [\n        1,\n    ]\n    for (item in parts) 1\n    1\n}\n";
  assert.equal(removeUnusedLocal(text, text.indexOf("parts"), "parts"), undefined);
  const loop = "fun f(): int {\n    for (item in [1]) 2\n    1\n}\n";
  assert.equal(removeUnusedLocal(loop, loop.indexOf("item"), "item"), undefined);
});

test("an unused declaration goes with its comment and one blank line", () => {
  const text = "fun keep(): int = 1\n\n/** Never called. */\nfun gone(x: int): int = x + 1\n\nfun main: int = keep()\n";
  const start = text.indexOf("fun gone");
  const end = text.indexOf("\n", start);
  assert.equal(apply(text, removeUnusedDeclaration(text, start, end, "gone")), "fun keep(): int = 1\n\nfun main: int = keep()\n");
  const methods = "class Box(val a: int) {\n    fun get(): int = a\n    // an old helper\n    fun gone(): int = 3\n}\n";
  const methodStart = methods.indexOf("fun gone");
  assert.equal(apply(methods, removeUnusedDeclaration(methods, methodStart, methods.indexOf("\n", methodStart), "gone")), "class Box(val a: int) {\n    fun get(): int = a\n}\n");
});

test("a declaration sharing its line with other code is left alone", () => {
  const text = "fun a(): int = 1; fun b(): int = 2\n";
  assert.equal(removeUnusedDeclaration(text, text.indexOf("fun b"), text.length - 1, "b"), undefined);
});

test("withPreview marks every edit with one annotation that needs confirmation", () => {
  const edit = withPreview({ changes: { "file:///a.ab": [{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: "" }] } }, "Delete");
  const annotation = Object.entries(edit.changeAnnotations ?? {});
  assert.equal(annotation.length, 1);
  assert.equal(annotation[0]?.[1].needsConfirmation, true);
  const change = edit.documentChanges?.[0];
  assert.ok(change !== undefined && "textDocument" in change);
  assert.ok("textDocument" in change && change.edits.every((item) => "annotationId" in item && item.annotationId === annotation[0]?.[0]));
});
