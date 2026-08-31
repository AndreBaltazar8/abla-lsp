import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceEdit } from "vscode-languageserver/node";
import { WorkspaceIndex } from "../src/index.js";
import { PositionMap } from "../src/positions.js";
import { AdvancedRefactors } from "../src/refactors.js";
import { SyntaxAnalyzer } from "../src/source.js";

function compilerDocument(index: WorkspaceIndex, uri: string, text: string): void {
  const syntax = new SyntaxAnalyzer().analyze(uri, 1, text);
  const unique = new Map<string, string>();
  for (const symbol of syntax.symbols) {
    if (!unique.has(symbol.name)) unique.set(symbol.name, symbol.id);
    else unique.set(symbol.name, "");
  }
  index.upsertAnalysis({
    ...syntax,
    authority: "compiler",
    occurrences: syntax.occurrences.map((occurrence) => {
      const id = unique.get(occurrence.name);
      return id === undefined || id === "" ? occurrence : { ...occurrence, declarationId: id };
    }),
  });
}

function apply(text: string, uri: string, edit: WorkspaceEdit): string {
  const positions = new PositionMap(text);
  return [...(edit.changes?.[uri] ?? [])]
    .map((candidate) => ({
      start: positions.offset(candidate.range.start),
      end: positions.offset(candidate.range.end),
      newText: candidate.newText,
    }))
    .sort((left, right) => right.start - left.start)
    .reduce((current, candidate) =>
      `${current.slice(0, candidate.start)}${candidate.newText}${current.slice(candidate.end)}`, text);
}

