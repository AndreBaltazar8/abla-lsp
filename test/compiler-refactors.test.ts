import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { CompilerClient } from "../src/compiler-client.js";
import type { CompilerTextEdit } from "../src/compiler-protocol.js";
import { WorkspaceIndex } from "../src/index.js";
import { PositionMap } from "../src/positions.js";
import { AdvancedRefactors } from "../src/refactors.js";
import { applyStagedRecipe } from "../src/staged-refactors.js";
import { SyntaxAnalyzer } from "../src/source.js";
import type { WorkspaceEdit } from "vscode-languageserver/node";

const compiler = process.env.ABLA_COMPILER;

function compilerEdits(index: WorkspaceIndex, edit: WorkspaceEdit): CompilerTextEdit[] {
  return Object.entries(edit.changes ?? {}).flatMap(([editUri, values]) => {
    const analysis = index.document(editUri);
    assert.notEqual(analysis, undefined);
    const positions = new PositionMap(analysis?.text ?? "");
    return values.flatMap((edit) => {
      if (!("newText" in edit)) return [];
      const start = positions.offset(edit.range.start);
      const end = positions.offset(edit.range.end);
      return [{
        uri: editUri,
        start: Buffer.byteLength((analysis?.text ?? "").slice(0, start), "utf8"),
        end: Buffer.byteLength((analysis?.text ?? "").slice(0, end), "utf8"),
        newText: edit.newText,
      }];
    });
  });
}

test("advanced refactors pass the real compiler prospective validator", {
  skip: compiler === undefined ? "set ABLA_COMPILER to run the compiler integration gate" : false,
}, async (context) => {
  assert.notEqual(compiler, undefined);
  const root = path.resolve("test/fixtures");
  const uri = pathToFileURL(path.join(root, "refactor.ab")).href;
  const client = new CompilerClient({ executable: compiler ?? "ablac" });
  context.after(async () => client.stop().catch(() => undefined));
  await client.start({ workspaceRoots: [root], clientName: "abla-lsp-tests", clientVersion: "0.2.0" });
  const snapshot = await client.analyze();
  const index = new WorkspaceIndex(new SyntaxAnalyzer());
  for (const document of snapshot.documents) {
    index.upsertAnalysis({ ...document, authority: "compiler" });
  }
  const length = index.symbols().find((symbol) => symbol.uri === uri && symbol.name === "length");
  assert.notEqual(length, undefined);
  const planned = new AdvancedRefactors(index).functionToMethod({
    symbolId: length?.id ?? "",
    receiver: "point",
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const edits: CompilerTextEdit[] = Object.entries(planned.edit.changes ?? {}).flatMap(([editUri, values]) => {
    const analysis = index.document(editUri);
    assert.notEqual(analysis, undefined);
    const positions = new PositionMap(analysis?.text ?? "");
    return values.map((edit) => {
      const start = positions.offset(edit.range.start);
      const end = positions.offset(edit.range.end);
      return {
        uri: editUri,
        start: Buffer.byteLength((analysis?.text ?? "").slice(0, start), "utf8"),
        end: Buffer.byteLength((analysis?.text ?? "").slice(0, end), "utf8"),
        newText: edit.newText,
      };
    });
  });
  const validated = await client.validate({
    baseRevision: snapshot.revision,
    edits,
    invariants: ["no-new-errors", "preserve-unedited-symbols"],
  });
  assert.deepEqual(validated.valid, true, validated.reason ?? "compiler rejected the refactor");

  const inline = new AdvancedRefactors(index).inlineSymbol({ symbolId: length?.id ?? "" });
  assert.equal(inline.ok, true);
  if (!inline.ok) return;
  const inlineEdits: CompilerTextEdit[] = Object.entries(inline.edit.changes ?? {}).flatMap(
    ([editUri, values]) => {
      const analysis = index.document(editUri);
      assert.notEqual(analysis, undefined);
      const positions = new PositionMap(analysis?.text ?? "");
      return values.map((edit) => {
        const start = positions.offset(edit.range.start);
        const end = positions.offset(edit.range.end);
        return {
          uri: editUri,
          start: Buffer.byteLength((analysis?.text ?? "").slice(0, start), "utf8"),
          end: Buffer.byteLength((analysis?.text ?? "").slice(0, end), "utf8"),
          newText: edit.newText,
        };
      });
    },
  );
  const inlineValidated = await client.validate({
    baseRevision: snapshot.revision,
    edits: inlineEdits,
    invariants: ["no-new-errors", "preserve-unedited-symbols"],
  });
  assert.equal(inlineValidated.valid, true, inlineValidated.reason ?? "compiler rejected block inline");

  const analysis = index.document(uri);
  assert.notEqual(analysis, undefined);
  const pointStart = analysis?.text.lastIndexOf("Point(2)") ?? -1;
  const introducedLocal = new AdvancedRefactors(index).introduceBinding({
    uri,
    range: new PositionMap(analysis?.text ?? "").range({
      start: pointStart,
      end: pointStart + "Point(2)".length,
    }),
    name: "point",
    destination: "local",
  });
  assert.equal(introducedLocal.ok, true);
  if (!introducedLocal.ok) return;
  const localValidated = await client.validate({
    baseRevision: snapshot.revision,
    edits: compilerEdits(index, introducedLocal.edit),
    invariants: ["no-new-errors", "preserve-unedited-symbols"],
  });
  assert.equal(localValidated.valid, true, localValidated.reason ?? "compiler rejected introduce local");

  const defaultScale = index.symbols().find((symbol) => symbol.name === "defaultScale");
  const changedBinding = new AdvancedRefactors(index).changeBindingKind({
    symbolId: defaultScale?.id ?? "",
    kind: "var",
  });
  assert.equal(changedBinding.ok, true);
  if (!changedBinding.ok) return;
  const bindingValidated = await client.validate({
    baseRevision: snapshot.revision,
    edits: compilerEdits(index, changedBinding.edit),
    invariants: ["no-new-errors", "preserve-unedited-symbols"],
  });
  assert.equal(bindingValidated.valid, true, bindingValidated.reason ?? "compiler rejected binding conversion");

  const targetUri = pathToFileURL(path.join(root, "staged-target.ab")).href;
  const staged = await applyStagedRecipe(snapshot, [
    {
      kind: "move",
      request: {
        symbols: [
          { uri, name: "Point" },
          { uri, name: "length" },
        ],
        targetUri,
        createTarget: true,
      },
    },
    {
      kind: "rename",
      request: {
        symbol: { uri: targetUri, name: "length" },
        newName: "distance",
      },
    },
  ], client);
  assert.equal(staged.ok, true, staged.ok ? "staged refactor passed" : staged.reason);
  if (staged.ok) {
    const textChanges = staged.edit.documentChanges?.filter(
      (change) => "textDocument" in change,
    ) ?? [];
    const source = textChanges.find((change) => change.textDocument.uri === uri)?.edits[0];
    const target = textChanges.find((change) => change.textDocument.uri === targetUri)?.edits[0];
    assert.match(source !== undefined && "newText" in source ? source.newText : "", /distance\(Point\(2\), defaultScale\)/u);
    assert.match(target !== undefined && "newText" in target ? target.newText : "", /fun distance/u);
  }
});
