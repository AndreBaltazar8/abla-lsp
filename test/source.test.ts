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

test("unrelated unresolved names do not block a canonical rename", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  const declarationUri = "file:///workspace/project/one.ab";
  index.upsertAnalysis({
    authority: "compiler",
    uri: declarationUri,
    version: 1,
    text: "fun run: int = 1\n",
    symbols: [{
      id: "abla:project:run",
      name: "run",
      kind: "function",
      uri: declarationUri,
      range: { start: 0, end: 16 },
      selectionRange: { start: 4, end: 7 },
      detail: "fun int",
      topLevel: true,
    }],
    occurrences: [{
      name: "run",
      range: { start: 4, end: 7 },
      declarationId: "abla:project:run",
    }],
    diagnostics: [],
  });
  index.upsertAnalysis({
    authority: "compiler",
    uri: "file:///workspace/unrelated/example.ab",
    version: 1,
    text: "val callback = run\n",
    symbols: [],
    occurrences: [{ name: "run", range: { start: 15, end: 18 } }],
    diagnostics: [],
  });
  const result = index.rename({
    uri: declarationUri,
    position: { line: 0, character: 5 },
    newName: "execute",
  });
  assert.equal(result.ok, true);
});

test("bulk rename supports atomic symbol swaps", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  const text = "fun alpha: int = beta()\nfun beta: int = 1\n";
  const uri = "file:///workspace/swap.ab";
  index.upsert(uri, 1, text);
  const result = index.bulkRename([
    { uri, position: { line: 0, character: 5 }, newName: "beta" },
    { uri, position: { line: 1, character: 5 }, newName: "alpha" },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edits = result.edit.changes?.[uri] ?? [];
  assert.equal(edits.length, 3);
  assert.deepEqual(new Set(edits.map((edit) => edit.newText)), new Set(["alpha", "beta"]));
});

test("multi-declaration move preserves attached comments and requested order", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  const sourceUri = "file:///workspace/source.ab";
  const targetUri = "file:///workspace/target.ab";
  const source = "// Alpha docs\nfun alpha: int = 1\n\nfun beta: int = 2\n\nfun caller: int = alpha()\n";
  const syntax = new SyntaxAnalyzer().analyze(sourceUri, 1, source);
  const alpha = syntax.symbols.find((symbol) => symbol.name === "alpha");
  index.upsertAnalysis({
    ...syntax,
    authority: "compiler",
    occurrences: syntax.occurrences.map((occurrence) =>
      occurrence.name === "alpha" && alpha !== undefined
        ? { ...occurrence, declarationId: alpha.id }
        : occurrence,
    ),
  });
  const targetSyntax = new SyntaxAnalyzer().analyze(targetUri, 1, "fun existing: int = 0\n");
  index.upsertAnalysis({ ...targetSyntax, authority: "compiler" });
  const beta = syntax.symbols.find((symbol) => symbol.name === "beta");
  assert.notEqual(alpha, undefined);
  assert.notEqual(beta, undefined);
  const result = index.moveDeclarations({
    symbolIds: [beta?.id ?? "", alpha?.id ?? ""],
    targetUri,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.edit.changes?.[sourceUri]?.length, 2);
  assert.ok(
    result.edit.changes?.[sourceUri]?.some(
      (edit) => edit.newText === 'import "target.ab"\n',
    ),
  );
  const insertion = result.edit.changes?.[targetUri]?.[0]?.newText ?? "";
  assert.ok(insertion.indexOf("fun beta") < insertion.indexOf("// Alpha docs"));
  assert.match(insertion, /\/\/ Alpha docs\nfun alpha/);
});

test("declaration move creates and populates a new target atomically", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  const sourceUri = "file:///workspace/source.ab";
  const targetUri = "file:///workspace/new-target.ab";
  const source = "fun alpha: int = 1\nfun caller: int = alpha()\n";
  const syntax = new SyntaxAnalyzer().analyze(sourceUri, 1, source);
  const alpha = syntax.symbols.find((symbol) => symbol.name === "alpha");
  index.upsertAnalysis({
    ...syntax,
    authority: "compiler",
    occurrences: syntax.occurrences.map((occurrence) =>
      occurrence.name === "alpha" && alpha !== undefined
        ? { ...occurrence, declarationId: alpha.id }
        : occurrence,
    ),
  });

  const result = index.moveDeclarations({
    symbolIds: [alpha?.id ?? ""],
    targetUri,
    createTarget: true,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.edit.documentChanges?.[0], { kind: "create", uri: targetUri });
  const edits = result.edit.documentChanges?.filter(
    (change) => "textDocument" in change,
  ) ?? [];
  const sourceEdit = edits.find((change) => change.textDocument.uri === sourceUri);
  const targetEdit = edits.find((change) => change.textDocument.uri === targetUri);
  assert.ok(sourceEdit?.edits.some(
    (edit) => "newText" in edit && edit.newText === 'import "new-target.ab"\n',
  ));
  const targetText = targetEdit?.edits[0];
  assert.match(targetText !== undefined && "newText" in targetText ? targetText.newText : "", /fun alpha: int = 1/);
});

test("declaration move does not overwrite an existing target", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  const sourceUri = "file:///workspace/source.ab";
  const targetUri = "file:///workspace/target.ab";
  const source = new SyntaxAnalyzer().analyze(sourceUri, 1, "fun alpha: int = 1\n");
  const target = new SyntaxAnalyzer().analyze(targetUri, 1, "fun existing: int = 0\n");
  index.upsertAnalysis({ ...source, authority: "compiler" });
  index.upsertAnalysis({ ...target, authority: "compiler" });
  const result = index.moveDeclarations({
    symbolIds: [source.symbols[0]?.id ?? ""],
    targetUri,
    createTarget: true,
  });
  assert.deepEqual(result, { ok: false, reason: "the requested target file already exists" });
});