test("change signature reorders parameters and rewrites calls", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun add(left: int, right: int): int = left + right\nfun main: int = add(1, 2)\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const symbol = index.symbols().find((candidate) => candidate.name === "add");
  const result = new AdvancedRefactors(index).changeSignature({
    symbolId: symbol?.id ?? "",
    parameters: [
      { name: "right", source: "right" },
      { name: "left", source: "left" },
      { name: "scale", declaration: "scale: int = 1" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.match(output, /fun add\(right: int, left: int, scale: int = 1\)/u);
  assert.match(output, /add\(2, 1, 1\)/u);
});

test("extract function replaces an expression and appends its declaration", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun main: int = 20 + 22\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const positions = new PositionMap(text);
  const start = text.indexOf("20");
  const result = new AdvancedRefactors(index).extractFunction({
    uri,
    range: positions.range({ start, end: start + "20 + 22".length }),
    name: "answer",
    returnType: "int",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.match(output, /fun main: int = answer\(\)/u);
  assert.match(output, /fun answer\(\): int = 20 \+ 22/u);
});

test("function-to-method converts its declaration and every call", () => {
  const uri = "file:///workspace/main.ab";
  const text = "class Point(val x: int)\nfun length(point: Point, scale: int): int = point.x * scale\nfun main: int = length(Point(2), 3)\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const symbol = index.symbols().find((candidate) => candidate.name === "length");
  const result = new AdvancedRefactors(index).functionToMethod({
    symbolId: symbol?.id ?? "",
    receiver: "point",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.match(output, /fun Point\.length\(scale: int\)/u);
  assert.match(output, /Point\(2\)\.length\(3\)/u);
});

test("extension method converts back to a function", () => {
  const uri = "file:///workspace/main.ab";
  const text = "class Point(val x: int)\nfun Point.length(scale: int): int = this.x * scale\nfun main: int = Point(2).length(3)\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const symbol = index.symbols().find((candidate) => candidate.name === "length");
  const result = new AdvancedRefactors(index).methodToFunction({
    symbolId: symbol?.id ?? "",
    receiverName: "point",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.match(output, /fun length\(point: Point, scale: int\)/u);
  assert.match(output, /length\(Point\(2\), 3\)/u);
});

test("class method lifts to a top-level function", () => {
  const uri = "file:///workspace/main.ab";
  const text = "class Point(val x: int) {\n    fun scaled(scale: int): int = this.x * scale\n}\nfun main: int = Point(2).scaled(3)\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const symbol = index.symbols().find((candidate) => candidate.name === "scaled");
  const result = new AdvancedRefactors(index).methodToFunction({
    symbolId: symbol?.id ?? "",
    receiverName: "point",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.match(output, /fun scaled\(point: Point, scale: int\): int = point\.x \* scale/u);
  assert.match(output, /scaled\(Point\(2\), 3\)/u);
});

test("inline function substitutes parameters once and removes the declaration", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun increment(value: int): int = value + 1\nfun main: int = increment(41)\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const symbol = index.symbols().find((candidate) => candidate.name === "increment");
  const result = new AdvancedRefactors(index).inlineSymbol({ symbolId: symbol?.id ?? "" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.doesNotMatch(output, /fun increment/u);
  assert.match(output, /\(\(41\) \+ 1\)/u);
});

test("inline reduces a single-expression block at expression call sites", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun increment(value: int): int {\n    value + 1\n}\nfun main: int = increment(41)\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const symbol = index.symbols().find((candidate) => candidate.name === "increment");
  const result = new AdvancedRefactors(index).inlineSymbol({ symbolId: symbol?.id ?? "" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.doesNotMatch(output, /fun increment/u);
  assert.match(output, /\(\(41\) \+ 1\)/u);
});

test("inline preserves a multi-statement block at standalone calls", () => {
  const uri = "file:///workspace/main.ab";
  const text = [
    "fun consume(value: int): void {",
    "    val copy = value",
    "    print(copy)",
    "}",
    "fun main(): void {",
    "    consume(42)",
    "}",
    "",
  ].join("\n");
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const symbol = index.symbols().find((candidate) => candidate.name === "consume");
  const result = new AdvancedRefactors(index).inlineSymbol({ symbolId: symbol?.id ?? "" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.doesNotMatch(output, /fun consume/u);
  assert.match(output, /fun main\(\): void \{\n    \{\n        val copy = \(42\)\n        print\(copy\)\n    \}\n\}/u);
});

test("introduce local evaluates the selected expression once at its statement", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun main(): int {\n    val result = 20 + 22\n    result\n}\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const start = text.indexOf("20 + 22");
  const result = new AdvancedRefactors(index).introduceBinding({
    uri,
    range: new PositionMap(text).range({ start, end: start + "20 + 22".length }),
    name: "answer",
    destination: "local",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.match(output, /    val answer = 20 \+ 22\n    val result = answer/u);
});

test("introduce constant lifts an uncaptured expression to top level", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun main: int = 20 + 22\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const start = text.indexOf("20 + 22");
  const result = new AdvancedRefactors(index).introduceBinding({
    uri,
    range: new PositionMap(text).range({ start, end: start + "20 + 22".length }),
    name: "answer",
    destination: "topLevel",
    type: "int",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.match(output, /fun main: int = answer/u);
  assert.match(output, /val answer: int = 20 \+ 22/u);
});

test("change binding kind converts a compiler-resolved declaration keyword", () => {
  const uri = "file:///workspace/main.ab";
  const text = "val answer: int = 42\nfun main: int = answer\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const answer = index.symbols().find((symbol) => symbol.name === "answer");
  const result = new AdvancedRefactors(index).changeBindingKind({
    symbolId: answer?.id ?? "",
    kind: "var",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(apply(text, uri, result.edit), /^var answer/u);
});

test("extract interface copies selected method signatures", () => {
  const uri = "file:///workspace/main.ab";
  const text = "class Greeter(val prefix: string) {\n    fun greet(name: string): string = prefix\n    fun count(): int = 1\n}\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const owner = index.symbols().find((candidate) => candidate.name === "Greeter");
  const method = index.symbols().find((candidate) => candidate.name === "greet");
  const result = new AdvancedRefactors(index).extractInterface({
    classSymbolId: owner?.id ?? "",
    methodSymbolIds: [method?.id ?? ""],
    name: "Greeting",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.match(output, /interface Greeting \{\n    fun greet\(name: string\): string/u);
  assert.doesNotMatch(output.slice(output.indexOf("interface Greeting")), /= prefix/u);
});

test("promote local moves its initializer into a default parameter", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun main(): int {\n    val answer: int = 42\n    answer\n}\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  const syntax = new SyntaxAnalyzer().analyze(uri, 1, text);
  const owner = syntax.symbols.find((candidate) => candidate.name === "main");
  assert.notEqual(owner, undefined);
  const begin = text.indexOf("val answer");
  const end = text.indexOf("\n", begin);
  const selection = text.indexOf("answer", begin);
  const local = {
    id: "abla:main:local:answer",
    name: "answer",
    kind: "value" as const,
    uri,
    range: { start: begin, end },
    selectionRange: { start: selection, end: selection + "answer".length },
    detail: "int",
    topLevel: false,
    containerId: owner?.id ?? "",
  };
  index.upsertAnalysis({
    ...syntax,
    authority: "compiler",
    symbols: [...syntax.symbols, local],
    occurrences: syntax.occurrences.map((occurrence) =>
      occurrence.name === "answer" ? { ...occurrence, declarationId: local.id, type: "int" } : occurrence),
  });
  const result = new AdvancedRefactors(index).promoteLocal({
    symbolId: local.id,
    destination: "parameter",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.match(output, /fun main\(answer: int = 42\): int/u);
  assert.doesNotMatch(output, /val answer/u);
});

test("generate declaration creates a compilable function stub from usage", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun main: int = missing(2)\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const result = new AdvancedRefactors(index).generateDeclaration({
    uri,
    position: { line: 0, character: text.indexOf("missing") + 2 },
    resultType: "int",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(apply(text, uri, result.edit), /fun missing\(argument1: int\): int = 0/u);
});

test("ownership repairs and compile-time migration produce bounded edits", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun answer(): int = 42\nfun main: int = answer()\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const engine = new AdvancedRefactors(index);
  const answer = index.symbols().find((candidate) => candidate.name === "answer");
  const migrated = engine.toggleCompileTime({ symbolId: answer?.id ?? "", compileTime: true });
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const output = apply(text, uri, migrated.edit);
  assert.match(output, /compile fun answer/u);
  assert.match(output, /#answer\(\)/u);

  const positions = new PositionMap(text);
  const begin = text.lastIndexOf("answer");
  const repaired = engine.repairOwnership({
    uri,
    range: positions.range({ start: begin, end: begin + "answer()".length }),
    strategy: "move",
  });
  assert.equal(repaired.ok, true);
  if (repaired.ok) assert.match(apply(text, uri, repaired.edit), /move\(answer\(\)\)/u);
});

test("dead-code removal proves absence of external references", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun _unused: int = 1\nfun used: int = 2\nfun main: int = used()\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const result = new AdvancedRefactors(index).removeDeadCode({});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = apply(text, uri, result.edit);
  assert.doesNotMatch(output, /_unused/u);
  assert.match(output, /fun used/u);
});

test("compound recipes deduplicate identical transformations atomically", () => {
  const uri = "file:///workspace/main.ab";
  const text = "fun answer: int = 42\n";
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  compilerDocument(index, uri, text);
  const symbol = index.symbols()[0];
  const engine = new AdvancedRefactors(index);
  const result = engine.recipe([
    { kind: "inline", request: { symbolId: symbol?.id ?? "" } },
    { kind: "removeDeadCode", request: { symbolIds: [symbol?.id ?? ""] } },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.edit.changes?.[uri]?.length, 1);
});
