import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceIndex } from "../src/index.js";
import { PositionMap } from "../src/positions.js";
import { SyntaxAnalyzer } from "../src/source.js";

test("syntax analysis publishes top-level and member symbols", () => {
  const source = `import "abla/http"

fun greet(name: string): string = "hello $name"

class Greeter(val prefix: string) {
    fun message(name: string): string = "$prefix $name"
}
`;
  const analysis = new SyntaxAnalyzer().analyze("file:///workspace/main.ab", 4, source);
  assert.equal(analysis.authority, "syntax");
  assert.deepEqual(
    analysis.symbols.map((symbol) => [symbol.kind, symbol.name, symbol.topLevel]),
    [
      ["function", "greet", true],
      ["class", "Greeter", true],
      ["function", "message", false],
    ],
  );
  assert.equal(analysis.diagnostics.length, 0);
});

test("syntax diagnostics identify malformed lexical structure", () => {
  const source = `fun broken(): string {\n    "unterminated\n`;
  const analysis = new SyntaxAnalyzer().analyze("file:///broken.ab", 1, source);
  assert.deepEqual(
    analysis.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    ["E_UNCLOSED_BRACE", "E_UNTERMINATED_STRING"],
  );
});

test("positions use LSP UTF-16 code units", () => {
  const positions = new PositionMap("a😀b\nnext");
  assert.deepEqual(positions.position(3), { line: 0, character: 3 });
  assert.equal(positions.offset({ line: 1, character: 2 }), 7);
});

test("workspace rename changes a unique symbol across documents", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  const declaration = "fun greet(): int = 42\n";
  const call = "fun main: int = greet()\n";
  index.upsert("file:///workspace/greet.ab", 1, declaration);
  index.upsert("file:///workspace/main.ab", 1, call);
  const position = new PositionMap(call).position(call.indexOf("greet") + 1);
  const result = index.rename({
    uri: "file:///workspace/main.ab",
    position,
    newName: "welcome",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.edit.changes?.["file:///workspace/greet.ab"]?.length, 1);
  assert.equal(result.edit.changes?.["file:///workspace/main.ab"]?.length, 1);
  assert.equal(
    result.edit.changes?.["file:///workspace/main.ab"]?.[0]?.newText,
    "welcome",
  );
});

test("syntax-only rename refuses ambiguous declarations", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  index.upsert("file:///workspace/one.ab", 1, "fun same(): int = 1\n");
  index.upsert("file:///workspace/two.ab", 1, "fun same(): int = 2\n");
  const result = index.rename({
    uri: "file:///workspace/one.ab",
    position: { line: 0, character: 5 },
    newName: "different",
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "syntax-only analysis cannot prove that this symbol is unambiguous",
  });
});

test("compiler references use canonical ids even when names collide", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  index.upsertAnalysis({
    authority: "compiler",
    uri: "file:///workspace/one.ab",
    version: 1,
    text: "fun run: int = 1\n",
    symbols: [{
      id: "abla:one:run",
      name: "run",
      kind: "function",
      uri: "file:///workspace/one.ab",
      range: { start: 0, end: 16 },
      selectionRange: { start: 4, end: 7 },
      detail: "fun int",
      topLevel: true,
    }],
    occurrences: [
      { name: "run", range: { start: 4, end: 7 }, declarationId: "abla:one:run" },
    ],
    diagnostics: [],
  });
  index.upsertAnalysis({
    authority: "compiler",
    uri: "file:///workspace/two.ab",
    version: 1,
    text: "fun run: int = 2\n",
    symbols: [{
      id: "abla:two:run",
      name: "run",
      kind: "function",
      uri: "file:///workspace/two.ab",
      range: { start: 0, end: 16 },
      selectionRange: { start: 4, end: 7 },
      detail: "fun int",
      topLevel: true,
    }],
    occurrences: [
      { name: "run", range: { start: 4, end: 7 }, declarationId: "abla:two:run" },
    ],
    diagnostics: [],
  });
  const caller = "fun main: int = run()\n";
  index.upsertAnalysis({
    authority: "compiler",
    uri: "file:///workspace/main.ab",
    version: 1,
    text: caller,
    symbols: [],
    occurrences: [
      { name: "run", range: { start: 16, end: 19 }, declarationId: "abla:one:run" },
    ],
    diagnostics: [],
  });

  const result = index.rename({
    uri: "file:///workspace/main.ab",
    position: { line: 0, character: 17 },
    newName: "execute",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.edit.changes?.["file:///workspace/one.ab"]?.length, 1);
  assert.equal(result.edit.changes?.["file:///workspace/main.ab"]?.length, 1);
  assert.equal(result.edit.changes?.["file:///workspace/two.ab"], undefined);
});

test("compiler rename refuses incomplete reference coverage", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  index.upsertAnalysis({
    authority: "compiler",
    uri: "file:///workspace/main.ab",
    version: 1,
    text: "fun run: int = 1\nval callback = run\n",
    symbols: [{
      id: "abla:run",
      name: "run",
      kind: "function",
      uri: "file:///workspace/main.ab",
      range: { start: 0, end: 16 },
      selectionRange: { start: 4, end: 7 },
      detail: "fun int",
      topLevel: true,
    }],
    occurrences: [
      { name: "run", range: { start: 4, end: 7 }, declarationId: "abla:run" },
      { name: "run", range: { start: 32, end: 35 } },
    ],
    diagnostics: [],
  });
  const result = index.rename({
    uri: "file:///workspace/main.ab",
    position: { line: 0, character: 5 },
    newName: "execute",
  });
  assert.equal(result.ok, false);
});