test("declaration move rejects a newly introduced import cycle", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  const sourceUri = "file:///workspace/source.ab";
  const targetUri = "file:///workspace/target.ab";
  const source = [
    "fun helper: int = 1",
    "fun alpha: int = helper()",
    "fun caller: int = alpha()",
    "",
  ].join("\n");
  const syntax = new SyntaxAnalyzer().analyze(sourceUri, 1, source);
  const helper = syntax.symbols.find((symbol) => symbol.name === "helper");
  const alpha = syntax.symbols.find((symbol) => symbol.name === "alpha");
  index.upsertAnalysis({
    ...syntax,
    authority: "compiler",
    occurrences: syntax.occurrences.map((occurrence) => {
      if (occurrence.name === "helper" && helper !== undefined) {
        return { ...occurrence, declarationId: helper.id };
      }
      if (occurrence.name === "alpha" && alpha !== undefined) {
        return { ...occurrence, declarationId: alpha.id };
      }
      return occurrence;
    }),
  });
  const target = new SyntaxAnalyzer().analyze(targetUri, 1, "fun existing: int = 0\n");
  index.upsertAnalysis({ ...target, authority: "compiler" });
  const result = index.moveDeclarations({
    symbolIds: [alpha?.id ?? ""],
    targetUri,
  });
  assert.deepEqual(result, { ok: false, reason: "move would introduce an import cycle" });
});

test("declaration move merges imports after a preserved file header", () => {
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  const sourceUri = "file:///workspace/source.ab";
  const targetUri = "file:///workspace/target.ab";
  const source = "fun helper: int = 1\nfun alpha: int = helper()\n";
  const sourceAnalysis = new SyntaxAnalyzer().analyze(sourceUri, 1, source);
  const helper = sourceAnalysis.symbols.find((symbol) => symbol.name === "helper");
  const alpha = sourceAnalysis.symbols.find((symbol) => symbol.name === "alpha");
  index.upsertAnalysis({
    ...sourceAnalysis,
    authority: "compiler",
    occurrences: sourceAnalysis.occurrences.map((occurrence) =>
      occurrence.name === "helper" && helper !== undefined
        ? { ...occurrence, declarationId: helper.id }
        : occurrence,
    ),
  });
  const target = "// Copyright Abla\n\nimport \"z.ab\"\n\nfun existing: int = 0\n";
  index.upsertAnalysis({
    ...new SyntaxAnalyzer().analyze(targetUri, 1, target),
    authority: "compiler",
  });
  const result = index.moveDeclarations({
    symbolIds: [alpha?.id ?? ""],
    targetUri,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const importEdit = result.edit.changes?.[targetUri]?.find(
    (edit) => edit.newText.includes('import "source.ab"'),
  );
  assert.equal(importEdit?.range.start.line, 2);
  assert.equal(importEdit?.newText, 'import "source.ab"\nimport "z.ab"\n');
});
